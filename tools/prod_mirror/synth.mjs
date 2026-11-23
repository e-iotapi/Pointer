#!/usr/bin/env node
// SYNTHESISE: a fully invented dataset of about N users that covers every
// combination of campus x role x grant state x activity, written in the export
// format so load.mjs loads it like an anonymised mirror.
//
//   node tools/prod_mirror/synth.mjs --users 2000 --out <dir> [--seed 1] [--like <anonymised export>] [--now <epoch s>]
//
// Nothing here comes from real people: names are drawn from lists, courses
// from assets/catalog.json (public). Same seed and --now give the same data.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAuth, readDocs, root, writeDocs } from './lib.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const CAMPUSES = ['goa', 'pilani', 'hyderabad', 'dubai'];
export const STATES = { cr: ['live', 'expiring', 'expired', 'revoked'], president: ['live', 'expiring', 'expired', 'revoked', 'handedOver'],
  secretary: ['live', 'expiring', 'expired', 'revoked'], admin: ['live', 'expiring', 'expired', 'revoked'],
  custom: ['live', 'expiring', 'expired', 'revoked'], contributor: ['pending', 'live', 'expiring', 'revoked', 'expired'] };
export const REFUSED = ['faculty', 'gmail', 'no-campus'];
export const ACTIVITIES = ['cgpa', 'marks', 'timetable', 'reviewer', 'volunteer', 'dual', 'brandNew', 'dormant'];
const DEPTS = ['BIO', 'BIOT', 'CE', 'CHE', 'CHEM', 'CS', 'ECON', 'ELEC', 'ENVS', 'GEN', 'MAC', 'MATH', 'ME', 'MF', 'PHA', 'PHY', 'SNS'];
const PROGS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A7', 'A8', 'B1', 'B2', 'B3', 'B4', 'B5'];
const FIRST = 'Aarav Aditi Akash Ananya Arjun Bhavya Chirag Deepa Dev Diya Esha Farhan Gauri Harsh Isha Ishaan Jaya Kabir Kavya Kiran Lakshmi Manav Meera Mohan Naina Neel Nikhil Nisha Om Pooja Pranav Rahul Riya Rohan Saanvi Sahil Sana Samar Tanvi Tara Uday Varun Veda Vihaan Yash Zara'.split(' ');
const LAST = 'Agarwal Bansal Bhatt Chopra Das Desai Dutta Gill Goyal Gupta Iyer Jain Joshi Kapoor Khan Kohli Kulkarni Mehta Menon Mishra Nair Pandey Patel Pillai Rao Reddy Saxena Sethi Shah Sharma Shetty Singh Sinha Soni Tiwari Trivedi Varma Verma Yadav Arora Banerjee Bose Dixit Ghosh Hegde Kamat Malhotra Naidu Prasad Sen Thakur'.split(' ');
const WORDS = 'course lectures notes tutorials quiz paper exam grading fair easy hard heavy light interesting practical theory examples slides doubts attendance marks scheme midsem compre average relative topics syllabus pace engaging recommended assignments labs project concepts basics advanced helpful clear organised'.split(' ');
const CAPS = ['courseStructures', 'averages', 'contribute', 'moderateReviews', 'departmentResources', 'courseResources', 'readAuditAndRoster', 'approveContributors'];
const DEFAULT_LIKE = { campusShare: { goa: 0.3, pilani: 0.35, hyderabad: 0.28, dubai: 0.07 }, coursesPerUser: 28, grades: { A: 12, 'A-': 22, B: 24, 'B-': 16, C: 12, 'C-': 7, D: 4, E: 1, GD: 2 }, reviewRate: 0.2, votesPerReview: 1.2 };
const GRADE = { A: 10, 'A-': 9, B: 8, 'B-': 7, C: 6, 'C-': 5, D: 4, E: 2, GD: -3 };
const deptOfCourse = (c) => {
  const p = c.trim().toUpperCase().split(' ')[0];
  return !/^[A-Z]{2,5}$/.test(p) ? 'GEN' : ['EEE', 'ECE', 'INSTR', 'ECOM'].includes(p) ? 'ELEC' : p === 'FIN' ? 'ECON' : DEPTS.includes(p) ? p : 'GEN';
};

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Distributions read from an anonymised export (campus split, courses per user, grade mix, review rate). */
export function profileFrom(docs) {
  const people = docs.filter((d) => d.path.startsWith('people/'));
  const users = docs.filter((d) => d.path.startsWith('users/'));
  if (!people.length || !users.length) return DEFAULT_LIKE;
  const inCampus = people.filter((p) => CAMPUSES.includes(p.data.campus));
  const share = Object.fromEntries(CAMPUSES.map((c) => [c, inCampus.filter((p) => p.data.campus === c).length / Math.max(1, inCampus.length)]));
  let courses = 0, nUsers = 0; const grades = {};
  const inv = Object.fromEntries(Object.entries(GRADE).map(([k, v]) => [v, k]));
  for (const u of users) {
    try {
      const j = JSON.parse(u.data.data);
      courses += (j.coursesBox ?? []).length; nUsers++;
      for (const [, c] of j.coursesBox ?? []) if (inv[c.grade1]) grades[inv[c.grade1]] = (grades[inv[c.grade1]] ?? 0) + 1;
    } catch { /* an unreadable snapshot adds nothing */ }
  }
  const entries = docs.filter((d) => /^reviews\/[^/]+\/entries\/[0-9a-f]{64}$/.test(d.path)).length;
  const votes = docs.filter((d) => d.path.includes('/votes/')).length;
  return {
    campusShare: share, coursesPerUser: nUsers ? courses / nUsers : 28,
    grades: Object.keys(grades).length ? grades : DEFAULT_LIKE.grades,
    reviewRate: Math.min(0.9, (entries / Math.max(1, people.length)) / 3),
    votesPerReview: entries ? votes / entries : 1.2,
  };
}

