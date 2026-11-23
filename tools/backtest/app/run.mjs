#!/usr/bin/env node
// App and data backtest: the new app on old data, old app on new data, device
// upgrade, sync round trip. See README.md. Heavy steps go through
// /tmp/pointer-heavy.sh when it exists (one heavy job at a time).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
process.chdir(root);
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const base = opt('--base', 'origin/master');
const exportPath = opt('--export', null);
const skipRules = args.includes('--skip-rules');
const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
const heavy = fs.existsSync('/tmp/pointer-heavy.sh') ? ['/tmp/pointer-heavy.sh'] : [];
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const sha = git('rev-parse', '--short', base);
const tag = base.replace(/[^\w.-]/g, '_') + '_' + sha;
const out = path.join('build', 'backtest', tag);
const oldDir = path.join(out, 'old');
const fixDir = path.join(out, 'fixtures');
const res = path.join(out, 'results');
fs.rmSync(out, { recursive: true, force: true });
for (const d of [oldDir, fixDir, res]) fs.mkdirSync(d, { recursive: true });
const findings = []; // {severity, id, text}
const notes = [];
const log = (...m) => console.log(...m);
const abs = (p) => path.resolve(p);

// Allow-list (allowlist.json): every kind of finding can be ruled intended, one reason per entry.
const allow = JSON.parse(fs.readFileSync('tools/backtest/app/allowlist.json', 'utf8')).intended;
const used = new Set();
const intended = {};
const allowed = (kind, key, oldV, newV) => {
  const a = allow.find((e) => e.kind === kind && new RegExp(e.keyRegex).test(key) &&
    (e.old == null || String(oldV) === e.old) && (e.new == null || String(newV) === e.new) &&
    (e.oldRegex == null || new RegExp(e.oldRegex).test(String(oldV))) && (e.newRegex == null || new RegExp(e.newRegex).test(String(newV))));
  if (a) { used.add(a.id); (intended[a.id] ??= []).push(key); }
  return a;
};

// 1. Surface that must be byte-identical (users/{uid} sync, models, storage).
const SURFACE = ['lib/sync.dart', 'lib/course.dart', 'lib/course.g.dart', 'lib/core/models', 'lib/core/storage',
  'lib/core/grading', 'lib/core/cache', 'lib/core/prefs', 'lib/core/timings.dart', 'lib/main.dart', 'lib/script.dart'];
const surface = git('diff', '--name-only', base, 'HEAD', '--', ...SURFACE).split('\n').filter(Boolean);
log(`sync/model/storage surface vs ${base}: ${surface.length ? 'CHANGED ' + surface.join(', ') : 'unchanged'}`);
const changed = surface.filter((f) => !allowed('surface', f));
if (changed.length) findings.push({ id: 'surface-changed', severity: 'review', text: `Student-data code changed vs ${base}: ${changed.join(', ')}. Review the round-trip and add fixtures.` });

// 2. Extract the base tree and give it the harness.
log(`extracting ${base} (${sha}) ...`);
const arc = sh('sh', ['-c', `git archive ${base} lib pubspec.yaml pubspec.lock analysis_options.yaml build.yaml assets fonts | tar -x -C ${oldDir}`]);
if (arc.status) throw new Error(arc.stderr);
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
cp('test/backtest/common', path.join(oldDir, 'test/backtest/common'));
for (const f of ['probes_test.dart', 'sync_probe_test.dart', 'export_probe_test.dart']) cp(`test/backtest/${f}`, path.join(oldDir, 'test/backtest', f));
for (const f of fs.readdirSync('test/backtest/old_side')) {
  const dest = f.replace('.dart.old', '_test.dart');
  const src = fs.readFileSync(path.join('test/backtest/old_side', f), 'utf8').replace("'../common/support.dart'", "'common/support.dart'");
  fs.writeFileSync(path.join(oldDir, 'test/backtest', dest), src);
}
cp('tools/backtest/app/old_flutter_test_config.dart', path.join(oldDir, 'test/flutter_test_config.dart'));
cp('tools/backtest/app/fixtures', path.join(oldDir, 'tools/backtest/app/fixtures'));
cp('tools/backtest/app/fixtures', fixDir);

