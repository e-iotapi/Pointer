import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { anonymise, shiftToNowSeconds } from './anonymise.mjs';
import { buildFixture } from './fixtures/build.mjs';
import { grantsOf, loadOrder, pickIdentities, resolveTarget, selectSample, writeDocs } from './load.mjs';
import { assertSafeDir, collectionsFromRules, decode, encode } from './lib.mjs';

const mirror = () => {
  const f = buildFixture();
  return anonymise(f.docs, f.auth, { salt: 'load-test-salt-0123456789', shiftSeconds: shiftToNowSeconds(f.docs) });
};

test('typed values survive encode/decode', async () => {
  const { Timestamp, GeoPoint } = await import('firebase-admin/firestore');
  const v = { t: Timestamp.fromMillis(1_700_000_000_123), g: new GeoPoint(1, 2), b: Buffer.from('hi'), n: [1, { x: null }], __t: 'user data', 'a.b@c.d': 1 };
  const j = encode(v);
  assert.equal(j.__t, 'map'); // a user key called __t cannot be mistaken for a type tag
  const back = decode(JSON.parse(JSON.stringify(j)), { Timestamp, GeoPoint });
  assert.equal(back.t.toMillis(), 1_700_000_000_123);
  assert.equal(back.g.latitude, 1);
  assert.equal(back.b.toString(), 'hi');
  assert.equal(back.__t, 'user data');
  assert.equal(back['a.b@c.d'], 1);
});

test('collections come from the rules and include the subcollections', () => {
  const { top, sub } = collectionsFromRules();
  for (const c of ['users', 'grants', 'reviews', 'repIndex', 'heads', 'resourceVersions', 'roles']) assert.ok(top.includes(c), c);
  for (const c of ['entries', 'offerings', 'votes', 'reports', 'stats', 'campus']) assert.ok(sub.includes(c), c);
  assert.ok(!top.includes('reports')); // read by collection group with its namesake
});

test('real data may not be written inside the repo', () => {
  assert.throws(() => assertSafeDir(path.join(process.cwd(), 'out'), 'x'), /inside the repository/);
  assert.doesNotThrow(() => assertSafeDir(os.tmpdir(), 'x'));
  assert.doesNotThrow(() => assertSafeDir(path.resolve(import.meta.dirname, '../../sensitive_data_NO_COMMIT/mirror/anon'), 'x'));
});

test('staging is refused unless every safeguard holds; production never', () => {
  const key = (project_id) => { const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'k-')), 'k.json'); writeFileSync(f, JSON.stringify({ project_id })); return f; };
  assert.throws(() => resolveTarget('production'), /emulator or staging/);
  assert.throws(() => resolveTarget('staging', {}), /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.throws(() => resolveTarget('staging', { GOOGLE_APPLICATION_CREDENTIALS: key('cgpa-calculator-fb90c'), STAGING_PASSWORD: 'x' }), /not staging/);
  assert.throws(() => resolveTarget('staging', { GOOGLE_APPLICATION_CREDENTIALS: key('pointer-staging'), FIRESTORE_EMULATOR_HOST: 'localhost:8085' }), /unset it/);
  assert.equal(resolveTarget('staging', { GOOGLE_APPLICATION_CREDENTIALS: key('pointer-staging'), STAGING_PASSWORD: 'x' }).project, 'pointer-staging');
  assert.equal(resolveTarget('emulator', {}).project, 'demo-pointer');
  assert.throws(() => resolveTarget('emulator', {}, 'cgpa-calculator-fb90c'), /demo-/); // --project: emulator projects only
});

test('the writer stops at the daily cap and resumes where it stopped', async () => {
  const written = [];
  const db = { doc: (p) => p, batch: () => { const ops = []; return { set: (p) => ops.push(p), commit: async () => { written.push(...ops); } }; } };
  const docs = Array.from({ length: 1000 }, (_, i) => ({ path: `c/d${i}`, data: { n: i } }));
  const a = await writeDocs(db, docs, { start: 0, cap: 650 });
  assert.deepEqual([a.next, a.written, written.length], [650, 650, 650]);
  const b = await writeDocs(db, docs, { start: a.next, cap: 650 });
  assert.deepEqual([b.next, b.written], [1000, 350]);
  assert.deepEqual(written.map((p) => p), docs.map((d) => d.path)); // each once, in order
});

