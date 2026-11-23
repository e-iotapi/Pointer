#!/usr/bin/env node
// LOAD: writes an anonymised (or synthetic) dataset into the emulator or the
// staging project, and creates sign-in accounts for a few of its people.
//
//   node tools/prod_mirror/load.mjs --in <dir> [--target emulator|staging]
//        [--sample N] [--daily-write-cap 18000] [--resume|--restart]
//        [--wipe] [--no-auth] [--all-auth]
//
// The emulator is the default and is wiped first. Staging needs an explicit
// --target staging, GOOGLE_APPLICATION_CREDENTIALS (a staging key; its
// project_id must be staging's) and STAGING_PASSWORD. Staging is a Spark
// project: 20k writes a day, so the load commits in batches, checkpoints in a
// state file next to the input, stops at the daily cap and continues with
// --resume after midnight Pacific. The production project is refused.
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { EMULATOR_PROJECT, PROD_PROJECT_ID, decode, pacificDay, parseArgs, readAuth, readDocs, root, sha256 } from './lib.mjs';

const BATCH = 400;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const STUDENT = /^[fhp]\d{4}\d+@(goa|hyderabad|pilani|dubai)\.bits-pilani\.ac\.in$/;
const emailIn = (p) => p.match(EMAIL)?.[0]?.toLowerCase();

// ---- who is who ----------------------------------------------------------

/** Grants as {id, role, campus, scope, email, secretary, live}. "Live" is judged at the data's own clock. */
export function grantsOf(docs) {
  const rows = docs.filter((d) => d.path.startsWith('grants/') && d.data);
  const clock = Math.max(0, ...rows.map((d) => d.data.grantedAt?.s ?? 0), ...docs.map((d) => d.data?.updatedAt?.s ?? 0));
  const now = clock || Math.floor(Date.now() / 1000);
  return rows.map((d) => ({
    id: d.path.slice(7), role: d.data.role, campus: d.data.campus, scope: d.data.scope, email: String(d.data.email ?? '').toLowerCase(),
    name: d.data.name, secretary: d.data.secretary === true, active: d.data.active !== false,
    live: d.data.active !== false && (d.data.expiresAt?.s ?? Infinity) > now,
  }));
}

/** One representative per kind of person, for sign-in. Order: owner first. */
export function pickIdentities(docs, auth) {
  const grants = grantsOf(docs);
  const uidOf = new Map(auth.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u.uid]));
  const hasUserDoc = new Set(docs.filter((d) => d.path.startsWith('users/')).map((d) => d.path.slice(6)));
  const nameOf = (e) => docs.find((d) => d.path === `people/${e}`)?.data?.name ?? e.split('@')[0];
  const picks = [];
  const add = (key, email, note) => {
    if (!email || picks.some((p) => p.key === key)) return;
    if (picks.some((p) => p.email === email)) return; // one account per person
    picks.push({ key, email, uid: uidOf.get(email), name: nameOf(email), note });
  };
  const first = (f) => grants.find((x) => f(x) && !picks.some((p) => p.email === x.email)) ?? grants.find(f);
  add('owner', docs.find((d) => d.path.startsWith('owners/') && d.data.active !== false)?.path.slice(7), 'owner');
  const g = (key, f, note) => { const x = first(f); if (x) add(key, x.email, `${note} ${x.campus}/${x.scope}`); };
  g('admin', (x) => x.role === 'admin' && x.live, 'campus admin');
  g('president', (x) => x.role === 'dept' && !x.secretary && x.live, 'president');
  g('secretary', (x) => x.role === 'dept' && x.secretary && x.live, 'secretary');
  g('cr', (x) => x.role === 'course' && x.live, 'CR');
  g('contributor', (x) => x.role === 'contributor' && x.live, 'contributor');
  g('custom', (x) => !['admin', 'dept', 'course', 'contributor'].includes(x.role) && x.live, 'custom role');
  g('expired', (x) => !x.live && x.role !== 'contributor', 'lapsed grant');
  const held = new Set(grants.map((x) => x.email));
  for (const campus of ['goa', 'pilani', 'hyderabad', 'dubai']) {
    const e = [...uidOf.keys()].sort().find((m) => STUDENT.test(m) && m.endsWith(`@${campus}.bits-pilani.ac.in`) && !held.has(m) && hasUserDoc.has(uidOf.get(m)));
    add(`student_${campus}`, e, `student, ${campus}`);
  }
  return picks.map((p) => ({ ...p, key: `mirror_${p.key}` }));
}