function flutter(cwd, files, env, name) {
  const jf = abs(path.join(res, `${name}.jsonl`));
  const r = sh(heavy[0] ?? 'flutter', [...heavy.slice(1), ...(heavy.length ? ['flutter'] : []), 'test', '--no-pub', '--file-reporter', `json:${jf}`, ...files],
    { cwd, env: { ...process.env, BACKTEST_OUT: abs(res), BACKTEST_FIXTURES: abs(fixDir), ...env } });
  const tests = new Map(), fails = [];
  if (fs.existsSync(jf)) {
    for (const l of fs.readFileSync(jf, 'utf8').split('\n')) {
      if (!l.startsWith('{')) continue;
      const e = JSON.parse(l);
      if (e.type === 'testStart') tests.set(e.test.id, e.test.name);
      if (e.type === 'testDone' && !e.hidden && e.result !== 'success' && !e.skipped) fails.push(tests.get(e.testID));
    }
  }
  return { status: r.status, fails: fails.filter((n) => n && !n.startsWith('loading ')), stderr: r.stderr, stdout: r.stdout, tests: [...tests.values()].filter((n) => !n.startsWith('loading ')) };
}
const short = (n) => n.replace(/^.*\/(\w+_test\.dart): /, '$1: ');

// 3. Base tree: pub get, then its own encoders write the fixtures and probes.
log('base tree: pub get ...');
const pubGet = (...extra) => sh(heavy[0] ?? 'flutter', [...heavy.slice(1), ...(heavy.length ? ['flutter'] : []), 'pub', 'get', ...extra], { cwd: oldDir });
let pg = pubGet('--offline');
if (pg.status) pg = pubGet(); // a fresh machine (CI) lacks the base's packages in its cache
if (pg.status) { console.error(pg.stdout, pg.stderr); throw new Error('flutter pub get failed in the base tree'); }
log('base tree: generate fixtures + probes ...');
let o = flutter(oldDir, ['test/backtest/gen_old_test.dart', 'test/backtest/probes_test.dart', 'test/backtest/sync_probe_test.dart'], { BACKTEST_SIDE: 'old' }, 'old_gen');
if (o.status) { console.error(o.stdout.slice(-3000)); throw new Error('base tree harness failed: ' + o.fails.join(', ')); }
for (const f of ['old_app_docs.json', 'old_storage.json']) cp(path.join(res, f), path.join(fixDir, f));
cp(path.join(res, 'old_sync.json'), path.join(fixDir, 'old_sync.json'));

// 4. New tree: generate the new-app documents, then every new-side test.
log('new tree: generate new-app documents ...');
let n = flutter('.', ['test/backtest/gen_new_docs_test.dart'], {}, 'new_gen');
if (n.status) { console.error(n.stdout.slice(-3000)); throw new Error('gen_new_docs failed'); }
cp(path.join(res, 'new_app_docs.json'), path.join(fixDir, 'new_app_docs.json'));
cp(path.join(res, 'new_app_docs.json'), path.join(oldDir, 'tools/backtest/app/fixtures/new_app_docs.json'));
log('base tree: stable app on new-app documents ...');
o = flutter(oldDir, ['test/backtest/mixed_fleet_test.dart'], { BACKTEST_SIDE: 'old' }, 'old_mixed');
if (o.status) { console.error(o.stdout.slice(-3000)); throw new Error('mixed_fleet failed'); }
log('new tree: probes, old-data, device upgrade, sync ...');
n = flutter('.', ['test/backtest'], { BACKTEST_RUN: '1', BACKTEST_SIDE: 'new' }, 'new_all');
const gens = ['gen_new_docs_test.dart'];
for (const f of n.fails) {
  const id = (f.match(/BREAK ([\w-]+)/) ?? [])[1];
  findings.push({ severity: id ? 'break' : 'break', id: id ?? short(f), source: 'flutter test', text: `new-side test failed: ${short(f)}` });
}
const ran = n.tests.length;