test('markers load last so a client never sees a marker ahead of its data', () => {
  const order = loadOrder(mirror().docs).map((d) => d.path);
  const firstHead = order.findIndex((p) => p.startsWith('heads/'));
  assert.ok(order.slice(firstHead).every((p) => p.startsWith('heads/') || p === 'catalog/marker' || p.endsWith('|current')));
});

test('identities: one of each role, with the uid the export linked to the email', () => {
  const m = mirror();
  const picks = pickIdentities(m.docs, m.auth);
  const by = Object.fromEntries(picks.map((p) => [p.key, p]));
  for (const k of ['owner', 'admin', 'president', 'secretary', 'cr', 'contributor', 'expired', 'student_hyderabad']) assert.ok(by[`mirror_${k}`], k);
  assert.equal(by.mirror_president.uid, m.auth.find((u) => u.email === by.mirror_president.email).uid);
  assert.equal(new Set(picks.map((p) => p.email)).size, picks.length);
  const grants = grantsOf(m.docs);
  assert.ok(grants.find((g) => g.email === by.mirror_secretary.email).secretary);
  assert.ok(!grants.find((g) => g.email === by.mirror_expired.email).live);
});

test('a sample keeps one of every kind and leaves no dangling reference', () => {
  const m = mirror();
  const s = selectSample(m.docs, m.auth, 1);
  const paths = new Set(s.map((d) => d.path));
  assert.ok(s.length < m.docs.length || m.docs.length < 90);
  const kinds = (docs) => new Set(docs.filter((d) => d.path.startsWith('grants/')).map((d) => `${d.data.role}|${d.data.campus}|${d.data.active}|${d.data.secretary ?? false}`));
  assert.deepEqual(kinds(s), kinds(m.docs)); // roles, states and secretaries all there
  for (const d of s) {
    if (d.path.startsWith('staff/') || d.path.startsWith('directory/')) {
      const e = d.path.split('/')[1];
      assert.ok([...paths].some((p) => p.startsWith('grants/') && p.endsWith(`|${e}`)) || [...paths].some((p) => p.startsWith('owners/')), e);
    }
    if (d.data?.auditId && m.docs.some((x) => x.path === `audit/${d.data.auditId}`)) assert.ok(paths.has(`audit/${d.data.auditId}`), d.path); // every auditId resolves
    if (d.path.startsWith('users/')) assert.ok(m.auth.some((u) => u.uid === d.path.slice(6)));
  }
  // repIndex only lists people who are kept
  const rep = s.find((d) => d.path === 'repIndex/goa').data.p;
  for (const e of Object.keys(rep)) assert.ok(paths.has(`people/${e}`) || paths.has(`staff/${e}`), e);
  // hidden/reported/voted reviews (edge cases) survive with their votes
  assert.ok([...paths].some((p) => p.includes('/votes/')));
  assert.ok(![...paths].some((p) => p.startsWith('signInLog/') || p.startsWith('reports/')));
});


test('--skip-same-as leaves out what was already loaded unchanged', async () => {
  const { execFileSync } = await import('node:child_process');
  const m = mirror();
  const a = mkdtempSync(path.join(os.tmpdir(), 'skip-a-')), b = mkdtempSync(path.join(os.tmpdir(), 'skip-b-'));
  const { writeDocs: wd } = await import('./lib.mjs');
  wd(a, m.docs, m.auth);
  const changed = structuredClone(m.docs);
  changed[0].data = { ...changed[0].data, touched: 1 };
  wd(b, [...changed, { path: 'extra/doc', data: { x: 1 } }], m.auth);
  // no emulator here: --dry stops after the plan
  const out = execFileSync('node', [path.join(import.meta.dirname, 'load.mjs'), '--in', b, '--skip-same-as', a, '--dry'], { encoding: 'utf8' });
  assert.match(out, /2 documents/);
});
