// End to end, in a real browser: user B has the app open and idle; something happens elsewhere (another user
// writes shared data, or appoints/revokes B); B's open screen must change without navigation or sign-out.
// The "other user" is a script: it writes Firestore (emulator owner bypass) and sends the frames the app sends
// after such a write (poke with its campuses, pokeUser), so the receiving side is the app under test.
// Local only: the writes need rules bypass; staging runs the frame-level specs.
import { test, expect } from '@playwright/test';
import { LOCAL, CFG, openLive, idToken, bumpHeads, putDoc, increment, commit, docName, openAs, email, str, sleep } from '../lib.mjs';

test.skip(!LOCAL, 'UI-level checks need rules-bypass writes (local emulators only)');

// "Instantly": roles arrive in about a second (pokeUser). Shared data arrives 1.5 s after a poke, or up to 20 s when
// that campus's hub read a head a moment ago (its read gap, which protects the Spark quota); 30 s covers both.
const WITHIN = 30_000;

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
  // Written as the app's own add does: the link goes in the campus's version doc, which the list is read from.
  const id = `live${Date.now()}`;
  await commit([
    {
      update: {
        name: docName('resourceVersions/goa'),
        fields: { links: { mapValue: { fields: { [id]: { mapValue: { fields: {
          title: str(title), url: str(`https://example.com/${id}`), host: str('example.com'), kind: str('link'),
          department: str('ELEC'), scope: str('department'), courseIds: { arrayValue: {} }, pinnedToDepartment: { booleanValue: true },
          addedBy: { mapValue: { fields: { email: str(email('owner')), name: str('Test Owner') } } }, addedAt: { integerValue: String(Date.now()) },
        } } } } } } },
      },
      updateMask: { fieldPaths: [`links.${id}`] },
    },
  ]);
  await increment('resourceVersions/goa', 'v'); // the list the screen reads is versioned here
  await bumpHeads(['goa'], 'resources');
  const owner = await ownerSocket();
  owner.send({ t: 'poke', path: 'resources', campuses: ['goa'] });
  await expect.poll(() => links(b.page).count(), { timeout: WITHIN, message: 'B sees the new link without navigating' }).toBe(before + 1);
  owner.close();
  await b.context.close();
});

test('appointing B shows Controls on B\'s open Settings, revoking removes it, no sign-out', async ({ browser }) => {
  const b = await openAs(browser, 'student_full', '/settings', (p) => p.getByText('Discipline').first());
  await expect(b.page.locator('body')).not.toContainText('Controls Admin');
  const owner = await ownerSocket();
  const ALL = ['goa', 'hyderabad', 'pilani', 'dubai'];
  const id = `admin|all|all|${email('student_full')}`;
  await putDoc(`grants/${id}`, grant('admin', 'all', 'all', 'student_full', 'Test Student'));
  await bumpHeads(ALL, 'grants'); // an admin grant moves every head
  owner.send({ t: 'pokeUser', email: email('student_full') });
  owner.send({ t: 'poke', path: 'grants', campuses: ALL });
  await expect(b.page.locator('body'), 'role appears live').toContainText('Controls Admin', { timeout: WITHIN });
  await putDoc(`grants/${id}`, { ...grant('admin', 'all', 'all', 'student_full', 'Test Student'), active: { booleanValue: false } });
  await bumpHeads(ALL, 'grants');
  await sleep(1500); // a person revoking is not inside the sender's 250 ms gap
  owner.send({ t: 'pokeUser', email: email('student_full') });
  await expect(b.page.locator('body'), 'revocation is live').not.toContainText('Controls Admin', { timeout: WITHIN });
  owner.close();
  await b.context.close();
});

test('an owner on Goa view appoints a Hyderabad student as admin; the every-campus bump reaches Hyderabad', async ({ browser }) => {
  const b = await openAs(browser, 'student_hyd', '/settings', (p) => p.getByText('Discipline').first());
  await expect(b.page.locator('body')).not.toContainText('Controls Admin');
  const owner = await ownerSocket(); // the owner's app is on the Goa hub
  await putDoc(`grants/admin|all|all|${email('student_hyd')}`, grant('admin', 'all', 'all', 'student_hyd', 'Student Hyd'));
  await bumpHeads(['goa', 'hyderabad', 'pilani', 'dubai'], 'grants');
  owner.send({ t: 'pokeUser', email: email('student_hyd') });
  owner.send({ t: 'poke', path: 'grants', campuses: ['goa', 'hyderabad', 'pilani', 'dubai'] });
  await expect(b.page.locator('body'), 'cross-campus appointment is live').toContainText('Controls Admin', { timeout: WITHIN });
  owner.close();
  await b.context.close();
});
