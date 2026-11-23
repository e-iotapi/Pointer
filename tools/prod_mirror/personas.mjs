#!/usr/bin/env node
// PERSONAS: the seed's test accounts (student_full, president, owner, …) as a dataset that
// combine.mjs can merge into the mirror, keyed to the uids the staging Auth accounts
// already have, so every existing ?as= key keeps working without rebuilding the app.
//
//   1. node tools/prod_mirror/personas.mjs --lookup --out <dir>      (staging key; reads Auth only)
//   2. firebase emulators:start --only auth,firestore --project demo-pointer   (and the seed's
//      snapshots built: POINTER_SEED=1 flutter test tools/test_env/build_snapshots_test.dart)
//      node tools/prod_mirror/personas.mjs --build --out <dir>       (seeds the emulator with those uids, exports it)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { parseArgs, root } from './lib.mjs';
import { resolveTarget } from './load.mjs';

const a = parseArgs(process.argv.slice(2), ['lookup', 'build']);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!a.out || !(a.lookup || a.build)) { console.error('usage: personas.mjs --lookup|--build --out <dir>'); process.exit(2); }
  const out = path.resolve(a.out);
  const uidsFile = path.join(out, 'persona_uids.json');
  const accounts = JSON.parse(readFileSync(path.join(root, 'test_env', 'accounts.json'), 'utf8'));
  mkdirSync(out, { recursive: true });
  if (a.lookup) {
    const t = resolveTarget('staging', { ...process.env, STAGING_PASSWORD: process.env.STAGING_PASSWORD ?? 'lookup-only' });
    initializeApp({ projectId: t.project });
    const uids = {};
    for (const x of accounts.accounts) {
      try { uids[x.email] = (await getAuth().getUserByEmail(x.email)).uid; } catch { console.log(`no staging Auth account for ${x.key}: it will get a new uid`); }
    }
    writeFileSync(uidsFile, JSON.stringify(uids, null, 1));
    console.log(`Wrote ${Object.keys(uids).length} uids to ${uidsFile}`);
  } else {
    if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run with the emulators: set FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST.');
    initializeApp({ projectId: 'demo-pointer' });
    const uids = JSON.parse(readFileSync(uidsFile, 'utf8'));
    // seed.mjs reuses an Auth user it finds by email, so creating them with staging's uids first is all it takes
    for (const x of accounts.accounts) if (uids[x.email]) await getAuth().createUser({ uid: uids[x.email], email: x.email, password: accounts.password, displayName: x.name ?? x.key, emailVerified: true }).catch(() => {});
    execFileSync('node', [path.join(root, 'tools', 'test_env', 'seed.mjs')], { stdio: 'inherit' });
    execFileSync('node', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'export.mjs'), '--project', 'demo-pointer', '--out', path.join(out, 'personas')], { stdio: 'inherit' });
    writeFileSync(path.join(out, 'personas', 'manifest.json'), JSON.stringify({ personas: true }));
    console.log(`Personas dataset: ${path.join(out, 'personas')}`);
  }
  process.exit(0);
}
