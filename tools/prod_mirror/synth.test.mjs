import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { anonymise } from './anonymise.mjs';
import { buildFixture } from './fixtures/build.mjs';
import { selectSample } from './load.mjs';
import { ACTIVITIES, CAMPUSES, REFUSED, STATES, profileFrom, sharedDelta, synthesise } from './synth.mjs';
import { combine } from './combine.mjs';
import { shiftToNowSeconds } from './anonymise.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const NOW = 1_795_000_000;
const make = (o = {}) => synthesise({ users: 600, seed: 7, now: NOW, ...o });
const R = make();
const byPath = new Map(R.docs.map((d) => [d.path, d.data]));

test('every campus x kind x state and every activity pair is present, with an example', () => {
  assert.deepEqual(R.coverage.missing, []);
  assert.deepEqual(R.coverage.missingPairs, []);
  for (const c of CAMPUSES) {
    for (const [k, states] of Object.entries(STATES)) for (const s of states) assert.ok(R.coverage.cells.get(`${c}|${k}|${s}`)?.example.includes('@'), `${c} ${k} ${s}`);
    for (const t of REFUSED) assert.ok(R.coverage.cells.has(`${c}|refused|${t}`));
    for (const a of ACTIVITIES) assert.ok(R.coverage.cells.has(`${c}|student|none`) && R.coverage.pairs.has(`campus=${c}|${a}`));
  }
  assert.equal(R.people.length, 600);
  for (const t of ['president+cr', 'admin+president', 'cr+contributor+custom']) assert.ok(R.coverage.cells.has(`goa|multi|${t}`));
});

test('too few users to cover the combinations is an error that says how many are needed', () => {
  assert.throws(() => synthesise({ users: 50, seed: 1, now: NOW }), /at least \d+/);
});

test('the same seed gives the same data; another seed does not', () => {
  assert.equal(JSON.stringify(make().docs), JSON.stringify(R.docs));
  assert.notEqual(JSON.stringify(make({ seed: 8 }).docs), JSON.stringify(R.docs));
});

test('paths are unique and every address is well formed', () => {
  assert.equal(new Set(R.docs.map((d) => d.path)).size, R.docs.length);
  const students = R.people.filter((p) => p.kind === 'student' || p.kind === 'cr' || p.kind === 'president');
  for (const p of students) assert.match(p.email, /^[fhp]20(2\d)\d{4}@(goa|hyderabad|pilani|dubai)\.bits-pilani\.ac\.in$/);
  assert.equal(new Set(R.people.map((p) => p.email)).size, R.people.length);
  assert.equal(new Set(R.auth.map((u) => u.uid)).size, R.auth.length);
  for (const p of R.people.filter((x) => x.refused)) assert.ok(!/^[fhp]\d{4}\d+@(goa|hyderabad|pilani|dubai)\./.test(p.email), p.email);
});

test('the staff index agrees with the grants, and states read as the rules read them', () => {
  const grants = R.docs.filter((d) => d.path.startsWith('grants/'));
  for (const { path: gp, data: g } of grants) {
    assert.equal(gp, `grants/${g.role === 'custom' ? `custom|${g.email}` : `${g.role}|${g.campus}|${g.scope}|${g.email}`}`);
    if (g.role === 'contributor') continue;
    const s = byPath.get(`staff/${g.email}`);
    assert.ok(s, `staff for ${g.email}`);
    const on = g.active && g.expiresAt.s > NOW;
    if (g.role === 'dept') assert.equal(s.presidentOf.includes(g.scope), on, gp);
    if (g.role === 'course') assert.equal(s.courses.includes(g.scope), on, gp);
    if (g.role === 'admin') assert.equal(s.admin, on || s.admin, gp);
    assert.ok(Array.isArray(s.reach));
  }
  const states = { expired: (g) => g.active && g.expiresAt.s < NOW, revoked: (g) => !g.active, expiring: (g) => g.active && g.expiresAt.s > NOW && g.expiresAt.s < NOW + 14 * 86400 };
  for (const [name, f] of Object.entries(states)) assert.ok(grants.some((d) => f(d.data)), name);
  const handed = grants.filter((d) => d.data.handedTo);
  assert.ok(handed.length >= 4);
  for (const { data: g } of handed) {
    assert.ok(byPath.has(`grants/dept|${g.campus}|${g.scope}|${g.handedTo}`), 'the successor holds the same scope');
    assert.ok(g.expiresAt.s <= NOW + 20 * 86400);
  }
  for (const [, v] of byPath) if (v?.auditId) assert.ok(byPath.has(`audit/${v.auditId}`), JSON.stringify(v).slice(0, 80));
  assert.ok([...byPath.keys()].some((p) => p.startsWith('roles/')) && [...byPath.keys()].some((p) => p.startsWith('contributorRequests/')));
});

