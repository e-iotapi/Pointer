// Shared setup for the rules tests: the emulator, the seeded people and
// grants, and an appointment written the way the app writes it.
import { readFileSync } from 'node:fs';
import { after, before, beforeEach } from 'node:test';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

export const OWNER = 'owner@gmail.com';
export const ADMIN = 'f20200001@pilani.bits-pilani.ac.in';
export const ADMIN_GOA = 'f20200002@goa.bits-pilani.ac.in'; // seeded on demand by adminGoa()
export const PRES = 'f20230802@goa.bits-pilani.ac.in'; // ELEC president, Goa
export const STUDENT = 'f20230456@goa.bits-pilani.ac.in';
export const OTHER = 'f20230119@hyderabad.bits-pilani.ac.in';
export const FACULTY = 'rmenon@goa.bits-pilani.ac.in';
export const NEVER = 'f20239999@goa.bits-pilani.ac.in'; // never signed in
export const CUSTOM = 'f20231234@goa.bits-pilani.ac.in'; // holds a custom role in custom_roles tests

export let env;
export const days = (n) => Timestamp.fromMillis(Date.now() + n * 864e5);
export const name = (email) => `Name of ${email.split('@')[0]}`;

export function as(email) {
  return env
    .authenticatedContext(email, { email, email_verified: true, name: name(email) })
    .firestore();
}

/// Someone signed out.
export function anon() {
  return env.unauthenticatedContext().firestore();
}

export async function seed(fn) {
  await env.withSecurityRulesDisabled((c) => fn(c.firestore()));
}

/// In a batch: moves [path]'s marker on [campus]'s head by one (the app's
/// bumpPath). Campus 'all' is the goa head, where the rules check owners,
/// terms and admin grants; the app bumps every head.
export function bump(b, db, campus, path, by = 1) {
  b.set(doc(db, 'heads', campus === 'all' ? 'goa' : campus), { v: { [path]: increment(by) } }, { merge: true });
}

/// One doc written with its marker bump, in one batch.
export function putBumped(db, campus, path, ref, data) {
  const b = writeBatch(db);
  b.set(ref, data);
  bump(b, db, campus, path);
  return b.commit();
}

export const grantId = (g) => `${g.role}|${g.campus}|${g.scope}|${g.email}`;

/// One appointment: the grant, the staff index and the audit entry, in one
/// batch — the shape the app writes.
export function appoint(db, actor, g, staff, { audit = true, auditPath, marker = true } = {}) {
  const id = grantId(g);
  const b = writeBatch(db);
  if (marker) bump(b, db, g.campus, 'grants');
  const a = doc(collection(db, 'audit'));
  b.set(doc(db, 'grants', id), {
    name: name(g.email),
    active: true,
    expiresAt: days(100),
    grantedBy: { email: actor, name: name(actor) },
    grantedAt: serverTimestamp(),
    auditId: a.id,
    ...g,
  });
  if (staff !== null) {
    b.set(doc(db, 'staff', g.email), {
      name: name(g.email),
      email: g.email,
      campus: g.campus,
      owner: false,
      admin: false,
      presidentOf: [],
      courses: [],
      expiresAt: days(100),
      lastGrant: id,
      ...staff,
    });
  }
  if (audit) {
    b.set(a, {
      actor: { email: actor, name: name(actor), role: 'test' },
      action: 'grant',
      path: auditPath ?? `grants/${id}`,
      campus: g.campus,
      before: null,
      after: g.role,
      at: serverTimestamp(),
    });
  }
  return b.commit();
}

