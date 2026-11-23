#!/usr/bin/env bash
# Runs inside `firebase emulators:exec --only auth,firestore --project demo-pointer`
# (see e2e_run.sh): seeds, then runs tools/e2e's Playwright journeys against the
# base build and the new build on identical data.
set -uo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p build/backtest/e2e
for side in old new; do
  node tools/test_env/seed.mjs > build/backtest/e2e/seed_$side.log 2>&1
  node tools/backtest/app/serve_dir.mjs build/backtest/web_$side 5050 & SP=$!
  sleep 2
  (cd tools/e2e && PLAYWRIGHT_JSON_OUTPUT_NAME=../../build/backtest/e2e/$side.json \
     npx playwright test --reporter=json --grep-invert "perf|quota" 2>../../build/backtest/e2e/${side}_stderr.log >/dev/null)
  kill $SP 2>/dev/null; wait $SP 2>/dev/null
done
echo E2E_DONE