// ---- sampling -------------------------------------------------------------

const PERSON_COLLS = new Set(['grants', 'staff', 'staffContacts', 'directory', 'volunteers', 'people', 'contributors', 'contributorRequests', 'owners', 'usernames']);

/**
 * A consistent subset: every kind of person (one of each role/campus/state, the
 * edge cases), N students per campus, and N courses' worth of reviews, with
 * every reference between kept documents intact. Shared catalogue-like data
 * (heads, catalogue, offerings, resources, professors, timetable...) is kept whole.
 */
export function selectSample(docs, auth, n, { now = Math.floor(Date.now() / 1000) } = {}) {
  const uidOf = new Map(auth.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u.uid]));
  const emailOfUid = new Map([...uidOf].map(([e, u]) => [u, e]));
  const keep = new Set();
  const byColl = (c) => docs.filter((d) => d.path.startsWith(c + '/'));
  const rank = (s) => sha256('sample' + s);
  const bySha = (f) => (a, b) => (rank(f(a)) < rank(f(b)) ? -1 : 1);
  const campusOfPerson = (e) => e.split('@')[1]?.split('.')[0] ?? 'goa';
  // people: one of each (role, their campus, state), each multi-role combination, every request status
  for (const d of byColl('owners')) keep.add(d.path.slice(7));
  const stateOf = (g) => (g.handedTo ? 'handedOver' : g.active === false ? 'revoked' : g.expiresAt?.s < now ? 'expired' : g.expiresAt?.s < now + 14 * 86400 ? 'expiring' : 'live');
  const seenKind = new Set();
  const rolesOf = new Map();
  const grants = byColl('grants');
  for (const d of grants) (rolesOf.get(String(d.data.email).toLowerCase()) ?? rolesOf.set(String(d.data.email).toLowerCase(), []).get(String(d.data.email).toLowerCase())).push(d.data.role + (d.data.secretary ? '*' : ''));
  for (const d of [...grants].sort(bySha((x) => x.path))) {
    const g = d.data, e = String(g.email).toLowerCase();
    const kind = [g.role, campusOfPerson(e), stateOf(g), g.secretary === true].join('|');
    const multi = rolesOf.get(e).length > 1 ? `multi|${campusOfPerson(e)}|${[...new Set(rolesOf.get(e))].sort().join('+')}` : null;
    for (const k of [kind, multi]) if (k && !seenKind.has(k)) { seenKind.add(k); keep.add(e); }
  }
  for (const c of ['contributorRequests', 'volunteers']) {
    for (const d of byColl(c).sort(bySha((x) => x.path))) {
      const kind = c + (d.data.status ?? d.data.open ?? '') + (d.data.campus ?? '');
      if (!seenKind.has(kind)) { seenKind.add(kind); keep.add(String(d.data.email).toLowerCase()); }
    }
  }
  // students: n per campus, chosen to differ (has a snapshot, marks, dual degree, dormant, volunteer)
  const userOf = new Map(byColl('users').map((d) => [d.path.slice(6), d.data]));
  const volunteering = new Set(byColl('volunteers').map((d) => String(d.data.email).toLowerCase()));
  const feature = (e) => {
    const u = userOf.get(uidOf.get(e));
    let j = {};
    try { j = u ? JSON.parse(u.data) : {}; } catch { /* unreadable snapshot: a plain one */ }
    const disc = j.settingsBox?.find?.(([k]) => k === 'selecteddiscipline')?.[1] ?? '';
    const seen = docs.find((d) => d.path === `people/${e}`)?.data?.lastSeen;
    return [u ? 'u' : '-', j.marksBox?.length ? 'm' : '-', /^[AB]\d[AB]\d$/.test(disc) ? 'd' : '-', seen && seen < (now - 90 * 86400) * 1000 ? 'z' : '-', volunteering.has(e) ? 'v' : '-'].join('');
  };
  const students = byColl('people').map((d) => d.path.slice(7)).filter((e) => STUDENT.test(e));
  for (const campus of ['goa', 'pilani', 'hyderabad', 'dubai']) {
    const here = students.filter((e) => e.endsWith(`@${campus}.bits-pilani.ac.in`)).sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
    const picked = new Set(), shapes = new Set();
    for (const e of here) { const f = feature(e); if (!shapes.has(f) && picked.size < Math.max(n, 1)) { shapes.add(f); picked.add(e); } }
    for (const e of here) if (picked.size < n) picked.add(e);
    picked.forEach((e) => keep.add(e));
  }
  // courses with reviews: the busiest n, plus any with a hidden or reported review or votes
  const perCourse = new Map(), edge = new Set();
  for (const d of docs) {
    const m = /^reviews\/([^/]+)\/entries\/[0-9a-f]{64}(\/(votes|reports)\/.*)?$/.exec(d.path);
    if (!m) continue;
    if (m[2]) edge.add(m[1]);
    else {
      perCourse.set(m[1], (perCourse.get(m[1]) ?? 0) + 1);
      if (d.data.hidden === true || d.data.reports > 0 || d.data.reason) edge.add(m[1]);
    }
  }
  const courses = new Set([...perCourse].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map((x) => x[0]));
  for (const c of [...edge].sort().slice(0, Math.max(3, n))) courses.add(c);
  const out = [];
  for (const d of docs) {
    const [top, id] = d.path.split('/');
    let data = d.data;
    if (PERSON_COLLS.has(top)) {
      const e = top === 'usernames' ? String(data.email).toLowerCase() : emailIn(id);
      if (!keep.has(e)) continue;
    } else if (top === 'users') {
      if (!keep.has(emailOfUid.get(id))) continue;
    } else if (top === 'repIndex') {
      data = { ...data, p: Object.fromEntries(Object.entries(data.p ?? {}).filter(([e]) => keep.has(e.toLowerCase()))) };
    } else if (top === 'reviews' || (top === 'courses' && d.path.split('/')[2] === 'stats')) {
      if (!courses.has(id)) continue;
    } else if (top === 'reviewIndex') {
      data = { ...data, c: Object.fromEntries(Object.entries(data.c ?? {}).filter(([c]) => courses.has(c))) };
    } else if (top === 'signInLog' || top === 'reports') {
      continue;
    }
    out.push(data === d.data ? d : { ...d, data });
  }
  // audit rows: kept only when something kept points at them or a kept person acted
  const refs = new Set(out.map((d) => d.data?.auditId).filter(Boolean));
  return out.filter((d) => !d.path.startsWith('audit/') || refs.has(d.path.slice(6)) || keep.has(String(d.data?.actor?.email ?? '').toLowerCase()));
}

