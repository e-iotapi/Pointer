# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pointer: a Flutter **web** app (CGPA, marks, timetable, reviews, resources for BITS Pilani/Goa/Hyderabad) on Firebase's free Spark plan, plus a read-only Cloudflare Worker (`server/`). Work happens on `pointer-dev`.

## Read first

- `docs/ARCHITECTURE.md`: contributor overview (startup, sync, data model, roles, releases). §12 "Things that will surprise you" is mandatory.
- `agent_instructions/ARCHITECTURE.md`: the design of record (data, roles, routes, rules). Code comments cite it and other records by section ("ARCHITECTURE.md §7"); superseded plans are in `agent_instructions/deprecated/`. `PLAN.md` is retired.
- `docs/DEVELOPMENT.md`: setup, emulators, releasing, data tools.
- `agent_toolchains/README.md`: the verify/commit/ui_check tooling.
- `graphify-out/GRAPH_REPORT.md` + `graph.json`: knowledge graph of the codebase (communities, god nodes). Query it with the graphify skill before broad file reading.

## Commands

```sh
flutter pub get
flutter test                                    # all Dart tests
flutter test test/grading/some_test.dart        # one file
flutter test test/x_test.dart --plain-name "…"  # one test
cd test/rules && npm install && npm test        # Firestore security rules, on the emulator
cd server && npm test                           # Worker (vitest)
python3 agent_toolchains/code/verify.py         # format + analyzer baseline + full suite (--fast: no tests)
python3 agent_toolchains/ui_check/ui_check.py run --card <screen>   # render screens light/dark, report UI issues
tools/test_env/up.sh                            # emulators + seed + serve app; open with ?as=student_full|president|owner
cd tools/e2e && npm test                        # Playwright e2e / perf / quota specs vs. seeded emulator
cd tools/e2e && npm run live                   # live-update specs: the real Worker (wrangler dev) vs. the emulators
node tools/backtest/rules/run.mjs               # replay old suites + the stable app against the new rules (tools/backtest/app/run.sh: old caches, damaged data)
tools/prod_mirror/README.md                     # export prod, anonymise, load into staging (mirror people get ?as= keys)
```

- Backend is chosen at compile time: `--dart-define=POINTER_ENV=prod|staging|emulator` (default `prod`; `?as=` test sign-in is compiled out of prod builds, and CI guards that).
- CI (`check.yml`) fails on any analyzer issue not listed in `tools/analyze_baseline.txt`.
- Commit helper: `python3 agent_toolchains/code/commit.py -m "msg" <files…>` stages only named files, refuses forbidden ones, runs verify, and **pushes** (`--no-push` to stop). Every push to `pointer-dev` auto-deploys staging (https://pointer-staging.web.app) and may reseed it.
- `lib/course.g.dart` is Hive codegen (`dart run build_runner build`); adapters are registered by hand in `main.dart`.

## Architecture

- **Layers:** `lib/main.dart` (startup, sign-in) → `lib/app` (go_router in `router.dart`, theme) → `lib/features/*` (student screens) and `lib/admin` (maintainer screens, a **deferred import** so students never download them) → `lib/shared/widgets` (widget kit) → `lib/core` (stores, models, domain rules) → Hive + Firestore.
- **Legacy files** predating the rebuild: `main.dart`, `home_page.dart`, `script.dart`, `course.dart`, `mastercourselist.dart`, `sync.dart`, `settings_page.dart`. Never `dart format` them (it rewrites them wholesale); edit by hand. Check other files with `dart format --output=none` before formatting.
- **Local first.** Personal data lives in Hive (IndexedDB) and syncs as one doc `users/{uid}` with a revision counter; conflicts resolve server-wins, keeping the local copy as backup. A new Hive box must be opened at startup, added to sync if personal, and cleared on sign-out.
- **Spark-plan budget drives design** (50k reads/20k writes per day). Shared data is cached on device and re-fetched only when its per-campus version marker ("heads", `lib/core/heads`) moves; the Worker serves those markers and pushes changes over a WebSocket. All sync/cache timings and their costs are in `lib/core/timings.dart`. State Firestore reads per user per day for any change that adds reads; `agent_instructions/QUOTA.md` has the sums.
- **`firestore.rules` is the backend.** No Cloud Functions; roles are Firestore documents (grants with `expiresAt`) looked up by the rules on every request. Owner → admin → department president (+ secretary flag) → CR → student. Only `f/h/p` + digits student addresses at BITS domains (plus listed owners) get in. `lib/core/roles/capabilities.dart` mirrors rules in the UI and `test/core/capabilities_test.dart` checks it against the §4 table of `agent_instructions/ARCHITECTURE.md`. Rules changes need `test/rules` tests.
- **One GPA function:** `tally` in `lib/core/grading/cgpa.dart`. Everything showing a GPA or credit count calls it; lists and GPA share the same `inDiscipline` filter.
- **UI rule:** compose new screens from `lib/shared/widgets` and `lib/admin/widgets.dart`; no new styles. Staging is the UI spec: screens or parts not explicitly in scope must not change.
- **Backend work names its screens:** any design or plan for new backend infrastructure (rules, stores, data model, permissions) lists every UI screen it changes, including ones that only change who can open them. New or changed screens are drawn first on a new page of the Pointer — UI Directions artifact (https://claude.ai/artifact/K4H9w2Ad9cwdTqxPSAiWMW), and the plan's UI tasks cite that page.

## Gotchas

- Email-keyed maps: on web `SetOptions(mergeFields:)` splits field paths at dots; use `update` with a `FieldPath`. `fake_cloud_firestore` also gets this wrong, so test on the emulator.
- Hive writes triggered from widget tests stall under fake time: unit-test storage, give widget tests in-memory data.
- Wasm build: `dartify()` returns `double`; read JS numbers as `num` (a post-first-frame throw blanks the app).
- `test/helpers/fake_seed.dart` is the fake data for widget tests and the `demo/` build.

## Branches and repo hygiene

- `pointer-dev` → `pointer-beta` (/beta/) → `master` (/calculator/) only via the `release.yml` workflow (one-commit PRs that drop the `DEV_ONLY` paths; the owner merges). Never PR `pointer-dev` straight into `master`/`pointer-beta`. New dev-only paths go in `DEV_ONLY`. Beta and stable share production data, so changes must be additive and readable by the stable app.
- Never commit `bugs/`, `bug_*.md`, `tools/perf_out/`, `tools/course_reviews_out/`, `sensitive_data_NO_COMMIT/` or any service-account key. Deploys of rules, indexes, the Worker and production are the owner's. The stable app crashes on custom role grants: create no custom roles in production (`agent_instructions/CUSTOM_ROLES_DESIGN.md`).
- No Claude/AI co-author or "Generated with" lines in commits or PRs.
