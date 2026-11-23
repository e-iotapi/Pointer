#!/usr/bin/env bash
# End to end on both builds: tools/backtest/app/e2e_build.sh <old tree> first, then
#   tools/backtest/app/e2e_run.sh
export PATH="$HOME/.local/bin:$HOME/development/flutter/bin:$PATH"
cd "$(dirname "$0")/../../.."
H=/tmp/pointer-heavy.sh; [ -x $H ] || H=
$H firebase emulators:exec --only auth,firestore --project demo-pointer "bash tools/backtest/app/e2e.sh"
node tools/backtest/app/e2e_compare.mjs