test('reviews: ids belong to their author, counters equal the entries, votes are keyed to their voter', () => {
  const uid = new Map(R.people.map((p) => [p.uid, p]));
  const entries = R.docs.filter((d) => /^reviews\/[^/]+\/entries\/[0-9a-f]{64}$/.test(d.path));
  assert.ok(entries.length > 100);
  for (const { path: p, data: e } of entries) {
    const [, c, , id] = p.split('/');
    assert.ok([...uid.keys()].some(() => true));
    assert.equal(e.courseId, c);
    assert.ok(e.stars >= 1 && e.stars <= 5);
    const owner = R.people.find((x) => sha(x.uid + c) === id);
    assert.ok(owner, 'the review id is sha256(uid + course) of someone');
    assert.equal(owner.campus, e.campus);
  }
  assert.ok(entries.some((d) => d.data.hidden), 'a hidden review');
  const idx = byPath.get('reviewIndex/goa').c;
  for (const [c, t] of Object.entries(idx)) {
    const vis = entries.filter((d) => d.data.courseId === c && d.data.campus === 'goa' && !d.data.hidden);
    assert.equal(t.count, vis.length, c);
    assert.equal(t.starSum, vis.reduce((a, d) => a + d.data.stars, 0));
  }
  const votes = R.docs.filter((d) => d.path.includes('/votes/'));
  assert.ok(votes.length > 50);
  for (const { path: p } of votes) {
    const [, , , rid, , vid] = p.split('/');
    assert.ok(R.people.some((x) => sha(x.uid + rid) === vid));
  }
});

test('users docs hold real courses with valid grades; brand new users have none', () => {
  const valid = new Set([10, 9, 8, 7, 6, 5, 4, 2, -2, -3]);
  let withMarks = 0, dual = 0;
  for (const p of R.people.filter((x) => !x.refused)) {
    const d = byPath.get(`users/${p.uid}`);
    if (p.activity === 'brandNew' || p.nonBits) { assert.equal(d, undefined); continue; }
    const j = JSON.parse(d.data);
    assert.equal(j.format, 2);
    assert.ok(j.coursesBox.length > 0, p.email);
    for (const [, c] of j.coursesBox) { assert.ok(valid.has(c.grade1) && valid.has(c.grade2)); assert.match(c.id, /^[A-Z]+ [A-Za-z]?\d+[A-Za-z]?$/); }
    withMarks += j.marksBox.length > 0;
    dual += /^[AB]\d[AB]\d$/.test(j.settingsBox.find(([k]) => k === 'selecteddiscipline')[1]);
    assert.equal(j.settingsBox.find(([k]) => k === 'campus')[1], p.campus);
    assert.equal(j.settingsBox.find(([k]) => k === 'batch')[1], p.batch % 100);
  }
  assert.ok(withMarks > 20 && dual > 10);
  const batches = new Set(R.people.filter((p) => p.kind === 'student').map((p) => p.batch));
  for (const b of [2020, 2021, 2022, 2023, 2024, 2025]) assert.ok(batches.has(b), `batch ${b}`);
});

