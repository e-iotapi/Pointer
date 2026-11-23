# App and data backtest

Before every production push, prove that existing users, their data and the
stable/beta apps keep working. This part covers the **app and data**: the new
app on old data, old app on new data, device upgrade, `users/{uid}` sync. (Rules
behaviour old vs new is the sibling `tools/backtest/rules`.)

## Run (before each push)

```sh
tools/backtest/app/run.sh                          # base origin/master vs HEAD
tools/backtest/app/run.sh --base origin/pointer-beta
tools/backtest/app/run.sh --export <dump.json>     # also check a production export
```

About 5 minutes (heavy steps go through `/tmp/pointer-heavy.sh`; the base tree's
`flutter pub get --offline` and compile are most of it). Exit 0 = nothing
unexpected; non-zero = findings, listed in the summary
(`build/backtest/<ref>_<sha>/summary.md`, raw outcomes in `results/`).

## What it does

1. **Extracts the base ref** (`git archive`) into `build/backtest/<ref>/old`,
   a complete Flutter package, and adds the harness. Nothing of the base is
   copied by hand: every release compares any two refs.
2. **Base build writes the fixtures** (`old_side/gen_old.dart.old`): the old
   app's own encoders create production-shaped Firestore documents (grants,
   staff, audit, heads, config, gate, owners, people) and the device storage it
   leaves behind (the cached roles JSON, `cacheFirst` entries for roster, audit,
   terms, owners, gate, hints, directory, `workingAs`, `previewCampus`, prefs),
   plus a `users/{uid}` sync document. Shapes no harness encoder makes live in
   `fixtures/hand_docs.json` (contributor grants, early builds' millis dates,
   hints, directory, `config/public`).
3. **New build on old data** (`test/backtest/old_docs_test.dart`,
   `device_upgrade_test.dart`, `sync_roundtrip_test.dart`): asserts roles,
   `may()`, defaults when `roles/builtin` is missing, `config/grantTerms`, gate
   with `dept`, restore of old caches, old->new->old sync.
4. **Differential probes** (`probes_test.dart`, `common/probes.dart`): the same
   code runs against the base and the new build: a `may()` matrix (10 personas x
   every capability x 4 campuses x 6 scopes), ~120 damaged-document cases
   (missing/wrong-typed/huge/unknown fields, Timestamp vs millis, staff without
   reach, dangling custom grants) and 25 damaged device-storage cases (truncated
   roles JSON, unknown `workingAs`, invalid `previewCampus`, ...). `run.mjs`
   diffs the outcomes. A difference is **intended** only when `allowlist.json`
   has an entry with a reason; the rest are findings. A case that throws on the
   new side and not on the base is a regression.
5. **Mixed fleet** (`gen_new_docs_test.dart`, `old_side/mixed_fleet.dart.old`):
   the new app's own stores write custom roles, staff with `reach`,
   `roles/builtin`, the `config/grantTerms` mirror, custom grants, gate docs
   without `dept`, negative search votes; the **base build's code** then reads
   and writes them. `throws:*` / `BREAK:*` outcomes are findings.
6. **Emulator proof** (`test/rules/backtest_app_mixed.test.mjs`): where a
   finding depends on the rules, the stable app's exact write and the new app's
   next write go through `firestore.rules` on the emulator.
7. **Sync surface**: `lib/sync.dart`, `course*`, models, storage, grading, cache,
   prefs are diffed against the base; both builds push the same boxes and must
   write byte-identical documents.

## Reading the output

`[break]` = a user or app that worked before fails; `[review]` = behaviour
differs and nobody ruled on it. "held" counts what was compared and matched.
Tests that prove a known break are named `BREAK <id>`; they are skipped in the
normal `flutter test` / rules suites (so those stay green) and run here
(`BACKTEST_RUN=1`).

## Extending

- **New collection or document shape**: add the doc to `fixtures/hand_docs.json`
  (or to the scenario in `gen_old.dart.old` if the old encoder can write it),
  then a read in `old_docs_test.dart`; if the app parses it with a new function,
  add damaged variants to `common/probes.dart` (`docProbes`).
- **New Hive box or cache key**: put an entry in `gen_old.dart.old`'s device
  section (written by the base's own code), assert it in `device_upgrade_test.dart`,
  add damaged variants to `deviceProbes`. New personal boxes also belong in
  `common/sync_probe.dart`'s `fillBoxes`.
- **New capability / role**: nothing to do; the matrix covers every capability the
  base also knows. New-only capabilities are noted, not compared.
- **An intended change**: add an entry to `allowlist.json` with the reason (owner
  ruling and date). After the release ships, delete it (the base now has it).
- **A fixed break**: its `BREAK` test starts passing; keep it as a regression test
  (rename without `breakTest`).
- Probes use only APIs present in both builds; if the base lacks one, add a
  version-specific test under `old_side/`.

## Real production data

`--export <file>` takes a flat JSON map `{"grants/<id>": {...}, "staff/<email>":
{...}}` (`{"$ts": millis}` for Timestamps), outside the repo (e.g.
`sensitive_data_NO_COMMIT/`). It is loaded into a fake Firestore only; every
grant/staff/directory document is parsed and every holder's `loadMine` answered
by both builds, and the outcomes are diffed. Never commit an export. (Tested with
the fixtures only; the toolset never obtains or reads real data.)

## Not covered

Browser end-to-end journeys (`tools/e2e`) on both builds: see the report; the
Dart harness covers the app logic they exercise. Rules old-vs-new is the rules
part's job.
