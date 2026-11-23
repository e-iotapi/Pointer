# Developing Pointer

This guide lives on `pointer-dev` only, like everything it describes: the
tests, the local emulators, the tools and the design records. `master` and
`pointer-beta` carry the app alone (see
[README → Release channels](../README.md#release-channels-and-branches)).
How the system works is in [ARCHITECTURE.md](ARCHITECTURE.md).

- [Setting up](#setting-up)
- [Running the app](#running-the-app)
- [Tests and checks](#tests-and-checks)
- [Releasing](#releasing)
- [Deploying by hand](#deploying-by-hand)
- [Data tools](#data-tools)
- [What lives where on this branch](#what-lives-where-on-this-branch)
- [House rules](#house-rules)

## Setting up

**You need:** [Flutter](https://docs.flutter.dev/get-started/install) (Dart
SDK ^3.7; CI pins 3.47.5 for staging), [Node.js](https://nodejs.org/) 22, the
[Firebase CLI](https://firebase.google.com/docs/cli) and Java 21 (for the
Firestore emulator). Python 3 runs the verification scripts.

```sh
git clone -b pointer-dev https://github.com/e-iotapi/Pointer.git
cd Pointer
flutter pub get
```

## Running the app

### Against local emulators (recommended)

Starts the Auth and Firestore emulators, seeds them with test accounts and
data, and serves the app against them. Nothing touches a real project.

```sh
tools/test_env/up.sh
```

Open the app with `?as=<account>` to sign in as a seeded user, for example
`?as=student_full`, `?as=president` or `?as=owner`. The accounts are in
[`test_env/accounts.json`](../test_env/accounts.json).

### Build environments

The backend is picked at compile time with `--dart-define=POINTER_ENV=…`:

| `POINTER_ENV` | Backend | Test sign-in (`?as=`) |
|---|---|---|
| `prod` (default) | Production Firebase | removed from the build |
| `staging` | The `pointer-staging` Firebase project | yes |
| `emulator` | Local emulators | yes |

`flutter run -d chrome --web-port 5000` with no define talks to production
with real Google sign-in, so it needs a BITS account.

### The UI-only demo

[`demo/`](../demo) runs the real app over the test fakes, with no backend:
every sign-in is a made-up owner and the data is
`test/helpers/fake_seed.dart`, reseeded on each load. `demo/build.sh` builds
it into `build/demo`.

## Tests and checks

Every suite runs from one entry point, in tiers:

```sh
tools/qa/run.sh --tier 0,1     # before a push (CI runs this on every push)
tools/qa/run.sh --tier 2       # rules or roles changed; before a release
tools/qa/run.sh --tier 3,4     # before a release (release.yml runs it)
tools/qa/run.sh --tier all
```

| Tier | What | Time here (12 cores, ~2 GB free) |
|---|---|---|
| T0 fast | analyzer vs `tools/analyze_baseline.txt`, `flutter test`, Worker vitest, tool unit tests (`tools/prod_mirror`, seed markers), fixture and allow-list checks, `ui_check` (local only) | ~4 min |
| T1 rules | `test/rules`, four files at once, each in its own emulator project (`demo-r-<file>`) | ~2.5 min, beside T0 |
| T2 compatibility | `tools/backtest/rules` + `tools/backtest/app` against `--base` (default `origin/master`), both also fed the shared fixtures | ~17 min |
| T3 live system | `tools/e2e/live.sh local`: emulator + `wrangler dev` Worker + browsers, on the shared fixtures with the seed on top | ~9 min with the build |
| T4 production-like | `tools/qa/t4.sh`: the e2e journeys on the base build and the new build side by side, on fixtures + synthetic people (`tools/prod_mirror`) + seed | ~21 min with both builds |

`run.sh` starts every step at once and prints one pass/fail table; logs are in
`build/qa/run/<step>.log`. Heavy steps queue in `tools/qa/heavy.sh` (also
`/tmp/pointer-heavy.sh`): one **emulator lane** (anything binding 8085/9099:
emulators, e2e, live) and one **compute lane** (Flutter tests, builds), each
starting a job only with 2 GB free and 20 s after the other lane's last start.
T3 and T4 both serve `build/web`, so they run one after the other; `--tier all`
takes ~30 min. Before/after timings and what the tiers found:
`agent_instructions/deprecated/TEST_ARCHITECTURE_PLAN.md`.

- **Shared fixtures:** `test_env/fixtures/prod_shapes.json` (versioned) is one
  production-shaped document set: the stable app's own encoders' output
  (refreshed by every T2 app run), plus the hand-copied stable write shapes and
  the shapes no encoder writes. `node tools/qa/fixtures.mjs build` regenerates
  it from those sources, `check` (T0) fails when it is stale, and
  `out rules|app|jsonl <path>` writes it for the backtests' `--export`, for
  `prod_mirror/load.mjs` / `combine.mjs` (T3, T4, a staging mirror).
- **Allow-lists:** an intended difference goes in
  `tools/backtest/rules/allowlist.json` or `tools/backtest/app/allowlist.json`
  (kind `e2e` for a T4 journey), one reason per entry; `tools/qa/allowlists.mjs`
  (T0) refuses an entry without one. Each run then flags only new differences.
- **Parallel e2e:** `E2E_WORKERS` (default 2) Playwright workers, each on its
  own emulator project `demo-e2e-<n>` seeded by `tools/e2e/global_setup.mjs`;
  the emulator build reads it from `window.pointerEmulatorProject`. Auth stays
  on `demo-pointer`, so every worker signs in as the same accounts.

Single suites, while iterating:

```sh
flutter test                               # unit, widget and render tests
cd test/rules && npm install && npm test   # security rules (RULES_JOBS=4 files at once)
python3 agent_toolchains/code/verify.py    # analyzer baseline + full suite
```

- **Screen checks:** `python3 agent_toolchains/ui_check/ui_check.py run`
  renders every screen in light and dark at phone widths and reports overflow,
  contrast and tap-size problems.
- **End to end:** [`tools/e2e`](../tools/e2e) runs Playwright specs, including
  performance and Firestore-quota budgets, against the seeded emulator
  (`e2e.yml`, run by hand).
- **Live updates:** `cd tools/e2e && npm run live -- local` (or
  `STAGING_PASSWORD=… npm run live -- staging`; extra args go to Playwright)
  proves another user's edit, appointment or revoke reaches an open app
  without a sign-out, and that the Worker's endpoints are up. Local: the real
  Worker under `wrangler dev` (`server/wrangler.live.toml`,
  `server/test/live/entry.ts`) against the emulators, with an app built for
  them and the Worker on :8793 (`live.sh` prints the build command). Specs:
  `tools/e2e/specs/live/` (`infra`, `fanout`, `instant`, `failure`); the
  "other user" is a script that writes Firestore and sends the frames the app
  sends. Staging writes only head markers.
- **Analyzer baseline:** CI fails on any analyzer issue not in
  `tools/analyze_baseline.txt`; the legacy files' old issues are listed there.

`check.yml` runs T0 + T1 and a production-build guard (test sign-in must not
reach a prod build) on every push to and pull request into `pointer-dev`, and
again before every release to beta. `qa.yml` runs T2 on pushes that touch the
rules or roles, and T3 + T4 when `release.yml` promotes to beta.

## Releasing

```mermaid
flowchart LR
  Dev["pointer-dev<br/>push → staging"] -- "release: to pointer-beta<br/>(full checks first)" --> PRB["PR: one commit,<br/>dev files left out"]
  PRB -- "owner merges" --> Beta["pointer-beta<br/>→ /beta/"]
  Beta -- "release: to master" --> PRM["PR: one commit"]
  PRM -- "owner merges" --> Master["master<br/>→ /calculator/"]
```

1. Push to `pointer-dev`. `deploy-staging.yml` publishes it to
   https://pointer-staging.web.app with seeded test accounts.
2. **Actions → release → Run workflow → `pointer-beta`.** The full checks run
   on `pointer-dev`; then one commit holding `pointer-dev`'s files minus the
   dev-only paths (the `DEV_ONLY` list in `release.yml`) is opened as a pull
   request into `pointer-beta`, listing every change since the last release.
3. Merge it (squash). `deploy.yml` rebuilds the site with the beta at `/beta/`.
4. When the beta is ready: **release → `master`**, merge, and the same
   workflow publishes it at `/calculator/`.

A file that should stay off `master` goes in `DEV_ONLY`. The first release
to a branch that doesn't exist yet creates it directly; run **deploy** by
hand once after that, since a push made by the workflow's token starts no
other workflow.

The beta and the stable app share one origin, one sign-in and the production
data, so **a beta must not change data in a way the stable app can't read**:
new fields are additive, and rules changes are deployed only once both
channels can live with them.

## Deploying by hand

These stay manual and are the owner's to run:

| What | Command |
|---|---|
| Firestore rules | `firebase deploy --only firestore:rules --project default` |
| Firestore indexes | `firebase deploy --only firestore:indexes --project default` (answer **No** to deleting indexes) |
| The Worker | `cd server && npx wrangler deploy` (`--env staging` for staging) |
| Staging by hand | `tools/test_env/staging.sh` (needs `STAGING_PASSWORD` and a service-account key, both outside the repo) |

The full first-time production checklist is
[`agent_instructions/PROD_DEPLOY.md`](../agent_instructions/PROD_DEPLOY.md).

`lib/firebase_options.dart` is generated by `flutterfire configure`. The
Firebase web API key in it is public by design; restrict it by HTTP referrer
in the Google Cloud console.

## Data tools

All run with Node from the repo root, take `--project`, refuse production
without `--allow-prod`, and write nothing without `--commit`. Service-account
keys are passed by path and never committed.

| Tool | What it does |
|---|---|
| `tools/timetable/extract.mjs` | Reads the timetable PDF into the published timetable, the academic calendar and course offerings |
| `tools/import/import.mjs` | `faculty`, `reviews` (the old course reviews, handouts and class averages) and `rebuild` (every summary from the source documents) |
| `tools/export_catalog.dart` | Exports the course catalogue to `assets/catalog.json` |
| `tools/subset_fonts.sh` | Subsets the bundled fonts to the characters the app uses |
| `tools/backend_tools/import_sheet.mjs` | Imports a student's ERP performance sheet into their account (`users/{uid}`), as the in-app import would, when it cannot run on their device; backs the doc up to `sensitive_data_NO_COMMIT/backend_backups/` first |

Their outputs (`tools/course_reviews_out/`, `tools/perf_out/`) are
git-ignored: they hold real student data.

## What lives where on this branch

| Folder | What |
|---|---|
| `test/` | Dart tests; `test/rules` has the security-rule tests (Node, on the emulator) |
| `test_env/` | The seeded test accounts |
| `tools/` | Emulator setup and seeding, e2e specs, data import, build helpers |
| `demo/` | The UI-only demo |
| `agent_instructions/` | The design records: the detailed architecture, plans, quota sums and the UI map. Superseded ones are in `deprecated/` |
| `agent_toolchains/` | Verification, commit and screen-check scripts |

## House rules

- **Don't format legacy files.** `main.dart`, `home_page.dart`, `script.dart`,
  `course.dart`, `mastercourselist.dart`, `sync.dart` and `settings_page.dart`
  predate the rebuild and are edited by hand; `dart format` would rewrite them
  wholesale (several newer files are unformatted too: check with
  `dart format --output=none` before formatting one).
- **Never commit** `bugs/`, `bug_*.md`, `tools/perf_out/`,
  `tools/course_reviews_out/` or a service-account key.
- **Public APIs get `///` doc comments**
  ([Effective Dart](https://dart.dev/effective-dart/documentation)).
- More traps are in
  [ARCHITECTURE.md §12](ARCHITECTURE.md#12-things-that-will-surprise-you).
