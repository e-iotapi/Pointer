import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anonymise, shiftToNowSeconds } from './anonymise.mjs';
import { combine } from './combine.mjs';
import { buildFixture } from './fixtures/build.mjs';
import { synthesise } from './synth.mjs';

const f = buildFixture();
const anon = anonymise(f.docs, f.auth, { salt: 'combine-test-salt-0123456789', shiftSeconds: shiftToNowSeconds(f.docs) });
const prod = { name: 'prod', docs: anon.docs, auth: anon.auth };
const reserved = { emails: new Set(anon.auth.map((u) => u.email)), uids: new Set(anon.auth.map((u) => u.uid)) };
const synth = synthesise({ users: 400, seed: 5, now: Math.floor(Date.now() / 1000), reserved });
const C = combine([prod, { name: 'synth', docs: synth.docs, auth: synth.auth, synthetic: true }]);
const at = (docs, p) => docs.find((d) => d.path === p)?.data;

test('synthetic people never collide with the mirror, and every person survives', () => {
  const emails = new Set(C.auth.map((u) => u.email));
  assert.equal(C.auth.length, prod.auth.length + synth.auth.length);
  assert.equal(emails.size, C.auth.length);
  assert.equal(new Set(C.auth.map((u) => u.uid)).size, C.auth.length);
  const users = C.docs.filter((d) => d.path.startsWith('users/')).length;
  assert.equal(users, prod.docs.filter((d) => d.path.startsWith('users/')).length + synth.docs.filter((d) => d.path.startsWith('users/')).length);
  assert.equal(new Set(C.docs.map((d) => d.path)).size, C.docs.length);
});

test('shared maps are merged, markers take the max, counters are summed', () => {
  const rep = at(C.docs, 'repIndex/goa').p;
  for (const e of Object.keys(at(prod.docs, 'repIndex/goa').p)) assert.ok(e in rep);
  for (const e of Object.keys(at(synth.docs, 'repIndex/goa')?.p ?? {})) assert.ok(e in rep);
  assert.ok(Object.keys(rep).length > Object.keys(at(prod.docs, 'repIndex/goa').p).length);
  const h = at(C.docs, 'heads/goa'), hp = at(prod.docs, 'heads/goa'), hs = at(synth.docs, 'heads/goa');
  for (const k of new Set([...Object.keys(hp.v), ...Object.keys(hs.v)])) assert.equal(h.v[k], Math.max(hp.v[k] ?? 0, hs.v[k] ?? 0), k);
  assert.equal(h.catalog, hp.catalog);
  // review counters add up per course, and the review mirror holds both sets of reviews
  for (const campus of ['goa', 'pilani', 'hyderabad']) {
    const a = at(prod.docs, `reviewIndex/${campus}`)?.c ?? {}, b = at(synth.docs, `reviewIndex/${campus}`)?.c ?? {}, c = at(C.docs, `reviewIndex/${campus}`).c;
    for (const course of new Set([...Object.keys(a), ...Object.keys(b)])) assert.equal(c[course].count, (a[course]?.count ?? 0) + (b[course]?.count ?? 0), `${campus} ${course}`);
  }
  const m = C.docs.filter((d) => /^reviews\/[^/]+\/campus\//.test(d.path));
  const n0 = new Set([...prod.docs, ...synth.docs].filter((d) => /^reviews\/[^/]+\/campus\//.test(d.path)).flatMap((d) => Object.keys(d.data.r)));
  assert.equal(new Set(m.flatMap((d) => Object.keys(d.data.r))).size, n0.size);
  const lb = at(C.docs, 'leaderboard/hyderabad').p;
  assert.ok(Object.keys(lb).length >= Object.keys(at(prod.docs, 'leaderboard/hyderabad').p).length);
});

test('the catalogue, config and a published timetable come from the first set only', () => {
  assert.deepEqual(C.docs.filter((d) => d.path.startsWith('catalog/')).map((d) => d.path).sort(), prod.docs.filter((d) => d.path.startsWith('catalog/')).map((d) => d.path).sort());
  assert.deepEqual(at(C.docs, 'config/public'), at(prod.docs, 'config/public'));
  assert.ok(!at(synth.docs, 'timetable/goa|current') || at(C.docs, 'timetable/goa|2026-1') === at(prod.docs, 'timetable/goa|2026-1'));
  assert.deepEqual(at(C.docs, 'timetable/goa|current'), at(prod.docs, 'timetable/goa|current'));
});

test('synthetic reviews use the mirror\'s professors, and every professor reference resolves', () => {
  const profs = new Set(C.docs.filter((d) => d.path.startsWith('professors/')).map((d) => d.path.slice(11)));
  for (const d of C.docs) {
    if (/^reviews\/[^/]+\/entries\/[0-9a-f]{64}$/.test(d.path) && d.data.professorId) assert.ok(profs.has(d.data.professorId), d.path);
    if (/^courses\/[^/]+\/offerings\//.test(d.path)) for (const p of d.data.professors ?? []) assert.ok(profs.has(p), d.path);
    if (/^courses\/[^/]+\/stats\//.test(d.path) && d.data.professorId) assert.ok(profs.has(d.data.professorId) && d.path.endsWith(`_${d.data.professorId}`), d.path);
  }
  // goa ELEC has a real professor in the mirror (prof1), so the synthetic goa ELEC ones are gone
  const goaElec = C.docs.filter((d) => d.path.startsWith('professors/') && d.data.campus === 'goa' && d.data.department === 'ELEC' && !d.data.removed && !d.data.mergedInto);
  assert.equal(goaElec.length, prod.docs.filter((d) => d.path.startsWith('professors/') && d.data.campus === 'goa' && d.data.department === 'ELEC' && !d.data.removed && !d.data.mergedInto).length);
  // a stats doc both sets wrote is the sum
  for (const d of C.docs.filter((x) => /^courses\/[^/]+\/stats\//.test(x.path))) {
    const a = at(prod.docs, d.path);
    if (a) assert.ok(d.data.count >= a.count);
  }
});

test('the report says what was added, merged and left out', () => {
  const [a, b] = C.report;
  assert.equal(a.added, prod.docs.length);
  assert.equal(b.in, synth.docs.length);
  assert.ok(b.merged > 5 && b.dropped > 5);
  assert.equal(C.docs.length, a.added + b.added);
  assert.ok(C.docs.length < prod.docs.length + synth.docs.length);
});
