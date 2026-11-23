import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { anonymise, leakCheck, shiftToNowSeconds, summarise } from './anonymise.mjs';
import { PEOPLE, buildFixture } from './fixtures/build.mjs';

const SALT = 'unit-test-salt-0123456789';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const run = (salt = SALT) => {
  const { docs, auth } = buildFixture();
  return { in: { docs, auth }, ...anonymise(structuredClone(docs), structuredClone(auth), { salt }) };
};
const byPath = (r) => new Map(r.docs.map((d) => [d.path, d.data]));
const P = Object.fromEntries(PEOPLE.map((p) => [p.key, p]));
const fakeEmail = (r, e) => r.maps.email.get(e.toLowerCase());
const fakeUid = (r, u) => r.maps.uid.get(u);

test('leak check passes on the fixture and nothing personal survives', () => {
  const r = run();
  assert.deepEqual(leakCheck(r.docs, r.auth, r.registry, r.fakes), []);
  const all = JSON.stringify(r.docs) + JSON.stringify(r.auth);
  for (const p of PEOPLE) {
    assert.ok(!all.includes(p.email), p.email);
    assert.ok(!all.includes(p.uid), p.uid);
    assert.ok(!all.toLowerCase().includes(p.name.toLowerCase().replace(/^dr\. /, '')), p.name);
  }
  for (const s of ['98765 43210', '9876543210', '919876500011', '9812345678', 'nisharao_cs', 'Aarti']) assert.ok(!all.includes(s), s);
});

test('deterministic with the same salt, different with another', () => {
  assert.deepEqual(run().docs, run().docs);
  assert.notDeepEqual(run().docs, run('another-salt-9876543210').docs);
});

test('BITS addresses keep campus, letter, year and length; others become fake', () => {
  const r = run();
  for (const p of PEOPLE) {
    const f = fakeEmail(r, p.email);
    assert.notEqual(f, p.email.toLowerCase());
    const m = /^([fhp])(\d{4})(\d+)@(\w+)\.bits-pilani\.ac\.in$/.exec(p.email);
    if (m) {
      const g = new RegExp(`^${m[1]}${m[2]}\\d{${m[3].length}}@${m[4]}\\.bits-pilani\\.ac\\.in$`);
      if (!p.email.includes('+')) assert.match(f, g, p.email);
    }
  }
  assert.match(fakeEmail(r, P.owner.email), /@example\.com$/);
  const fac = fakeEmail(r, P.faculty.email);
  assert.match(fac, /@goa\.bits-pilani\.ac\.in$/);
  assert.doesNotMatch(fac, /^[fhp]\d{4}\d+@/); // still not a student
  assert.equal(new Set(PEOPLE.map((p) => fakeEmail(r, p.email))).size, PEOPLE.length);
});

test('doc ids, map keys, nested actors and path strings are rewritten consistently', () => {
  const r = run();
  const d = byPath(r);
  const pres = fakeEmail(r, P.president.email);
  const gid = `dept|goa|ELEC|${pres}`;
  assert.ok(d.has(`grants/${gid}`));
  assert.ok(d.has(`staff/${pres}`) && d.has(`directory/${pres}`) && d.has(`people/${pres}`) && d.has(`staffContacts/${pres}`));
  assert.ok(d.has(`volunteers/goa|EEE F311|${fakeEmail(r, P.plus.email)}`));
  assert.ok(d.has(`owners/${fakeEmail(r, P.owner.email)}`));
  assert.deepEqual(Object.keys(d.get('repIndex/goa').p).sort(), [pres, fakeEmail(r, P.cr.email)].sort());
  assert.equal(d.get(`grants/${gid}`).email, pres);
  assert.equal(d.get(`staff/${pres}`).lastGrant, gid);
  const aud = r.docs.filter((x) => x.path.startsWith('audit/')).map((x) => x.data);
  assert.ok(aud.some((a) => a.path === `grants/${gid}` && a.after.to === pres));
  assert.ok(aud.every((a) => a.actor.email !== P.owner.email && a.summary === a.action));
  // the same person has the same fake name wherever they appear
  const nm = d.get(`people/${pres}`).name;
  assert.equal(d.get(`grants/${gid}`).name, nm);
  assert.equal(d.get(`staff/${pres}`).name, nm);
  assert.equal(d.get(`resources/r1`).addedBy.name, nm);
  assert.notEqual(nm, P.president.name);
});

