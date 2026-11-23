// Synthetic stand-in for a production export: every collection the rules know,
// tricky ids, email-keyed maps, free text with personal data in it. All
// people, numbers and addresses here are invented.
//   node tools/prod_mirror/fixtures/build.mjs   -> fixtures/export/
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDocs } from '../lib.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const ts = (s) => ({ __t: 'ts', s, n: 0 });
const T0 = 1_760_000_000; // a fixed "now"

export const PEOPLE = [
  { key: 'owner', email: 'founder.dev@gmail.com', name: 'Ishaan Verma', uid: 'Qm3xT9aLp2VnR7cYh4KdZs8WbEf1' },
  { key: 'admin', email: 'f20180412@pilani.bits-pilani.ac.in', name: 'Meera Kapoor', uid: 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34' },
  { key: 'president', email: 'f20230802@goa.bits-pilani.ac.in', name: 'Rohan Desai', uid: 'Pr45Es67Id89Nt01Go23Aa45Bb67', phone: '98765 43210' },
  { key: 'secretary', email: 'f20231173@goa.bits-pilani.ac.in', name: 'Tanvi Shetty', uid: 'Se11Cr22Et33Ar44Yy55Zz66Aa77' },
  { key: 'cr', email: 'f20240560@goa.bits-pilani.ac.in', name: 'Kabir Singh', uid: 'Cr99Aa88Bb77Cc66Dd55Ee44Ff33' },
  { key: 'contributor', email: 'f20241201@hyderabad.bits-pilani.ac.in', name: 'Nisha Rao', uid: 'Co01Nt02Ri03Bu04To05Rr06Aa07' },
  { key: 'student', email: 'h20230099@hyderabad.bits-pilani.ac.in', name: 'Aman Joshi', uid: 'St01Ud02En03Tt04Aa05Bb06Cc07' },
  { key: 'dual', email: 'f20220345@pilani.bits-pilani.ac.in', name: 'Diya Menon', uid: 'Du01Al02De03Gr04Ee05Ee06Ff07' },
  { key: 'dubai', email: 'p20250071@dubai.bits-pilani.ac.in', name: 'Zara Khan', uid: 'Db01Ai02St03Ud04En05Tt06Gg07' },
  { key: 'plus', email: 'f20210777+alt@goa.bits-pilani.ac.in', name: 'Harsh Gill', uid: 'Pl01Us02Al03Tt04Ee05Mm06Hh07' },
  { key: 'faculty', email: 'k.r.nair@goa.bits-pilani.ac.in', name: 'Dr. K. R. Nair', uid: 'Fa01Cu02Lt03Yy04Aa05Bb06Cc07' },
];
const P = Object.fromEntries(PEOPLE.map((p) => [p.key, p]));
const campusOf = (e) => e.split('@')[1].split('.')[0];

export function buildFixture() {
  const docs = [];
  const put = (p, data) => docs.push({ path: p, data });
  const aud = (n, actor, action, p, campus, before, after) => put(`audit/aud${n}`, {
    actor: { email: actor.email, name: actor.name, role: 'owner' }, action,
    summary: `${actor.name} did ${action} for ${p}`, path: p, campus,
    before: before ?? null, after: after ?? null, at: ts(T0 - n * 3600),
  });

  // users/{uid}: a Sync snapshot; marks, grades, a profile name that is a name.
  const snap = (email, withMarks) => JSON.stringify({
    format: 2,
    settingsBox: [['batch', Number(/^[fhp](\d{4})/.exec(email)[1]) % 100], ['campus', campusOf(email)], ['profile1n', 'Actual'], ['profile3n', 'Plan for Rohan'], ['selected_theme', 1]],
    coursesBox: [['c1', { id: 'EEE F311', title: 'Communication System', credits: 3, linked: true, grade1: 8, grade2: 9, discipline: 'A3', sem: '3 - 1', elective: 'CDC' }],
      ['c2', { id: 'MATH F211', title: 'Prob and Stats', credits: 3, grade1: -2, grade2: 7, discipline: 'A3', sem: '3 - 1', elective: 'CDC', more: { 3: 6 } }],
      ['c3', { id: 'HSS F111', title: 'Intro', credits: 3, grade1: 10, grade2: 10, discipline: 'A3', sem: '1 - 1', elective: 'HUEL' }]],
    offshootBox: [],
    marksBox: withMarks ? [['EEE F311|quiz1', { t: 'eval', c: 'EEE F311', n: 'Quiz 1', w: 10, p: [{ n: '', m: 17, o: 20, d: null }], b: 0, a: 12 }],
      ['EEE F311|cfg', { t: 'config', c: 'EEE F311', w: true, tot: 100, d: 100, a: 61.5 }]] : [],
  });
  for (const p of PEOPLE.filter((x) => x.key !== 'faculty' && x.key !== 'owner')) {
    put(`users/${p.uid}`, { rev: 3, uid: p.uid, data: snap(p.email, p.key !== 'dubai'), updatedAt: ts(T0 - 86400) });
  }

  // people, staff, owners, grants, directory, contacts, repIndex
  for (const p of PEOPLE) put(`people/${p.email}`, { name: p.name, campus: campusOf(p.email), firstSignIn: (T0 - 9e6) * 1000, lastSeen: ts(T0 - 1000) });
  put(`owners/${P.owner.email}`, { email: P.owner.email, name: P.owner.name, active: true, addedBy: { email: P.owner.email, name: P.owner.name }, addedAt: ts(T0 - 99e5), auditId: 'aud1' });
  const grant = (role, campus, scope, who, extra = {}) => {
    const id = `${role}|${campus}|${scope}|${who.email}`;
    put(`grants/${id}`, { role, campus, scope, email: who.email, name: who.name, active: true, expiresAt: ts(T0 + 86400 * 90), grantedBy: { email: P.owner.email, name: P.owner.name }, grantedAt: ts(T0 - 86400 * 30), auditId: 'aud2', ...extra });
    return id;
  };
  const gA = grant('admin', 'pilani', 'all', P.admin);
  const gP = grant('dept', 'goa', 'ELEC', P.president, { programme: 'A3' });
  const gS = grant('dept', 'goa', 'ELEC', P.secretary, { secretary: true, programme: 'A3' });
  const gC = grant('course', 'goa', 'EEE F311', P.cr);
  grant('dept', 'goa', 'GEN', P.plus, { active: false, expiresAt: ts(T0 - 86400 * 5) }); // expired
  grant('contributor', 'hyderabad', 'hyderabad', P.contributor, { dept: 'CS', expiresAt: ts(4102444800) });
  const staff = (p, extra) => put(`staff/${p.email}`, { email: p.email, name: p.name, campus: campusOf(p.email), owner: false, admin: false, presidentOf: [], courses: [], expiresAt: ts(T0 + 86400 * 90), ...extra });
  staff(P.admin, { admin: true, lastGrant: gA }); staff(P.president, { presidentOf: ['ELEC'], lastGrant: gP });
  staff(P.secretary, { presidentOf: ['ELEC'], lastGrant: gS }); staff(P.cr, { courses: ['EEE F311'], lastGrant: gC });
  put(`staffContacts/${P.president.email}`, { name: P.president.name, phone: '+91 98765 43210', email: P.president.email, updatedAt: ts(T0) });
  const dir = (p, extra) => ({ name: p.name, campus: campusOf(p.email), roles: [{ role: 'dept', scope: 'ELEC', until: ts(T0 + 86400 * 90) }], updatedAt: ts(T0), ...extra });
  put(`directory/${P.president.email}`, dir(P.president, { email: P.president.email, whatsapp: '9876543210', phone: '098765-43210' }));
  put(`directory/${P.cr.email}`, dir(P.cr, {}));
  put('repIndex/goa', { k: 'k1', p: { [P.president.email]: dir(P.president, { email: P.president.email, phone: '9876543210' }), [P.cr.email]: dir(P.cr, {}) } });
  put('roles/builtin', { v: 2, caps: { admin: ['publish'] } });

  // config + public contact
  put('config/public', { contactName: 'Aarti Support Desk', contactMethod: 'whatsapp', contactTarget: '919876500011', contactEnabled: true, updatedBy: { email: P.owner.email, name: P.owner.name }, updatedAt: ts(T0), auditId: 'aud3' });
  put('config/grantTerms', { crDays: 183, presidentDays: 365, adminDays: 730, auditId: 'aud4' });

  // catalogue + heads
  put('catalog/marker', { version: 41, schema: 2, auditId: 'aud5' });
  put('catalog/v41', { version: 41, schema: 2, json: '{"courses":[]}' });
  for (const c of ['goa', 'pilani', 'hyderabad', 'dubai']) put(`heads/${c}`, { catalog: 41, catalogSchema: 2, v: { reviewGate: 3, grants: 7, timetable: 2, 'professors/ELEC': 4 }, offerings: { 'EEE F311': 5 } });

  // professors (a merge pair + a removed one) and offerings, stats
  const prof = (id, name, extra = {}) => put(`professors/${id}`, { name, campus: 'goa', department: 'ELEC', aliases: [], nameTokens: ['d', 'dr'], mergedIds: [], active: true, updatedBy: { email: P.president.email, name: P.president.name }, updatedAt: ts(T0), auditId: 'aud6', ...extra });
  prof('prof1', 'Dr. R. Menon'); prof('prof2', 'Dr. K. Rao', { mergedIds: ['prof3'], aliases: ['Prof. K. Rao'] });
  prof('prof3', 'Prof. K. Rao', { mergedInto: 'prof2', active: false }); prof('prof4', 'Dr. T. Nair', { removed: true, removedAt: ts(T0 - 5e5), removedBy: { email: P.owner.email, name: P.owner.name } });
  put('courses/EEE F311/offerings/goa_2026-27-1', { courseId: 'EEE F311', campus: 'goa', term: '2026-27-1', weighted: true, totalMarks: 100, components: [{ id: 'q1', name: 'Quiz 1', weight: 10, countBest: 0, parts: [{ name: '', outOf: 20 }] }], professors: ['prof1'], updatedAt: ts(T0), updatedBy: { email: P.cr.email, name: P.cr.name }, auditId: 'aud7' });
  put('courses/EEE F311/stats/goa', { count: 3, starSum: 12, recommendCount: 2, campus: 'goa', courseId: 'EEE F311', scope: 'course', professorId: null });
  put('courses/EEE F311/stats/goa_prof1', { count: 3, starSum: 12, recommendCount: 2, campus: 'goa', courseId: 'EEE F311', scope: 'professor', professorId: 'prof1' });

  // reviews: id = sha256(uid + course); votes/reports = sha256(uid + reviewId)
  const rid = (u, c) => sha(u + c);
  const reviews = [['student', 'EEE F311', 5, false], ['cr', 'EEE F311', 4, false], ['president', 'EEE F311', 3, true], ['dual', 'CS F211', 4, false]];
  const mirror = {};
  for (const [k, c, stars, hidden] of reviews) {
    const id = rid(P[k].uid, c);
    const campus = k === 'dual' ? 'pilani' : k === 'student' ? 'hyderabad' : 'goa';
    const e = { courseId: c, department: c.split(' ')[0] === 'EEE' ? 'ELEC' : 'CS', stars, recommend: stars >= 3, text: `${P[k].name} here (${P[k].email}, 9${String(8000000 + stars).padStart(9, '0')}): ${stars} stars, sir was great`, grade: 'A', campus, term: '2026-27-1', professorId: 'prof1', hidden, reason: hidden ? 'Contains the author name Rohan Desai' : null, helpful: 1, reports: 0, createdAt: ts(T0 - 8e5), updatedAt: ts(T0 - 8e5) };
    put(`reviews/${c}/entries/${id}`, e);
    if (!hidden) (mirror[`${c}|${campus}`] ??= {})[id] = { stars, recommend: e.recommend, text: e.text, term: e.term, grade: 'A', professorId: 'prof1', helpful: 1, createdAt: e.createdAt, updatedAt: e.updatedAt };
  }
  const first = rid(P.student.uid, 'EEE F311');
  put(`reviews/EEE F311/entries/${first}/votes/${sha(P.cr.uid + first)}`, { createdAt: ts(T0) });
  put(`reviews/EEE F311/entries/${first}/votes/${sha('long-gone-uid-not-in-any-export0' + first)}`, { createdAt: ts(T0) }); // an account with no users doc
  put(`reviews/EEE F311/entries/${first}/reports/${sha(P.plus.uid + first)}`, { createdAt: ts(T0) });
  for (const [k, m] of Object.entries(mirror)) { const [c, campus] = k.split('|'); put(`reviews/${c}/campus/${campus}`, { k: 'k', r: m }); }
  put('reviewIndex/goa', { k: 'k', c: { 'EEE F311': { count: 2, starSum: 7, recommendCount: 2 } } });
  put('reviewGate/goa', { on: true, by: { email: P.owner.email, name: P.owner.name }, at: ts(T0), auditId: 'aud8' });
  put('searchHints/goa', { q: { menon: { 'dr menon': 2 }, rao: { 'k rao': 1 } }, k: 'menon', t: 'dr menon' });

  // resources, versions, flags, reports, pending
  const links = [['r1', 'EEE F311 drive from Rohan Desai', 'https://drive.google.com/drive/folders/1AbCdEfGhIjK', 'folder'], ['r2', 'Formula sheet', 'https://docs.google.com/document/d/1xYz', 'doc']];
  const rm = {};
  for (const [id, title, url, kind] of links) {
    put(`resources/${id}`, { title, url, host: new URL(url).host, kind, campus: 'goa', department: 'ELEC', scope: 'department', courseIds: [], pinnedToDepartment: true, addedBy: { email: P.president.email, name: P.president.name }, addedAt: ts(T0 - 1e6), removed: false, auditId: 'aud9', actingFor: '' });
    rm[id] = { title, url, host: new URL(url).host, kind, department: 'ELEC', scope: 'department', courseIds: [], pinnedToDepartment: true, addedBy: { email: P.president.email, name: P.president.name }, addedAt: (T0 - 1e6) * 1000 };
  }
  put('resourceVersions/goa', { v: 1760000000000, k: 'k', links: rm });
  put(`resourceReports/r1/entries/${sha(P.student.uid + 'r1')}`, { reason: 'broken', note: `Not working, text me ${P.president.name} at +91 98765 43210`, campus: 'goa', createdAt: ts(T0) });
  put('resourceFlags/r1', { campus: 'goa', department: 'ELEC', courseIds: [], open: true, count: 1, reasons: { broken: 1 }, lastAt: ts(T0) });
  put('pending/goa|ELEC', { batches: { b1: { email: P.contributor.email, username: 'nisharao_cs', at: ts(T0 - 9e4), links: { r3: { title: 'Drive of Nisha Rao', url: 'https://drive.google.com/x/1' } } } } });

  // contributors
  put(`contributors/${P.contributor.email}`, { username: 'nisharao_cs', campus: 'hyderabad', points: 24 });
  put('usernames/hyderabad|nisharao_cs', { email: P.contributor.email, claimedAt: ts(T0 - 4e6) });
  put(`contributorRequests/hyderabad|CS|${P.contributor.email}`, { name: P.contributor.name, email: P.contributor.email, campus: 'hyderabad', dept: 'CS', status: 'approved', createdAt: ts(T0 - 5e6), decidedBy: P.president.email, decidedAt: ts(T0 - 4e6) });
  put('leaderboard/hyderabad', { p: { nisharao_cs: 24 }, tags: { nisharao_cs: 'A7' }, k: 'nisharao_cs' });

  // volunteers, claims, activity, analytics, timetable, signInLog, bug reports
  put(`volunteers/goa|EEE F311|${P.plus.email}`, { name: P.plus.name, email: P.plus.email, campus: 'goa', courseId: 'EEE F311', dept: 'ELEC', term: '2026-27-1', open: true, createdAt: ts(T0) });
  put('courseClaims/goa|HSS F219', { campus: 'goa', courseId: 'HSS F219', dept: 'ELEC', by: { email: P.president.email, name: P.president.name }, at: ts(T0), auditId: 'aud10' });
  put('activity/goa', { course: { 'EEE F311': ts(T0 - 3e5) }, dept: { ELEC: ts(T0 - 3e5) }, c: '', d: '' });
  put('analytics/2026-11-01', { sample: 20, goa: { dau: 14, h: { '9': 5 }, at: '9' } });
  put('signInLog/s1', { email: P.student.email, at: ts(T0), ok: true });
  put('reports/rep1', { uid: P.student.uid, message: `The app shows ${P.student.name}'s CGPA wrong, mail ${P.student.email} or call 9812345678`, createdAt: ts(T0) });
  put('timetable/goa|2026-1', { v: 1, sem: '2026-1', campus: 'goa', chunks: 1, marker: 2, events: [{ from: '2026-08-03', title: 'Instruction begins', kind: 'term' }] });
  put('timetable/goa|2026-1|0', { n: 0, courses: { 'EEE F311': { t: 'Communication System', cr: 3, sec: [{ ty: 'L', no: 1, prof: ['R. Menon'], room: 'F101', slots: [{ d: 1, s: 540, e: 600 }] }] } } });
  put('timetable/goa|current', { sem: '2026-1', marker: 2 });

  // audit trail naming people and paths with emails
  aud(1, P.owner, 'add owner', `owners/${P.owner.email}`, 'all');
  aud(2, P.owner, 'appoint dept', `grants/${gP}`, 'goa', null, { active: true, to: P.president.email });
  aud(3, P.president, 'appoint course', `grants/${gC}`, 'goa');

  const auth = PEOPLE.map((p) => ({ uid: p.uid, email: p.email, displayName: p.name, disabled: false }));
  return { docs, auth };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { docs, auth } = buildFixture();
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'export');
  writeDocs(out, docs, auth);
  console.log(`Wrote ${docs.length} fixture docs to ${out}`);
}
