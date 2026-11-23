// Mixed fleet on the emulator: the STABLE app's staff write (no `reach`)
// followed by the NEW app's revoke of a custom grant whose role was deleted.
// Was a known break (stable-app-wipes-reach); fixed, now a regression test.
import { describe, test } from 'node:test';
import { assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { CUSTOM, OWNER, as, bump, customGrant, customRole, days, name, seed, useEmulator } from './helpers.mjs';

useEmulator();

/// The stable app's _staffInto: a whole-doc set with no `reach`.
async function stableAppointsCr(email) {
  const db = as(OWNER);
  const b = writeBatch(db);
  const a = doc(collection(db, 'audit'));
  const id = `course|goa|EEE F211|${email}`;
  b.set(doc(db, 'grants', id), {
    role: 'course', campus: 'goa', scope: 'EEE F211', email, name: name(email), active: true,
    expiresAt: days(100), grantedBy: { email: OWNER, name: name(OWNER) }, grantedAt: serverTimestamp(), auditId: a.id,
  });
  b.set(doc(db, 'staff', email), {
    email, name: name(email), campus: 'goa', owner: false, admin: false, presidentOf: [],
    courses: ['EEE F211'], expiresAt: days(100), lastGrant: id,
  });
  b.set(a, {
    actor: { email: OWNER, name: name(OWNER), role: 'owner' }, action: 'x', summary: 'x', path: `grants/${id}`,
    campus: 'goa', before: null, after: null, at: serverTimestamp(),
  });
  bump(b, db, 'goa', 'grants');
  return b.commit();
}

/// The new app's revoke of grants/custom|{email} (role deleted): grant switched
/// off, staff entry written without the custom reach, audit, marker.
function newAppRevokesCustom(email, courses = []) {
  const db = as(OWNER);
  const b = writeBatch(db);
  const a = doc(collection(db, 'audit'));
  b.update(doc(db, 'grants', `custom|${email}`), {
    active: false, auditId: a.id, grantedBy: { email: OWNER, name: name(OWNER) }, grantedAt: serverTimestamp(),
  });
  b.set(doc(db, 'staff', email), {
    email, name: name(email), campus: 'goa', owner: false, admin: false, presidentOf: [],
    courses, reach: [],
    expiresAt: days(100), lastGrant: `custom|${email}`,
  });
  b.set(a, {
    actor: { email: OWNER, name: name(OWNER), role: 'owner' }, action: 'x', summary: 'x', path: `grants/custom|${email}`,
    campus: 'goa', before: null, after: null, at: serverTimestamp(),
  });
  bump(b, db, 'goa', 'grants');
  return b.commit();
}

async function seedHolder(withReach) {
  await customRole('avg', ['averages'], 365, 'goa', 'ELEC');
  await customGrant(CUSTOM, 'avg');
  await seed((db) => setDoc(doc(db, 'staff', CUSTOM), {
    email: CUSTOM, name: name(CUSTOM), campus: 'goa', owner: false, admin: false, presidentOf: [], courses: [],
    expiresAt: days(100), lastGrant: `custom|${CUSTOM}`,
    ...(withReach ? { reach: [{ role: 'custom', campus: 'goa', dept: 'ELEC' }] } : {}),
  }));
}

describe('stable app write, then new app revoke of a dangling custom grant', () => {
  test('control: staff keeps its reach list, revoke of a deleted-role custom grant works', async () => {
    await seedHolder(true);
    await seed((db) => deleteDoc(doc(db, 'roles', 'avg')));
    await assertSucceeds(newAppRevokesCustom(CUSTOM));
  });

  test('stable-app-wipes-reach: after the stable app appointed a CR, the revoke still works', async () => {
    await seedHolder(true);
    await assertSucceeds(stableAppointsCr(CUSTOM)); // accepted: old shape has no reach
    const s = (await getDoc(doc(as(OWNER), 'staff', CUSTOM))).data();
    if ('reach' in s) throw new Error('expected the stable app write to drop reach');
    await seed((db) => deleteDoc(doc(db, 'roles', 'avg')));
    await assertSucceeds(newAppRevokesCustom(CUSTOM, ['EEE F211']));
  });
});
