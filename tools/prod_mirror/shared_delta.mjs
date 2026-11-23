#!/usr/bin/env node
// SHARED-DATA DELTA: more of what every student shares, on top of a dataset that is already loaded.
//
//   node tools/prod_mirror/synth.mjs --shared-delta --base <combined> --out <dir> [--seed 9] [--scale 1] [--budget 6000]
//   node tools/prod_mirror/load.mjs --in <dir> --target staging --skip-same-as <combined> …
//
// Reads the base (documents and auth.json), invents course links in every state, contributors at every
// level, requests, offerings with professors and components, a second-semester timetable per campus,
// votes and reports on existing reviews, claims, volunteers, directory entries, search hints, and then
// REWRITES the documents derived from them (resourceVersions, leaderboard, repIndex, searchHints, activity,
// heads markers, review mirrors, entries' counters) so they agree. Only people and ids already in the
// base are used, and nothing existing is replaced except those derived documents. --out holds base +
// delta; the write count of the load is the number of documents that differ from the base.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, readAuth, readDocs, root, writeDocs } from './lib.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const CAMPUSES = ['goa', 'pilani', 'hyderabad', 'dubai'];
const WORDS = 'course lectures notes tutorials quiz paper exam grading fair easy hard heavy light practical theory examples slides doubts marks scheme midsem compre topics syllabus assignments labs project concepts basics advanced helpful clear organised solved previous year'.split(' ');
const DEPTS = ['BIO', 'BIOT', 'CE', 'CHE', 'CHEM', 'CS', 'ECON', 'ELEC', 'ENVS', 'MAC', 'MATH', 'ME', 'MF', 'PHA', 'PHY', 'SNS'];
const KINDS = [['folder', 'https://drive.google.com/drive/folders/'], ['video', 'https://youtube.com/playlist?list='], ['doc', 'https://docs.google.com/document/d/'], ['link', 'https://github.com/example/']];
const TIERS = [0, 4, 12, 30, 60, 110, 200, 340];
const deptOf = (c) => {
  const p = c.trim().toUpperCase().split(' ')[0];
  return !/^[A-Z]{2,5}$/.test(p) ? 'GEN' : ['EEE', 'ECE', 'INSTR', 'ECOM'].includes(p) ? 'ELEC' : p === 'FIN' ? 'ECON' : DEPTS.includes(p) ? p : 'GEN';
};
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ts = (s) => ({ __t: 'ts', s: Math.round(s), n: 0 });

