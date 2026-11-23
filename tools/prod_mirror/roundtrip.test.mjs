// Emulator round trip: fixture -> anonymise -> load (CLI) -> read back through
// the real firestore.rules as the mirrored people, and export it again.
// Needs the emulators; run by `npm run test:emulator` (skipped otherwise).
//   cd tools/prod_mirror && npm run test:emulator
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc } from 'firebase/firestore';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { wipeProject } from './load.mjs';
import { anonymise, leakCheck, shiftToNowSeconds } from './anonymise.mjs';
import { PEOPLE, buildFixture } from './fixtures/build.mjs';
import { readAuth, readDocs, writeDocs } from './lib.mjs';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = path.dirname(new URL(import.meta.url).pathname);
const P = Object.fromEntries(PEOPLE.map((p) => [p.key, p]));

const why = async (l, f) => { try { return await f(); } catch (e) { e.message = `step ${l}: ${e.message}`; throw e; } };

describe('prod mirror round trip', { skip: !host && 'needs the emulators (npm run test:emulator)' }, () => {
  let env, dir, anon;
  const as = (key) => {
    const email = anon.maps.email.get(P[key].email), uid = anon.maps.uid.get(P[key].uid);
    return env.authenticatedContext(uid, { email, email_verified: true, name: 'x' }).firestore();
  };
  const ids = (key) => ({ email: anon.maps.email.get(P[key].email), uid: anon.maps.uid.get(P[key].uid) });

  before(async () => {
    const f = buildFixture();
    anon = anonymise(f.docs, f.auth, { salt: 'round-trip-salt-0123456789', shiftSeconds: shiftToNowSeconds(f.docs) });
    assert.deepEqual(leakCheck(anon.docs, anon.auth, anon.registry, anon.fakes), []);
    dir = mkdtempSync(path.join(os.tmpdir(), 'mirror-rt-'));
    writeDocs(dir, anon.docs, anon.auth);
    const out = execFileSync('node', [path.join(here, 'load.mjs'), '--in', dir, '--target', 'emulator'], { encoding: 'utf8' });
    assert.match(out, new RegExp(`Wrote ${anon.docs.length} documents`));
    assert.match(out, /\?as=mirror_owner/);
    const [h, p] = host.split(':');
    env = await initializeTestEnvironment({ projectId: 'demo-pointer', firestore: { host: h, port: Number(p) } });
  });
  after(async () => { await env?.cleanup(); });

  test('every document arrived, with its types', async () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'mirror-exp-'));
    execFileSync('node', [path.join(here, 'export.mjs'), '--project', 'demo-pointer', '--out', out], { encoding: 'utf8' });
    const got = new Map(readDocs(out).map((d) => [d.path, JSON.stringify(d.data, Object.keys(d.data).sort())]));
    const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
    const gotC = new Map(readDocs(out).map((d) => [d.path, canon(d.data)]));
    assert.equal(gotC.size, anon.docs.length);
    for (const d of anon.docs) assert.equal(gotC.get(d.path), canon(d.data), d.path);
    assert.ok(got.size > 0);
    // the auth emulator list came along
    assert.ok(readAuth(out).length >= 1);
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.complete, true);
    // each doc once, plus the few the probe for unlisted subcollections reads
    assert.ok(manifest.reads >= anon.docs.length && manifest.reads <= anon.docs.length + 3 * 40, manifest.reads);
  });

  test('--max-reads stops cleanly and --resume finishes', () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'mirror-exp2-'));
    const run = (...a) => execFileSync('node', [path.join(here, 'export.mjs'), '--project', 'demo-pointer', '--out', out, '--no-auth', ...a], { encoding: 'utf8' });
    const first = run('--max-reads', '30');
    assert.match(first, /Not complete/);
    assert.ok(readDocs(out).length <= 30);
    run('--resume');
    assert.equal(readDocs(out).length, anon.docs.length);
  });

  test('a mirrored student reads their own data through the rules', async () => {
    const { uid } = ids('student');
    const db = as('student');
    await assertSucceeds(getDoc(doc(db, 'users', uid)));
    await assertFails(getDoc(doc(db, 'users', ids('dual').uid)));
    await assertSucceeds(getDoc(doc(db, 'heads', 'hyderabad')));
    await assertSucceeds(getDoc(doc(db, 'reviewIndex', 'hyderabad')));
    // their review sits under sha256(uid + course): the app finds it by that id
    const mine = await assertSucceeds(getDoc(doc(db, 'reviews', 'EEE F311', 'entries', sha(uid + 'EEE F311'))));
    assert.equal(mine.data().stars, 5);
    const mirror = (await getDoc(doc(db, 'reviews', 'EEE F311', 'campus', 'hyderabad'))).data();
    assert.ok(sha(uid + 'EEE F311') in mirror.r);
  });

  test('roles read as the app reads them', async () => {
    const pres = ids('president');
    const db = as('president');
    const g = await why('3', () => assertSucceeds(getDoc(doc(db, 'grants', `dept|goa|ELEC|${pres.email}`))));
    assert.equal(g.data().active, true);
    await why('5', () => assertSucceeds(getDoc(doc(db, 'staffContacts', pres.email))));
    const rep = (await assertSucceeds(getDoc(doc(db, 'repIndex', 'goa')))).data();
    assert.ok(pres.email in rep.p && ids('cr').email in rep.p);
    await why('8', () => assertFails(getDoc(doc(as('student'), 'staffContacts', pres.email))));
    await why('9', () => assertSucceeds(getDoc(doc(as('owner'), 'owners', ids('owner').email))));
    await why('10', () => assertSucceeds(getDoc(doc(as('admin'), 'owners', ids('admin').email))));
    await why('11', () => assertSucceeds(getDoc(doc(as('contributor'), 'contributors', ids('contributor').email))));
    await why('12', () => assertFails(getDoc(doc(as('student'), 'contributors', ids('contributor').email))));
  });

  test('a capped wipe deletes in steps and a second run finishes it (last: it empties the emulator)', async () => {
    initializeApp({ projectId: 'demo-pointer' });
    const db = getFirestore();
    const first = await wipeProject(db, { cap: 30, log: () => {} });
    assert.ok(first >= 30 && first < anon.docs.length, `deleted ${first}`);
    let left = 0;
    for (const c of await db.listCollections()) left += (await c.limit(1).get()).size + (await c.listDocuments()).length;
    assert.ok(left > 0);
    while ((await wipeProject(db, { cap: 100000, log: () => {} })) > 0);
    assert.equal((await db.listCollections()).length, 0);
  });
});