export function synthesise({ users = 2000, seed = 1, like = null, now = Math.floor(Date.UTC(2026, 10, 23) / 1000), reserved = {} } = {}) {
  const rnd = mulberry32(seed * 2654435761);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const weighted = (m) => { const t = Object.values(m).reduce((a, b) => a + b, 0); let x = rnd() * t; for (const [k, w] of Object.entries(m)) if ((x -= w) < 0) return k; return Object.keys(m)[0]; };
  const L = like ?? DEFAULT_LIKE;
  const DAY = 86400;
  const ts = (s) => ({ __t: 'ts', s: Math.round(s), n: 0 });
  const docs = [];
  const put = (p, data) => docs.push({ path: p, data });
  const cat = JSON.parse(readFileSync(path.join(root, 'assets', 'catalog.json'), 'utf8'));
  const rows = cat.chartNew.filter((r, i, a) => a.findIndex((x) => x[0] === r[0]) === i); // one row per course id
  const byDisc = {};
  for (const r of rows) (byDisc[r[4]] ??= []).push(r);
  const semOrder = ['1 - 1', '1 - 2', '2 - 1', '2 - 2', 'PS 1', '3 - 1', '3 - 2', 'ST 1', '4 - 1', '4 - 2'];
  const nowD = new Date(now * 1000);
  const acadStart = nowD.getUTCMonth() >= 6 ? nowD.getUTCFullYear() : nowD.getUTCFullYear() - 1;
  const term = `${acadStart}-${String(acadStart + 1).slice(2)}-${nowD.getUTCMonth() >= 6 ? 1 : 2}`;
  const emails = new Set(reserved.emails ?? []);
  const usedUids = new Set(reserved.uids ?? []);
  const people = [];
  let uidN = 0;
  const mkUid = () => { for (;;) { const u = sha(`uid${seed}-${uidN++}`).slice(0, 28).replace(/[a-f]/g, (c) => c.toUpperCase()); if (!usedUids.has(u)) return u; } };

  // ---- people --------------------------------------------------------------
  const newPerson = (campus, o = {}) => {
    const batch = o.batch ?? int(2020, 2025);
    let email;
    for (;;) {
      const letter = o.letter ?? (campus === 'hyderabad' ? 'h' : chance(0.05) ? 'p' : 'f');
      email = `${letter}${batch}${String(int(0, 9999)).padStart(4, '0')}@${campus}.bits-pilani.ac.in`;
      if (!emails.has(email)) break;
    }
    emails.add(email);
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const p = { email, name, uid: mkUid(), campus, batch, kind: 'student', state: 'none', activity: 'cgpa', grants: [], tags: [], ...o };
    p.email = email;
    people.push(p);
    return p;
  };
  const prog = () => pick(PROGS);
  const need = [];
  for (const campus of CAMPUSES) {
    // Two people where a state has too few cells to meet all eight activities.
    for (const [kind, states] of Object.entries(STATES)) for (const state of states) for (let i = 0; i < (state === 'pending' || state === 'handedOver' ? 2 : 1); i++) need.push({ campus, kind, state });
  }
  const roleFolk = need.map((n) => newPerson(n.campus, { ...n }));
  // owners: not tied to a campus; one with a BITS address (a student who is also an owner)
  const owners = [0, 1, 2].map((i) => {
    const e = i < 2 ? `owner${i + 1}.pointer@example.com` : null;
    if (e) { emails.add(e); const p = { email: e, name: `${pick(FIRST)} ${pick(LAST)}`, uid: mkUid(), campus: 'goa', batch: 2020, kind: 'owner', state: 'live', activity: 'cgpa', grants: [], tags: [], nonBits: true }; people.push(p); return p; }
    const p = newPerson('goa', { kind: 'owner', state: 'live' }); return p;
  });
  const refused = [];
  for (const campus of CAMPUSES) {
    for (const t of REFUSED) {
      const local = `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${int(10, 99)}`;
      const email = t === 'faculty' ? `${local}@${campus}.bits-pilani.ac.in` : t === 'gmail' ? `${local}@gmail.com` : `f2023${String(int(0, 9999)).padStart(4, '0')}@bits-pilani.ac.in`;
      emails.add(email);
      const p = { email, name: `${pick(FIRST)} ${pick(LAST)}`, uid: mkUid(), campus, batch: 0, kind: 'refused', state: t, activity: 'none', grants: [], tags: [], refused: true };
      people.push(p); refused.push(p);
    }
  }
  const students = [];
  for (const campus of CAMPUSES) for (const activity of ACTIVITIES) students.push(newPerson(campus, { kind: 'student', state: 'none', activity }));
  const minUsers = people.length;
  if (users < minUsers) throw new Error(`--users must be at least ${minUsers}: that is how many people it takes to cover every combination.`);
  // fill the rest by the production-like mix
  while (people.length < users) {
    const campus = weighted(L.campusShare);
    students.push(newPerson(campus, { kind: 'student', state: 'none', activity: weighted({ cgpa: 30, marks: 20, timetable: 15, reviewer: 15, volunteer: 3, dual: 8, brandNew: 5, dormant: 4 }) }));
  }
  // Activities of role holders: greedy, so every pair (campus|kind|state, activity) is met.
  const seen = new Set();
  const dims = (p) => [`c:${p.campus}`, `k:${p.kind}`, `s:${p.state}`];
  for (const p of students) for (const d of dims(p)) seen.add(`${d}/${p.activity}`);
  for (const p of roleFolk) {
    let best = ACTIVITIES[0], score = -1;
    for (const a of ACTIVITIES) {
      const s = dims(p).filter((d) => !seen.has(`${d}/${a}`)).length * 10 + rnd();
      if (s > score) { score = s; best = a; }
    }
    p.activity = best;
    for (const d of dims(p)) seen.add(`${d}/${best}`);
  }
  // multi-role people, taken from the plain students of each campus
  const multi = [];
  for (const campus of CAMPUSES) {
    const pool = students.filter((s) => s.campus === campus && s.activity !== 'brandNew' && s.batch >= 2022);
    const [a, b, c] = [pool[0], pool[1], pool[2]];
    a.tags.push('president+cr'); b.tags.push('admin+president'); c.tags.push('cr+contributor+custom');
    multi.push(a, b, c);
  }

  // ---- grants and everything about roles -----------------------------------
  const auditOf = (actor, action, p, campus, after) => {
    const id = sha(`aud${seed}${docs.length}${p}${action}`).slice(0, 20);
    put(`audit/${id}`, { actor: { email: actor.email, name: actor.name, role: actor.role ?? 'owner' }, action, summary: action, path: p, campus, before: null, after: after ?? null, at: ts(now - int(1, 200) * DAY) });
    return id;
  };
  const ownerA = owners[0];
  const gid = (g) => g.role === 'custom' ? `custom|${g.email}` : `${g.role}|${g.campus}|${g.scope}|${g.email}`;
  const roleDocs = {}; // custom roles by key
  const mkRole = (id, o) => {
    const aid = auditOf(ownerA, 'save role', `roles/${id}`, o.campus);
    roleDocs[id] = o;
    put(`roles/${id}`, { name: o.name, caps: o.caps, termDays: o.termDays, campus: o.campus, dept: o.dept, createdBy: { email: ownerA.email, name: ownerA.name }, updatedAt: ts(now - 60 * DAY), auditId: aid });
  };
  mkRole('timetable-editor', { name: 'Timetable editor', caps: ['contribute', 'readAuditAndRoster'], termDays: 180, campus: 'all', dept: 'all' });
  mkRole('goa-moderator', { name: 'Goa moderator', caps: ['moderateReviews', 'readAuditAndRoster'], termDays: 120, campus: 'goa', dept: 'all' });
  mkRole('elec-resources', { name: 'ELEC resources', caps: ['departmentResources', 'courseResources', 'contribute'], termDays: 365, campus: 'goa', dept: 'ELEC' });
  mkRole('hyd-cs-courses', { name: 'CS course structures', caps: ['courseStructures', 'averages'], termDays: 365, campus: 'hyderabad', dept: 'CS' });
  const roleFor = (campus) => campus === 'goa' ? pick(['goa-moderator', 'elec-resources', 'timetable-editor']) : campus === 'hyderabad' ? pick(['hyd-cs-courses', 'timetable-editor']) : 'timetable-editor';
  const scopeFor = (id) => ({ campus: roleDocs[id].campus, dept: roleDocs[id].dept });

  const expiry = (state) => ({ live: now + int(60, 300) * DAY, expiring: now + int(1, 12) * DAY, expired: now - int(2, 90) * DAY, revoked: now + int(30, 200) * DAY, handedOver: now + int(5, 18) * DAY, pending: now, none: now }[state]);
  const grants = []; // {id, ...doc}
  const presidentOf = new Map(); // campus -> live president person
  const addGrant = (p, role, o) => {
    const state = o.state ?? p.state;
    const g = { role, campus: o.campus ?? p.campus, scope: o.scope, email: p.email, name: p.name, ...(o.programme ? { programme: o.programme } : {}), ...(o.secretary ? { secretary: true } : {}), ...(o.extra ?? {}) };
    if (role === 'custom') { g.roleId = o.roleId; g.scope = 'role'; }
    if (role === 'contributor') { g.dept = o.dept; g.scope = g.campus; }
    const live = state !== 'revoked';
    const expiresAt = o.expiresAt ?? expiry(state);
    const granter = o.granter ?? ownerA;
    const id = gid(g);
    const aid = auditOf(granter, `appoint ${role}`, `grants/${id}`, g.campus, { active: live, expiresAt: new Date(expiresAt * 1000).toISOString() });
    const doc = { ...g, active: live, expiresAt: ts(expiresAt), grantedBy: { email: granter.email, name: granter.name }, grantedAt: ts(now - int(5, 300) * DAY), auditId: aid };
    p.grants.push({ id, ...doc, stateAtBuild: state });
    put(`grants/${id}`, doc);
    grants.push({ id, person: p, doc, state });
    return id;
  };

  for (const p of roleFolk) {
    const dept = pick(DEPTS), prg = prog();
    const state = p.state;
    if (p.kind === 'president') {
      const id = addGrant(p, 'dept', { scope: dept, programme: prg, state, ...(state === 'handedOver' ? { extra: { handedTo: 'PLACEHOLDER', expiresBefore: ts(now + 120 * DAY) } } : {}) });
      p.dept = dept;
      if (state === 'live') presidentOf.set(p.campus, p);
      p.lastGrant = id;
    } else if (p.kind === 'secretary') {
      const boss = presidentOf.get(p.campus) ?? roleFolk.find((x) => x.kind === 'president' && x.state === 'live' && x.campus === p.campus);
      p.lastGrant = addGrant(p, 'dept', { scope: boss?.dept ?? dept, programme: prg, secretary: true, state, granter: boss ?? ownerA });
      p.dept = boss?.dept ?? dept;
    } else if (p.kind === 'cr') {
      const c = pick(rows.filter((r) => deptOfCourse(r[0]) !== 'GEN'))[0];
      p.course = c; p.dept = deptOfCourse(c);
      p.lastGrant = addGrant(p, 'course', { scope: c, state });
    } else if (p.kind === 'admin') {
      p.lastGrant = addGrant(p, 'admin', { campus: 'all', scope: 'all', state });
    } else if (p.kind === 'custom') {
      const roleId = roleFor(p.campus);
      p.roleId = roleId;
      p.lastGrant = addGrant(p, 'custom', { roleId, scope: 'role', state, campus: p.campus });
    } else if (p.kind === 'contributor') {
      p.dept = pick(['CS', 'ELEC', 'MATH', 'PHY', 'ME']);
      if (state !== 'pending') p.lastGrant = addGrant(p, 'contributor', { dept: p.dept, state: state === 'live' ? 'live' : state, expiresAt: state === 'live' ? now + 20 * 365 * DAY : undefined });
    }
  }
  // handovers: the outgoing president's grant names a successor who holds the same scope
  for (const g of grants.filter((x) => x.doc.handedTo === 'PLACEHOLDER')) {
    const succ = presidentOf.get(g.person.campus) ?? grants.find((x) => x.doc.role === 'dept' && !x.doc.secretary && x.state === 'live')?.person;
    g.doc.handedTo = succ.email;
    g.doc.auditId = auditOf(g.person, 'hand over', `grants/${g.id}`, g.doc.campus);
    if (!grants.some((x) => x.id === `dept|${g.doc.campus}|${g.doc.scope}|${succ.email}`)) {
      addGrant(succ, 'dept', { scope: g.doc.scope, programme: g.doc.programme, state: 'live', campus: g.doc.campus, granter: g.person });
    }
    succ.tags.push('handover-successor');
  }
  // multi-role extras
  const live = (campus, role) => roleFolk.find((x) => x.kind === role && x.state === 'live' && x.campus === campus);
  for (const p of multi) {
    const c = p.campus;
    if (p.tags[0] === 'president+cr') {
      p.dept = pick(DEPTS); p.course = pick(rows.filter((r) => deptOfCourse(r[0]) === p.dept))?.[0] ?? 'CS F111';
      addGrant(p, 'dept', { scope: p.dept, programme: prog(), state: 'live' });
      addGrant(p, 'course', { scope: p.course, state: 'live' });
    } else if (p.tags[0] === 'admin+president') {
      p.dept = pick(DEPTS);
      addGrant(p, 'admin', { campus: 'all', scope: 'all', state: 'live' });
      addGrant(p, 'dept', { scope: p.dept, programme: prog(), state: 'live' });
    } else {
      p.dept = pick(['CS', 'ELEC']); p.course = pick(rows)[0]; p.roleId = roleFor(c);
      addGrant(p, 'course', { scope: p.course, state: 'live' });
      addGrant(p, 'contributor', { dept: p.dept, state: 'live', expiresAt: now + 20 * 365 * DAY });
      addGrant(p, 'custom', { roleId: p.roleId, scope: 'role', state: 'live', campus: c });
    }
  }
  // owners
  for (const o of owners) {
    const aid = auditOf(ownerA, 'add owner', `owners/${o.email}`, 'all');
    put(`owners/${o.email}`, { email: o.email, name: o.name, active: true, addedBy: { email: ownerA.email, name: ownerA.name }, addedAt: ts(now - 400 * DAY), auditId: aid });
  }

  // staff, directory, staffContacts, repIndex, contributors
  const byPerson = new Map();
  for (const g of grants) (byPerson.get(g.person) ?? byPerson.set(g.person, []).get(g.person)).push(g);
  const repP = Object.fromEntries(CAMPUSES.map((c) => [c, {}]));
  const usernames = new Set();
  const leader = Object.fromEntries(CAMPUSES.map((c) => [c, { p: {}, tags: {} }]));
  for (const [p, gs] of byPerson) {
    const hold = gs.filter((x) => x.doc.role !== 'contributor');
    if (hold.length) {
      const cur = hold[hold.length - 1];
      const on = (x) => x.doc.active && x.doc.expiresAt.s > now;
      const reach = hold.filter(on).map((x) => x.doc.role === 'admin' ? { role: 'admin', campus: 'all' } : x.doc.role === 'dept' ? { role: 'president', campus: x.doc.campus, dept: x.doc.scope } : x.doc.role === 'course' ? { role: 'cr', campus: x.doc.campus, course: x.doc.scope } : { role: 'custom', campus: roleDocs[x.doc.roleId].campus, dept: roleDocs[x.doc.roleId].dept });
      put(`staff/${p.email}`, {
        email: p.email, name: p.name, campus: hold[0].doc.campus === 'all' ? 'all' : p.campus, owner: false,
        admin: hold.some((x) => x.doc.role === 'admin' && on(x)),
        presidentOf: [...new Set(hold.filter((x) => x.doc.role === 'dept' && on(x)).map((x) => x.doc.scope))],
        courses: hold.filter((x) => x.doc.role === 'course' && on(x)).map((x) => x.doc.scope),
        reach, expiresAt: ts(Math.max(...hold.map((x) => x.doc.expiresAt.s))), lastGrant: cur.id,
      });
    }
    const listed = hold.filter((x) => x.doc.role === 'dept' || x.doc.role === 'course');
    if (listed.length && listed.some((x) => x.doc.active)) {
      const phone = `9${String(int(100000000, 999999999))}`;
      const entry = {
        name: p.name, campus: p.campus,
        roles: listed.slice(0, 4).map((x) => ({ role: x.doc.role, scope: x.doc.scope, ...(x.doc.programme ? { programme: x.doc.programme } : {}), ...(x.doc.secretary ? { secretary: true } : {}), until: x.doc.expiresAt })),
        ...(chance(0.6) ? { email: p.email } : {}), ...(chance(0.7) ? { whatsapp: phone } : {}), updatedAt: ts(now - int(1, 100) * DAY),
      };
      if (!('email' in entry) && !('whatsapp' in entry)) entry.phone = phone;
      put(`directory/${p.email}`, entry);
      if (listed.some((x) => x.doc.active && x.doc.expiresAt.s > now)) repP[p.campus][p.email] = entry;
      put(`staffContacts/${p.email}`, { name: p.name, phone: `+91 ${phone}`, email: p.email, updatedAt: ts(now - int(1, 100) * DAY) });
    }
  }
  for (const c of CAMPUSES) if (Object.keys(repP[c]).length) put(`repIndex/${c}`, { k: `s${seed}`, p: repP[c] });

  // contributors: requests (every status), usernames, points, leaderboard
  const contribs = people.filter((p) => p.kind === 'contributor' || p.tags.includes('cr+contributor+custom'));
  for (const p of contribs) {
    const status = p.kind === 'contributor' ? (p.state === 'pending' ? 'pending' : p.state === 'revoked' ? 'withdrawn' : 'approved') : 'approved';
    put(`contributorRequests/${p.campus}|${p.dept}|${p.email}`, { name: p.name, email: p.email, campus: p.campus, dept: p.dept, status, createdAt: ts(now - int(5, 120) * DAY), ...(status !== 'pending' ? { decidedBy: ownerA.email, decidedAt: ts(now - int(1, 4) * DAY) } : {}) });
    if (p.state === 'pending') continue;
    const uname = `${p.name.split(' ')[0].toLowerCase()}_${int(10, 99)}${p.uid.slice(0, 2).toLowerCase()}`.replace(/[^a-z0-9_]/g, '');
    if (usernames.has(`${p.campus}|${uname}`)) continue;
    usernames.add(`${p.campus}|${uname}`);
    const points = p.state === 'live' || p.tags.length ? int(4, 90) : int(0, 10);
    p.username = uname; p.points = points;
    put(`contributors/${p.email}`, { username: uname, campus: p.campus, points });
    put(`usernames/${p.campus}|${uname}`, { email: p.email, claimedAt: ts(now - int(10, 100) * DAY) });
    leader[p.campus].p[uname] = points;
    if (chance(0.5)) leader[p.campus].tags[uname] = pick(PROGS);
  }
  for (const c of CAMPUSES) if (Object.keys(leader[c].p).length) put(`leaderboard/${c}`, { ...leader[c], k: Object.keys(leader[c].p)[0] });

  // ---- professors, offerings, timetable ----------------------------------
  const profs = {}; // campus -> dept -> [ids]
  const profDoc = {};
  const nameTokens = (n) => { const out = new Set(); for (const w of n.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x && !['dr', 'prof'].includes(x))) for (let i = 1; i <= Math.min(w.length, 12); i++) out.add(w.slice(0, i)); return [...out]; };
  for (const c of CAMPUSES) {
    profs[c] = {};
    for (const d of DEPTS.filter((x) => x !== 'GEN')) {
      profs[c][d] = [];
      for (let i = 0; i < 3; i++) {
        const id = sha(`prof${seed}${c}${d}${i}`).slice(0, 20);
        const name = `${pick(['Dr.', 'Prof.'])} ${pick('ABCDEGHJKLMNPRSTV'.split(''))}. ${pick(LAST)}`;
        const aid = auditOf(ownerA, 'add professor', `professors/${id}`, c);
        const base = { name, campus: c, department: d, aliases: [], nameTokens: nameTokens(name), mergedIds: [], active: true, updatedBy: { email: ownerA.email, name: ownerA.name }, updatedAt: ts(now - 90 * DAY), auditId: aid };
        if (i === 2 && d === 'CS') { // a merge pair and a removed professor on every campus
          const keep = profs[c][d][0], kd = profDoc[keep];
          put(`professors/${id}`, { ...base, mergedInto: keep, active: false });
          kd.mergedIds.push(id); kd.aliases.push(name); kd.nameTokens = [...new Set([...kd.nameTokens, ...base.nameTokens])];
          continue;
        }
        if (i === 2 && d === 'ELEC') { put(`professors/${id}`, { ...base, removed: true, removedBy: { email: ownerA.email, name: ownerA.name }, removedAt: ts(now - 20 * DAY) }); continue; }
        put(`professors/${id}`, base);
        profDoc[id] = base;
        profs[c][d].push(id);
      }
    }
  }
  const popular = {}; // campus -> courses with offerings
  for (const c of CAMPUSES) {
    popular[c] = rows.filter((r) => /F[1-4]\d\d$/.test(r[0]) && deptOfCourse(r[0]) !== 'GEN').filter((_, i) => (i + CAMPUSES.indexOf(c)) % 9 === 0).slice(0, 40);
    for (const r of popular[c]) {
      const d = deptOfCourse(r[0]);
      const aid = auditOf(ownerA, 'publish offering', `courses/${r[0]}/offerings/${c}_${term}`, c);
      const w = [10, 10, 30, 50];
      put(`courses/${r[0]}/offerings/${c}_${term}`, {
        courseId: r[0], campus: c, term, weighted: true, totalMarks: 100,
        components: ['Quiz 1', 'Quiz 2', 'Midsem', 'Compre'].map((n, i) => ({ id: n.toLowerCase().replace(' ', ''), name: n, weight: w[i], countBest: 0, parts: [{ name: '', outOf: [20, 20, 60, 80][i], ...(i > 1 ? { date: i === 2 ? '2026-10-15' : '2026-12-05' } : {}) }] })),
        professors: (profs[c][d] ?? []).slice(0, 1), updatedAt: ts(now - 30 * DAY), updatedBy: { email: ownerA.email, name: ownerA.name }, auditId: aid,
      });
    }
  }
  const tt = (c) => {
    const aid = auditOf(ownerA, 'publish timetable', `timetable/${c}|2026-1`, c);
    const courses = {};
    for (const r of popular[c].slice(0, 25)) courses[r[0]] = { t: r[1], cr: r[2], sec: [{ ty: 'L', no: 1, prof: ['A Teacher'], room: `F${int(100, 399)}`, slots: [{ d: int(1, 5), s: 540, e: 600 }, { d: int(1, 5), s: 660, e: 720 }] }], mid: { d: '2026-10-12', s: 570, e: 660 }, compre: { d: '2026-12-10', slot: 'FN', s: 570, e: 750 } };
    put(`timetable/${c}|2026-1|0`, { n: 0, courses });
    put(`timetable/${c}|2026-1`, { v: 1, sem: '2026-1', campus: c, hours: { 1: [480, 540], 2: [540, 600] }, examSlots: { FN: [570, 750], AN: [840, 1020] }, events: [{ from: '2026-08-03', title: 'Instruction begins', kind: 'term' }, { from: '2026-10-12', to: '2026-10-17', title: 'Midsem exams', kind: 'exam' }], chunks: 1, publishedAt: ts(now - 100 * DAY), marker: 2, auditId: aid });
    put(`timetable/${c}|current`, { sem: '2026-1', marker: 2 });
  };
  CAMPUSES.forEach(tt);

  // ---- users/{uid}, people ------------------------------------------------
  const gradeLetters = () => weighted(L.grades);
  const semIdx = (p) => {
    const yr = acadStart - p.batch + 1, s = nowD.getUTCMonth() >= 6 ? 1 : 2;
    const cur = `${Math.min(yr, 4)} - ${yr > 4 ? 2 : s}`;
    return yr > 4 ? semOrder.length : Math.max(0, semOrder.indexOf(cur));
  };
  const reviewers = [], volunteers = [];
  for (const p of people) {
    if (p.refused) continue;
    const dormant = p.activity === 'dormant';
    const fs = (now - (p.activity === 'brandNew' ? int(0, 3) : dormant ? int(150, 400) : int(5, 700)) * DAY) * 1000;
    put(`people/${p.email}`, { name: p.name, campus: p.campus, firstSignIn: Math.round(fs), lastSeen: Math.round((now - (dormant ? int(100, 300) : int(0, 20)) * DAY) * 1000) });
    if (p.activity === 'brandNew' || p.nonBits) continue;
    const dual = p.activity === 'dual' || chance(0.04);
    const h1 = pick(PROGS), h2 = pick(PROGS.filter((x) => x[0] !== h1[0]));
    p.discipline = dual ? (h1[0] === 'B' ? h1 + h2 : h2 + h1) : (chance(0.7) ? `--${prog().replace(/^B/, 'A')}` : `${PROGS.filter((x) => x[0] === 'B')[int(0, 4)]}--`);
    p.dual = dual;
    const halves = [p.discipline.slice(0, 2), p.discipline.slice(2)].filter((h) => h !== '--');
    const sem = semIdx(p);
    const courses = [];
    for (const r of rows.filter((r) => (r[4] === 'AA' || halves.includes(r[4])) && semOrder.indexOf(r[3]) >= 0 && semOrder.indexOf(r[3]) <= Math.min(sem, semOrder.length - 1))) {
      const done = semOrder.indexOf(r[3]) < sem;
      const g1 = done ? GRADE[gradeLetters()] : -2;
      courses.push([courses.length, { id: r[0], title: r[1], credits: r[2], linked: true, grade1: g1, grade2: done ? g1 : GRADE[gradeLetters()], discipline: r[4] === 'AA' ? halves[0] : r[4], sem: r[3], elective: r[5].startsWith('CDC') ? 'CDC' : 'DEL', ...(chance(0.05) ? { more: { 3: GRADE[gradeLetters()] } } : {}) }]);
    }
    const marks = [];
    if (['marks', 'timetable'].includes(p.activity) || chance(0.1)) {
      for (const [, c] of courses.filter(([, x]) => x.grade1 === -2).slice(0, 5)) {
        marks.push([`config:${c.id}`, { t: 'config', c: c.id, w: true, tot: 100, d: 100, a: Math.round((45 + rnd() * 25) * 10) / 10 }]);
        ['Quiz 1', 'Quiz 2', 'Midsem', 'Compre'].forEach((n, i) => {
          const o = [20, 20, 60, 80][i];
          marks.push([`eval:${c.id}:${i + 1}`, { t: 'eval', c: c.id, n, w: [10, 10, 30, 50][i], p: [{ n: '', m: i < 3 ? Math.round(o * (0.4 + rnd() * 0.55) * 2) / 2 : null, o, d: i > 1 ? (i === 2 ? '2026-10-15' : '2026-12-05') : null }], b: 0 }]);
        });
      }
    }
    const batch2 = p.batch % 100;
    const data = {
      format: 2,
      settingsBox: [['batch', batch2], ['campus', p.campus], ['selecteddiscipline', p.discipline], ['degree_selected', true], ['currentsem', Math.min(semOrder.length - 1, sem)], ['currentsort', int(0, 2)], ['selected_theme', int(0, 2)], ['profile1n', 'Actual'], ['profile2n', 'Expected'], ...(p.activity === 'timetable' ? [['stats_target', 8 + Math.round(rnd() * 15) / 10]] : [])],
      coursesBox: courses, offshootBox: [], marksBox: marks,
    };
    put(`users/${p.uid}`, { rev: int(1, 40), uid: p.uid, data: JSON.stringify(data), updatedAt: ts(now - (dormant ? int(120, 400) : int(0, 30)) * DAY) });
    p.courses = courses.map(([, c]) => c);
    if (['reviewer'].includes(p.activity) || chance(L.reviewRate * 0.5)) reviewers.push(p);
    if (p.activity === 'volunteer') volunteers.push(p);
    if (p.activity === 'volunteer' || p.kind === 'student' && chance(0.01)) volunteers.push(p);
  }

  // ---- volunteers, claims, gate, activity ------------------------------------
  for (const p of [...new Set(volunteers)]) {
    const c = pick(p.courses?.filter((x) => deptOfCourse(x.id) !== 'GEN') ?? []) ?? null;
    if (!c) continue;
    const open = chance(0.7);
    put(`volunteers/${p.campus}|${c.id}|${p.email}`, { name: p.name, email: p.email, campus: p.campus, courseId: c.id, dept: deptOfCourse(c.id), term, open, createdAt: ts(now - int(1, 60) * DAY), ...(open ? {} : { closedBy: { email: p.email, name: p.name } }) });
  }
  for (const c of CAMPUSES) {
    const aid = auditOf(ownerA, 'Turned the review gate on', `reviewGate/${c}`, c);
    if (c !== 'dubai') put(`reviewGate/${c}`, { on: c === 'goa', by: { email: ownerA.email, name: ownerA.name }, at: ts(now - 40 * DAY), auditId: aid });
    const claimer = roleFolk.find((x) => x.kind === 'president' && x.state === 'live' && x.campus === c);
    if (claimer) {
      const ca = auditOf(claimer, `Claimed HSS F219 for ${claimer.dept}`, `courseClaims/${c}|HSS F219`, c, claimer.dept);
      put(`courseClaims/${c}|HSS F219`, { campus: c, courseId: 'HSS F219', dept: claimer.dept, by: { email: claimer.email, name: claimer.name }, at: ts(now - 10 * DAY), auditId: ca });
    }
    put(`activity/${c}`, { course: Object.fromEntries(popular[c].slice(0, 6).map((r, i) => [r[0], ts(now - [3, 20, 500, 40, 5, 200][i] * DAY)])), dept: { ELEC: ts(now - 3 * DAY), CS: ts(now - 400 * DAY) }, c: '', d: '' });
    put(`searchHints/${c}`, { q: { menon: { 'dr menon': 2 }, rao: { 'k rao': 1 } }, k: 'menon', t: 'dr menon' });
  }

  // ---- reviews -----------------------------------------------------------
  const entries = [];
  const sentence = () => `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} ${pick(['was', 'is', 'felt'])} ${pick(WORDS)}`;
  for (const p of reviewers) {
    const mine = (p.courses ?? []).filter((c) => c.grade1 !== -2 && deptOfCourse(c.id) !== 'GEN');
    for (let i = 0; i < Math.min(mine.length, int(1, 5)); i++) {
      const c = mine.splice(int(0, mine.length - 1), 1)[0];
      const d = deptOfCourse(c.id), stars = Math.max(1, Math.min(5, Math.round(3.4 + (rnd() - 0.45) * 3)));
      const hidden = chance(0.03);
      const id = sha(p.uid + c.id);
      const prof = (profs[p.campus][d] ?? [])[0] ?? null;
      const e = { courseId: c.id, department: d, stars, recommend: stars >= 3, text: Array.from({ length: int(1, 4) }, sentence).join('. ') + '.', campus: p.campus, term, professorId: prof, hidden, helpful: 0, reports: 0, createdAt: ts(now - int(5, 400) * DAY), updatedAt: ts(now - int(0, 5) * DAY), ...(chance(0.5) ? { grade: Object.keys(GRADE).find((k) => GRADE[k] === c.grade1) ?? 'B' } : {}), ...(chance(0.15) ? { marks: int(40, 95) } : {}) };
      if (hidden) { e.reason = 'off-topic'; e.hiddenBy = { email: ownerA.email, name: ownerA.name }; e.moderatedAt = ts(now - int(1, 30) * DAY); e.auditId = auditOf(ownerA, 'hide review', `reviews/${c.id}/entries/${id}`, p.campus); }
      entries.push({ id, e, p });
    }
  }
  const have = new Set();
  const votersBy = Object.fromEntries(CAMPUSES.map((c) => [c, people.filter((x) => x.campus === c && !x.refused && x.activity !== 'brandNew' && !x.nonBits)]));
  for (const { id, e, p } of entries) {
    const nv = Math.floor(L.votesPerReview + rnd());
    for (let i = 0; i < nv; i++) {
      const v = pick(votersBy[e.campus]);
      const vp = `reviews/${e.courseId}/entries/${id}/votes/${sha(v.uid + id)}`;
      if (v === p || have.has(vp)) continue;
      have.add(vp);
      put(vp, { createdAt: ts(now - int(0, 100) * DAY) });
      e.helpful++;
    }
    if (chance(0.04)) {
      const v = pick(votersBy[e.campus]);
      if (v !== p) { put(`reviews/${e.courseId}/entries/${id}/reports/${sha(v.uid + id)}`, { createdAt: ts(now - int(0, 30) * DAY) }); e.reports++; }
    }
    put(`reviews/${e.courseId}/entries/${id}`, e);
  }
  const index = {}, mirror = {}, stats = {};
  for (const { id, e } of entries) {
    if (e.hidden) continue;
    const t = ((index[e.campus] ??= {})[e.courseId] ??= { count: 0, starSum: 0, recommendCount: 0 });
    t.count++; t.starSum += e.stars; t.recommendCount += e.recommend ? 1 : 0;
    (mirror[`${e.courseId}|${e.campus}`] ??= {})[id] = { stars: e.stars, recommend: e.recommend, text: e.text, term: e.term, ...(e.grade ? { grade: e.grade } : {}), ...(e.marks ? { marks: e.marks } : {}), professorId: e.professorId, helpful: e.helpful, createdAt: e.createdAt, updatedAt: e.updatedAt };
    for (const pr of [null, e.professorId]) {
      const k = `${e.courseId}|${pr ? `${e.campus}_${pr}` : e.campus}`;
      const s = (stats[k] ??= { count: 0, starSum: 0, recommendCount: 0, campus: e.campus, courseId: e.courseId, scope: pr ? 'professor' : 'course', professorId: pr });
      s.count++; s.starSum += e.stars; s.recommendCount += e.recommend ? 1 : 0;
    }
  }
  for (const [c, v] of Object.entries(index)) put(`reviewIndex/${c}`, { k: `s${seed}`, c: v });
  for (const [k, r] of Object.entries(mirror)) { const [c, campus] = k.split('|'); put(`reviews/${c}/campus/${campus}`, { k: `s${seed}`, r }); }
  for (const [k, s] of Object.entries(stats)) { const [c, sid] = k.split('|'); put(`courses/${c}/stats/${sid}`, s); }

  // ---- resources ---------------------------------------------------------
  const kinds = [['folder', 'https://drive.google.com/drive/folders/'], ['video', 'https://youtube.com/playlist?list='], ['doc', 'https://docs.google.com/document/d/'], ['link', 'https://github.com/example/']];
  const rv = Object.fromEntries(CAMPUSES.map((c) => [c, {}]));
  const resIds = [];
  for (const c of CAMPUSES) {
    const poster = roleFolk.find((x) => x.kind === 'president' && x.state === 'live' && x.campus === c) ?? ownerA;
    for (const d of DEPTS.filter((x) => x !== 'GEN')) {
      for (let i = 0; i < 3; i++) {
        const id = sha(`res${seed}${c}${d}${i}`).slice(0, 20), [kind, base] = pick(kinds), url = `${base}${sha(id).slice(0, 12)}`;
        const aid = auditOf(poster, 'add resource', `resources/${id}`, c);
        const addedBy = { email: poster.email, name: poster.name };
        put(`resources/${id}`, { title: `${d} ${pick(WORDS)} ${pick(WORDS)}`, url, host: new URL(url).host, kind, campus: c, department: d, scope: 'department', courseIds: [], pinnedToDepartment: i === 0, addedBy, addedAt: ts(now - int(5, 300) * DAY), removed: false, auditId: aid, actingFor: '' });
        const dd = docs.at(-1).data;
        rv[c][id] = { title: dd.title, url, host: dd.host, kind, department: d, scope: 'department', courseIds: [], pinnedToDepartment: dd.pinnedToDepartment, addedBy, addedAt: dd.addedAt.s * 1000 };
        resIds.push([id, c, d]);
      }
    }
  }
  // contributors' unapproved batches, flags and reports
  for (const c of CAMPUSES) {
    const cp = people.find((x) => x.kind === 'contributor' && x.state === 'live' && x.campus === c && x.username);
    if (!cp) continue;
    const bid = sha(`batch${seed}${c}`).slice(0, 20), rid = sha(`pres${seed}${c}`).slice(0, 20), url = 'https://drive.google.com/drive/folders/' + sha(rid).slice(0, 12), at = ts(now - 2 * DAY);
    put(`resources/${rid}`, { title: 'Contributed notes', url, host: 'drive.google.com', kind: 'folder', campus: c, department: cp.dept, scope: 'department', courseIds: [], pinnedToDepartment: true, addedBy: { email: cp.email, name: cp.username }, addedAt: at, removed: false, approved: false, publishedAt: at, batchId: bid, auditId: auditOf({ ...cp, role: 'contributor' }, 'submit resource', `resources/${rid}`, c), actingFor: '' });
    rv[c][rid] = { title: 'Contributed notes', url, host: 'drive.google.com', kind: 'folder', department: cp.dept, scope: 'department', courseIds: [], pinnedToDepartment: true, addedBy: { email: cp.email, name: cp.username }, addedAt: at.s * 1000, approved: false, publishedAt: at.s * 1000 };
    put(`pending/${c}|${cp.dept}`, { batches: { [bid]: { email: cp.email, username: cp.username, at, links: { [rid]: { title: 'Contributed notes', url } } } } });
  }
  for (const c of CAMPUSES) put(`resourceVersions/${c}`, { v: now * 1000, k: `s${seed}`, links: rv[c] });
  for (const [id, c, d] of resIds.filter((_, i) => i % 40 === 0)) {
    const r = pick(votersBy[c]);
    put(`resourceReports/${id}/entries/${sha(r.uid + id)}`, { reason: pick(['broken', 'wrong', 'spam']), note: sentence(), campus: c, createdAt: ts(now - int(0, 20) * DAY) });
    put(`resourceFlags/${id}`, { campus: c, department: d, courseIds: [], open: true, count: 1, reasons: { broken: 1 }, lastAt: ts(now - 5 * DAY) });
  }

  // ---- config, catalogue, analytics, heads --------------------------------
  const gt = auditOf(ownerA, 'save grant terms', 'config/grantTerms', 'all');
  put('config/grantTerms', { crDays: 183, presidentDays: 365, adminDays: 730, auditId: gt });
  put('config/public', { contactName: 'Pointer Support', contactMethod: 'whatsapp', contactTarget: '910000000000', contactEnabled: true, updatedBy: { email: ownerA.email, name: ownerA.name }, updatedAt: ts(now - 50 * DAY), auditId: auditOf(ownerA, 'save public contact', 'config/public', 'all') });
  const ver = cat.version + 1;
  put(`catalog/v${ver}`, { version: ver, schema: cat.schema, json: JSON.stringify({ ...cat, version: ver }) });
  put('catalog/marker', { version: ver, schema: cat.schema, auditId: auditOf(ownerA, 'publish catalogue', 'catalog/marker', 'all', { version: ver }) });
  for (let i = 0; i < 14; i++) {
    const day = new Date((now - i * DAY) * 1000).toISOString().slice(0, 10);
    put(`analytics/${day}`, { sample: 20, ...Object.fromEntries(CAMPUSES.filter((c) => c !== 'dubai').map((c) => [c, { dau: int(20, 300), h: { 9: int(1, 40), 13: int(1, 60) }, at: '13' }])) });
  }
  for (const c of CAMPUSES) {
    const v = { owners: 3, terms: 2, grants: grants.length, staff: 5, reps: 4, resources: 3, reviews: 6, reviewGate: 2, timetable: 2, leaderboard: 3, courseClaims: 2, ...(c === 'goa' ? { roles: 4 } : {}) };
    for (const d of DEPTS) { v[`professors/${d}`] = 2; v[`pending/${d}`] = 1; v[`contributorRequests/${d}`] = 1; v[`volunteers/${d}`] = 1; }
    put(`heads/${c}`, { catalog: ver, catalogSchema: cat.schema, v, offerings: Object.fromEntries(popular[c].map((r) => [r[0], 1])) });
  }
  // a few failed sign-ins (written signed out) and a bug report
  for (let i = 0; i < 4; i++) put(`signInLog/${sha(`sil${seed}${i}`).slice(0, 20)}`, { outcome: 'failed', stage: 'domain', code: 'refused', message: 'not a student address', attempt: 1, ms: int(200, 4000), ua: 'Mozilla/5.0', device: 'phone', browser: 'chrome', standalone: false, path: '/', at: ts(now - i * DAY) });
  const bug = pick(people.filter((p) => !p.refused));
  put(`reports/${sha(`rep${seed}`).slice(0, 20)}`, { uid: bug.uid, message: 'The semester tab shows the wrong credits.', createdAt: ts(now - 3 * DAY) });

  const auth = people.map((p) => ({ uid: p.uid, email: p.email, displayName: p.refused ? null : p.name, disabled: false }));
  return { docs, auth, people, coverage: coverageOf(people) };
}

