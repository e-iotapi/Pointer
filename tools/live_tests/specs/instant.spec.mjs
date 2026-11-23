// End to end, in a real browser: user B has the app open and idle; something happens elsewhere (another user
// writes shared data, or appoints/revokes B); B's open screen must change without navigation or sign-out.
// The "other user" is a script: it writes Firestore (emulator owner bypass) and sends the frames the app sends
// after such a write (poke with its campuses, pokeUser), so the receiving side is the app under test.
// Local only: the writes need rules bypass; staging runs the frame-level specs.
import { test, expect } from '@playwright/test';
import { LOCAL, CFG, openLive, idToken, bumpHeads, putDoc, firstWhere, openAs, email, str, sleep } from '../lib.mjs';

test.skip(!LOCAL, 'UI-level checks need rules-bypass writes (local emulators only)');

const WITHIN = 12_000; // "instantly": the hub waits ~1.5 s to batch, plus a read and a screen reload

const grant = (role, campus, scope, key, name) => ({
  role: str(role), campus: str(campus), scope: str(scope), email: str(email(key)), name: str(name),
  active: { booleanValue: true },
  expiresAt: { timestampValue: new Date(Date.now() + 90 * 864e5).toISOString() },
});

async function ownerSocket() {
  const s = openLive('goa', await idToken('owner'));
  await s.opened;
  await s.waitFor((f) => f.t === 'hello');
  return s;
}

test('shared data edited by someone else shows on an open screen', async ({ browser }) => {
  const links = (page) => page.getByRole('button', { name: 'More options for this link' });
  const b = await openAs(browser, 'student_full', '/more/resources/A3', (p) => links(p).first());
  const before = await links(b.page).count();
  const title = `ELEC Live Update ${Date.now()}`;
  const src = await firstWhere('resources', 'title', 'ELEC Course Drive folder');
  expect(src, 'seeded resource to copy').toBeTruthy();
  await putDoc(`resources/live${Date.now()}`, { ...src.fields, title: str(title) });
  await bumpHeads(['goa'], 'resources');
  const owner = await ownerSocket();
  owner.send({ t: 'poke', path: 'resources', campuses: ['goa'] });
  await expect.poll(() => links(b.page).count(), { timeout: WITHIN, message: 'B sees the new link without navigating' }).toBe(before + 1);
  owner.close();
  await b.context.close();
});

test('appointing B shows Controls on B\'s open Settings, revoking removes it, no sign-out', async ({ browser }) => {
  const b = await openAs(browser, 'student_full', '/settings', (p) => p.getByText('Discipline').first());
  await expect(b.page.getByText('Controls', { exact: true })).toHaveCount(0);
  const owner = await ownerSocket();
  const id = `course|goa|EEE F313|${email('student_full')}`;
  await putDoc(`grants/${id}`, grant('course', 'goa', 'EEE F313', 'student_full', 'Test Student'));
  await bumpHeads(['goa'], 'grants');
  owner.send({ t: 'pokeUser', email: email('student_full') });
  owner.send({ t: 'poke', path: 'grants', campuses: ['goa'] });
  await expect(b.page.getByText('Controls', { exact: true }), 'role appears live').toBeVisible({ timeout: WITHIN });
  await putDoc(`grants/${id}`, { ...grant('course', 'goa', 'EEE F313', 'student_full', 'Test Student'), active: { booleanValue: false } });
  await bumpHeads(['goa'], 'grants');
  owner.send({ t: 'pokeUser', email: email('student_full') });
  await expect(b.page.getByText('Controls', { exact: true }), 'revocation is live').toHaveCount(0, { timeout: WITHIN });
  owner.close();
  await b.context.close();
});

test('an owner on Goa view appoints a Hyderabad student; an admin bump reaches every campus', async ({ browser }) => {
  const b = await openAs(browser, 'student_hyd', '/settings', (p) => p.getByText('Discipline').first());
  await expect(b.page.getByText('Controls', { exact: true })).toHaveCount(0);
  const owner = await ownerSocket(); // the owner's app is on the Goa hub
  await putDoc(`grants/course|hyderabad|EEE F313|${email('student_hyd')}`, grant('course', 'hyderabad', 'EEE F313', 'student_hyd', 'Student Hyd'));
  await bumpHeads(['hyderabad'], 'grants');
  owner.send({ t: 'pokeUser', email: email('student_hyd') });
  owner.send({ t: 'poke', path: 'grants', campuses: ['hyderabad'] });
  await expect(b.page.getByText('Controls', { exact: true }), 'cross-campus appointment is live').toBeVisible({ timeout: WITHIN });
  owner.close();
  await b.context.close();
});
