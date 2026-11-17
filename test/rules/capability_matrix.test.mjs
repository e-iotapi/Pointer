// Every capability x every actor, against the emulator (CUSTOM_ROLES_PLAN.md
// Task B4). The expected answer comes from the seed the rules read
// (roles/builtin and the custom role) and the actor's reach, so toggling a
// tick in the seed changes the expectation with no test edit.
//   firebase emulators:exec --only firestore --project demo-pointer 'node --test --test-concurrency=1 test/rules/capability_matrix.test.mjs'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import {
  ADMIN, CUSTOM, DEFAULT_CAPS, OWNER, PRES, STUDENT,
  as, customGrant, customRole, days, name, seed, seedBuiltin, useEmulator,
} from './helpers.mjs';
import {
  APP_ONLY, APPOINT_ROWS, COURSE_SITES, CR, CUSTOM_EXCLUDED, IN, OUT, OWN_CAMPUS_SITES, PRESIDENT_CAMPUS_SITES,
  PROBES, TARGET_SCOPED, UNENFORCED,
} from './capability_probes.mjs';

useEmulator();

const SEC = 'f20230803@goa.bits-pilani.ac.in'; // a secretary of Goa ELEC

// The enum in lib/core/roles/capabilities.dart: each key and its reach kind.
const dart = readFileSync(new URL('../../lib/core/roles/capabilities.dart', import.meta.url), 'utf8');
const enumBody = dart.slice(dart.indexOf('enum Capability {'));
const ROWS = enumBody.split(/^  (?=\w+\()/m).slice(1)
  .filter((s) => /CapReach\./.test(s))
  .map((s) => ({ key: /^(\w+)\(/.exec(s)[1], reach: /CapReach\.(\w+)/.exec(s)[1] }));
const CAPABILITY_KEYS = ROWS.map((r) => r.key);
const REACH = Object.fromEntries(ROWS.map((r) => [r.key, r.reach]));

const live = { active: true, expiresAt: days(100) };
const staff = (db, email, extra) => setDoc(doc(db, 'staff', email), {
  email, campus: 'goa', admin: false, presidentOf: [], courses: [], owner: false, expiresAt: days(100), ...extra,
});
const crGrant = (db, email) => setDoc(doc(db, 'grants', `course|goa|${IN.course}|${email}`), {
  role: 'course', campus: 'goa', scope: IN.course, email, name: name(email), ...live,
});

/// A custom actor: a role [scope] holding [caps] and CUSTOM's grant on it.
const custom = (label, scope, { ticked = true, grant = {}, alsoCr = false, noRole = false } = {}) => ({
  label, kind: 'custom', scope, ticked, alsoCr, bad: Object.keys(grant).length > 0 || noRole,
  email: CUSTOM,
  async setup(cap) {
    if (!noRole) await customRole('r', ticked ? [cap] : ['openAs'], 365, scope.campus, scope.dept);
    await customGrant(CUSTOM, 'r', grant);
    if (alsoCr) {
      await seed(async (db) => {
        await crGrant(db, CUSTOM);
        await staff(db, CUSTOM, { courses: [IN.course] });
      });
    }
  },
});

const ACTORS = [
  { label: 'owner', kind: 'owner', email: OWNER, async setup() {} },
  { label: 'admin', kind: 'admin', email: ADMIN, async setup() {} },
  { label: 'president', kind: 'president', email: PRES, async setup() {} },
  {
    label: 'secretary', kind: 'president', email: SEC,
    async setup() {
      await seed(async (db) => {
        await setDoc(doc(db, 'grants', `dept|goa|ELEC|${SEC}`), {
          role: 'dept', campus: 'goa', scope: 'ELEC', programme: 'A3', secretary: true, email: SEC,
          name: name(SEC), ...live,
        });
        await staff(db, SEC, { presidentOf: ['ELEC'] });
      });
    },
  },
  {
    label: 'cr', kind: 'cr', email: CR,
    async setup() {
      await seed(async (db) => {
        await crGrant(db, CR);
        await staff(db, CR, { courses: [IN.course] });
      });
    },
  },
  { label: 'student', kind: 'none', email: STUDENT, async setup() {} },
  {
    label: 'contributor', kind: 'contributor', email: STUDENT,
    async setup() {
      await seed((db) => setDoc(doc(db, 'grants', `contributor|goa|goa|${STUDENT}`), {
        role: 'contributor', campus: 'goa', scope: 'goa', email: STUDENT, name: name(STUDENT), dept: 'ELEC',
        active: true, expiresAt: new Date('2100-01-01T00:00:00Z'),
      }));
    },
  },
  custom('custom at goa|ELEC', { campus: 'goa', dept: 'ELEC' }),
  custom('custom at goa|all', { campus: 'goa', dept: 'all' }),
  custom('custom at all|all', { campus: 'all', dept: 'all' }),
  custom('custom without the row', { campus: 'all', dept: 'all' }, { ticked: false }),
  custom('custom, expired', { campus: 'all', dept: 'all' }, { grant: { expiresAt: days(-1) } }),
  custom('custom, revoked', { campus: 'all', dept: 'all' }, { grant: { active: false } }),
  custom('custom, role deleted', { campus: 'all', dept: 'all' }, { noRole: true }),
  custom('worst case: custom at goa|ELEC and a CR', { campus: 'goa', dept: 'ELEC' }, { alsoCr: true }),
];

/// What a custom role of [scope] covers for a row of reach [reach] at [t].
function customCovers(cap, reach, scope, t, own) {
  // Decision 11: a custom role never crosses campuses; "every campus" is the holder's own.
  if (reach === 'everywhere' && !OWN_CAMPUS_SITES.includes(cap)) return true;
  if (t.campus !== own) return false;
  if (scope.campus === 'all') return true;
  return scope.campus === t.campus && (reach === 'campus' || scope.dept === 'all' || scope.dept === t.dept);
}

/// Whether [actor] may do [cap] at target [t], from the seeded built-in rows.
function expected(cap, actor, t, caps = DEFAULT_CAPS) {
  const reach = TARGET_SCOPED.includes(cap) ? 'dept' : REACH[cap];
  if (actor.kind === 'owner') return true;
  if (actor.kind === 'custom' && APPOINT_ROWS.includes(cap)) return false;
  // Contributors queue pending links; built-in staff publish directly instead.
  if (cap === 'contribute' && actor.kind === 'contributor') return t.campus === 'goa';
  if (cap === 'contribute' && ['admin', 'president', 'cr'].includes(actor.kind)) return false;
  const ownCampus = !OWN_CAMPUS_SITES.includes(cap) || t.campus === actor.email.split('@')[1].split('.')[0];
  if (actor.kind === 'admin') return caps.admin.includes(cap) && ownCampus && !(
    ['departmentResources', 'courseResources'].includes(cap) && t.campus !== 'pilani');
  if (actor.kind === 'president') {
    return caps.president.includes(cap) && t.campus === 'goa' && (
      reach === 'dept' ? t.dept === 'ELEC' : PRESIDENT_CAMPUS_SITES.includes(cap));
  }
  if (actor.kind === 'cr') {
    // A CR reaches course sites on their course, campus-level rows on their campus (staff index).
    return caps.cr.includes(cap) && (reach === 'campus' ? t.campus === 'goa'
      : COURSE_SITES.includes(cap) && t.course === IN.course);
  }
  if (actor.kind === 'custom') {
    const viaCustom = actor.ticked && !actor.bad && !CUSTOM_EXCLUDED.includes(cap)
      && customCovers(cap, reach, actor.scope, t, actor.email.split('@')[1].split('.')[0]);
    const viaCr = actor.alsoCr && expected(cap, { kind: 'cr', email: CR }, t, caps);
    return viaCustom || viaCr;
  }
  return false;
}

for (const cap of CAPABILITY_KEYS) {
  if (UNENFORCED.includes(cap) || APP_ONLY.includes(cap)) continue;
  describe(cap, () => {
    // Also with no roles/builtin document: the rules' inline defaults (builtin()
    // and capIn()) must answer exactly as the seeded DEFAULT_CAPS do.
    for (const seeded of [true, false]) for (const actor of ACTORS) {
      // Custom roles need roles/builtin seeded by their owner first; the four
      // built-in actors must work on the defaults alone (backward compatibility).
      if (!seeded && !['admin', 'president', 'secretary', 'cr'].includes(actor.label)) continue;
      test(`${cap} x ${actor.label}${seeded ? '' : ' (roles/builtin absent)'}`, async () => {
        if (seeded) await seedBuiltin();
        await PROBES[cap].setup();
        await actor.setup(cap);
        const db = as(actor.email);
        await (expected(cap, actor, IN) ? assertSucceeds : assertFails)(PROBES[cap].inScope(db, actor.email));
        await (expected(cap, actor, OUT) ? assertSucceeds : assertFails)(PROBES[cap].outScope(db, actor.email));
      });
    }
  });
}

test('every capability has a probe or is listed', () => {
  assert.ok(CAPABILITY_KEYS.length >= 26, 'the enum was not read');
  for (const cap of CAPABILITY_KEYS) {
    assert.ok(PROBES[cap] || UNENFORCED.includes(cap) || APP_ONLY.includes(cap), cap);
  }
  for (const cap of [...UNENFORCED, ...APP_ONLY, ...Object.keys(PROBES)]) {
    assert.ok(CAPABILITY_KEYS.includes(cap), `${cap} is not a capability`);
  }
});

describe('toggling a tick flips the answer', () => {
  const without = (list, cap) => list.filter((c) => c !== cap);

  test('averages unticked for the president', async () => {
    const caps = { ...DEFAULT_CAPS, president: without(DEFAULT_CAPS.president, 'averages') };
    await seedBuiltin(caps);
    await PROBES.averages.setup();
    await assertFails(PROBES.averages.inScope(as(PRES), PRES));
    assert.equal(expected('averages', ACTORS[2], IN, caps), false);
  });

  test('averages unticked for the admin, ticked for the CR', async () => {
    await seedBuiltin({ ...DEFAULT_CAPS, admin: without(DEFAULT_CAPS.admin, 'averages') });
    await PROBES.averages.setup();
    await assertFails(PROBES.averages.inScope(as(ADMIN), ADMIN));
  });
});