/** Counts by campus x kind x state, the pairs with activity, and one example each. */
export function coverageOf(people) {
  const cells = new Map(), pairs = new Map();
  const bump = (m, k, p) => { const x = m.get(k) ?? { count: 0, example: p.email }; x.count++; m.set(k, x); };
  for (const p of people) {
    if (p.nonBits) continue;
    bump(cells, `${p.campus}|${p.kind}|${p.state}`, p);
    for (const [d, v] of [['campus', p.campus], ['kind', p.kind], ['state', p.state]]) if (p.activity !== 'none') bump(pairs, `${d}=${v}|${p.activity}`, p);
    for (const t of p.tags) bump(cells, `${p.campus}|multi|${t}`, p);
  }
  const required = [];
  for (const campus of CAMPUSES) {
    for (const [kind, states] of Object.entries(STATES)) for (const s of states) required.push(`${campus}|${kind}|${s}`);
    for (const t of REFUSED) required.push(`${campus}|refused|${t}`);
    required.push(`${campus}|multi|president+cr`, `${campus}|multi|admin+president`, `${campus}|multi|cr+contributor+custom`);
  }
  const reqPairs = [];
  for (const a of ACTIVITIES) {
    for (const c of CAMPUSES) reqPairs.push(`campus=${c}|${a}`);
    for (const k of ['student', ...Object.keys(STATES)]) reqPairs.push(`kind=${k}|${a}`);
    for (const s of ['none', 'live', 'expiring', 'expired', 'revoked', 'handedOver', 'pending']) reqPairs.push(`state=${s}|${a}`);
  }
  return { cells, pairs, missing: required.filter((k) => !cells.has(k)), missingPairs: reqPairs.filter((k) => !pairs.has(k)) };
}