// 5. Differential outcomes.
const rd = (f) => JSON.parse(fs.readFileSync(path.join(res, f), 'utf8'));
const held = {};
for (const [kind, file] of [['may', 'may'], ['docs', 'docs'], ['device', 'device']]) {
  const a = rd(`old_${file}.json`), b = rd(`new_${file}.json`);
  let cmp = 0, diff = 0;
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    cmp++;
    if (a[k] === b[k]) continue;
    diff++;
    if (allowed(kind, k, a[k], b[k])) continue;
    const regress = kind !== 'may' && String(b[k]).startsWith('throws') && !String(a[k]).startsWith('throws');
    findings.push({ severity: regress ? 'break' : 'review', id: `${kind}:${k}`, source: 'differential', text: `${kind} ${k}: base ${a[k]} -> new ${b[k]}` });
  }
  held[kind] = { compared: cmp, differing: diff };
  const newOnly = Object.keys(b).filter((k) => !(k in a));
  if (newOnly.length) notes.push(`${kind}: ${newOnly.length} keys only on the new side (new capabilities): ${newOnly.slice(0, 3).join(', ')}…`);
}
// Stable app on new-app documents.
const mixed = rd('old_on_new.json');
let mixedOk = 0;
for (const [k, v] of Object.entries(mixed)) {
  if (/^(throws|BREAK)/.test(v) && !allowed('mixed', k, null, v)) findings.push({ severity: 'break', id: `mixed:${k}`, source: 'stable app on new docs', text: `${k}: ${v}` });
  else mixedOk++;
}
held.mixedFleet = { compared: Object.keys(mixed).length, ok: mixedOk };
// Sync byte-identity.
const so = rd('old_sync.json'), sn = rd('new_sync.json');
if (so.data !== sn.data || JSON.stringify(so.keys) !== JSON.stringify(sn.keys))
  findings.push({ severity: 'break', id: 'sync-differs', source: 'sync', text: 'Old and new write different users/{uid} documents for the same boxes.' });
held.sync = { identical: so.data === sn.data };

// 6. Rules-side mixed-fleet proof (emulator).
if (!skipRules) {
  log('rules: mixed fleet on the emulator ...');
  const r = sh(heavy[0] ?? 'firebase', [...heavy.slice(1), ...(heavy.length ? ['firebase'] : []), 'emulators:exec', '--only', 'firestore', '--project', 'demo-pointer',
    'BACKTEST_RUN=1 node --test --test-concurrency=1 test/rules/backtest_app_mixed.test.mjs']);
  const txt = (r.stdout ?? '') + (r.stderr ?? '');
  for (const m of txt.matchAll(/^\s*not ok \d+ - (BREAK [\w-]+)/gm))
    findings.push({ severity: 'break', id: m[1].replace('BREAK ', ''), source: 'rules emulator', text: `rules test failed: ${m[1]}` });
  held.rulesMixed = { passed: (txt.match(/^# pass (\d+)/m) ?? [])[1], failed: (txt.match(/^# fail (\d+)/m) ?? [])[1] };
}

// 7. Real data hook.
if (exportPath) {
  log(`real data hook: ${exportPath}`);
  const r = sh('node', ['tools/backtest/app/export_check.mjs', exportPath, abs(fixDir), abs(res), oldDir]);
  log(r.stdout); if (r.status) findings.push({ severity: 'break', id: 'export', source: 'export', text: r.stdout.slice(-1500) + r.stderr.slice(-500) });
}

// 8. Summary.
const stale = allow.filter((e) => !used.has(e.id) && !['custom-roles-are-new'].includes(e.id));
for (const e of stale) notes.push(`allow-list entry "${e.id}" matched nothing: remove it if the change shipped.`);
const lines = [`# App backtest: ${base} (${sha}) vs HEAD`, '',
  `new-side tests run: ${ran}; failed: ${n.fails.length}`,
  `held: ${JSON.stringify(held)}`,
  `intended differences: ${Object.entries(intended).map(([k, v]) => `${k} (${v.length})`).join(', ') || 'none'}`, ''];
for (const f of findings) lines.push(`- [${f.severity}] ${f.id}: ${f.text}`);
for (const t of notes) lines.push(`- note: ${t}`);
fs.writeFileSync(path.join(out, 'summary.md'), lines.join('\n'));
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ base, sha, findings, intended, held, notes }, null, 1));
log('\n' + lines.join('\n'));
log(`\nresults in ${out}`);
process.exit(findings.length ? 1 : 0);