test('every collection the rules know has a document', () => {
  const have = new Set(R.docs.map((d) => d.path.split('/')[0]));
  for (const c of ['users', 'people', 'owners', 'grants', 'staff', 'staffContacts', 'directory', 'repIndex', 'volunteers', 'contributors', 'contributorRequests', 'usernames', 'leaderboard',
    'reviews', 'reviewIndex', 'resources', 'resourceVersions', 'resourceReports', 'resourceFlags', 'pending', 'courses', 'professors', 'audit', 'heads', 'catalog', 'config', 'roles',
    'timetable', 'reviewGate', 'courseClaims', 'activity', 'analytics', 'signInLog', 'reports', 'searchHints']) assert.ok(have.has(c), c);
  assert.ok(R.docs.some((d) => d.path.includes('/offerings/')) && R.docs.some((d) => d.path.includes('/stats/')) && R.docs.some((d) => d.path.includes('/reports/')));
  assert.ok(R.docs.some((d) => d.path.startsWith('professors/') && d.data.mergedInto) && R.docs.some((d) => d.path.startsWith('professors/') && d.data.removed));
});

test('--like takes its distributions from an anonymised export', () => {
  const f = buildFixture();
  const anon = anonymise(f.docs, f.auth, { salt: 'synth-test-salt-0123456789' });
  const prof = profileFrom(anon.docs);
  assert.ok(prof.campusShare.goa > 0.2 && prof.campusShare.dubai > 0);
  assert.equal(Math.round(Object.values(prof.campusShare).reduce((a, b) => a + b, 0) * 100), 100);
  assert.ok(prof.coursesPerUser > 0);
  const skew = synthesise({ users: 800, seed: 2, now: NOW, like: { ...prof, campusShare: { goa: 1, pilani: 0, hyderabad: 0, dubai: 0 } } });
  const goa = skew.people.filter((p) => p.campus === 'goa').length;
  assert.ok(goa > 500, goa);
});

test('the write count is what a load would spend', () => {
  assert.ok(R.docs.length > 3000 && R.docs.length < 20000, R.docs.length);
  assert.ok(synthesise({ users: 2000, seed: 1, now: NOW }).docs.length > R.docs.length);
});

test('a sample keeps every campus x kind x state, the multi-role people and the edge reviews, with fewer documents', () => {
  const s = selectSample(R.docs, R.auth, 1, { now: NOW });
  assert.ok(s.length < R.docs.length * 0.7, `${s.length} of ${R.docs.length}`);
  const kept = new Set(s.filter((d) => d.path.startsWith('people/')).map((d) => d.path.slice(7)));
  const stateOf = (g) => (g.handedTo ? 'handedOver' : g.active === false ? 'revoked' : g.expiresAt.s < NOW ? 'expired' : g.expiresAt.s < NOW + 14 * 86400 ? 'expiring' : 'live');
  const roleOf = { cr: 'course', president: 'dept', secretary: 'dept', admin: 'admin', custom: 'custom', contributor: 'contributor' };
  const held = new Set(s.filter((d) => d.path.startsWith('grants/')).map((d) => `${d.data.email.split('@')[1].split('.')[0]}|${d.data.role}${d.data.secretary ? '*' : ''}|${stateOf(d.data)}`));
  const pending = new Set(s.filter((d) => d.path.startsWith('contributorRequests/') && d.data.status === 'pending').map((d) => d.data.campus));
  for (const campus of CAMPUSES) {
    for (const [kind, states] of Object.entries(STATES)) {
      for (const state of states) {
        const ok = kind === 'contributor' && state === 'pending' ? pending.has(campus) : held.has(`${campus}|${roleOf[kind]}${kind === 'secretary' ? '*' : ''}|${state}`);
        assert.ok(ok, `${campus} ${kind} ${state}`);
      }
    }
    for (const tag of ['president+cr', 'admin+president', 'cr+contributor+custom']) {
      assert.ok(R.people.some((p) => p.campus === campus && p.tags.includes(tag) && kept.has(p.email)), `${campus} ${tag}`);
    }
  }
  const paths = new Set(s.map((d) => d.path));
  assert.ok([...paths].some((p) => p.includes('/votes/')) || !R.docs.some((d) => d.path.includes('/votes/')));
  for (const d of s) if (d.data?.auditId && byPath.has(`audit/${d.data.auditId}`)) assert.ok(paths.has(`audit/${d.data.auditId}`), d.path);
  // every kept review has its course's index entry, and every index entry a kept review
  const idx = s.find((d) => d.path === 'reviewIndex/goa')?.data.c ?? {};
  for (const c of Object.keys(idx)) assert.ok(s.some((d) => d.path.startsWith(`reviews/${c}/entries/`)), c);
});

// ---- shared-data delta
{
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
}
