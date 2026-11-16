// heads/{campus} (PERF_TEST_PLAN.md §A): campus-readable; offering versions
// move only by staff of that campus; the catalogue and contact fields only
// alongside the documents they mirror.
import { describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, increment, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { CUSTOM, OTHER, PRES, STUDENT, as, customGrant, customRole, name, seed, useEmulator } from './helpers.mjs';

useEmulator();

const bump = (db, campus, key) =>
  setDoc(doc(db, 'heads', campus), { offerings: { [key]: increment(1) } }, { merge: true });

describe('heads', () => {
  test('staff of a campus move its offering versions; nobody else does', async () => {
    await assertSucceeds(bump(as(PRES), 'goa', 'EEE F211|2026-27-1'));
    await assertFails(bump(as(PRES), 'hyderabad', 'EEE F211|2026-27-1'));
    await assertFails(bump(as(STUDENT), 'goa', 'EEE F211|2026-27-1'));
  });

  test('staff cannot set the catalogue or contact fields', async () => {
    await assertFails(setDoc(doc(as(PRES), 'heads', 'goa'), { catalog: 99 }, { merge: true }));
    await assertFails(setDoc(doc(as(PRES), 'heads', 'goa'),
      { contact: { contactEnabled: true, contactTarget: 'x' } }, { merge: true }));
  });

  test('a campus reads its own head only', async () => {
    await seed((db) => setDoc(doc(db, 'heads', 'goa'), { offerings: {} }));
    await assertSucceeds(getDoc(doc(as(STUDENT), 'heads', 'goa')));
    await assertFails(getDoc(doc(as(OTHER), 'heads', 'goa')));
  });
});

describe('a custom holder saving an offering', () => {
  const save = (db, campus = 'goa') => {
    const b = writeBatch(db);
    const a = doc(collection(db, 'audit'));
    const path = `courses/EEE F211/offerings/${campus}_2026-27-1`;
    b.set(doc(db, path), {
      courseId: 'EEE F211', campus, term: '2026-27-1', weighted: true, totalMarks: 100, components: [],
      professors: [], updatedBy: { email: CUSTOM, name: name(CUSTOM) }, updatedAt: serverTimestamp(), auditId: a.id,
    });
    b.set(a, {
      actor: { email: CUSTOM, name: name(CUSTOM), role: 'test' }, action: 'probe', path, campus,
      at: serverTimestamp(),
    });
    b.set(doc(db, 'heads', campus), { offerings: { 'EEE F211|2026-27-1': increment(1) } }, { merge: true });
    return b.commit();
  };

  test('a custom courseStructures holder saves an offering and bumps heads', async () => {
    await customRole('cs', ['courseStructures'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'cs');
    await assertSucceeds(save(as(CUSTOM)));
    await assertFails(save(as(CUSTOM), 'hyderabad'));
  });

  test('a custom role without an offering row cannot bump offering versions', async () => {
    await customRole('res', ['courseResources'], 365, 'goa', 'ELEC');
    await customGrant(CUSTOM, 'res');
    await assertFails(bump(as(CUSTOM), 'goa', 'EEE F211|2026-27-1'));
  });
});
