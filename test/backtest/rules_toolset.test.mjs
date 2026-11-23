// Fast self-checks of tools/backtest/rules (no emulator): node --test test/backtest/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { baseTestsCommit, git, loadAllow } from '../../tools/backtest/rules/lib.mjs';

const R = new URL('../../tools/backtest/rules/', import.meta.url);
const read = (p) => readFileSync(new URL(p, R), 'utf8');

test('old suites come from a commit whose rules equal the base ref', () => {
  const c = baseTestsCommit('origin/master');
  assert.equal(git('rev-parse', `${c}:firestore.rules`), git('rev-parse', 'origin/master:firestore.rules'));
  assert.ok(git('ls-tree', '--name-only', c, 'test/rules/').includes('helpers.mjs'));
});

test('allow-list entries carry a reason and a known section', () => {
  for (const a of loadAllow()) {
    assert.ok(['suites', 'replay'].includes(a.section), JSON.stringify(a));
    assert.ok(a.reason && a.reason.length > 10, JSON.stringify(a));
  }
});

test('fixture: every grant has a person; every staff doc a grant; actors exist', () => {
  const f = JSON.parse(read('fixtures/prod_shapes.json'));
  const has = (p) => p in f.docs;
  for (const [p, d] of Object.entries(f.docs)) {
    if (p.startsWith('grants/')) assert.ok(has(`people/${d.email}`), p);
    if (p.startsWith('staff/')) assert.ok(has(`people/${d.email}`) || d.email === 'owner@gmail.com', p);
  }
  for (const e of Object.values(f.actors)) assert.ok(e.includes('@'), e);
  assert.ok(!has('roles/builtin'), 'production has no roles/builtin at deploy time');
  assert.ok(has('config/grantTerms'));
});

test('scenario ids are unique and corruption names real base scenarios', () => {
  const ids = [...read('scenarios.mjs').matchAll(/add\('([^']+)'/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate scenario id');
  for (const m of read('corruption.mjs').matchAll(/(?:stored|nd)\('[^']+', '([^']+)'/g)) {
    assert.ok(ids.includes(m[1]), `corruption.mjs names unknown scenario ${m[1]}`);
  }
});
