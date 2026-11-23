# Rules backtest

Proves that a new `firestore.rules` keeps production users, data and the already-deployed
stable/beta apps working, or lists exactly what changes. Production runs the *old* rules and
*old* apps against the *same* Firestore, so every release must pass this before the rules deploy.

```sh
export PATH=$HOME/.local/bin:$HOME/development/flutter/bin:$PATH
node tools/backtest/rules/run.mjs                              # origin/master vs HEAD
node tools/backtest/rules/run.mjs --base origin/pointer-beta   # the beta's rules
node tools/backtest/rules/run.mjs --only replay --only-scenario '^roles/'   # a subset
node tools/backtest/rules/run.mjs --export <json dump>         # production data, see below
node tools/backtest/rules/run.mjs --json out.json              # machine-readable result
```

Exit 0 = every difference is in `allowlist.json`. Exit 1 = a new difference; the output names it.
Needs the Firestore emulator (started per run, project `demo-pointer`, port 8085; nothing is left
running) and `/tmp/pointer-heavy.sh` (used when present). **About 12–20 minutes**, of which the
old-suite part is ~7 (two modes plus the re-run of failures) and the replay part the rest.

## What it checks

1. **Old suites vs new rules** (`suites.mjs`). Production has no `test/` (DEV_ONLY), so the old
   suites are taken from the last pointer-dev commit whose `firestore.rules` equals `<base>`'s
   (`baseTestsCommit`; override with `--tests-ref`). They run against the NEW rules twice:
   *unseeded* (no `roles/builtin`: the state at deploy) and *seeded* (after Controls › Roles saved it;
   `helpers.mjs` is patched in the temp copy only). A failing test is re-run with the suites' ADMIN
   moved to a Goa address (`+adminOnGoa`); if it then passes the failure is the owner-ruled campus
   separation, otherwise it is reported `BREAK?`.
2. **Replay** (`replay.mjs`, `scenarios.mjs`). The stable app's writes and reads, with the payload
   shapes of `lib/` at the base ref, run as every production actor (student, CR, president,
   secretary, campus admins, owner, contributor, president+CR+contributor, admin+president, other
   campus, faculty) on `fixtures/prod_shapes.json`, under three rule sets on one emulator: old,
   new, new+`roles/builtin`. Any old≠new cell is a difference. Lookup/expression budget overruns show
   up here as old-allowed, new-denied for the heaviest actors (compare the `new` and `newB` columns).
3. **Corruption** (`corruption.mjs`). (a) damaged writes even a privileged actor must be refused
   (wrong types, null, millis for Timestamp, huge values, unknown/forged keys, dangling `roleId`,
   forged reach); (b) damaged stored docs (grant without expiry, staff without grant, partial terms,
   broken heads/users docs, a custom grant whose role was deleted, garbage `roles/builtin`) must give
   the same results as under the old rules. `info: true` scenarios are printed, never failed.

## Reading the output

`held` = old and new agree. `intended` = differs, with an allow-list reason. `UNEXPECTED` / `BREAK?`
= a finding; run `--only replay --only-scenario '<id>' --json x.json` to iterate on it.
In a replay row, `o` = allowed, `-` = denied, in the order old/new/new+builtin.

## Extending

- New call site in the app → add a scenario to `scenarios.mjs` (payload shape cited from `lib/`).
- New collection, doc shape or role → add a doc to `fixtures/prod_shapes.json` (`{"$ts": days}` is a
  Timestamp relative to now, `{"$delete":true}` drops a field) and a scenario.
- New corruption → a line in `corruption.mjs` naming a base scenario plus a `seed` overlay
  (`null` removes a fixture doc), or a bad payload with `expectNew: 'deny'`.
- New intended change → an entry in `allowlist.json` (`section` `suites`|`replay`, `reason`, plus
  `file`/`test` for suites; for replay `test` is a regex over `"<scenario id>@<ACTOR>"`).
  Delete entries once the change has shipped and the old rules are retired.
- New builtin cap → update `fixtures/default_caps.json` and the `__caps` list in `suites.mjs`
  (they must equal `builtin()` in `firestore.rules`).

## Production export (owner only)

`--export <file.json>` overlays `{ "collection/doc": {fields} }` (Timestamps as
`{"$tsMs": millis}`) onto the fixture in the emulator, so every replay and corruption scenario
runs on real grants/staff/terms. Keep the file outside the repo (e.g. `sensitive_data_NO_COMMIT/`);
it is read only into the emulator. Scenario actors stay the fixture's; add the real addresses to
`fixtures/prod_shapes.json` `actors` if you want to replay as them. Not exercised with real data
by the authors (only the fixture).

## Not covered (see the report for the current list)

Device storage (Hive/cache) and the app's decoding of damaged docs belong to the app part
(`tools/backtest/app`). Generating fixtures from the old app's Dart encoders is not done here:
shapes are copied from the stable `lib/` write sites by hand and cited in `scenarios.mjs`.