test('campus, year and student-ness survive in every email that is left', () => {
  const r = run();
  const emails = new Set();
  for (const d of r.docs) for (const m of JSON.stringify(d).matchAll(/[\w.+-]+@[\w.-]+\.[a-z]+/g)) emails.add(m[0]);
  for (const e of emails) assert.ok(r.fakes.emails.has(e), e);
});

test('hashed ids are recomputed so the mapped person still owns their rows', () => {
  const r = run();
  const d = byPath(r);
  const c = 'EEE F311';
  const own = sha(fakeUid(r, P.student.uid) + c);
  assert.ok(d.has(`reviews/${c}/entries/${own}`));
  assert.ok(!d.has(`reviews/${c}/entries/${sha(P.student.uid + c)}`));
  assert.ok(d.has(`reviews/${c}/entries/${own}/votes/${sha(fakeUid(r, P.cr.uid) + own)}`));
  assert.ok(d.has(`reviews/${c}/entries/${own}/reports/${sha(fakeUid(r, P.plus.uid) + own)}`));
  assert.ok(d.has(`resourceReports/r1/entries/${sha(fakeUid(r, P.student.uid) + 'r1')}`));
  // the mirror copy keys by the new id too
  assert.ok(own in d.get('reviews/EEE F311/campus/hyderabad').r);
  // an account with no users doc still gets a stable, different id
  const orphan = [...d.keys()].filter((k) => k.includes(`${own}/votes/`));
  assert.equal(orphan.length, 2);
  // fixture sanity: users/{uid} re-keyed
  assert.ok(d.has(`users/${fakeUid(r, P.student.uid)}`));
  assert.equal(d.get(`users/${fakeUid(r, P.student.uid)}`).uid, fakeUid(r, P.student.uid));
});

test('users/{uid} grades and marks are randomised but keep shape and valid values', () => {
  const r = run();
  const before = JSON.parse(r.in.docs.find((x) => x.path === `users/${P.student.uid}`).data.data);
  const after = JSON.parse(byPath(r).get(`users/${fakeUid(r, P.student.uid)}`).data);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.equal(after.coursesBox.length, before.coursesBox.length);
  const valid = new Set([8, 9, 10, 7, 6]);
  const c = after.coursesBox.map(([, x]) => x);
  assert.equal(c[1].grade1, -2); // "not graded" stays
  assert.equal(c[1].id, 'MATH F211');
  for (const x of c) for (const g of [x.grade1, x.grade2, ...Object.values(x.more ?? {})]) assert.ok(g <= 0 || valid.has(g), g);
  const part = after.marksBox[0][1].p[0];
  assert.ok(part.m >= 0 && part.m <= part.o);
  assert.equal(after.settingsBox.find(([k]) => k === 'profile1n')[1], 'Actual');
  assert.equal(after.settingsBox.find(([k]) => k === 'profile3n')[1], 'Profile 3'); // had a name in it
  assert.equal(after.settingsBox.find(([k]) => k === 'campus')[1], 'hyderabad');
});

