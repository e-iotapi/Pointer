#!/usr/bin/env node
// EXPORT (the owner runs this). Reads every collection and subcollection of a
// Firestore project into typed JSON, plus the Auth user list (uid <-> email,
// which Firestore alone cannot give: it does not bill reads).
//
//   GOOGLE_APPLICATION_CREDENTIALS=key.json \
//     node tools/prod_mirror/export.mjs --project <id> --out <dir> \
//       [--collections a,b,group:entries] [--resume] [--max-reads 45000] [--no-auth]
//
// Read quota (Spark: 50k/day): every document read is counted and printed;
// --max-reads stops cleanly before the budget, and --resume continues the next
// day from the manifest. Against the emulator (FIRESTORE_EMULATOR_HOST set) it
// reads the emulator, which is how the tests exercise it.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { collectionsFromRules, encode, parseArgs } from './lib.mjs';

const PAGE = 500;

export async function runExport({ project, out, only, resume = false, maxReads = Infinity, auth = true, log = console.log }) {
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  if (!emulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key (read access) first.');
  }
  initializeApp({ projectId: project });
  const db = getFirestore();
  mkdirSync(out, { recursive: true });
  const file = path.join(out, 'docs.jsonl');
  const mf = path.join(out, 'manifest.json');
  const manifest = existsSync(mf) && resume
    ? JSON.parse(readFileSync(mf, 'utf8'))
    : { project, startedAt: new Date().toISOString(), units: {}, reads: 0, days: [] };
  if (existsSync(mf) && !resume) throw new Error(`${mf} exists: use --resume to continue, or pick an empty --out.`);
  if (!resume) writeFileSync(file, '');
  const save = () => writeFileSync(mf, JSON.stringify(manifest, null, 1));

  // Units: top-level collections from the rules plus any the project has
  // (listCollections is one cheap call), and collection groups for the
  // subcollections. A sample of docs is probed for subcollections the rules
  // do not name.
  const { top, sub } = collectionsFromRules();
  const live = (await db.listCollections()).map((c) => c.id);
  const extraTop = live.filter((c) => !top.includes(c) && !sub.includes(c));
  const extraSub = new Set();
  let reads = 0;
  if (!resume) {
    for (const c of live) {
      const probe = await db.collection(c).limit(3).get();
      reads += probe.size;
      for (const d of probe.docs) for (const sc of await d.ref.listCollections()) if (!sub.includes(sc.id)) extraSub.add(sc.id);
    }
    manifest.extraSub = [...extraSub];
    manifest.reads += reads;
  }
  for (const s of manifest.extraSub ?? []) extraSub.add(s);
  if (extraTop.length || extraSub.size) log(`Not in firestore.rules, exported anyway: ${[...extraTop, ...extraSub].join(', ')}`);
  let units = [...top, ...extraTop].map((c) => ({ id: c, group: false }))
    .concat([...sub, ...extraSub].map((c) => ({ id: `group:${c}`, group: true, name: c })));
  if (only) units = units.filter((u) => only.includes(u.id) || only.includes(u.name ?? u.id));

  const today = new Date().toISOString().slice(0, 10);
  let stopped = false;
  for (const u of units) {
    const st = (manifest.units[u.id] ??= { status: 'new', docs: 0 });
    if (st.status === 'done') continue;
    for (;;) {
      const limit = Math.min(PAGE, maxReads - reads);
      if (limit <= 0) { stopped = true; break; }
      let q = (u.group ? db.collectionGroup(u.name) : db.collection(u.id)).orderBy(FieldPath.documentId()).limit(limit);
      if (st.last) q = q.startAfter(db.doc(st.last));
      const snap = await q.get();
      reads += snap.size;
      if (snap.size) {
        appendFileSync(file, snap.docs.map((d) => JSON.stringify({ path: d.ref.path, data: encode(d.data()) })).join('\n') + '\n');
        st.last = snap.docs.at(-1).ref.path;
        st.docs += snap.size;
      }
      st.status = snap.size < limit ? 'done' : 'partial';
      manifest.reads += snap.size;
      save();
      if (st.status === 'done') break;
    }
    if (stopped) break;
    log(`${u.id}: ${st.docs} docs`);
  }
  if (!manifest.days.includes(today)) manifest.days.push(today);
  manifest.complete = units.every((u) => manifest.units[u.id]?.status === 'done');
  if (auth && !manifest.authDone) {
    const users = [];
    let token;
    do {
      const page = await getAuth().listUsers(1000, token);
      for (const x of page.users) users.push({ localId: x.uid, email: x.email ?? null, displayName: x.displayName ?? null, disabled: x.disabled });
      token = page.pageToken;
    } while (token);
    writeFileSync(path.join(out, 'auth.json'), JSON.stringify({ users }, null, 1));
    manifest.authDone = true;
    log(`Auth: ${users.length} users`);
  }
  save();
  log(`Read ${reads} documents this run (${manifest.reads} in total). ${manifest.complete ? 'Export complete.' : 'Not complete: run again with --resume (after the quota resets if you hit the budget).'}`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2), ['resume', 'no-auth']);
  if (!a.project || !a.out) {
    console.error('usage: export.mjs --project <id> --out <dir> [--collections a,b,group:entries] [--resume] [--max-reads N] [--no-auth]');
    process.exit(2);
  }
  await runExport({
    project: a.project, out: path.resolve(a.out), resume: a.resume, auth: !a['no-auth'],
    only: a.collections?.split(','), maxReads: a['max-reads'] ? Number(a['max-reads']) : Infinity,
  });
}
