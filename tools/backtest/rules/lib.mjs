// Shared helpers for tools/backtest/rules: git extraction, workdir, emulator runs, allow-list.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../../..');
export const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
export const show = (ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

/// The pointer-dev commit whose test/rules matches [ref]'s rules: production drops
/// test/ (DEV_ONLY), so the old suites come from the last commit before the first
/// rules change that follows the commit whose rules blob equals [ref]'s.
export function baseTestsCommit(ref, head = 'HEAD') {
  const want = git('rev-parse', `${ref}:firestore.rules`);
  const log = git('log', '--format=%H', head, '--', 'firestore.rules').split('\n'); // newest first
  const i = log.findIndex((c) => git('rev-parse', `${c}:firestore.rules`) === want);
  if (i < 0) throw new Error(`no commit on ${head} has the rules of ${ref}; pass --tests-ref`);
  if (i === 0) return head; // rules unchanged since the base
  return git('rev-parse', `${log[i - 1]}^`); // last commit still on the old rules
}

/// A temp tree {firestore.rules, firebase.json, test/rules/...} for node tests.
export function workdir({ rulesFrom, testsFrom, patchHelpers }) {
  const d = mkdtempSync(join(tmpdir(), 'bt-rules-'));
  mkdirSync(join(d, 'test/rules'), { recursive: true });
  writeFileSync(join(d, 'firestore.rules'), rulesFrom());
  writeFileSync(join(d, 'firestore.indexes.json'), show('HEAD', 'firestore.indexes.json'));
  writeFileSync(join(d, 'firebase.json'), JSON.stringify({
    firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
    emulators: { firestore: { port: 8085, host: '127.0.0.1' }, ui: { enabled: false } },
  }));
  if (testsFrom) {
    for (const f of git('ls-tree', '--name-only', testsFrom, 'test/rules/').split('\n')) {
      if (/\.(mjs|json)$/.test(f) && !f.endsWith('package-lock.json')) writeFileSync(join(d, f), show(testsFrom, f));
    }
    if (patchHelpers) {
      const p = join(d, 'test/rules/helpers.mjs');
      writeFileSync(p, patchHelpers(readFileSync(p, 'utf8')));
    }
  }
  symlinkSync(join(ROOT, 'test/rules/node_modules'), join(d, 'test/rules/node_modules'));
  symlinkSync(join(ROOT, 'test/rules/node_modules'), join(d, 'node_modules')); // for files under d/bt/
  return d;
}

/// Runs a node command under a fresh firestore emulator (via the heavy-job wrapper).
export function emulatorExec(cwd, cmd, env = {}) {
  const wrapper = process.env.BT_HEAVY ?? '/tmp/pointer-heavy.sh';
  const args = [...(existsSync(wrapper) ? [wrapper] : []), 'firebase', 'emulators:exec', '--only', 'firestore', '--project', 'demo-pointer', cmd];
  const [bin, ...rest] = args;
  return spawnSync(bin, rest, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 28 });
}

export const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/// allow-list entries: {id, reason, file?, test? (regex), mode? ('unseeded'|'seeded'|'*'), kind: 'intended'}
export function loadAllow() { return JSON.parse(readFileSync(join(HERE, 'allowlist.json'), 'utf8')); }
export function allowed(list, section, r) {
  return list.find((a) => a.section === section && (!a.file || a.file === r.file) && (!a.test || new RegExp(a.test).test(r.name)) && (!a.mode || a.mode === '*' || a.mode === r.mode));
}
export { rmSync, cpSync };