test('structure is untouched: ids of courses, counts, markers, timestamps', () => {
  const r = run();
  assert.equal(r.docs.length, r.in.docs.length);
  const d = byPath(r);
  assert.deepEqual(d.get('heads/goa'), r.in.docs.find((x) => x.path === 'heads/goa').data);
  assert.deepEqual(d.get('reviewIndex/goa'), r.in.docs.find((x) => x.path === 'reviewIndex/goa').data);
  assert.deepEqual(d.get('timetable/goa|current'), { sem: '2026-1', marker: 2 });
  const g = [...d.entries()].find(([k]) => k.startsWith('grants/dept|goa|ELEC|'))[1];
  assert.deepEqual(g.expiresAt, { __t: 'ts', s: 1_760_000_000 + 86400 * 90, n: 0 });
  assert.equal(g.secretary ?? false, g.email === fakeEmail(r, P.secretary.email));
  // professors: merge structure and recomputed tokens
  const p2 = d.get('professors/prof2'), p3 = d.get('professors/prof3');
  assert.equal(p3.mergedInto, 'prof2');
  assert.notEqual(p2.name, 'Dr. K. Rao');
  assert.match(p2.name, /^Dr\. /);
  assert.equal(p3.name.replace(/^Prof\./, 'Dr.'), p2.name);
  assert.ok(p2.nameTokens.includes(p2.name.split(' ').at(-1).toLowerCase()));
  assert.ok(!p2.nameTokens.includes('rao') && !byPath(r).get('professors/prof1').nameTokens.includes('menon'));
  // free text replaced; enum reasons kept; url host kept
  assert.equal(d.get(`resourceReports/r1/entries/${sha(fakeUid(r, P.student.uid) + 'r1')}`).reason, 'broken');
  assert.equal(d.get('resources/r1').host, 'drive.google.com');
  assert.match(d.get('resources/r1').url, /^https:\/\/drive\.google\.com\/x[0-9a-f]{10}$/);
  const lb = d.get('leaderboard/hyderabad');
  assert.match(Object.keys(lb.p)[0], /^u_[0-9a-f]{7}$/);
  assert.deepEqual(Object.keys(lb.p), Object.keys(lb.tags));
  assert.equal(lb.k, Object.keys(lb.p)[0]);
  assert.ok(d.has(`usernames/hyderabad|${Object.keys(lb.p)[0]}`));
});

test('the shift moves timestamps and nothing else', () => {
  const { docs, auth } = buildFixture();
  const r = anonymise(structuredClone(docs), auth, { salt: SALT, shiftDays: 10 });
  const g = [...new Map(r.docs.map((x) => [x.path, x.data])).entries()].find(([k]) => k.startsWith('grants/dept|goa|ELEC|'))[1];
  assert.equal(g.expiresAt.s, 1_760_000_000 + 86400 * 100);
});

test('the leak check catches planted leaks', () => {
  const r = run();
  const plant = (mut) => {
    const docs = structuredClone(r.docs);
    mut(docs);
    return summarise(leakCheck(docs, r.auth, r.registry, r.fakes));
  };
  assert.ok(plant((d) => { d[0].data.note = `mail ${P.student.email}`; }).email);
  assert.ok(plant((d) => { d[0].data.note = 'mail somebody.else@gmail.com'; })['unknown-email']);
  assert.ok(plant((d) => { d[0].data.note = 'call 9876543210 now'; }).phone);
  assert.ok(plant((d) => { d[0].data.note = 'call 9111122223'; })['unknown-phone']);
  assert.ok(plant((d) => { d[0].data.note = 'Tanvi Shetty was kind'; }).name);
  assert.ok(plant((d) => { d[0].path += `/${P.cr.uid}`; })['uid-or-hash']);
  assert.ok(plant((d) => { d[0].data.k = { [P.cr.uid]: 1 }; })['uid-or-hash']);
  assert.ok(plant((d) => { d[0].data.u = 'nisharao_cs'; }).username);
  assert.ok(plant((d) => { d[0].data.h = sha(P.student.uid + 'EEE F311'); })['uid-or-hash']);
});

test('shift-to-now makes the newest past timestamp today and keeps expiry order', () => {
  const { docs, auth } = buildFixture();
  const now = 1_800_000_000;
  const sec = shiftToNowSeconds(docs, now);
  const r = anonymise(structuredClone(docs), auth, { salt: SALT, shiftSeconds: sec });
  const ts = r.docs.flatMap((d) => JSON.stringify(d.data).match(/"__t":"ts","s":(\d+)/g) ?? []).map((m) => Number(m.split(':').pop()));
  assert.ok(ts.filter((s) => s <= now).reduce((a, b) => Math.max(a, b)) === now);
  const g = r.docs.filter((d) => d.path.startsWith('grants/')).map((d) => d.data);
  assert.ok(g.some((x) => x.expiresAt.s > now) && g.some((x) => x.expiresAt.s < now)); // live and expired both remain
});
