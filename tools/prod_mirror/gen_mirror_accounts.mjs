#!/usr/bin/env node
// Writes lib/core/env/test_accounts.g.dart from accounts.mirror.json (load.mjs writes it),
// for a staging build whose ?as= keys name mirrored people. Run, build, then
// `git checkout lib/core/env/test_accounts.g.dart`. Kept out of tools/test_env so that
// nothing here can start the staging reseed.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generate } from '../test_env/gen_accounts.mjs';
import { root } from './lib.mjs';

const [file, ...more] = process.argv.slice(2);
if (!file) { console.error('usage: gen_mirror_accounts.mjs <accounts.mirror.json> [<accounts.json to keep>]'); process.exit(2); }
const mirror = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
// the usual keys stay valid too, unless asked otherwise
const base = JSON.parse(readFileSync(path.resolve(more[0] ?? path.join(root, 'test_env', 'accounts.json')), 'utf8'));
const accounts = [...base.accounts, ...mirror.accounts.filter((a) => !base.accounts.some((b) => b.key === a.key))];
const out = path.join(root, 'lib', 'core', 'env', 'test_accounts.g.dart');
writeFileSync(out, generate({ ...base, accounts }));
console.log(`Wrote ${path.relative(root, out)}: ${base.accounts.length} usual keys + ${accounts.length - base.accounts.length} mirrored.`);
