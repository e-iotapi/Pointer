#!/usr/bin/env bash
# T4 production-like (tools/qa/run.sh --tier 4): the e2e journeys on the base
# build and the new build side by side, on production-shaped data: the shared
# fixtures (they win on a clash), synthetic people and shared data
# (tools/prod_mirror), and the seed's ?as= accounts on top. A journey that
# passes on the base and fails on the new build is a finding unless
# tools/backtest/app/allowlist.json (kind "e2e") says why. The base tree gets
# one test-only shim (tools/qa/base_shim.py).
#   BASE=origin/master T4_USERS=400 bash tools/qa/t4.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
H="$PWD/tools/qa/heavy.sh"; BASE="${BASE:-origin/master}"
D=build/qa/t4; rm -rf "$D"; mkdir -p "$D/old"

node tools/qa/fixtures.mjs out jsonl "$D/fx"
node tools/prod_mirror/synth.mjs --users "${T4_USERS:-400}" --seed 1 --avoid "$D/fx" --out "$D/synth" > "$D/synth.log"
node tools/prod_mirror/combine.mjs --out "$D/data" "$D/fx" "$D/synth" > "$D/combine.log"
echo "data: $(wc -l < "$D/data/docs.jsonl") documents"

git archive "$BASE" | tar -x -C "$D/old"
python3 tools/qa/base_shim.py "$D/old/lib/main.dart"
(cd "$D/old" && { POINTER_LANE=compute "$H" flutter pub get --offline || POINTER_LANE=compute "$H" flutter pub get; } > /dev/null)
BASE_REF="$BASE" bash tools/backtest/app/e2e_build.sh "$D/old"
E2E_DATA="$PWD/$D/data" bash tools/backtest/app/e2e_run.sh
