// Every allow-list of intended differences: each entry names one reason, and its
// pattern compiles. T0 runs this; the tiers that diff (T2, T4) read the lists.
//   tools/backtest/rules/allowlist.json  rules old vs new (suites, replay)
//   tools/backtest/app/allowlist.json    app base vs new (may, docs, device, e2e journeys)
import { readFileSync } from 'node:fs';

const lists = {
  'tools/backtest/rules/allowlist.json': (j) => j,
  'tools/backtest/app/allowlist.json': (j) => j.intended,
};
let bad = 0;
for (const [file, entries] of Object.entries(lists)) {
  const seen = new Set();
  for (const [i, e] of entries(JSON.parse(readFileSync(file, 'utf8'))).entries()) {
    const at = `${file} #${i}${e.id ? ` (${e.id})` : ''}`;
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) { bad++; console.error(`${at}: no reason`); }
    if (e.id && seen.has(e.id)) { bad++; console.error(`${at}: duplicate id`); }
    seen.add(e.id);
    for (const k of ['test', 'keyRegex']) {
      try { if (e[k]) new RegExp(e[k]); } catch { bad++; console.error(`${at}: ${k} is not a valid regex`); }
    }
  }
}
process.exit(bad ? 1 : 0);
