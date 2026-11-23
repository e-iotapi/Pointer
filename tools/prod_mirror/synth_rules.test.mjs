// The synthetic dataset, loaded by load.mjs into the emulator, read and
// written back through the real firestore.rules as the people in it.
// Run with the emulators: cd tools/prod_mirror && npm run test:emulator
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { writeDocs } from './lib.mjs';
import { synthesise } from './synth.mjs';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const here = path.dirname(new URL(import.meta.url).pathname);

describe('synthetic mirror through the rules', { skip: !host && 'needs the emulators (npm run test:emulator)' }, () => {
  let env, R, out;
  const as = (p) => env.authenticatedContext(p.uid, { email: p.email, email_verified: true, name: p.name }).firestore();
  const rep = (kind, state, campus = 'goa') => R.people.find((p) => p.kind === kind && p.state === state && p.campus === campus);

  before(async () => {
    R = synthesise({ users: 400, seed: 3, now: Math.floor(Date.now() / 1000) });
    out = mkdtempSync(path.join(os.tmpdir(), 'synth-rt-'));
    writeDocs(out, R.docs, R.auth);
    const log = execFileSync('node', [path.join(here, 'load.mjs'), '--in', out], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.match(log, new RegExp(`Wrote ${R.docs.length} documents`));
    assert.match(log, /\?as=mirror_owner/);
    const [h, p] = host.split(':');
    env = await initializeTestEnvironment({ projectId: 'demo-pointer', firestore: { host: h, port: Number(p) } });
  });
  after(async () => { await env?.cleanup(); });

  test('everyone with a student address reads their campus and their own data', async () => {
    for (const [kind, state] of [['student', 'none'], ['cr', 'live'], ['president', 'live'], ['admin', 'live'], ['custom', 'live'], ['contributor', 'live'], ['president', 'expired'], ['cr', 'revoked']]) {
      const p = kind === 'student' ? R.people.find((x) => x.kind === 'student' && x.campus === 'goa' && x.activity === 'marks' && !x.tags.length) : rep(kind, state);
      assert.ok(p, `${kind} ${state}`);
      const db = as(p);
      await assertSucceeds(getDoc(doc(db, 'heads', 'goa')));
      await assertSucceeds(getDoc(doc(db, 'users', p.uid)));
      if (!['admin', 'custom'].includes(kind)) await assertFails(getDoc(doc(db, 'heads', 'hyderabad'))).catch((e) => { e.message = `${kind} ${state}: ${e.message}`; throw e; }); // admins and wide custom roles cross campuses
      await assertFails(getDoc(doc(db, 'users', R.people.find((x) => x !== p && !x.refused && x.activity === 'cgpa').uid)));
    }
  });

  test('live and expiring staff are privileged, lapsed and revoked ones are not', async () => {
    for (const kind of ['president', 'cr', 'secretary', 'admin']) {
      for (const state of ['live', 'expiring']) {
        const p = rep(kind, state);
        await assertSucceeds(getDoc(doc(as(p), 'staffContacts', p.email)));
        await assertSucceeds(getDoc(doc(as(p), 'staff', p.email)));
      }
      for (const state of ['expired', 'revoked']) {
        const p = rep(kind, state);
        await assertFails(getDoc(doc(as(p), 'staffContacts', p.email)));
      }
    }
    const handed = rep('president', 'handedOver');
    await assertSucceeds(getDoc(doc(as(handed), 'staffContacts', handed.email))); // still a president until the grant ends
  });

  test('a president reads the directory of their campus; the grant they were given is theirs to read', async () => {
    const p = rep('president', 'live');
    const g = p.grants[0];
    await assertSucceeds(getDoc(doc(as(p), 'grants', g.id)));
    await assertSucceeds(getDoc(doc(as(p), 'repIndex', 'goa')));
    await assertSucceeds(getDoc(doc(as(p), 'directory', p.email)));
    await assertFails(getDoc(doc(as(p), 'directory', rep('president', 'live', 'hyderabad').email)));
  });

  test('refused addresses read nothing', async () => {
    for (const p of R.people.filter((x) => x.refused && x.campus === 'goa')) {
      await assertFails(getDoc(doc(as(p), 'heads', 'goa')));
      await assertFails(getDoc(doc(as(p), 'reviewIndex', 'goa')));
    }
  });

  test('a review reads back under its author\'s id, and the contributor docs read as the app reads them', async () => {
    const e = R.docs.find((d) => /^reviews\/[^/]+\/entries\//.test(d.path) && d.data.campus === 'goa' && !d.data.hidden && !d.path.includes('/votes/') && !d.path.includes('/reports/'));
    const c = e.data.courseId;
    const author = R.people.find((p) => !p.refused && sha(p.uid + c) === e.path.split('/')[3]);
    assert.ok(author);
    await assertSucceeds(getDoc(doc(as(author), 'reviews', c, 'entries', e.path.split('/')[3])));
    await assertSucceeds(getDoc(doc(as(author), 'reviews', c, 'campus', 'goa')));
    const cp = rep('contributor', 'live');
    await assertSucceeds(getDoc(doc(as(cp), 'contributors', cp.email)));
    await assertFails(getDoc(doc(as(author), 'contributors', cp.email)));
  });

  test('a student can push their sync doc: the shape is what the app writes', async () => {
    const p = R.people.find((x) => x.kind === 'student' && x.campus === 'goa' && x.activity === 'cgpa');
    const db = as(p);
    const cur = (await getDoc(doc(db, 'users', p.uid))).data();
    await assertSucceeds(setDoc(doc(db, 'users', p.uid), { rev: cur.rev + 1, uid: p.uid, data: cur.data, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db, 'users', p.uid), { rev: cur.rev + 5, uid: p.uid, data: cur.data, updatedAt: serverTimestamp() }));
  });
});
