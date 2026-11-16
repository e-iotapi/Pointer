// firestore.rules for the roles collection, may() and custom grants
// (CUSTOM_ROLES_PLAN.md Task B3), against the emulator.
//   firebase emulators:exec --only firestore --project demo-pointer 'node --test --test-concurrency=1 test/rules/custom_roles.test.mjs'
import { describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import {
  ADMIN, CUSTOM, DEFAULT_CAPS, FACULTY, OTHER, OWNER, PRES, STUDENT,
  as, bump, customGrant, customRole, days, name, seed, seedBuiltin, useEmulator,
} from './helpers.mjs';

// A test-only read that asks may() directly: id = cap|campus|dept|course ('-' = none).
useEmulator({
  extraRules: `
    match /probe/{id} {
      allow get: if may(id.split('[|]')[0], id.split('[|]')[1], id.split('[|]')[2],
        id.split('[|]')[3] == '-' ? '' : id.split('[|]')[3]);
    }`,
});

const may = (actor, cap, campus = 'all', dept = 'all', course = '-') =>
  getDoc(doc(as(actor), 'probe', `${cap}|${campus}|${dept}|${course}`));

/// A role write the way the app writes it: document + audit + marker, one batch.
function writeRole(actor, id, data) {
  const db = as(actor);
  const b = writeBatch(db);
  const a = doc(collection(db, 'audit'));
  b.set(doc(db, 'roles', id), {
    name: 'Tester', caps: ['averages', 'courseStructures'], termDays: 100, campus: 'goa', dept: 'ELEC',
    createdBy: { email: actor, name: name(actor) }, updatedAt: serverTimestamp(), auditId: a.id,
    ...data,
  });
  b.set(a, {
    actor: { email: actor, name: name(actor), role: 'test' }, action: 'roles', path: `roles/${id}`,
    campus: 'all', before: null, after: id, at: serverTimestamp(),
  });
  bump(b, db, 'all', 'roles');
  return b.commit();
}

function writeBuiltin(actor, caps = {}, terms = {}) {
  const db = as(actor);
  const b = writeBatch(db);
  const a = doc(collection(db, 'audit'));
  b.set(doc(db, 'roles', 'builtin'), {
    admin: { caps: caps.admin ?? DEFAULT_CAPS.admin, termDays: terms.admin ?? 730 },
    president: { caps: caps.president ?? DEFAULT_CAPS.president, termDays: terms.president ?? 365 },
    cr: { caps: caps.cr ?? DEFAULT_CAPS.cr, termDays: terms.cr ?? 183 },
    auditId: a.id,
  });
  b.set(a, {
    actor: { email: actor, name: name(actor), role: 'test' }, action: 'roles', path: 'roles/builtin',
    campus: 'all', before: null, after: 'builtin', at: serverTimestamp(),
  });
  bump(b, db, 'all', 'roles');
  return b.commit();
}

/// grants/custom|{email}: grant + audit + marker + the holder's staff entry,
/// the app's exact batch. The entry is the role's scope unless [staff] says
/// otherwise; with [extra].active false it is removed.
async function grantCustom(actor, email, roleId, extra = {}, staff = {}) {
  const db = as(actor);
  const r = (await getDoc(doc(db, 'roles', roleId))).data();
  const b = writeBatch(db);
  const a = doc(collection(db, 'audit'));
  const campus = email.split('@')[1].split('.')[0];
  const active = extra.active ?? true;
  const id = `custom|${email}`;
  b.set(doc(db, 'grants', id), {
    role: 'custom', campus, scope: 'role', email, roleId, name: name(email), active: true,
    expiresAt: days(30), grantedBy: { email: actor, name: name(actor) }, grantedAt: serverTimestamp(),
    auditId: a.id, ...extra,
  });
  b.set(doc(db, 'staff', email), {
    email, name: name(email), campus, owner: false, admin: false, presidentOf: [], courses: [],
    expiresAt: days(30), lastGrant: id,
    reach: active ? [{ role: 'custom', campus: r?.campus ?? null, dept: r?.dept ?? null }] : [], ...staff,
  });
  b.set(a, {
    actor: { email: actor, name: name(actor), role: 'test' }, action: 'grant',
    path: `grants/custom|${email}`, campus, before: null, after: 'custom', at: serverTimestamp(),
  });
  bump(b, db, campus, 'grants');
  return b.commit();
}

describe('built-in defaults and roles/builtin', () => {
  test('builtin defaults when the document is missing', async () => {
    await assertSucceeds(may(ADMIN, 'publicContact'));
    await assertFails(may(ADMIN, 'publish'));
    await assertSucceeds(may(PRES, 'courseStructures', 'goa', 'ELEC'));
    await assertFails(may(PRES, 'courseStructures', 'goa', 'CS'));
    await assertFails(may(PRES, 'publish'));
    await assertSucceeds(may(OWNER, 'publish'));
  });

  test('a stored roles/builtin replaces the defaults', async () => {
    await seedBuiltin({ admin: ['averages'] });
    await assertFails(may(ADMIN, 'publicContact'));
    await assertSucceeds(may(ADMIN, 'averages'));
  });

  test('only owners write roles/builtin', async () => {
    await assertSucceeds(writeBuiltin(OWNER));
    await assertFails(writeBuiltin(ADMIN, { cr: ['courseStructures'] })); // admins change terms, never rows
    await assertFails(writeBuiltin(PRES));
  });
});

describe('custom roles', () => {
  test('an admin creates a custom role inside their rows', async () => {
    await assertSucceeds(writeRole(ADMIN, 'r1', { caps: ['averages', 'courseStructures'] }));
    await assertFails(writeRole(ADMIN, 'r2', { caps: ['publish'] }));
    await assertFails(writeRole(PRES, 'r3', { caps: ['averages', 'courseStructures'] }));
    await assertSucceeds(writeRole(OWNER, 'r4', { caps: ['publish'] }));
  });

  test('a role needs a valid name, term and scope', async () => {
    await assertFails(writeRole(OWNER, 'a', { name: '' }));
    await assertFails(writeRole(OWNER, 'b', { termDays: 5000 }));
    await assertFails(writeRole(OWNER, 'c', { campus: 'mars' }));
    await assertFails(writeRole(OWNER, 'd', { campus: 'all', dept: 'ELEC' }));
    await assertSucceeds(writeRole(OWNER, 'e', { campus: 'all', dept: 'all' }));
  });

  test('a custom manager cannot create a role with a row they lack, nor edit one that has it', async () => {
    await customRole('mgr', ['manageRoles', 'averages', 'courseStructures'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'mgr');
    await customRole('big', ['averages', 'courseStructures', 'publish'], 365, 'goa', 'ELEC');
    await assertSucceeds(writeRole(CUSTOM, 'ok', { caps: ['averages', 'courseStructures'] }));
    await assertFails(writeRole(CUSTOM, 'bad', { caps: ['courseStructures', 'bulkUpload'] }));
    await assertFails(writeRole(CUSTOM, 'big', { caps: ['courseStructures'] }));
  });

  test('a custom role gives exactly its ticked row inside its scope', async () => {
    await customRole('avg', ['averages'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'avg');
    await assertSucceeds(may(CUSTOM, 'averages', 'goa', 'ELEC', 'EEE F211'));
    await assertFails(may(CUSTOM, 'averages', 'goa', 'CS', 'CS F211'));
    await assertFails(may(CUSTOM, 'averages', 'hyderabad', 'ELEC', 'EEE F211'));
    await assertFails(may(CUSTOM, 'courseStructures', 'goa', 'ELEC', 'EEE F211'));
    await customRole('res', ['courseResources'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'res');
    await assertFails(may(CUSTOM, 'averages', 'goa', 'ELEC', 'EEE F211'));
  });

  test('an everywhere row in a department-scoped role works on every campus', async () => {
    await customRole('tt', ['publishTimetable', 'readAuditAndRoster'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'tt');
    await assertSucceeds(may(CUSTOM, 'publishTimetable', 'all', 'all'));
  });

  test('a campus row in a department-scoped role covers that campus', async () => {
    await customRole('tt', ['publishTimetable', 'readAuditAndRoster'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'tt');
    await assertSucceeds(may(CUSTOM, 'readAuditAndRoster', 'goa', 'all'));
    await assertFails(may(CUSTOM, 'readAuditAndRoster', 'hyderabad', 'all'));
  });

  test('expired, revoked or deleted-role custom grants give nothing', async () => {
    await customRole('avg', ['averages'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'avg', { expiresAt: days(-1) });
    await assertFails(may(CUSTOM, 'averages', 'goa', 'ELEC', 'EEE F211'));
    await customGrant(CUSTOM, 'avg', { active: false });
    await assertFails(may(CUSTOM, 'averages', 'goa', 'ELEC', 'EEE F211'));
    await customGrant(CUSTOM, 'avg');
    await assertSucceeds(may(CUSTOM, 'averages', 'goa', 'ELEC', 'EEE F211'));
    await seed((db) => deleteDoc(doc(db, 'roles', 'avg')));
    await assertFails(may(CUSTOM, 'averages', 'goa', 'ELEC', 'EEE F211'));
  });

  test("custom grant used off its holder's campus is refused", async () => {
    await customRole('hy', ['averages'], 365, 'hyderabad', 'all');
    await customGrant(CUSTOM, 'hy', { campus: 'hyderabad' }); // a Goa address
    await assertFails(may(CUSTOM, 'averages', 'hyderabad', 'CS', 'CS F211'));
  });
});

describe('custom grants', () => {
  test('an owner grants a custom role; a president cannot', async () => {
    await customRole('avg', ['averages'], 365, 'goa', 'ELEC');
    await seed((db) => setDoc(doc(db, 'people', CUSTOM), { name: name(CUSTOM), campus: 'goa', firstSignIn: 1 }));
    await assertFails(grantCustom(PRES, CUSTOM, 'avg'));
    await assertSucceeds(grantCustom(OWNER, CUSTOM, 'avg'));
    await assertSucceeds(may(CUSTOM, 'averages', 'goa', 'ELEC', 'EEE F211'));
  });

  test('a grant needs a role that exists, on the holder\'s campus', async () => {
    await customRole('hy', ['averages'], 365, 'hyderabad', 'all');
    await seed((db) => setDoc(doc(db, 'people', CUSTOM), { name: name(CUSTOM), campus: 'goa', firstSignIn: 1 }));
    await assertFails(grantCustom(OWNER, CUSTOM, 'nope'));
    await assertFails(grantCustom(OWNER, CUSTOM, 'hy'));
  });

  test('a grant expires within the role term, and can be revoked', async () => {
    await customRole('avg', ['averages'], 10, 'goa', 'ELEC');
    await seed((db) => setDoc(doc(db, 'people', CUSTOM), { name: name(CUSTOM), campus: 'goa', firstSignIn: 1 }));
    await assertFails(grantCustom(OWNER, CUSTOM, 'avg', { expiresAt: days(30) }));
    await assertSucceeds(grantCustom(OWNER, CUSTOM, 'avg', { expiresAt: days(9) }));
    const db = as(OWNER);
    const b = writeBatch(db);
    const a = doc(collection(db, 'audit'));
    b.set(doc(db, 'grants', `custom|${CUSTOM}`), {
      role: 'custom', campus: 'goa', scope: 'role', email: CUSTOM, roleId: 'avg', name: name(CUSTOM),
      active: false, expiresAt: days(9), grantedBy: { email: OWNER, name: name(OWNER) },
      grantedAt: serverTimestamp(), auditId: a.id,
    });
    b.set(a, {
      actor: { email: OWNER, name: name(OWNER), role: 'test' }, action: 'revoke',
      path: `grants/custom|${CUSTOM}`, campus: 'goa', before: null, after: 'custom', at: serverTimestamp(),
    });
    b.set(doc(db, 'staff', CUSTOM), {
      email: CUSTOM, name: name(CUSTOM), campus: 'goa', owner: false, admin: false, presidentOf: [],
      courses: [], expiresAt: days(9), lastGrant: `custom|${CUSTOM}`, reach: [],
    });
    bump(b, db, 'goa', 'grants');
    await assertSucceeds(b.commit());
    await assertFails(may(CUSTOM, 'averages', 'goa', 'ELEC', 'EEE F211'));
  });

  test('a faculty address cannot hold a custom grant', async () => {
    await customRole('avg', ['averages'], 365, 'goa', 'ELEC');
    await seed((db) => setDoc(doc(db, 'people', FACULTY), { name: name(FACULTY), campus: 'goa', firstSignIn: 1 }));
    await assertFails(grantCustom(OWNER, FACULTY, 'avg'));
  });

  test('roles are readable by signed-in students, not writable by them', async () => {
    await customRole('avg', ['averages']);
    await assertSucceeds(getDoc(doc(as(STUDENT), 'roles', 'avg')));
    await assertFails(writeRole(STUDENT, 'x', {}));
  });
});

// ---- B5: one appointment rule, terms on the role ---------------------------

const grantRole = (actor, email, roleId) => grantCustom(actor, email, roleId);

const MGR = ['manageRoles', 'averages', 'courseStructures'];

describe('appointing custom roles', () => {
  test('an admin with manageRoles grants a custom role inside admin rows', async () => {
    await customRole('inside', ['averages', 'courseStructures'], 365, 'goa', 'ELEC');
    await customRole('outside', ['publish'], 365, 'goa', 'ELEC');
    await assertSucceeds(grantRole(ADMIN, STUDENT, 'inside'));
    await assertFails(grantRole(ADMIN, OTHER, 'outside'));
    await seedBuiltin({ admin: DEFAULT_CAPS.admin.filter((c) => c !== 'manageRoles') });
    await seed((db) => deleteDoc(doc(db, 'grants', `custom|${STUDENT}`)));
    await assertFails(grantRole(ADMIN, STUDENT, 'inside'));
  });

  test('a custom manager at goa|CS grants at goa|CS, not at goa|all or hyderabad', async () => {
    await customRole('mgr', MGR, 365, 'goa', 'CS');
    await customGrant(CUSTOM, 'mgr');
    await customRole('cs', ['averages', 'courseStructures'], 365, 'goa', 'CS');
    await customRole('goa', ['averages', 'courseStructures'], 365, 'goa', 'all');
    await customRole('hy', ['averages', 'courseStructures'], 365, 'hyderabad', 'CS');
    await assertFails(grantRole(CUSTOM, STUDENT, 'goa'));
    await assertFails(grantRole(CUSTOM, OTHER, 'hy'));
    await assertSucceeds(grantRole(CUSTOM, STUDENT, 'cs'));
  });

  test('a custom manager cannot grant rows they lack', async () => {
    await customRole('mgr', MGR, 365, 'goa', 'CS');
    await customGrant(CUSTOM, 'mgr');
    await customRole('more', ['averages', 'courseStructures', 'professors'], 365, 'goa', 'CS');
    await assertFails(grantRole(CUSTOM, STUDENT, 'more'));
  });

  test('nobody grants themselves a custom role', async () => {
    await customRole('mgr', MGR, 365, 'goa', 'CS');
    await customGrant(CUSTOM, 'mgr');
    await assertFails(grantRole(CUSTOM, CUSTOM, 'mgr'));
  });

  test("custom grant expiry follows the role's termDays", async () => {
    await customRole('mgr', MGR, 365, 'goa', 'CS');
    await customGrant(CUSTOM, 'mgr');
    await customRole('short', ['courseStructures'], 10, 'goa', 'CS');
    await assertFails(grantCustom(CUSTOM, STUDENT, 'short', { expiresAt: days(30) }));
    await assertSucceeds(grantCustom(CUSTOM, STUDENT, 'short', { expiresAt: days(9) }));
  });

  test('a manager creates roles inside their scope only', async () => {
    await customRole('mgr', MGR, 365, 'goa', 'CS');
    await customGrant(CUSTOM, 'mgr');
    await assertSucceeds(writeRole(CUSTOM, 'in', { campus: 'goa', dept: 'CS' }));
    await assertFails(writeRole(CUSTOM, 'wide', { campus: 'goa', dept: 'all' }));
    await assertFails(writeRole(CUSTOM, 'elsewhere', { campus: 'hyderabad', dept: 'CS' }));
  });
});

describe('terms on the role', () => {
  test('an admin changes the CR term but not the admin term', async () => {
    await seedBuiltin();
    await assertSucceeds(writeBuiltin(ADMIN, {}, { cr: 150 }));
    await assertFails(writeBuiltin(ADMIN, {}, { admin: 900 }));
    await assertFails(writeBuiltin(ADMIN, { cr: ['courseStructures'] }, { cr: 150 }));
    await assertSucceeds(writeBuiltin(OWNER, {}, { admin: 900 }));
  });
});

describe('averages need course structures', () => {
  test('a custom role', async () => {
    await assertFails(writeRole(OWNER, 'a', { caps: ['averages'] }));
    await assertSucceeds(writeRole(OWNER, 'b', { caps: ['averages', 'courseStructures'] }));
  });

  test('roles/builtin, each role', async () => {
    for (const k of ['admin', 'president', 'cr']) {
      await assertFails(writeBuiltin(OWNER, { [k]: ['averages'] }));
      await assertSucceeds(writeBuiltin(OWNER, { [k]: ['averages', 'courseStructures'] }));
    }
  });
});

describe('custom grants and the staff index (M3)', () => {
  const entry = { role: 'custom', campus: 'goa', dept: 'ELEC' };
  const setup = async () => {
    await customRole('avg', ['averages', 'courseStructures'], 365, 'goa', 'ELEC');
    await seed((db) => setDoc(doc(db, 'people', CUSTOM), { name: name(CUSTOM), campus: 'goa', firstSignIn: 1 }));
  };

  test('appointing a custom role writes its staff entry', async () => {
    await setup();
    await assertSucceeds(grantCustom(OWNER, CUSTOM, 'avg'));
    await seed(async (db) => {
      const s = (await getDoc(doc(db, 'staff', CUSTOM))).data();
      if (JSON.stringify(s.reach) !== JSON.stringify([entry])) throw new Error('reach ' + JSON.stringify(s.reach));
    });
  });

  test('a custom grant without its staff entry, or with a wrong one, is refused', async () => {
    await setup();
    await assertFails(grantCustom(OWNER, CUSTOM, 'avg', {}, { reach: [] }));
    await assertFails(grantCustom(OWNER, CUSTOM, 'avg', {}, { reach: [{ ...entry, dept: 'all' }] }));
  });

  test('revoking removes it', async () => {
    await setup();
    await assertSucceeds(grantCustom(OWNER, CUSTOM, 'avg'));
    await assertFails(grantCustom(OWNER, CUSTOM, 'avg', { active: false }, { reach: [entry] }));
    await assertSucceeds(grantCustom(OWNER, CUSTOM, 'avg', { active: false }));
  });

  test('a custom staff write cannot add presidentOf or admin', async () => {
    await setup();
    await assertFails(grantCustom(ADMIN, CUSTOM, 'avg', {}, { presidentOf: ['ELEC'] }));
    await assertFails(grantCustom(ADMIN, CUSTOM, 'avg', {}, { admin: true }));
    await assertFails(grantCustom(ADMIN, CUSTOM, 'avg', {}, { courses: ['EEE F211'] }));
  });
});