export function sharedDelta(baseDocs, baseAuth, { seed = 9, scale = 1, now = Math.floor(Date.now() / 1000) } = {}) {
  const rnd = mulberry32(seed * 2654435761);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const n = (x) => Math.max(1, Math.round(x * scale));
  const DAY = 86400;
  const base = new Map(baseDocs.map((d) => [d.path, d.data]));
  const out = new Map(); // path -> data, new or changed
  const get = (p) => out.get(p) ?? base.get(p);
  const put = (p, data) => { out.set(p, data); };
  const fresh = (p) => !base.has(p) && !out.has(p);
  const cat = JSON.parse(readFileSync(path.join(root, 'assets', 'catalog.json'), 'utf8'));
  const rows = cat.chartNew.filter((r, i, a) => a.findIndex((x) => x[0] === r[0]) === i && /F[1-4]\d\d$/.test(r[0]));
  const uidOf = new Map(baseAuth.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u.uid]));
  const campusOfEmail = (e) => e.split('@')[1]?.split('.')[0];
  const student = /^[fhp]\d{4}\d+@(goa|hyderabad|pilani|dubai)\.bits-pilani\.ac\.in$/;
  const people = base.size ? [...base].filter(([p]) => p.startsWith('people/')).map(([p, d]) => ({ email: p.slice(7), name: d.name, campus: d.campus })).filter((x) => student.test(x.email)) : [];
  const byCampus = Object.fromEntries(CAMPUSES.map((c) => [c, people.filter((x) => x.campus === c)]));
  const grants = [...base].filter(([p]) => p.startsWith('grants/')).map(([, d]) => d);
  const liveGrant = (g) => g.active !== false && (g.expiresAt?.s ?? 0) > now;
  const owner = [...base].find(([p]) => p.startsWith('owners/'))?.[1];
  const ownerA = { email: owner?.email ?? 'owner@example.com', name: owner?.name ?? 'Owner', role: 'owner' };
  const poster = (c) => { const g = grants.filter((x) => x.role === 'dept' && x.campus === c && liveGrant(x) && !x.secretary); return g.length ? { email: g[int(0, g.length - 1)].email, name: g[0].name, role: 'dept' } : ownerA; };
  const termOf = (c) => [...base].find(([p, d]) => /^courses\/[^/]+\/offerings\//.test(p) && d.campus === c)?.[1].term ?? '2026-27-1';
  const profs = (c, d) => [...base].filter(([p, x]) => p.startsWith('professors/') && x.campus === c && x.department === d && !x.removed && !x.mergedInto && x.active !== false).map(([p]) => p.slice(11));
  let auditN = 0;
  const audit = (actor, action, p, campus, after) => {
    const id = sha(`sd${seed}${auditN++}${p}${action}`).slice(0, 20);
    put(`audit/${id}`, { actor: { email: actor.email, name: actor.name, role: actor.role ?? 'owner' }, action, summary: action, path: p, campus, before: null, after: after ?? null, at: ts(now - int(1, 60) * DAY) });
    return id;
  };
  const bumps = { reps: 0, leaderboard: 0, resources: 0, courseClaims: 0, grants: 0 };
  const deptBumps = new Map(); // `kind/DEPT` -> campuses
  const bump = (campus, key) => { (deptBumps.get(campus) ?? deptBumps.set(campus, new Set()).get(campus)).add(key); };
  const usedEmails = new Set();
  const takePeople = (c, k, filter = () => true) => {
    const pool = byCampus[c].filter((x) => !usedEmails.has(x.email) && filter(x));
    const got = [];
    while (got.length < k && pool.length) { const x = pool.splice(int(0, pool.length - 1), 1)[0]; usedEmails.add(x.email); got.push(x); }
    return got;
  };

  for (const c of CAMPUSES) {
    if (!byCampus[c].length) continue;
    const term = termOf(c);
    const courses = rows.filter((r) => deptOf(r[0]) !== 'GEN');
    const cs = Array.from({ length: n(70) }, () => pick(courses));

    // ---- course links, every state --------------------------------------------------
    const links = { ...(get(`resourceVersions/${c}`)?.links ?? {}) };
    const states = ['live', 'live', 'live', 'pinned', 'flagged', 'reported', 'removed', 'flagClosed'];
    cs.forEach((r, i) => {
      const id = sha(`sdres${seed}${c}${i}${r[0]}`).slice(0, 20);
      if (!fresh(`resources/${id}`)) return;
      const d = deptOf(r[0]), state = states[i % states.length], p = poster(c), [kind, b] = pick(KINDS), url = `${b}${sha(id).slice(0, 12)}`;
      const addedBy = { email: p.email, name: p.name };
      const aid = audit(p, 'add resource', `resources/${id}`, c);
      const doc = { title: `${r[0]} ${pick(WORDS)} ${pick(WORDS)}`, url, host: new URL(url).host, kind, campus: c, department: d, scope: 'course', courseIds: [r[0]], pinnedToDepartment: state === 'pinned', addedBy, addedAt: ts(now - int(3, 300) * DAY), removed: state === 'removed', auditId: aid, actingFor: r[0] };
      if (state === 'removed') Object.assign(doc, { removedAt: ts(now - int(1, 30) * DAY), removedBy: addedBy });
      put(`resources/${id}`, doc);
      if (state !== 'removed') links[id] = { title: doc.title, url, host: doc.host, kind, department: d, scope: 'course', courseIds: [r[0]], pinnedToDepartment: doc.pinnedToDepartment, addedBy, addedAt: doc.addedAt.s * 1000 };
      if (['flagged', 'reported', 'flagClosed'].includes(state)) {
        const reporters = takePeople(c, state === 'flagged' ? 3 : 1);
        const reasons = {};
        for (const rp of reporters) {
          const reason = pick(['broken', 'wrong', 'spam']);
          reasons[reason] = (reasons[reason] ?? 0) + 1;
          put(`resourceReports/${id}/entries/${sha((uidOf.get(rp.email) ?? rp.email) + id)}`, { reason, note: `${pick(WORDS)} ${pick(WORDS)}`, campus: c, createdAt: ts(now - int(0, 20) * DAY) });
        }
        if (state !== 'reported') put(`resourceFlags/${id}`, { campus: c, department: d, courseIds: [r[0]], open: state === 'flagged', count: reporters.length, reasons, lastAt: ts(now - int(0, 10) * DAY) });
      }
      bump(c, 'resources');
    });
    const rv = get(`resourceVersions/${c}`);
    put(`resourceVersions/${c}`, { ...(rv ?? { k: `sd${seed}` }), v: now * 1000, links });

    // ---- contributors at every level + requests in every state -------------------
    const lb = structuredClone(get(`leaderboard/${c}`) ?? { p: {}, tags: {}, k: '' });
    const levels = TIERS.flatMap((pts) => Array.from({ length: n(3) }, () => pts));
    for (const pts of levels) {
      const [x] = takePeople(c, 1);
      if (!x) break;
      const dept = pick(['CS', 'ELEC', 'MATH', 'PHY', 'ME', 'CHE']);
      const uname = `${x.name.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '')}_${sha(x.email).slice(0, 4)}`.slice(0, 20);
      if (!fresh(`usernames/${c}|${uname}`) || !fresh(`contributors/${x.email}`)) continue;
      const a = audit(ownerA, 'appoint contributor', `grants/contributor|${c}|${c}|${x.email}`, c, { active: true });
      put(`contributorRequests/${c}|${dept}|${x.email}`, { name: x.name, email: x.email, campus: c, dept, status: 'approved', createdAt: ts(now - int(30, 200) * DAY), decidedBy: ownerA.email, decidedAt: ts(now - int(5, 29) * DAY) });
      put(`grants/contributor|${c}|${c}|${x.email}`, { role: 'contributor', email: x.email, name: x.name, campus: c, scope: c, dept, active: true, expiresAt: ts(4102444800), grantedBy: { email: ownerA.email, name: ownerA.name }, grantedAt: ts(now - int(5, 200) * DAY), auditId: a });
      put(`contributors/${x.email}`, { username: uname, campus: c, points: pts });
      put(`usernames/${c}|${uname}`, { email: x.email, claimedAt: ts(now - int(5, 150) * DAY) });
      lb.p[uname] = pts;
      if (rnd() < 0.5) lb.tags[uname] = pick(['A3', 'A7', 'A4', 'B1', 'B3']);
      bump(c, `contributorRequests/${dept}`); bump(c, 'grants');
    }
    for (const status of ['pending', 'pending', 'pending', 'declined', 'declined', 'withdrawn']) {
      for (const x of takePeople(c, n(3))) {
        const dept = pick(['CS', 'ELEC', 'MATH', 'PHY']);
        put(`contributorRequests/${c}|${dept}|${x.email}`, { name: x.name, email: x.email, campus: c, dept, status, createdAt: ts(now - int(1, 60) * DAY), ...(status === 'declined' ? { decidedBy: ownerA.email, decidedAt: ts(now - int(0, 10) * DAY) } : {}) });
        bump(c, `contributorRequests/${dept}`);
      }
    }
    const top = Object.entries(lb.p).sort((a, b) => b[1] - a[1])[0]?.[0];
    put(`leaderboard/${c}`, { ...lb, k: top ?? lb.k });
    bump(c, 'leaderboard');
    // unapproved batches (pending links) for a few contributors
    for (const dept of ['CS', 'ELEC']) {
      const pid = `pending/${c}|${dept}`;
      const batches = { ...(get(pid)?.batches ?? {}) };
      const cand = [...out].filter(([p, d]) => p.startsWith('contributors/') && d.campus === c).map(([p]) => p.slice(13));
      const e = cand[int(0, Math.max(0, cand.length - 1))];
      if (!e) continue;
      const bid = sha(`sdb${seed}${c}${dept}`).slice(0, 20), rid = sha(`sdr${seed}${c}${dept}`).slice(0, 20);
      if (!fresh(`resources/${rid}`)) continue;
      const un = get(`contributors/${e}`).username, at = ts(now - int(0, 6) * DAY), url = `https://drive.google.com/drive/folders/${sha(rid).slice(0, 12)}`;
      put(`resources/${rid}`, { title: `${dept} ${pick(WORDS)} pack`, url, host: 'drive.google.com', kind: 'folder', campus: c, department: dept, scope: 'department', courseIds: [], pinnedToDepartment: true, addedBy: { email: e, name: un }, addedAt: at, removed: false, approved: false, publishedAt: at, batchId: bid, auditId: audit({ email: e, name: un, role: 'contributor' }, 'submit resource', `resources/${rid}`, c), actingFor: '' });
      links[rid] = { title: get(`resources/${rid}`).title, url, host: 'drive.google.com', kind: 'folder', department: dept, scope: 'department', courseIds: [], pinnedToDepartment: true, addedBy: { email: e, name: un }, addedAt: at.s * 1000, approved: false, publishedAt: at.s * 1000 };
      put(pid, { ...(get(pid) ?? {}), batches: { ...batches, [bid]: { email: e, username: un, at, links: { [rid]: { title: get(`resources/${rid}`).title, url } } } } });
      bump(c, `pending/${dept}`);
    }
    put(`resourceVersions/${c}`, { ...get(`resourceVersions/${c}`), links });

    // ---- offerings with professors and components ---------------------------------
    const aoff = { ...(get(`heads/${c}`)?.offerings ?? {}) };
    for (const r of Array.from({ length: n(70) }, () => pick(courses))) {
      const p = `courses/${r[0]}/offerings/${c}_${term}`;
      if (!fresh(p)) continue;
      const d = deptOf(r[0]), pr = profs(c, d);
      const names = pick([['Quiz 1', 'Quiz 2', 'Midsem', 'Compre'], ['Assignments', 'Midsem', 'Compre'], ['Lab', 'Viva', 'Compre'], ['Project', 'Midsem', 'Compre']]);
      const rest = names.length - 1, share = names.map((_, i) => (i === rest ? 50 : Math.floor(50 / rest) + (i === 0 ? 50 - rest * Math.floor(50 / rest) : 0)));
      put(p, { courseId: r[0], campus: c, term, weighted: true, totalMarks: 100, components: names.map((nm, i) => ({ id: nm.toLowerCase().replace(/\W/g, ''), name: nm, weight: share[i], countBest: 0, parts: [{ name: '', outOf: [20, 20, 60, 80][i % 4] }] })), professors: pr.length ? [pick(pr)] : [], updatedAt: ts(now - int(1, 60) * DAY), updatedBy: { email: ownerA.email, name: ownerA.name }, auditId: audit(ownerA, 'publish offering', p, c) });
      aoff[r[0]] = (aoff[r[0]] ?? 0) + 1;
    }
    put(`heads/${c}`, { ...get(`heads/${c}`), offerings: aoff });

    // ---- timetable of the next semester ---------------------------------------------
    const sem = '2026-2', tt = `timetable/${c}|${sem}`;
    if (fresh(tt)) {
      const cur = get(`timetable/${c}|2026-1`);
      const courses2 = {};
      for (const r of Array.from({ length: n(40) }, () => pick(rows))) courses2[r[0]] = { t: r[1], cr: r[2], sec: [{ ty: 'L', no: 1, prof: ['A Teacher'], room: `F${int(100, 399)}`, slots: [{ d: int(1, 5), s: 540, e: 600 }, { d: int(1, 5), s: 660, e: 720 }] }, { ty: 'T', no: 1, prof: [], room: `G${int(10, 99)}`, slots: [{ d: int(1, 5), s: 840, e: 900 }] }], compre: { d: '2027-05-10', slot: 'FN', s: 570, e: 750 } };
      put(`${tt}|0`, { n: 0, courses: courses2 });
      put(tt, { v: 1, sem, campus: c, hours: cur?.hours ?? { 1: [480, 540] }, examSlots: cur?.examSlots ?? { FN: [570, 750], AN: [840, 1020] }, events: [{ from: '2027-01-04', title: 'Instruction begins', kind: 'term' }, { from: '2027-03-10', to: '2027-03-15', title: 'Midsem exams', kind: 'exam' }], chunks: 1, publishedAt: ts(now - 20 * DAY), marker: cur?.marker ?? 2, auditId: audit(ownerA, 'publish timetable', tt, c) });
    }

    // ---- claims, volunteers --------------------------------------------------------
    for (const r of Array.from({ length: n(6) }, () => pick(rows.filter((x) => deptOf(x[0]) === 'GEN'))).filter(Boolean)) {
      const p = `courseClaims/${c}|${r[0]}`;
      if (!fresh(p)) continue;
      const pres = poster(c);
      const dept = grants.find((g) => g.email === pres.email && g.role === 'dept')?.scope ?? 'CS';
      put(p, { campus: c, courseId: r[0], dept, by: { email: pres.email, name: pres.name }, at: ts(now - int(1, 100) * DAY), auditId: audit(pres, `Claimed ${r[0]} for ${dept}`, p, c, dept) });
      bump(c, 'courseClaims');
    }
    for (const x of takePeople(c, n(14))) {
      const r = pick(courses), d = deptOf(r[0]), open = rnd() < 0.7, p = `volunteers/${c}|${r[0]}|${x.email}`;
      if (!fresh(p)) continue;
      put(p, { name: x.name, email: x.email, campus: c, courseId: r[0], dept: d, term, open, createdAt: ts(now - int(1, 60) * DAY), ...(open ? {} : { closedBy: { email: x.email, name: x.name } }) });
      bump(c, `volunteers/${d}`);
    }

    // ---- directory + staffContacts for holders that lack them -------------------------
    const rep = structuredClone(get(`repIndex/${c}`) ?? { k: `sd${seed}`, p: {} });
    for (const g of grants.filter((x) => (x.role === 'dept' || x.role === 'course') && x.campus === c && liveGrant(x)).slice(0, n(30))) {
      const e = g.email.toLowerCase();
      if (!fresh(`directory/${e}`) || rep.p[e]) continue;
      const phone = `9${int(100000000, 999999999)}`;
      const entry = { name: g.name, campus: c, roles: [{ role: g.role, scope: g.scope, ...(g.programme ? { programme: g.programme } : {}), ...(g.secretary ? { secretary: true } : {}), until: g.expiresAt }], email: e, whatsapp: phone, updatedAt: ts(now - int(1, 60) * DAY) };
      put(`directory/${e}`, entry);
      rep.p[e] = entry;
      if (fresh(`staffContacts/${e}`)) put(`staffContacts/${e}`, { name: g.name, phone: `+91 ${phone}`, email: e, updatedAt: ts(now - int(1, 60) * DAY) });
    }
    put(`repIndex/${c}`, rep);
    bump(c, 'reps');

    // ---- search hints, activity -------------------------------------------------------
    const sh = structuredClone(get(`searchHints/${c}`) ?? { q: {}, k: 'a', t: 'b' });
    for (const [pth, x] of [...base].filter(([p, x]) => p.startsWith('professors/') && x.campus === c && !x.removed).slice(0, n(40))) {
      const full = x.name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40), k = full.split(' ').at(-1);
      if (!k || k === full) continue;
      sh.q[k] = { ...(sh.q[k] ?? {}), [full]: (sh.q[k]?.[full] ?? 0) + int(1, 6) };
    }
    put(`searchHints/${c}`, sh);
    const act = structuredClone(get(`activity/${c}`) ?? { course: {}, dept: {}, c: '', d: '' });
    for (const r of cs.slice(0, n(30))) act.course[r[0]] ??= ts(now - int(1, 600) * DAY);
    for (const d of DEPTS) act.dept[d] ??= ts(now - int(1, 700) * DAY);
    put(`activity/${c}`, act);
  }

  // ---- votes and reports on existing reviews (entries and their mirror stay equal) ----
  const entries = [...base].filter(([p]) => /^reviews\/[^/]+\/entries\/[^/]+$/.test(p) && !base.get(p).hidden);
  const target = Math.min(entries.length, n(260));
  for (let i = 0; i < target; i++) {
    const [p, e] = entries[int(0, entries.length - 1)];
    const cur = get(p), [, c, , id] = p.split('/');
    const voters = byCampus[e.campus] ?? [];
    if (!voters.length) continue;
    const nv = int(1, 3);
    let added = 0, reported = 0;
    for (let k = 0; k < nv; k++) {
      const v = pick(voters), vid = sha((uidOf.get(v.email) ?? v.email) + id);
      if (!fresh(`${p}/votes/${vid}`)) continue;
      put(`${p}/votes/${vid}`, { createdAt: ts(now - int(0, 90) * DAY) });
      added++;
    }
    if (rnd() < 0.1) {
      const v = pick(voters), rid = sha((uidOf.get(v.email) ?? v.email) + id);
      if (fresh(`${p}/reports/${rid}`)) { put(`${p}/reports/${rid}`, { createdAt: ts(now - int(0, 30) * DAY) }); reported++; }
    }
    if (!added && !reported) continue;
    put(p, { ...cur, helpful: (cur.helpful ?? 0) + added, reports: (cur.reports ?? 0) + reported });
    const mp = `reviews/${c}/campus/${e.campus}`, m = get(mp);
    if (m?.r?.[id]) put(mp, { ...m, r: { ...m.r, [id]: { ...m.r[id], helpful: (m.r[id].helpful ?? 0) + added } } });
    bump(e.campus, `reviews/${c}`);
  }

  // ---- markers: every kind of data that moved gets its marker on its campus head -----------
  for (const [c, keys] of deptBumps) {
    const h = get(`heads/${c}`);
    if (!h) continue;
    const v = { ...(h.v ?? {}) };
    for (const k of keys) v[k] = (v[k] ?? 0) + 1;
    put(`heads/${c}`, { ...h, v });
  }
  const changed = [...out].filter(([p, d]) => JSON.stringify(base.get(p)) !== JSON.stringify(d)).map(([path, data]) => ({ path, data }));
  const merged = new Map(base);
  for (const d of changed) merged.set(d.path, d.data);
  return { changed, docs: [...merged].map(([path, data]) => ({ path, data })) };
}

export function runSharedDelta(a) {
  const baseDir = path.resolve(a.base);
  const r = sharedDelta(readDocs(baseDir), readAuth(baseDir), { seed: Number(a.seed ?? 9), scale: Number(a.scale ?? 1.8) });
  const budget = Number(a.budget ?? 6000);
  const by = {};
  for (const d of r.changed) by[d.path.split('/')[0]] = (by[d.path.split('/')[0]] ?? 0) + 1;
  console.log(`Delta: ${r.changed.length} documents differ from the base (the write count of the load). By collection:`, JSON.stringify(by));
  if (r.changed.length > budget) throw new Error(`${r.changed.length} writes is over the budget of ${budget}: lower --scale (now ${a.scale ?? 1.8}).`);
  const out = path.resolve(a.out);
  mkdirSync(out, { recursive: true });
  writeDocs(out, r.docs, readAuth(baseDir));
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ sharedDelta: true, base: baseDir, changed: r.changed.length }, null, 1));
  console.log(`Wrote ${out} (base + delta, ${r.docs.length} documents). Load: load.mjs --in ${out} --target staging --skip-same-as ${baseDir}`);
}
