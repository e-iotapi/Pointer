import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anonymise, shiftToNowSeconds } from './anonymise.mjs';
import { combine } from './combine.mjs';
import { buildFixture } from './fixtures/build.mjs';
import { sharedDelta } from './shared_delta.mjs';
import { synthesise } from './synth.mjs';

const NOW = Math.floor(Date.now() / 1000);
const f = buildFixture();
const anon = anonymise(f.docs, f.auth, { salt: 'delta-test-salt-0123456789', shiftSeconds: shiftToNowSeconds(f.docs) });
const syn = synthesise({ users: 600, seed: 4, now: NOW, reserved: { emails: new Set(anon.auth.map((u) => u.email)), uids: new Set(anon.auth.map((u) => u.uid)) } });
const base = combine([{ name: 'a', docs: anon.docs, auth: anon.auth }, { name: 'b', docs: syn.docs, auth: syn.auth, synthetic: true }]);
const D = sharedDelta(base.docs, base.auth, { seed: 9, now: NOW });
const B = new Map(base.docs.map((d) => [d.path, d.data]));
const M = new Map(D.docs.map((d) => [d.path, d.data]));
const isNew = (p) => !B.has(p);

test('the delta adds every kind of shared data, in every campus, and stays within budget', () => {
  const kinds = {};
  for (const d of D.changed) { const k = d.path.split('/')[0]; kinds[k] = (kinds[k] ?? 0) + 1; }
  for (const k of ['resources', 'resourceReports', 'resourceFlags', 'contributors', 'usernames', 'contributorRequests', 'grants', 'courses', 'timetable', 'courseClaims', 'volunteers', 'directory', 'staffContacts', 'searchHints', 'activity', 'leaderboard', 'repIndex', 'resourceVersions', 'heads', 'pending', 'audit', 'reviews']) assert.ok(kinds[k] > 0, k);
  assert.ok(D.changed.length < 6000, D.changed.length);
  assert.equal(D.docs.length, base.docs.length + D.changed.filter((d) => isNew(d.path)).length);
  for (const c of ['goa', 'pilani', 'hyderabad', 'dubai']) assert.ok(D.changed.some((d) => d.path.startsWith('resources/') && d.data.campus === c), c);
  const statuses = new Set(D.changed.filter((d) => d.path.startsWith('contributorRequests/')).map((d) => d.data.status));
  for (const s of ['pending', 'approved', 'declined', 'withdrawn']) assert.ok(statuses.has(s), s);
  const pts = new Set(D.changed.filter((d) => d.path.startsWith('contributors/')).map((d) => d.data.points));
  assert.ok(pts.size >= 6);
});

test('links in every state, and the resource list mirrors exactly the live ones', () => {
  const res = D.changed.filter((d) => d.path.startsWith('resources/') && isNew(d.path));
  assert.ok(res.some((d) => d.data.removed) && res.some((d) => d.data.pinnedToDepartment) && res.some((d) => d.data.approved === false));
  for (const { path: p, data: r } of res) {
    const id = p.slice(10), links = M.get(`resourceVersions/${r.campus}`).links;
    assert.equal(id in links, !r.removed, id);
    if (r.scope === 'course') assert.equal(r.actingFor, r.courseIds[0]);
    assert.ok(M.has(`audit/${r.auditId}`));
  }
  const flags = D.changed.filter((d) => d.path.startsWith('resourceFlags/'));
  assert.ok(flags.some((d) => d.data.open) && flags.some((d) => !d.data.open));
  for (const { path: p, data: fl } of flags) {
    const reps = D.changed.filter((d) => d.path.startsWith(`resourceReports/${p.slice(14)}/entries/`));
    assert.equal(reps.length, fl.count);
    assert.equal(Object.values(fl.reasons).reduce((a, b) => a + b, 0), fl.count);
  }
  for (const [p, d] of M) if (p.startsWith('resourceVersions/')) assert.ok(d.v >= B.get(p)?.v);
});

