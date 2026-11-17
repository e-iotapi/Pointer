// firestore.rules for reviewGate/<campus> (B6): owner any campus, admin
// on their own campus; presidents cannot, audited, marker bumped.
import { describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ADMIN, OTHER, OWNER, PRES, STUDENT, as, bump, name, useEmulator } from './helpers.mjs';

useEmulator();

function setGate(db, actor, campus, on, { audit = true, marker = true, byEmail = actor, dept } = {}) {
  const b = writeBatch(db);
  const a = doc(collection(db, 'audit'));
  b.set(a, { actor: { email: actor, name: name(actor), role: 'test' }, action: 'gate', path: audit ? `reviewGate/${campus}` : 'x', campus, at: serverTimestamp() });
  b.set(doc(db, 'reviewGate', campus), { on, by: { email: byEmail, name: name(actor) }, at: serverTimestamp(), auditId: a.id, ...(dept ? { dept } : {}) });
  if (marker) bump(b, db, campus, 'reviewGate');
  return b.commit();
}

describe('reviewGate', () => {
  test('owner any campus; an admin on their own campus only', async () => {
    await assertSucceeds(setGate(as(OWNER), OWNER, 'goa', true));
    await assertSucceeds(setGate(as(OWNER), OWNER, 'pilani', true));
    await assertSucceeds(setGate(as(ADMIN), ADMIN, 'pilani', false));
    await assertFails(setGate(as(ADMIN), ADMIN, 'hyderabad', true));
    await assertFails(setGate(as(ADMIN), ADMIN, 'goa', false));
  });

  test('a president cannot switch compulsory reviews; students never', async () => {
    await assertFails(setGate(as(PRES), PRES, 'goa', true, { dept: 'ELEC' }));
    await assertFails(setGate(as(PRES), PRES, 'goa', true));
    await assertFails(setGate(as(STUDENT), STUDENT, 'goa', true));
    await assertFails(setGate(as(OTHER), OTHER, 'hyderabad', true));
  });

  test('needs its audit entry, the marker bump and an honest by', async () => {
    await assertFails(setGate(as(ADMIN), ADMIN, 'pilani', true, { audit: false }));
    await assertFails(setGate(as(ADMIN), ADMIN, 'pilani', true, { marker: false }));
    await assertFails(setGate(as(ADMIN), ADMIN, 'pilani', true, { byEmail: OWNER }));
  });

  test('any signed-in campus user reads; no delete', async () => {
    await setGate(as(OWNER), OWNER, 'goa', true);
    await assertSucceeds(getDoc(doc(as(STUDENT), 'reviewGate', 'goa')));
    const db = as(OWNER);
    const b = writeBatch(db);
    b.delete(doc(db, 'reviewGate', 'goa'));
    await assertFails(b.commit());
  });
});
