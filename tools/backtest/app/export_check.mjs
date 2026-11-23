#!/usr/bin/env node
// Real-data hook: run the document checks on a production export the owner
// provides (never read or created by the toolset). Usage (via run.mjs --export):
//   <export.json> <fixtures dir> <results dir> <base tree>
// The export is a flat JSON map {"collection/id": {...}} in the fixture format
// ({"$ts": ms} for Timestamps); see README for converting an emulator export.
// The data stays on this machine: it is loaded into a fake Firestore only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [exp, fix, res, oldDir] = process.argv.slice(2);
const dump = JSON.parse(fs.readFileSync(exp, 'utf8'));
fs.writeFileSync(path.join(fix, 'export_docs.json'), JSON.stringify(dump));
fs.copyFileSync(path.join(fix, 'export_docs.json'), path.join(oldDir, 'tools/backtest/app/fixtures/export_docs.json'));
const heavy = fs.existsSync('/tmp/pointer-heavy.sh') ? ['/tmp/pointer-heavy.sh'] : [];
const run = (cwd, side) => spawnSync(heavy[0] ?? 'flutter', [...heavy.slice(1), ...(heavy.length ? ['flutter'] : []), 'test', '--no-pub', 'test/backtest/export_probe_test.dart'],
  { cwd, encoding: 'utf8', env: { ...process.env, BACKTEST_OUT: res, BACKTEST_FIXTURES: fix, BACKTEST_SIDE: side } });
const o = run(oldDir, 'old'), n = run('.', 'new');
if (o.status || n.status) { console.log((o.stdout + n.stdout).slice(-2000)); process.exit(1); }
const a = JSON.parse(fs.readFileSync(path.join(res, 'old_export.json'))), b = JSON.parse(fs.readFileSync(path.join(res, 'new_export.json')));
let bad = 0;
for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { bad++; console.log(`export ${k}: base ${JSON.stringify(a[k])} -> new ${JSON.stringify(b[k])}`); }
console.log(`export: ${Object.keys(a).length} checks, ${bad} differ`);
process.exit(bad ? 1 : 0);
