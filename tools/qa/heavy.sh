#!/bin/sh
# Heavy-job wrapper: two lanes, one job per lane, each started only with
# >= HEAVY_MIN_GB (2) GB available.
#   emu     binds the emulator ports (8085/9099): firebase emulators, up.sh, Playwright/e2e, live suite
#   compute everything else: flutter test/analyze/build, verify.py, npm test without an emulator
# The lane is guessed from the command; POINTER_LANE=emu|compute overrides.
# Re-entrant: a job already holding a lane runs nested commands of that lane
# without waiting for itself. Starts are serialised and spaced HEAVY_SETTLE (20) s
# apart, so the second lane's RAM check sees what the first one took.
# /tmp/pointer-heavy.sh (via ~/.local/bin/pointer-heavy.sh) execs this file.
case "$*" in
  *emulator*|*playwright*|*up.sh*|*live.sh*|*e2e*|*test:warm*) lane=emu ;;
  *) lane=compute ;;
esac
lane="${POINTER_LANE:-$lane}"
case " ${POINTER_HEAVY_HELD:-} " in *" $lane "*) exec "$@" ;; esac
export POINTER_HEAVY_HELD="${POINTER_HEAVY_HELD:-} $lane"
exec 9>"/tmp/pointer-heavy.$lane.lock"
flock 9
exec 8>/tmp/pointer-heavy.start.lock
flock 8
while [ "$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)" -lt "${HEAVY_MIN_GB:-2}" ]; do sleep 5; done
[ -z "${HEAVY_STARTED_FILE:-}" ] || date +%s >> "$HEAVY_STARTED_FILE" # tools/qa/run.sh: time spent queued
"$@" 8>&- 9>&- &
pid=$!
trap 'kill $pid 2>/dev/null' INT TERM HUP
i=0; while [ $i -lt "${HEAVY_SETTLE:-20}" ] && kill -0 $pid 2>/dev/null; do sleep 1; i=$((i+1)); done
exec 8>&-
wait $pid