// ---- target ---------------------------------------------------------------

export function resolveTarget(target, env = process.env) {
  if (target === 'emulator' || !target) {
    return { kind: 'emulator', project: EMULATOR_PROJECT, firestoreHost: env.FIRESTORE_EMULATOR_HOST ?? 'localhost:8085', authHost: env.FIREBASE_AUTH_EMULATOR_HOST ?? 'localhost:9099' };
  }
  if (target !== 'staging') throw new Error(`--target is emulator or staging, not ${target}.`);
  const rc = JSON.parse(readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects ?? {};
  const project = rc.staging;
  if (!project || project === PROD_PROJECT_ID) throw new Error('.firebaserc has no staging project distinct from production.');
  if (env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is set: unset it, or you would load the emulator while thinking it is staging.');
  const key = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!key) throw new Error('Loading staging needs GOOGLE_APPLICATION_CREDENTIALS (the staging service-account key).');
  const keyProject = JSON.parse(readFileSync(key, 'utf8')).project_id;
  if (keyProject !== project) throw new Error(`The key belongs to project "${keyProject}", not staging ("${project}"). Refusing.`);
  return { kind: 'staging', project };
}

const lastCommit = (d) => (d.path.startsWith('heads/') || d.path === 'catalog/marker' || d.path.endsWith('|current') ? 1 : 0);
export const loadOrder = (docs) => [...docs].sort((a, b) => lastCommit(a) - lastCommit(b) || (a.path < b.path ? -1 : 1));

/** Commits [docs] in order, stopping at the daily cap; returns the number of docs now written. */
export async function writeDocs(db, docs, { start = 0, cap = Infinity, onBatch = () => {}, log = console.log } = {}) {
  let next = start;
  let written = 0;
  while (next < docs.length && written < cap) {
    const slice = docs.slice(next, next + Math.min(BATCH, cap - written));
    const b = db.batch();
    for (const d of slice) b.set(db.doc(d.path), decode(d.data, { Timestamp, GeoPoint, db }));
    await b.commit();
    next += slice.length;
    written += slice.length;
    onBatch(next, written);
  }
  return { next, written };
}

async function confirm(question, expected) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question}\nType "${expected}" to continue: `)).trim();
  rl.close();
  return a === expected;
}

/** Deletes every document in the project, up to [cap] deletes; run again to continue. */
export async function wipeProject(db, { cap = Infinity, log = console.log } = {}) {
  let deleted = 0;
  const writer = db.bulkWriter();
  writer.onWriteResult(() => { deleted++; });
  writer.onWriteError((e) => { log(`delete failed: ${e.message}`); return false; });
  for (const col of await db.listCollections()) {
    for (const ref of await col.listDocuments()) {
      if (deleted >= cap) break;
      await db.recursiveDelete(ref, writer);
    }
    if (deleted >= cap) break;
  }
  await writer.close();
  return deleted;
}

async function ensureUsers(auth, picks, password) {
  for (const p of picks) {
    try {
      const u = await auth.getUserByEmail(p.email);
      if (p.uid && u.uid !== p.uid) { await auth.deleteUser(u.uid); throw new Error('recreate'); }
      await auth.updateUser(u.uid, { password, displayName: p.name });
    } catch (e) {
      if (e.code && e.code !== 'auth/user-not-found') throw e;
      try {
        const u = await auth.createUser({ ...(p.uid ? { uid: p.uid } : {}), email: p.email, password, displayName: p.name, emailVerified: true });
        p.uid = u.uid;
      } catch (e2) {
        if (e2.code !== 'auth/uid-already-exists') throw e2;
        await auth.updateUser(p.uid, { email: p.email, password, displayName: p.name, emailVerified: true });
      }
    }
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2), ['resume', 'restart', 'wipe', 'no-auth', 'all-auth', 'keep', 'dry']);
  if (!a.in) { console.error('usage: load.mjs --in <dir> [--target emulator|staging] [--sample N] [--only prefix,prefix] [--skip-same-as <dir>] [--daily-write-cap N] [--resume|--restart] [--wipe] [--no-auth] [--all-auth]'); process.exit(2); }
  const inDir = path.resolve(a.in);
  const tgt = resolveTarget(a.target ?? 'emulator');
  if (tgt.kind === 'emulator') {
    process.env.FIRESTORE_EMULATOR_HOST = tgt.firestoreHost;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = tgt.authHost;
  }
  let docs = readDocs(inDir);
  const authUsers = readAuth(inDir);
  if (a.sample) docs = selectSample(docs, authUsers, Number(a.sample));
  // --only a,b: just the documents whose path starts with one of these (repairs after a reseed, see README)
  if (a.only) docs = docs.filter((d) => a.only.split(',').some((p) => d.path.startsWith(p)));
  // --skip-same-as <dir>: leave out what that dataset already holds unchanged (it was loaded before), so a combined set only writes the difference
  if (a['skip-same-as']) {
    const before = new Map(readDocs(path.resolve(a['skip-same-as'])).map((d) => [d.path, JSON.stringify(d.data)]));
    docs = docs.filter((d) => before.get(d.path) !== JSON.stringify(d.data));
  }
  docs = loadOrder(docs);
  const cap = tgt.kind === 'staging' ? Number(a['daily-write-cap'] ?? 18000) : Infinity;
  const planId = sha256(`${tgt.project}|${a.sample ?? ''}|${a.only ?? ''}|${a['skip-same-as'] ?? ''}|${docs.length}|${docs[0]?.path}|${docs.at(-1)?.path}`);
  const stateFile = path.join(inDir, `.load_state.${tgt.project}.json`);

  const password = tgt.kind === 'emulator' ? JSON.parse(readFileSync(path.join(root, 'test_env', 'accounts.json'), 'utf8')).password : process.env.STAGING_PASSWORD;
  if (a.dry) { console.log(`Plan: ${docs.length} documents would be written to ${tgt.kind} (${tgt.project}).`); process.exit(0); }
  initializeApp({ projectId: tgt.project });
  const db = getFirestore();
  console.log(`Target: ${tgt.kind} (${tgt.project}). ${docs.length} documents${a.sample ? ` (sample ${a.sample})` : ''}. Daily write cap: ${cap}.`);

  let state = { planId, next: 0, day: pacificDay(), today: 0, done: false };
  const wipeFirst = a.wipe || (tgt.kind === 'emulator' && !a.keep && !a.resume);
  if (wipeFirst) {
    if (tgt.kind === 'staging') {
      if (!(await confirm(`This deletes EVERY document in the staging project "${tgt.project}" (Auth users stay).`, tgt.project))) { console.log('Not confirmed. Nothing changed.'); process.exit(1); }
      const n = await wipeProject(db, { cap: Number(a['daily-delete-cap'] ?? 18000) });
      console.log(`Deleted ${n} documents.${n >= Number(a['daily-delete-cap'] ?? 18000) ? ' Cap reached: run with --wipe again tomorrow, then load.' : ''}`);
      if (n >= Number(a['daily-delete-cap'] ?? 18000)) process.exit(0);
    } else {
      const res = await fetch(`http://${tgt.firestoreHost}/emulator/v1/projects/${tgt.project}/databases/(default)/documents`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Emulator wipe failed: ${res.status}`);
    }
    if (existsSync(stateFile)) writeFileSync(stateFile, JSON.stringify(state));
  }
  if (tgt.kind === 'staging' && existsSync(stateFile) && !a.wipe) {
    const old = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (old.planId === planId && !old.done && !a.restart) {
      if (!a.resume) throw new Error(`A load is in progress (${old.next}/${docs.length}). Use --resume to continue, or --restart to start over.`);
      state = { ...old, today: old.day === pacificDay() ? old.today : 0, day: pacificDay() };
    } else if (old.planId === planId && old.done && !a.restart) {
      console.log('This load already finished. Use --restart to write it again.');
      process.exit(0);
    }
  }
  const save = () => tgt.kind === 'staging' && writeFileSync(stateFile, JSON.stringify(state));
  const room = cap - state.today;
  if (room <= 0) { console.log(`Today's write cap (${cap}) is used up. Resume after midnight Pacific.`); process.exit(0); }
  const todayStart = state.today;
  const r = await writeDocs(db, docs, {
    start: state.next, cap: room,
    onBatch: (next, w) => { state.next = next; state.today = todayStart + w; save(); process.stdout.write(`\r${next}/${docs.length}   `); },
  });
  state.done = state.next >= docs.length;
  save();
  console.log(`\nWrote ${r.written} documents this run; ${state.next}/${docs.length} in total.`);
  if (!state.done) {
    console.log(`Daily cap reached. Run the same command with --resume after midnight Pacific (${Math.ceil((docs.length - state.next) / cap)} more day(s)).`);
  }

  if (!a['no-auth'] && state.done) {
    const auth = getAuth();
    let picks = pickIdentities(docs, authUsers);
    if (a['all-auth']) {
      const have = new Set(picks.map((p) => p.email));
      for (const u of authUsers) if (u.email && !have.has(u.email.toLowerCase())) picks.push({ key: `mirror_${u.uid.slice(0, 8)}`, email: u.email.toLowerCase(), uid: u.uid, name: u.displayName ?? u.email, note: 'all-auth' });
    }
    await ensureUsers(auth, picks, password);
    console.log(`\nSign-in accounts (password: ${tgt.kind === 'emulator' ? 'the accounts.json one' : '$STAGING_PASSWORD'}). For the \`mirror\` list in test_env/accounts.json:`);
    console.log(JSON.stringify(picks.map((p) => ({ key: p.key, email: p.email })), null, 1));
    for (const p of picks) console.log(`  ?as=${p.key.padEnd(24)} ${p.note ?? ''}${p.uid ? '' : '  [no auth record in the export: signs in as a new user]'}`);
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
