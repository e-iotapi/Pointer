#!/usr/bin/env bash
# The one entry point for the test tiers (docs/DEVELOPMENT.md, "Testing").
#   tools/qa/run.sh --tier 0|1|2|3|4[,…]|all [--base origin/master]
#   T0 fast       analyzer vs baseline, Dart unit/widget, Worker vitest, tool unit tests, fixture/allow-list checks, ui_check (local)
#   T1 rules      firestore.rules suite, files in parallel (one emulator project per file)
#   T2 compat     tools/backtest/rules + tools/backtest/app vs <base>, on the shared fixtures
#   T3 live       local Worker (wrangler dev) + emulator + browsers: tools/e2e/specs/live
#   T4 prod-like  e2e journeys, base and new builds side by side, on fixtures + synthetic people + seed
# Steps run at once; tools/qa/heavy.sh queues them per lane (emulator, compute)
# and on free RAM. T3 and T4 both serve build/web, so they run one after the other.
# Logs: build/qa/run/<step>.log. Exit 0 only when every step passed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$HOME/development/flutter/bin:$HOME/.pub-cache/bin:$PATH"
TIERS="" BASE="origin/master"
while [ $# -gt 0 ]; do
  case "$1" in
    --tier) TIERS="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    *) sed -n '2,11p' "$0"; exit 2 ;;
  esac
done
[ -n "$TIERS" ] || { sed -n '2,11p' "$0"; exit 2; }
[ "$TIERS" = all ] && TIERS=0,1,2,3,4
OUT=build/qa/run; rm -rf "$OUT"; mkdir -p "$OUT"
H="$ROOT/tools/qa/heavy.sh"
LIVE_DEFS="--dart-define=POINTER_ENV=emulator --dart-define=POINTER_EMULATOR_HOST=127.0.0.1 --dart-define=POINTER_HEADS_URL=http://127.0.0.1:8793 --dart-define=POINTER_LIVE_URL=ws://127.0.0.1:8793"

# step <name> <lane: emu|compute|self> <command>   ("self": the command queues its own parts)
STEPS=()
step() { STEPS+=("$1|$2|$3"); }
has() { case ",$TIERS," in *",$1,"*) return 0 ;; esac; return 1; }

if has 0; then
  step t0-analyze compute 'flutter analyze --no-fatal-infos > build/qa/run/analyze.out 2>&1; node tools/check_analyze_baseline.mjs < build/qa/run/analyze.out'
  step t0-dart    compute 'flutter test'
  step t0-worker  compute 'cd server && npm test'
  # Renders differ between machines (agent_toolchains/README.md), so CI leaves ui_check out.
  [ -n "${CI:-}" ] || step t0-ui compute 'python3 agent_toolchains/ui_check/ui_check.py run'
  step t0-tools   compute 'node tools/qa/fixtures.mjs check && node tools/qa/allowlists.mjs && (cd tools/prod_mirror && { [ -e node_modules ] || ln -s ../test_env/node_modules node_modules; } && npm test)'
fi
has 1 && step t1-rules emu 'cd test/rules && npm test'
if has 2; then
  step t2-rules self "node tools/qa/fixtures.mjs out rules $ROOT/build/qa/run/fx_rules.json && node tools/backtest/rules/run.mjs --base $BASE --export $ROOT/build/qa/run/fx_rules.json"
  # The app backtest refreshes the stable-encoder fixtures, so the shared file is rebuilt after it.
  step t2-app self "node tools/qa/fixtures.mjs out app $ROOT/build/qa/run/fx_app.json && tools/backtest/app/run.sh --base $BASE --export $ROOT/build/qa/run/fx_app.json; rc=\$?; node tools/qa/fixtures.mjs build; exit \$rc"
fi
CHAIN=()
if has 3; then
  CHAIN+=("t3-live|self|POINTER_LANE=compute $H flutter build web --release $LIVE_DEFS && node tools/qa/fixtures.mjs out jsonl build/qa/run/fx && LIVE_FIXTURES=build/qa/run/fx POINTER_LANE=emu $H bash tools/e2e/live.sh local")
fi
if has 4; then
  CHAIN+=("t4-prodlike|self|BASE=$BASE bash tools/qa/t4.sh")
fi

run_step() { # name lane cmd
  local s rc; s=$(date +%s)
  if [ "$2" = self ]; then bash -c "$3"; else HEAVY_STARTED_FILE="$OUT/$1.started" POINTER_LANE="$2" "$H" bash -c "$3"; fi > "$OUT/$1.log" 2>&1
  rc=$?
  # queued = before the lane took the job (lane-wrapped steps only; "self" steps queue inside)
  local q=0; [ -s "$OUT/$1.started" ] && q=$(( $(head -1 "$OUT/$1.started") - s ))
  echo "$rc $(( $(date +%s) - s - q )) $q" > "$OUT/$1.rc"
}
T0=$(date +%s)
for s in "${STEPS[@]}"; do IFS='|' read -r n l c <<< "$s"; run_step "$n" "$l" "$c" & done
( for s in "${CHAIN[@]}"; do IFS='|' read -r n l c <<< "$s"; run_step "$n" "$l" "$c"; done ) &
wait

fail=0
printf '\n%-14s %-6s %8s %7s  %s\n' STEP RESULT RUN_S QUEUED LOG
for s in "${STEPS[@]}" "${CHAIN[@]}"; do
  n="${s%%|*}"; read -r rc secs q < "$OUT/$n.rc" 2>/dev/null || { rc=?; secs=-; q=-; }
  r=pass; [ "$rc" = 0 ] || { r=FAIL; fail=1; }
  printf '%-14s %-6s %8s %7s  %s\n' "$n" "$r" "$secs" "$q" "$OUT/$n.log"
done
printf 'tiers %s: %s in %ss\n' "$TIERS" "$([ $fail = 0 ] && echo PASS || echo FAIL)" $(( $(date +%s) - T0 ))
exit $fail
