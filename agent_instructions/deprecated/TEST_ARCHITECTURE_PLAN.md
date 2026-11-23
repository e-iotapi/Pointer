> **Deprecated (2026-11-23, built):** the tiers, lanes, fixtures, allow-lists and CI wiring below exist. Kept for the reasoning and the before/after timings. Current source of truth: `docs/DEVELOPMENT.md` ("Tests and checks"), `agent_toolchains/README.md` ("Test tiers") and `tools/qa/run.sh`.

# Test architecture plan

Status: built 2026-11-23 (`tools/qa/run.sh --tier 0|1|2|3|4`). The open
decisions took the proposal: T0 + T1 on every push (`check.yml`), T2 on
pushes that touch the rules or roles (`qa.yml`), T3 + T4 locally and in
`release.yml` before a beta release (a gate: the release job needs them).

## Why

The suites test each version against itself, on fake or seeded data, one user
at a time. They missed what production hits: the stable app on new rules (a
custom grant crashes the old roster), damaged or old-format data, device
caches from an older build, and live updates between signed-in users (a new
appointee waits a week for their role; a write on another campus never
reaches that campus's open apps). They are also slow: the rules suite runs one
file at a time in one emulator project, and every heavy job on the machine
shares one lock.

## What was built

| Piece | Where |
|---|---|
| One entry point, one pass/fail table (run seconds and queued seconds per step) | `tools/qa/run.sh` |
| Two lanes (emulator, compute), each one job, gated on 2 GB free; re-entrant | `tools/qa/heavy.sh` (`/tmp/pointer-heavy.sh` execs it) |
| Rules files in parallel, one emulator project per file (`demo-r-<file>`) | `test/rules/helpers.mjs`, `RULES_JOBS` (4) |
| Playwright workers, one emulator project each (`demo-e2e-<n>`), Auth shared on `demo-pointer` | `tools/e2e/global_setup.mjs`, `E2E_WORKERS` (2), `window.pointerEmulatorProject` read by emulator builds |
| Shared production-shaped fixtures, versioned (v1), from the stable app's encoders + hand shapes | `test_env/fixtures/prod_shapes.json`, `tools/qa/fixtures.mjs` (`build`, `check`, `out rules|app|jsonl`) |
| Allow-lists, one reason per entry, every finding kind | `tools/backtest/{rules,app}/allowlist.json`, checked by `tools/qa/allowlists.mjs` |
| T3 live system on the fixtures | `tools/e2e/live.sh` (`LIVE_FIXTURES`), `specs/live/` (+ refused-connect retry) |
| T4 base and new builds side by side on fixtures + synthetic people + seed | `tools/qa/t4.sh`, `tools/backtest/app/e2e*.sh`, `tools/prod_mirror` (`synth`, `combine`, `load --project`), `seed.mjs --keep` |
| CI | `check.yml` (T0+T1, every push), `qa.yml` (T2 on rules/roles; T3+T4 via `release.yml`), Flutter pinned to 3.47.5 |

## Tiers

| Tier | Contents | When |
|---|---|---|
| T0 fast | analyzer vs baseline, `flutter test`, Worker vitest, tool unit tests, fixture + allow-list checks, `ui_check` (local only) | every push (CI) |
| T1 rules | rules suite, four files at once | every push (CI) |
| T2 compatibility | `tools/backtest/{rules,app}` vs `origin/master`, both also on the shared fixtures | rules or roles changes (CI); before a release |
| T3 live system | `wrangler dev` Worker + emulator + browsers: endpoints, instant cross-user and cross-campus updates, role grants reaching the grantee, Worker down, expired/refused token, reconnect, fallback | before a release (release.yml) |
| T4 production-like | e2e journeys, base and new builds, on fixtures + synthetic people + seed; a journey passing on the base and failing on the new build is a finding | before a release (release.yml) |

## Timings (this machine: 12 cores, ~2 GB free RAM, swapping)

Before = the same suites the way they ran before (one heavy job at a time,
one emulator project, no single command); after = `tools/qa/run.sh`.

| Tier | Before | After |
|---|---|---|
| T0 fast | ~234 s, by hand (verify.py + ui_check) | 234 s, one command |
| T1 rules | 250 s (one file at a time) | 148 s alone, 163 s beside T0 (4 files at once; 8 is no faster: one long file) |
| T0 + T1 | ~484 s (one lock) | ~305 s here, 318 s in CI |
| T2 compatibility | 17–25 min, two commands, one after the other | 17.4 min (rules 1,044 s and app 583 s side by side) |
| T3 live system | build + `npm run live`, by hand | 533 s with the build |
| T4 production-like | never green: the base build hung at startup and 23 of 55 journeys failed (route checks passed on the sign-in screen) | 1,255 s: 55/55 journeys on base and new, 3,454 production-shaped documents |
| All tiers | ~64 min if run one after another | 29.8 min (1,788 s), all pass |

## What the new tiers found

Each got a fix and a regression check, or a written reason.

1. **App, test builds only:** after the `?as=` test sign-in, startup waited on
   `authStateChanges().first`, and some emulator loads never got that first
   state and hung on "Loading". `lib/main.dart` now uses the user the
   sign-in returns. The e2e, T3 and T4 runs are the regression check. T4
   patches the base tree the same way (`tools/qa/base_shim.py`) until the
   stable app carries the fix.
2. **e2e suite:** `goto()` reloaded without `?as=`, and emulator builds
   forget the session on every load, so every route check passed on the
   sign-in screen. 23 journeys had drifted from the app (the appointment
   profile gate, the contributor nudge, `/home` redirects). Fixed in the
   helpers, seed and specs. `visitAndCheck` now refuses the sign-in screen.
3. **Staging reseed:** heads docs holding a mirror's offerings exceed
   Firestore's 500 field transforms per write, so `seed.mjs` failed on
   staging. The markers are now bumped in chunks
   (`tools/test_env/markers.test.mjs`).
4. **CI:** `channel: stable` had moved to Flutter 3.50.1, where the analyzer
   flags every `material.dart` import and three tests fail. The test
   workflows are pinned to 3.47.5.
5. **App backtest:** when its emulator step never ran (on CI, without
   `/tmp/pointer-heavy.sh`, two emulators raced for 8085), it passed
   silently. That is now a finding (`rules-mixed-not-run`), and `run.sh`
   provides the wrapper.
6. **T2 app:** 46 unruled differences. All are classified in
   `allowlist.json` with reasons: owner rulings, hardening, and the known
   open stable-app custom-grant crash, which only an owner-side stable
   release fixes.
7. **ui_check:** the baseline dated from 2026-10-04, with 58 UI commits never
   accepted. It is re-accepted at HEAD (staging is the UI spec). The current
   calendar has issues not fixed here (no UI changes): day cells announced
   as buttons with no tap action, low contrast on the exam-campus and add
   screens, and a 24 px tall "Search courses" target. They need a UI pass.
8. **commit.py:** it committed whatever else was staged, and refused the
   ui_check baseline the README says to commit. It now commits only the
   named paths and allows `agent_toolchains/ui_check/baseline/`.
