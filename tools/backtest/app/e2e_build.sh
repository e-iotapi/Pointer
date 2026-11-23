#!/usr/bin/env bash
# Builds the emulator web app for the base ref (extracted by run.mjs under
# build/backtest/<tag>/old) and for HEAD into build/backtest/web_old / web_new.
#   tools/backtest/app/e2e_build.sh <old tree dir>
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/development/flutter/bin:$PATH"
cd "$(dirname "$0")/../../.."
OLD="$1"; H=/tmp/pointer-heavy.sh; [ -x $H ] || H=
DEFS="--profile --dart-define=POINTER_ENV=emulator --dart-define=POINTER_EMULATOR_HOST=localhost"
POINTER_SEED=1 $H flutter test --no-pub tools/test_env/build_snapshots_test.dart
BASE_REF="${BASE_REF:-origin/master}"
git archive "$BASE_REF" web | tar -x -C "$OLD"
(cd "$OLD" && $H flutter build web $DEFS --no-pub)
rm -rf build/backtest/web_old && cp -r "$OLD/build/web" build/backtest/web_old
$H flutter build web $DEFS --no-pub
rm -rf build/backtest/web_new && cp -r build/web build/backtest/web_new
echo BUILT
