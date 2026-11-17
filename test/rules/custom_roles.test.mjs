// firestore.rules for the roles collection, may() and custom grants
// (CUSTOM_ROLES_PLAN.md Task B3), against the emulator.
//   firebase emulators:exec --only firestore --project demo-pointer 'node --test --test-concurrency=1 test/rules/custom_roles.test.mjs'
import { describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection, deleteDoc, deleteField, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch,
} from 'firebase/firestore';
import {
  ADMIN, CUSTOM, DEFAULT_CAPS, FACULTY, OTHER, OWNER, PRES, STUDENT,
  as, bump, customGrant, grantId, customRole, days, name, seed, seedBuiltin, useEmulator,
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
    await assertSucceeds(may(ADMIN, 'averages', 'pilani', 'all'));
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

  test('Decision 11: a custom role never crosses campuses', async () => {
    await customRole('tt', ['publishTimetable', 'publicContact', 'averages'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'tt');
    await assertSucceeds(may(CUSTOM, 'publishTimetable', 'goa', 'all'));
    await assertFails(may(CUSTOM, 'publishTimetable', 'hyderabad', 'all'));
    await assertFails(may(CUSTOM, 'publishTimetable', 'all', 'all'));
    // A row with no campus at its site (config) needs the row alone.
    await assertSucceeds(may(CUSTOM, 'publicContact', 'all', 'all'));
  });

  test('Decision 11: "Every campus" means the holder\'s own campus, every department', async () => {
    await customRole('ev', ['averages', 'courseStructures'], 365, 'all', 'all');
    await customGrant(CUSTOM, 'ev');
    await assertSucceeds(may(CUSTOM, 'averages', 'goa', 'CS'));
    await assertFails(may(CUSTOM, 'averages', 'hyderabad', 'CS'));
  });

  test('Decision 11: an admin acts on campus data on their own campus only', async () => {
    await assertSucceeds(may(ADMIN, 'courseStructures', 'pilani', 'CS'));
    await assertFails(may(ADMIN, 'courseStructures', 'goa', 'CS'));
    await assertFails(may(ADMIN, 'moderateReviews', 'goa', 'CS'));
    // People and config rows keep every campus.
    await assertSucceeds(may(ADMIN, 'appointCrs', 'goa', 'CS'));
    await assertSucceeds(may(ADMIN, 'publicContact', 'all', 'all'));
  });

  test('Decision 11: presidents lose the compulsory reviews switch by default', async () => {
    await assertFails(may(PRES, 'reviewGateSwitch', 'goa', 'ELEC'));
    await assertSucceeds(may(PRES, 'courseStructures', 'goa', 'ELEC'));
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

// ---- a grant whose role was deleted -----------------------------------------

describe('a grant whose role was deleted', () => {
  // STUDENT holds grants/custom|STUDENT naming role 'gone', which no longer exists.
  const dangling = async () => {
    await customGrant(STUDENT, 'gone');
    await seed((db) => setDoc(doc(db, 'staff', STUDENT), {
      email: STUDENT, name: name(STUDENT), campus: 'goa', owner: false, admin: false, presidentOf: [],
      courses: [], expiresAt: days(100), lastGrant: `custom|${STUDENT}`,
      reach: [{ role: 'custom', campus: 'goa', dept: 'CS' }],
    }));
  };

  test('a person whose old custom role was deleted can be given a new one', async () => {
    await dangling();
    await customRole('new', ['averages', 'courseStructures'], 365, 'goa', 'CS');
    await assertSucceeds(grantRole(OWNER, STUDENT, 'new'));
  });

  test('an admin revokes a grant whose role was deleted', async () => {
    await dangling();
    // The revoke moves active, grantedBy, grantedAt and auditId only.
    let was;
    await seed(async (db) => { was = (await getDoc(doc(db, 'grants', `custom|${STUDENT}`))).data().expiresAt; });
    await assertSucceeds(grantCustom(ADMIN, STUDENT, 'gone', { active: false, expiresAt: was }));
  });

  test('a custom manager cannot overwrite a dangling grant with a role outside their scope', async () => {
    await customRole('mgr', MGR, 365, 'goa', 'CS');
    await customGrant(CUSTOM, 'mgr');
    await dangling();
    await customRole('cs', ['averages', 'courseStructures'], 365, 'goa', 'CS');
    await customRole('wide', ['averages', 'courseStructures'], 365, 'goa', 'all');
    await assertFails(grantRole(CUSTOM, STUDENT, 'wide'));
    await assertSucceeds(grantRole(CUSTOM, STUDENT, 'cs'));
  });

  test('a custom manager cannot revoke a dangling grant', async () => {
    await customRole('mgr', MGR, 365, 'goa', 'CS');
    await customGrant(CUSTOM, 'mgr');
    await dangling();
    await assertFails(grantCustom(CUSTOM, STUDENT, 'gone', { active: false }));
  });
});

// ---- Batch 2: scope, audit freshness, self-appointment, roster reads ---------

const qaEntry = (campus = 'goa', dept = 'ELEC') => ({ role: 'custom', campus, dept });
const qaAudit = (b, db, actor, path, campus = 'all') => {
  const a = doc(collection(db, 'audit'));
  b.set(a, { actor: { email: actor, name: name(actor), role: 'qa' }, action: 'qa', path, campus, at: serverTimestamp() });
  return a.id;
};

/// The app's custom-grant batch: grant + audit + staff entry + marker. [staff]
/// overrides the index fields; [extra] the grant's.
async function qaGrant(actor, email, roleId, { extra = {}, staff = {}, id = `custom|${email}` } = {}) {
  const db = as(actor), b = writeBatch(db), campus = email.split('@')[1].split('.')[0];
  let r;
  await seed(async (s) => { r = (await getDoc(doc(s, 'roles', roleId))).data(); });
  const active = extra.active ?? true;
  b.set(doc(db, 'grants', id), { role: 'custom', email, roleId, campus, scope: 'role', name: name(email),
    active: true, expiresAt: days(20), grantedBy: { email: actor }, grantedAt: serverTimestamp(),
    auditId: qaAudit(b, db, actor, `grants/${id}`, campus), ...extra });
  b.set(doc(db, 'staff', email), { email, campus, owner: false, admin: false, presidentOf: [], courses: [],
    expiresAt: days(20), lastGrant: id, reach: active ? [qaEntry(r?.campus ?? 'goa', r?.dept ?? 'ELEC')] : [], ...staff });
  bump(b, db, campus, 'grants');
  return b.commit();
}

async function qaManager(campus = 'goa', dept = 'ELEC', email = CUSTOM) {
  await customRole('manager', ['manageRoles', 'courseStructures'], 365, campus, dept);
  await customGrant(email, 'manager');
}

describe('custom roles, batch 2', () => {
  test('a grant for a deleted role is revoked by an admin only as a revoke, with a fresh audit', async () => {
    await customGrant(STUDENT, 'gone');
    await seed((db) => setDoc(doc(db, 'staff', STUDENT), { email: STUDENT, campus: 'goa', owner: false,
      admin: false, presidentOf: [], courses: [], reach: [qaEntry()], expiresAt: days(100), lastGrant: `custom|${STUDENT}` }));
    const id = `custom|${STUDENT}`;
    const revoke = (actor, fields, { reach = [], marker = true } = {}) => {
      const db = as(actor), b = writeBatch(db);
      b.update(doc(db, 'grants', id), { active: false, grantedBy: { email: actor }, grantedAt: serverTimestamp(),
        auditId: qaAudit(b, db, actor, `grants/${id}`, 'goa'), ...fields });
      b.update(doc(db, 'staff', STUDENT), { reach });
      if (marker) bump(b, db, 'goa', 'grants');
      return b.commit();
    };
    await assertFails(revoke(ADMIN, { scope: 'forged', name: 'Forged', expiresAt: days(5000) }));
    await assertFails(revoke(ADMIN, {}, { marker: false }));
    await assertFails(revoke(ADMIN, {}, { reach: [qaEntry()] }));
    await assertSucceeds(revoke(ADMIN, {}));
  });

  test('an old audit entry cannot be reused for a deleted-role revoke', async () => {
    await customGrant(STUDENT, 'gone');
    await seed(async (db) => {
      await setDoc(doc(db, 'grants', `admin|all|all|${FACULTY}`), { role: 'admin', campus: 'all', scope: 'all',
        email: FACULTY, active: true, expiresAt: days(100) });
      await setDoc(doc(db, 'audit', 'historic'), { actor: { email: FACULTY, name: name(FACULTY) },
        path: `grants/custom|${STUDENT}`, campus: 'goa', at: days(-1) });
    });
    await assertFails(updateDoc(doc(as(FACULTY), 'grants', `custom|${STUDENT}`), {
      active: false, grantedBy: { email: FACULTY }, grantedAt: serverTimestamp(), auditId: 'historic' }));
  });

  test('replacing a custom role needs the manager to cover the old role too', async () => {
    await qaManager();
    await customRole('wide', ['courseStructures'], 30, 'all', 'all');
    await customRole('narrow', ['courseStructures'], 30, 'goa', 'ELEC');
    console.log('STEP1'); await assertSucceeds(qaGrant(OWNER, STUDENT, 'wide'));
    console.log('STEP2'); await assertFails(qaGrant(CUSTOM, STUDENT, 'narrow'));
    console.log('STEP3'); await assertSucceeds(qaGrant(OWNER, STUDENT, 'narrow'));
    await customRole('also', ['courseStructures'], 30, 'goa', 'ELEC');
    console.log('STEP4'); await assertSucceeds(qaGrant(CUSTOM, STUDENT, 'also'));
  });

  test('replacing a custom role leaves only the new role in the staff index', async () => {
    await customRole('first', ['courseStructures'], 30, 'goa', 'ELEC');
    await customRole('second', ['professors'], 30, 'goa', 'CS');
    await assertSucceeds(qaGrant(ADMIN, STUDENT, 'first'));
    await assertFails(qaGrant(ADMIN, STUDENT, 'second', { staff: { reach: [qaEntry(), qaEntry('goa', 'CS')] } }));
    await assertSucceeds(qaGrant(ADMIN, STUDENT, 'second'));
  });

  test('nobody gives themselves a custom role, owners and admins included', async () => {
    await seed((db) => setDoc(doc(db, 'owners', STUDENT), { active: true, email: STUDENT }));
    await customRole('target', ['courseStructures'], 30, 'goa', 'ELEC');
    await assertFails(qaGrant(STUDENT, STUDENT, 'target'));
    await customRole('self', ['courseStructures'], 30, 'all', 'all');
    const db = as(ADMIN), b = writeBatch(db), id = `custom|${ADMIN}`;
    b.set(doc(db, 'grants', id), { role: 'custom', campus: 'pilani', scope: 'role', email: ADMIN, roleId: 'self',
      name: name(ADMIN), active: true, expiresAt: days(20), grantedBy: { email: ADMIN }, grantedAt: serverTimestamp(),
      auditId: qaAudit(b, db, ADMIN, `grants/${id}`, 'pilani') });
    b.set(doc(db, 'staff', ADMIN), { email: ADMIN, campus: 'all', owner: false, admin: true, presidentOf: [],
      courses: [], expiresAt: days(100), lastGrant: id, reach: [{ role: 'custom', campus: 'all', dept: 'all' }] });
    bump(b, db, 'pilani', 'grants');
    await assertFails(b.commit());
  });

  test('a custom roster reader reads staff inside the scope, not elsewhere; no admin list without the row', async () => {
    await customRole('reader', ['readAuditAndRoster'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'reader');
    await seed((db) => setDoc(doc(db, 'staff', OTHER), { email: OTHER, campus: 'hyderabad', owner: false,
      admin: false, presidentOf: [], courses: [], expiresAt: days(100) }));
    await assertSucceeds(getDoc(doc(as(CUSTOM), 'staff', PRES)));
    await assertFails(getDoc(doc(as(CUSTOM), 'staff', OTHER)));
    await assertFails(getDocs(collection(as(CUSTOM), 'staff')));
    await seedBuiltin({ ...DEFAULT_CAPS, admin: DEFAULT_CAPS.admin.filter((c) => c !== 'readAuditAndRoster') });
    await assertFails(getDocs(collection(as(ADMIN), 'staff')));
  });

  test('a custom appointer reads people and staff in scope; a roleless student does not', async () => {
    await qaManager();
    await assertSucceeds(getDoc(doc(as(CUSTOM), 'people', STUDENT)));
    await assertSucceeds(getDoc(doc(as(CUSTOM), 'staff', STUDENT)));
    await assertFails(getDoc(doc(as(CUSTOM), 'people', OTHER)));
    await assertFails(getDoc(doc(as(STUDENT), 'people', PRES)));
  });

  test('a custom approver reads the contributor docs of their campus', async () => {
    await customRole('approver', ['approveContributors'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'approver');
    await seed(async (db) => {
      await setDoc(doc(db, 'contributors', STUDENT), { username: 'cee', campus: 'goa', points: 8 });
      await setDoc(doc(db, 'contributors', OTHER), { username: 'oth', campus: 'hyderabad', points: 4 });
    });
    await assertSucceeds(getDoc(doc(as(CUSTOM), 'contributors', STUDENT)));
    await assertFails(getDoc(doc(as(CUSTOM), 'contributors', OTHER)));
  });

  test('a manager on another campus moves the roles marker on goa, and only that key', async () => {
    await qaManager('hyderabad', 'ELEC', OTHER);
    const db = as(OTHER);
    const roles = writeBatch(db);
    bump(roles, db, 'all', 'roles');
    await assertSucceeds(roles.commit());
    const grants = writeBatch(db);
    bump(grants, db, 'goa', 'grants');
    await assertFails(grants.commit());
    await assertSucceeds(writeRole(OTHER, 'valid', { campus: 'hyderabad', caps: ['courseStructures'] }));
  });

  test('strict campus separation: a custom role scoped everywhere does not reach other campuses for resources', async () => {
    const { PROBES } = await import('./capability_probes.mjs');
    for (const cap of ['departmentResources', 'courseResources', 'publishDirectly', 'contribute']) {
      await PROBES[cap].setup();
      await customRole(`global-${cap}`, [cap], 365, 'all', 'all');
      await customGrant(CUSTOM, `global-${cap}`);
      await assertFails(PROBES[cap].outScope(as(CUSTOM), CUSTOM));
    }
  });

  test('a custom approver who is also a CR completes a full approval batch', async () => {
    await seedBuiltin();
    await customRole('approver', ['approveContributors'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'approver');
    await seed(async (db) => {
      const g = { role: 'course', campus: 'goa', scope: 'EEE F211', email: CUSTOM };
      await setDoc(doc(db, 'grants', grantId(g)), { ...g, active: true, expiresAt: days(100) });
      await setDoc(doc(db, 'staff', CUSTOM), { email: CUSTOM, campus: 'goa', owner: false, admin: false,
        presidentOf: [], courses: ['EEE F211'], expiresAt: days(100) });
      const r = { title: 'Notes', url: 'https://drive.google.com/x', host: 'drive.google.com', kind: 'folder',
        campus: 'goa', department: 'ELEC', scope: 'department', courseIds: [], pinnedToDepartment: false,
        removed: false, actingFor: '', approved: false, publishedAt: days(-1), batchId: 'b1' };
      await setDoc(doc(db, 'resources', 'qa'), { ...r, addedBy: { email: STUDENT, name: name(STUDENT) },
        addedAt: days(-1), auditId: 'before' });
      const copy = Object.fromEntries(['title', 'url', 'department', 'scope', 'courseIds', 'pinnedToDepartment',
        'approved', 'publishedAt'].map((k) => [k, r[k]]));
      await setDoc(doc(db, 'resourceVersions', 'goa'), { v: 5, links: { qa: copy } });
      await setDoc(doc(db, 'pending', 'goa|ELEC'), { batches: { b1: { email: STUDENT, username: 'cee',
        at: days(-1), links: { qa: { title: r.title, url: r.url } } } } });
      await setDoc(doc(db, 'contributors', STUDENT), { username: 'cee', campus: 'goa', points: 8 });
      await setDoc(doc(db, 'usernames', 'goa|cee'), { email: STUDENT });
      await setDoc(doc(db, 'leaderboard', 'goa'), { p: { cee: 8 }, tags: {} });
      await deleteDoc(doc(db, 'heads', 'goa'));
    });
    const db = as(CUSTOM), b = writeBatch(db), a = doc(collection(db, 'audit'));
    b.set(a, { actor: { email: CUSTOM, name: name(CUSTOM), role: 'qa' }, action: 'approve', path: 'resources/qa',
      campus: 'goa', at: serverTimestamp() });
    b.update(doc(db, 'resources', 'qa'), { approved: true, auditId: a.id });
    b.update(doc(db, 'resourceVersions', 'goa'), { v: 6, k: 'qa', 'links.qa.approved': true });
    b.update(doc(db, 'pending', 'goa|ELEC'), { 'batches.b1': deleteField(), b: 'b1', k: 'qa' });
    b.update(doc(db, 'contributors', STUDENT), { points: 12, lastLink: 'qa' });
    b.set(doc(db, 'leaderboard', 'goa'), { p: { cee: 12 }, k: 'cee' }, { merge: true });
    for (const path of ['resources', 'pending/ELEC', 'leaderboard']) bump(b, db, 'goa', path);
    await assertSucceeds(b.commit());
  });
});
