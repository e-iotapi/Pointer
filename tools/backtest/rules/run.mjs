#!/usr/bin/env node
// Rules backtest: node tools/backtest/rules/run.mjs [--base origin/master] [--head HEAD]
//   [--tests-ref <commit>] [--export <json dump>] [--only suites|replay] [--only-scenario <regex>] [--json <file>]
// Exit 1 on any difference not covered by allowlist.json. See README.md.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, ROOT, allowed, emulatorExec, git, loadAllow, readJsonl, show, workdir } from './lib.mjs';
import { runSuites } from './suites.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const base = arg('base', 'origin/master'); const head = arg('head', 'HEAD');
const only = arg('only'); const allow = loadAllow();
const from = arg('from') ? JSON.parse(readFileSync(arg('from'), 'utf8')) : null; // --from <result.json>: re-judge a saved run against the allow-list
const result = { base, head, baseRules: git('rev-parse', `${base}:firestore.rules`).slice(0, 8), headRules: git('rev-parse', `${head}:firestore.rules`).slice(0, 8) };
const unexpected = [];
console.log(`rules: base ${base} (${result.baseRules}) vs head ${head} (${result.headRules})${result.baseRules === result.headRules ? ' IDENTICAL' : ''}`);

if (only !== 'replay') {
  const t0 = Date.now();
  const s = from ? { testsCommit: from.suites.testsCommit, rows: from.suites.rows } : runSuites({ base, head, testsRef: arg('tests-ref') });
  result.suites = { testsCommit: s.testsCommit.slice(0, 8), secs: Math.round((Date.now() - t0) / 1e3), rows: s.rows };
  const modes = [...new Set(s.rows.map((r) => r.mode))];
  console.log(`\n== old suites (${s.testsCommit.slice(0, 8)}) vs new rules`);
  for (const m of modes) {
    const rows = s.rows.filter((r) => r.mode === m);
    console.log(`  ${m}: ${rows.filter((r) => r.ok).length} pass, ${rows.filter((r) => !r.ok).length} fail`);
  }
  for (const r of s.rows.filter((r) => !r.ok && !r.mode.endsWith('adminOnGoa'))) {
    // Exonerated by the same-campus variant, or named in the allow-list.
    const same = s.rows.find((x) => x.mode === `${r.mode}+adminOnGoa` && x.file === r.file && x.name === r.name);
    const a = allowed(allow, 'suites', r);
    r.class = a ? `intended: ${a.reason}` : same?.ok ? 'intended: passes when the suite admin acts on their own campus (campus separation)' : 'BREAK?';
    if (r.class === 'BREAK?') { unexpected.push(`suite ${r.mode} ${r.file} :: ${r.name}`); console.log(`  UNEXPECTED ${r.mode} ${r.file} :: ${r.name}\n     ${r.err}`); }
  }
}

if (only !== 'suites') {
  const t0 = Date.now();
  let rows; let d;
  if (from) rows = from.replay.rows; else {
    d = workdir({ rulesFrom: () => (arg('head-rules') ? readFileSync(arg('head-rules'), 'utf8') : show(head, 'firestore.rules')) }); // --head-rules <file>: try a candidate fix
    mkdirSync(join(d, 'bt'));
    for (const f of ['replay.mjs', 'scenarios.mjs', 'corruption.mjs']) cpSync(join(HERE, f), join(d, 'bt', f));
    cpSync(join(HERE, 'fixtures'), join(d, 'bt/fixtures'), { recursive: true });
    writeFileSync(join(d, 'old.rules'), show(base, 'firestore.rules'));
    const out = join(d, 'replay.jsonl');
    const r = emulatorExec(d, 'node bt/replay.mjs', {
      BT_OLD_RULES: join(d, 'old.rules'), BT_NEW_RULES: join(d, 'firestore.rules'), BT_OUT: out,
      BT_FIXTURE: join(d, 'bt/fixtures/prod_shapes.json'), ...(arg('export') ? { BT_EXPORT: arg('export') } : {}),
      ...(arg('only-scenario') ? { BT_ONLY: arg('only-scenario') } : {}) });
    try { const lg = readFileSync(join(d, 'firestore-debug.log'), 'utf8'); result.budgetErrors = (lg.match(/maximum of \d+ (expressions|lookups|accesses)/g) ?? []).length; } catch { /* no log */ }
    rows = readJsonl(out);
    if (!rows.length) throw new Error(`replay produced nothing:\n${r.stdout}\n${r.stderr}`);

  }
  const okc = (x) => (x.ok ? 'ok' : 'DENY');
  let held = 0, intended = 0, brk = 0, info = 0, preex = 0;
  for (const x of rows) {
    const diff = x.old.ok !== x.new.ok || x.old.ok !== x.newB.ok;
    // corruption writes: a new hole = new accepts what old refused; both accepting is pre-existing.
    const pre = x.expectNew === 'deny' && (x.new.ok || x.newB.ok) && x.old.ok;
    const bad = x.expectNew === 'deny' ? (x.new.ok || x.newB.ok) && !x.old.ok : diff;
    if (pre) { x.status = 'pre-existing'; x.reason = 'accepted by the old rules too'; preex++; continue; }
    x.status = 'held';
    if (bad && x.info) { x.status = 'info'; info++; } else if (bad) {
      const a = allowed(allow, 'replay', { file: undefined, name: `${x.id}@${x.actor}` });
      x.status = a ? 'intended' : 'BREAK'; x.reason = a?.reason;
      if (a) intended++; else { brk++; unexpected.push(`replay ${x.id} as ${x.actor}: old=${okc(x.old)} new=${okc(x.new)} newB=${okc(x.newB)}`); }
    } else held++;
  }
  result.replay = { secs: Math.round((Date.now() - t0) / 1e3), held, intended, info, preexisting: preex, breaks: brk, rows };
  if (result.budgetErrors !== undefined) console.log(`\n(emulator log: ${result.budgetErrors} budget-limit evaluation errors across all cells, many in cells denied on purpose; a budget break is an old=ok / new=DENY cell)`);
  console.log(`\n== replay: ${rows.length} scenario×actor cells; held ${held}, intended ${intended}, info-only ${info}, pre-existing ${preex}, UNEXPECTED ${brk}`);
  for (const x of rows.filter((x) => x.status === 'BREAK')) console.log(`  BREAK ${x.id} as ${x.actor}: old=${okc(x.old)} new=${okc(x.new)} newB=${okc(x.newB)} ${x.new.err ?? x.newB.err ?? ''}`);
  if (from) { /* nothing to clean */ } else if (process.argv.includes('--keep')) console.log(`workdir kept: ${d} (firestore-debug.log has the emulator's rule traces)`); else rmSync(d, { recursive: true, force: true });
}
if (arg('json')) writeFileSync(arg('json'), JSON.stringify(result, null, 1));
console.log(unexpected.length ? `\nFAIL: ${unexpected.length} unexpected difference(s)` : '\nPASS: no unexpected differences');
process.exit(unexpected.length ? 1 : 0);