export function printCoverage(cov, log = console.log) {
  log('\nCoverage (campus | kind | state -> people, example):');
  for (const [k, v] of [...cov.cells].sort()) log(`  ${k.padEnd(40)} ${String(v.count).padStart(4)}  ${v.example}`);
  log(`  missing cells: ${cov.missing.length}; missing activity pairs: ${cov.missingPairs.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2), ['shared-delta']);
  if (a['shared-delta']) { (await import('./shared_delta.mjs')).runSharedDelta(a); process.exit(0); }
  if (!a.out) { console.error('usage: synth.mjs --users 2000 --out <dir> [--seed 1] [--like <anonymised export>] [--avoid <dir,dir>] [--now <epoch s>]'); process.exit(2); }
  const like = a.like ? profileFrom(readDocs(path.resolve(a.like))) : null;
  // --avoid <dir,dir>: addresses and uids already taken (anonymised prod, the personas), so combining never collides.
  const reserved = { emails: new Set(), uids: new Set() };
  // the seed's ?as= accounts are taken too
  for (const x of JSON.parse(readFileSync(path.join(root, 'test_env', 'accounts.json'), 'utf8')).accounts) reserved.emails.add(x.email.toLowerCase());
  for (const d of (a.avoid ?? '').split(',').filter(Boolean)) {
    const dir = path.resolve(d);
    for (const u of readAuth(dir)) { if (u.email) reserved.emails.add(u.email.toLowerCase()); reserved.uids.add(u.uid); }
    for (const x of readDocs(dir)) {
      for (const e of x.path.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]+/g) ?? []) reserved.emails.add(e.toLowerCase());
      if (x.path.startsWith('users/')) reserved.uids.add(x.path.slice(6));
    }
  }
  const r = synthesise({ users: Number(a.users ?? 2000), seed: Number(a.seed ?? 1), like, reserved, ...(a.now ? { now: Number(a.now) } : {}) });
  const out = path.resolve(a.out);
  mkdirSync(out, { recursive: true });
  writeDocs(out, r.docs, r.auth);
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ synthetic: true, seed: Number(a.seed ?? 1), docs: r.docs.length, auth: r.auth.length }, null, 1));
  printCoverage(r.coverage);
  console.log(`\n${r.people.length} people, ${r.docs.length} documents = ${r.docs.length} staging writes (${Math.ceil(r.docs.length / 18000)} day(s) at 18,000 a day). Wrote ${out}`);
}