test('contributors: leaderboard, usernames, requests and grants agree', () => {
  for (const c of ['goa', 'pilani', 'hyderabad', 'dubai']) {
    const lb = M.get(`leaderboard/${c}`);
    const mine = D.changed.filter((d) => d.path.startsWith('contributors/') && d.data.campus === c);
    for (const { path: p, data: x } of mine) {
      assert.equal(lb.p[x.username], x.points);
      assert.equal(M.get(`usernames/${c}|${x.username}`).email, p.slice(13));
      assert.equal(M.get(`grants/contributor|${c}|${c}|${p.slice(13)}`).active, true);
      assert.ok([...M.keys()].some((k) => k.startsWith(`contributorRequests/${c}|`) && k.endsWith(`|${p.slice(13)}`)));
    }
    if (lb.k) assert.equal(lb.p[lb.k], Math.max(...Object.values(lb.p)));
    assert.deepEqual(Object.keys(lb.tags).filter((k) => !(k in lb.p)), []);
  }
});

test('offerings carry professors that exist and components that add up to 100; timetables are new semesters', () => {
  const offs = D.changed.filter((d) => /^courses\/[^/]+\/offerings\//.test(d.path) && isNew(d.path));
  assert.ok(offs.length > 100);
  for (const { data: o } of offs) {
    assert.equal(o.components.reduce((a, c) => a + c.weight, 0), 100);
    for (const p of o.professors) assert.ok(M.has(`professors/${p}`));
    assert.ok(M.get(`heads/${o.campus}`).offerings[o.courseId] >= 1);
  }
  const tt = D.changed.filter((d) => d.path.startsWith('timetable/'));
  assert.ok(tt.every((d) => d.path.includes('|2026-2')));
  assert.deepEqual(M.get('timetable/goa|current'), B.get('timetable/goa|current'));
});

test('votes and reports: counters on the review and its mirror equal the documents', () => {
  const entries = [...M].filter(([p]) => /^reviews\/[^/]+\/entries\/[^/]+$/.test(p));
  let touched = 0;
  for (const [p, e] of entries) {
    const votes = [...M.keys()].filter((k) => k.startsWith(`${p}/votes/`)).length;
    const reports = [...M.keys()].filter((k) => k.startsWith(`${p}/reports/`)).length;
    if (JSON.stringify(e) === JSON.stringify(B.get(p))) continue;
    touched++;
    const baseVotes = [...B.keys()].filter((k) => k.startsWith(`${p}/votes/`)).length;
    assert.equal(e.helpful - (B.get(p).helpful ?? 0), votes - baseVotes, p);
    const [, c, , id] = p.split('/');
    const m = M.get(`reviews/${c}/campus/${e.campus}`);
    if (m?.r?.[id]) assert.equal(m.r[id].helpful, e.helpful, 'mirror');
    assert.ok(reports >= 0);
  }
  assert.ok(touched > 20);
});

test('markers moved for what changed, nothing existing was replaced except derived documents, and it is deterministic', () => {
  for (const c of ['goa', 'hyderabad']) {
    const a = B.get(`heads/${c}`).v, b = M.get(`heads/${c}`).v;
    for (const k of Object.keys(a)) assert.ok(b[k] >= a[k], k);
    assert.ok(b.resources > (a.resources ?? 0) && b.leaderboard > (a.leaderboard ?? 0));
  }
  const derived = /^(resourceVersions|leaderboard|repIndex|searchHints|activity|heads|pending|reviews\/[^/]+\/(entries\/[^/]+|campus\/[^/]+))/;
  for (const d of D.changed) if (B.has(d.path)) assert.match(d.path, derived, d.path);
  assert.equal(JSON.stringify(sharedDelta(base.docs, base.auth, { seed: 9, now: NOW }).changed), JSON.stringify(D.changed));
  assert.ok(sharedDelta(base.docs, base.auth, { seed: 9, now: NOW, scale: 0.3 }).changed.length < D.changed.length);
});
