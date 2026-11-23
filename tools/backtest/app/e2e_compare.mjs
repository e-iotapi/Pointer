// Compares the Playwright JSON of the base and the new build: a journey that
// passes on the base and fails on the new one is a finding (unless allow-listed
// under kind "e2e" in allowlist.json). Exit 1 on any such journey.
import fs from 'node:fs';
const load = (side) => {
  const out = new Map();
  const walk = (suite, trail) => {
    for (const x of suite.suites ?? []) walk(x, [...trail, x.title]);
    for (const sp of suite.specs ?? []) {
      const ok = sp.tests?.every((t) => t.results?.every((r) => r.status === 'passed' || r.status === 'skipped') ?? false);
      out.set([...trail, sp.title].join(' > '), ok ? 'pass' : 'FAIL');
    }
  };
  for (const s of JSON.parse(fs.readFileSync(`build/backtest/e2e/${side}.json`, 'utf8')).suites) walk(s, [s.title]);
  return out;
};
const o = load('old'), n = load('new');
const allow = JSON.parse(fs.readFileSync('tools/backtest/app/allowlist.json', 'utf8')).intended.filter((e) => e.kind === 'e2e');
let bad = 0;
for (const [k, v] of n) {
  const b = o.get(k);
  const a = allow.find((e) => new RegExp(e.keyRegex).test(k));
  if (b === 'pass' && v === 'FAIL') { if (a) console.log(`intended (${a.id}): ${k}`); else { bad++; console.log(`REGRESSION (passes on base, fails on new): ${k}`); } }
  else if (b === 'FAIL' && v === 'FAIL') console.log(`fails on both: ${k}`);
  else if (b === 'FAIL' && v === 'pass') console.log(`fixed on new: ${k}`);
}
console.log(`e2e: ${n.size} journeys; base pass ${[...o.values()].filter((x) => x === 'pass').length}, new pass ${[...n.values()].filter((x) => x === 'pass').length}; regressions ${bad}`);
process.exit(bad ? 1 : 0);
