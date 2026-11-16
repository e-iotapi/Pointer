// A built-in term change from Controls › Roles writes roles/builtin and, in
// the same batch, mirrors the terms to config/grantTerms for the stable app
// (RoleStore.saveBuiltin). The rules must accept the combined batch.
//   firebase emulators:exec --only firestore --project demo-pointer 'node --test --test-concurrency=1 test/rules/terms_mirror.test.mjs'
import { describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { ADMIN, DEFAULT_CAPS, OWNER, as, bump, name, seed, seedBuiltin, useEmulator } from './helpers.mjs';

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
