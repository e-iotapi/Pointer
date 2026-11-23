#!/usr/bin/env bash
# Runs inside `firebase emulators:exec --only auth,firestore --project demo-pointer`
# (see e2e_run.sh): seeds, then runs tools/e2e's Playwright journeys against the
# base build and the new build on identical data.
set -uo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p build/backtest/e2e
# E2E_DATA=<docs.jsonl dir> (tools/qa/t4.sh) is loaded first and the seed goes on top.
# The base build reads demo-pointer only: one worker. The new build runs
# E2E_WORKERS (default 2), each on its own project seeded by tools/e2e/global_setup.mjs.
for side in old new; do
  W=1; [ $side = new ] && W="${E2E_WORKERS:-2}"
  if [ "$W" = 1 ]; then
    [ -z "${E2E_DATA:-}" ] || node tools/prod_mirror/load.mjs --in "$E2E_DATA" --no-auth > build/backtest/e2e/load_$side.log 2>&1
    node tools/test_env/seed.mjs ${E2E_DATA:+--keep} > build/backtest/e2e/seed_$side.log 2>&1
  fi
  node tools/backtest/app/serve_dir.mjs build/backtest/web_$side 5050 & SP=$!
  sleep 2
  (cd tools/e2e && E2E_WORKERS=$W PLAYWRIGHT_JSON_OUTPUT_NAME=../../build/backtest/e2e/$side.json \
     npx playwright test --reporter=json --grep-invert "perf|quota" 2>../../build/backtest/e2e/${side}_stderr.log >/dev/null)
  kill $SP 2>/dev/null; wait $SP 2>/dev/null
done
echo E2E_DONE
