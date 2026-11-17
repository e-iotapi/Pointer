// A built-in term change from Controls › Roles writes roles/builtin and, in
// the same batch, mirrors the terms to config/grantTerms for the stable app
// (RoleStore.saveBuiltin). The rules must accept the combined batch.
//   firebase emulators:exec --only firestore --project demo-pointer 'node --test --test-concurrency=1 test/rules/terms_mirror.test.mjs'
import { describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { ADMIN, DEFAULT_CAPS, OWNER, PRES, STUDENT, as, bump, days, grantId, name, seed, seedBuiltin, useEmulator } from './helpers.mjs';

useEmulator();

const CAMPUSES = ['goa', 'pilani', 'hyderabad', 'dubai'];

/// roles/builtin with [terms], plus config/grantTerms = [mirror], each with
/// its audit entry and marker bumps, in one batch.
function save(actor, terms, mirror) {
  const db = as(actor);
  const b = writeBatch(db);
  const a1 = doc(collection(db, 'audit'));
  const a2 = doc(collection(db, 'audit'));
  b.set(doc(db, 'roles', 'builtin'), {
    admin: { caps: DEFAULT_CAPS.admin, termDays: terms.admin },
    president: { caps: DEFAULT_CAPS.president, termDays: terms.president },
    cr: { caps: DEFAULT_CAPS.cr, termDays: terms.cr },
    auditId: a1.id,
  });
  b.set(a1, {
    actor: { email: actor, name: name(actor), role: 'test' }, action: 'roles', path: 'roles/builtin',
    campus: 'all', at: serverTimestamp(),
  });
  bump(b, db, 'goa', 'roles');
  b.set(doc(db, 'config', 'grantTerms'), { ...mirror, auditId: a2.id });
  b.set(a2, {
    actor: { email: actor, name: name(actor), role: 'test' }, action: 'config', path: 'config/grantTerms',
    campus: 'all', at: serverTimestamp(),
  });
  for (const c of CAMPUSES) bump(b, db, c, 'terms');
  return b.commit();
}

describe('a built-in term change mirrors to config/grantTerms', () => {
  test('an owner changes the CR term in both places at once', async () => {
    await seedBuiltin();
    await seed((db) => setDoc(doc(db, 'config', 'grantTerms'), { crDays: 183, presidentDays: 365, adminDays: 730 }));
    await assertSucceeds(save(OWNER, { admin: 730, president: 365, cr: 150 },
      { crDays: 150, presidentDays: 365, adminDays: 730 }));
  });

  test('an admin changes the president term in both places, not the admin term', async () => {
    await seedBuiltin();
    await seed((db) => setDoc(doc(db, 'config', 'grantTerms'), { crDays: 183, presidentDays: 365, adminDays: 730 }));
    await assertSucceeds(save(ADMIN, { admin: 730, president: 300, cr: 183 },
      { crDays: 183, presidentDays: 300, adminDays: 730 }));
    await assertFails(save(ADMIN, { admin: 900, president: 300, cr: 183 },
      { crDays: 183, presidentDays: 300, adminDays: 900 }));
  });
});

// The stable app's batches (RoleStore._grantInto/_staffInto): a grant update of
// active/expiresAt/auditId, the whole staff doc without `reach`, audit, marker.
const cr = { role: 'course', campus: 'goa', scope: 'EEE F211', email: STUDENT, name: name(STUDENT), active: true };

function auditOf(b, db, actor, path) {
  const a = doc(collection(db, 'audit'));
  b.set(a, { actor: { email: actor, name: name(actor), role: 'test' }, action: 'compat', path, campus: 'goa', at: serverTimestamp() });
  return a.id;
}

/// A new CR grant, then (renew) the same grant updated, as the stable app writes it.
async function writeCr(actor, scope, expiresAt, renew = false) {
  const db = as(actor), b = writeBatch(db);
  const g = { ...cr, scope, expiresAt };
  const id = grantId(g);
  const auditId = auditOf(b, db, actor, `grants/${id}`);
  if (renew) b.update(doc(db, 'grants', id), { active: true, expiresAt, auditId });
  else b.set(doc(db, 'grants', id), { ...g, grantedBy: { email: actor, name: name(actor) }, grantedAt: serverTimestamp(), auditId });
  const old = (await getDoc(doc(db, 'staff', STUDENT))).data() ?? {};
  b.set(doc(db, 'staff', STUDENT), {
    email: STUDENT, name: name(STUDENT), campus: 'goa', owner: false, admin: false,
    presidentOf: old.presidentOf ?? [], courses: [...new Set([...(old.courses ?? []), scope])],
    expiresAt: old.expiresAt && old.expiresAt.toMillis() > expiresAt.toMillis() ? old.expiresAt : expiresAt,
    lastGrant: id,
  });
  bump(b, db, 'goa', 'grants');
  return b.commit();
}

describe('legacy renewals and terms', () => {
  for (const seeded of [false, true])
    test(`a president renews an existing CR with the stable batch (${seeded ? 'builtin seeded' : 'no builtin'})`, async () => {
      if (seeded) await seedBuiltin();
      await assertSucceeds(writeCr(PRES, 'EEE F211', days(90)));
      await assertSucceeds(writeCr(PRES, 'EEE F211', days(150), true));
    });

  for (const seeded of [false, true])
    test(`config/grantTerms is the term while it exists (${seeded ? 'builtin seeded' : 'no builtin'})`, async () => {
      if (seeded) await seedBuiltin();
      await seed((db) => setDoc(doc(db, 'config', 'grantTerms'), { crDays: 30, presidentDays: 365, adminDays: 730 }));
      await assertSucceeds(writeCr(PRES, 'EEE F211', days(29)));
      await assertFails(writeCr(PRES, 'EEE F212', days(100)));
    });

  test('a longer config/grantTerms value than roles/builtin is honoured', async () => {
    await seedBuiltin();
    await seed((db) => setDoc(doc(db, 'config', 'grantTerms'), { crDays: 300, presidentDays: 365, adminDays: 730 }));
    await assertSucceeds(writeCr(PRES, 'EEE F211', days(250)));
  });

  test('without config/grantTerms the roles/builtin term (or the default) decides', async () => {
    await seed((db) => deleteDoc(doc(db, 'config', 'grantTerms')));
    await assertSucceeds(writeCr(PRES, 'EEE F211', days(150)));
    await assertFails(writeCr(PRES, 'EEE F212', days(200)));
    await seed((db) => setDoc(doc(db, 'roles', 'builtin'), {
      admin: { caps: DEFAULT_CAPS.admin, termDays: 730 },
      president: { caps: DEFAULT_CAPS.president, termDays: 365 },
      cr: { caps: DEFAULT_CAPS.cr, termDays: 60 },
    }));
    await assertFails(writeCr(PRES, 'EEE F213', days(100)));
    await assertSucceeds(writeCr(PRES, 'EEE F213', days(50)));
  });
});

// Each term needs its row (grantTermsCrPresident, grantTermsAdmin); owners any.
function saveGrantTerms(actor, terms) {
  const db = as(actor), b = writeBatch(db);
  b.set(doc(db, 'config', 'grantTerms'), { ...terms, auditId: auditOf(b, db, actor, 'config/grantTerms') });
  for (const c of CAMPUSES) bump(b, db, c, 'terms');
  return b.commit();
}

describe('who may change config/grantTerms', () => {
  const base = { crDays: 183, presidentDays: 365, adminDays: 730 };

  test('an admin without grantTermsCrPresident cannot change the CR or president term', async () => {
    await seedBuiltin({ ...DEFAULT_CAPS, admin: DEFAULT_CAPS.admin.filter((c) => c !== 'grantTermsCrPresident') });
    await assertFails(saveGrantTerms(ADMIN, { ...base, crDays: 400, presidentDays: 800 }));
    await assertFails(saveGrantTerms(ADMIN, { ...base, crDays: 30 }));
    await assertSucceeds(saveGrantTerms(ADMIN, base)); // nothing changed
  });

  test('an admin with the row changes CR and president terms, never the admin term', async () => {
    await assertSucceeds(saveGrantTerms(ADMIN, { ...base, crDays: 30, presidentDays: 200 }));
    await assertFails(saveGrantTerms(ADMIN, { ...base, adminDays: 900 }));
  });

  test('the admin term needs grantTermsAdmin; an owner needs nothing', async () => {
    await seedBuiltin({ ...DEFAULT_CAPS, admin: [...DEFAULT_CAPS.admin, 'grantTermsAdmin'] });
    await assertSucceeds(saveGrantTerms(ADMIN, { ...base, adminDays: 900 }));
    await assertSucceeds(saveGrantTerms(OWNER, { ...base, adminDays: 1000 }));
  });

  test('an overlong appointment is refused once the term row was refused', async () => {
    await seedBuiltin({ ...DEFAULT_CAPS, admin: DEFAULT_CAPS.admin.filter((c) => c !== 'grantTermsCrPresident') });
    await assertFails(saveGrantTerms(ADMIN, { ...base, crDays: 400 }));
    await assertFails(writeCr(ADMIN, 'EEE F211', days(390)));
  });
});