/// `demo-r-<test file name>`: node --test runs each file as its own process.
function fileProject() {
  const f = (process.argv[1] ?? 'rules').split('/').pop().replace(/\.test\.mjs$|\.mjs$/, '');
  return `demo-r-${f.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 30);
}

/// Registers the emulator hooks and the seed every test starts from.
export function useEmulator({ extraRules = '' } = {}) {
before(async () => {
  env = await initializeTestEnvironment({
    // One emulator project per test file (data is isolated per project), so
    // files run in parallel on one emulator and never touch up.sh's seed.
    projectId: process.env.RULES_PROJECT ?? fileProject(),
    firestore: {
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8')
        // extraRules (test-only matches) go inside the documents block.
        .replace(/\}\s*\}\s*$/, `${extraRules}\n  }\n}`),
      host: '127.0.0.1',
      port: Number(process.env.RULES_PORT ?? 8085),
    },
  });
});

after(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await seed(async (db) => {
    await setDoc(doc(db, 'owners', OWNER), { email: OWNER, name: name(OWNER), active: true });
    await setDoc(doc(db, 'config', 'grantTerms'), { crDays: 183, presidentDays: 365, adminDays: 730 });
    for (const e of [ADMIN, PRES, STUDENT, OTHER, FACULTY]) {
      await setDoc(doc(db, 'people', e), { name: name(e), campus: e.split('@')[1].split('.')[0], firstSignIn: 1 });
    }
    const live = { active: true, expiresAt: days(100) };
    await setDoc(doc(db, 'grants', `admin|all|all|${ADMIN}`), {
      role: 'admin', campus: 'all', scope: 'all', email: ADMIN, name: name(ADMIN), ...live,
    });
    await setDoc(doc(db, 'staff', ADMIN), {
      email: ADMIN, campus: 'all', admin: true, presidentOf: [], courses: [], owner: false, expiresAt: days(100),
    });
    await setDoc(doc(db, 'grants', `dept|goa|ELEC|${PRES}`), {
      role: 'dept', campus: 'goa', scope: 'ELEC', programme: 'A3', email: PRES, name: name(PRES), ...live,
    });
    await setDoc(doc(db, 'staff', PRES), {
      email: PRES, campus: 'goa', admin: false, presidentOf: ['ELEC'], courses: [], owner: false, expiresAt: days(100),
    });
  });
});
}

/// The rules' inline defaults for roles/builtin (firestore.rules builtin()),
/// which must equal defaultBuiltinCaps() in lib/core/roles/capabilities.dart.
export const DEFAULT_CAPS = {
  admin: ['appointPresidents', 'appointCrs', 'publicContact', 'grantTermsCrPresident', 'mergeProfessors',
    'courseStructures', 'bulkUpload', 'degreeRequirements', 'departmentResources', 'courseResources',
    'averages', 'professors', 'moderateReviews', 'readAuditAndRoster', 'contribute', 'manageRoles',
    'approveContributors', 'claimElectives', 'reviewGateSwitch', 'publishTimetable', 'publishDirectly'],
  president: ['appointCrs', 'mergeProfessors', 'courseStructures', 'bulkUpload', 'degreeRequirements',
    'departmentResources', 'courseResources', 'averages', 'professors', 'moderateReviews',
    'readAuditAndRoster', 'contribute', 'approveContributors', 'claimElectives',
    'publishDirectly'],
  cr: ['courseStructures', 'courseResources', 'averages', 'contribute'],
};

/// Seeds roles/builtin with [caps] ({admin, president, cr}, default the §4 table).
export function seedBuiltin(caps = DEFAULT_CAPS) {
  return seed((db) => setDoc(doc(db, 'roles', 'builtin'), {
    admin: { caps: caps.admin ?? DEFAULT_CAPS.admin, termDays: 730 },
    president: { caps: caps.president ?? DEFAULT_CAPS.president, termDays: 365 },
    cr: { caps: caps.cr ?? DEFAULT_CAPS.cr, termDays: 183 },
  }));
}

/// Seeds a custom role; the scope (campus, dept) lives on the role.
export function customRole(id, caps, termDays = 365, campus = 'all', dept = 'all') {
  return seed((db) => setDoc(doc(db, 'roles', id), {
    name: `Role ${id}`, caps, termDays, campus, dept,
    createdBy: { email: OWNER, name: name(OWNER) },
  }));
}

/// Seeds grants/custom|{email} naming [roleId] (live unless opts say otherwise).
export function customGrant(email, roleId, { campus, active = true, expiresAt = days(100) } = {}) {
  return seed(async (db) => {
    await setDoc(doc(db, 'people', email), { name: name(email), campus: email.split('@')[1].split('.')[0], firstSignIn: 1 });
    await setDoc(doc(db, 'grants', `custom|${email}`), {
      role: 'custom', campus: campus ?? email.split('@')[1].split('.')[0], scope: 'role', email,
      name: name(email), roleId, active, expiresAt,
    });
  });
}

/// A second admin, on Goa (ADMIN is on Pilani): for own-campus-only tests.
export async function adminGoa() {
  await seed(async (db) => {
    await setDoc(doc(db, 'people', ADMIN_GOA), { name: name(ADMIN_GOA), campus: 'goa', firstSignIn: 1 });
    await setDoc(doc(db, 'grants', `admin|all|all|${ADMIN_GOA}`), {
      role: 'admin', campus: 'all', scope: 'all', email: ADMIN_GOA, name: name(ADMIN_GOA), active: true, expiresAt: days(100),
    });
    await setDoc(doc(db, 'staff', ADMIN_GOA), {
      email: ADMIN_GOA, campus: 'all', admin: true, presidentOf: [], courses: [], owner: false, expiresAt: days(100),
    });
  });
}
