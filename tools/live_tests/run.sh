#!/usr/bin/env bash
# Live-update / infrastructure suite. One entry point:
#   tools/live_tests/run.sh local     # emulators + `wrangler dev` Worker + the app build + Playwright
#   STAGING_PASSWORD=... tools/live_tests/run.sh staging
# Extra arguments go to `playwright test` (e.g. -g "roles"). See README.md. Leaves nothing running.
set -uo pipefail
MODE="${1:-local}"; shift || true
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/tools/live_tests"
cd "$HERE"
mkdir -p out
export LIVE_MODE="$MODE"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -- "-$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

wait_http() { for _ in $(seq 1 90); do curl -s -o /dev/null "$1" && return 0; sleep 1; done; echo "timed out waiting for $1" >&2; exit 1; }
# start <dir> <cmd...>: own process group, so cleanup can kill the whole tree.
start() { local d="$1"; shift; (cd "$d" && exec setsid "$@" >> "$HERE/out/services.log" 2>&1) & PIDS+=("$!"); }

[ -d node_modules/@playwright ] || npm install --no-fund --no-audit >/dev/null

if [ "$MODE" = "local" ]; then
  [ -f "$ROOT/build/web/index.html" ] || { echo "No build. Run: flutter build web --release --dart-define=POINTER_ENV=emulator --dart-define=POINTER_EMULATOR_HOST=127.0.0.1 --dart-define=POINTER_HEADS_URL=http://127.0.0.1:8793 --dart-define=POINTER_LIVE_URL=ws://127.0.0.1:8793" >&2; exit 1; }
  : > out/services.log
  rm -rf out/wrangler-state # a hub remembers the markers it last announced; the emulator restarts from the seed
  [ -f "$ROOT/tools/test_env/out/student_full.json" ] || (cd "$ROOT" && POINTER_SEED=1 flutter test --no-pub tools/test_env/build_snapshots_test.dart >> "$HERE/out/services.log" 2>&1) || { echo "snapshot build failed (out/services.log)" >&2; exit 1; }
  # A throwaway signing key: the Worker trusts it (JWKS) and signs its own fake Google access token with it.
  node --input-type=module -e "
    import { generateKeyPairSync } from 'node:crypto'; import { writeFileSync } from 'node:fs';
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const q = (s) => String.fromCharCode(39) + s + String.fromCharCode(39); // dotenv single quotes keep backslash-n literal
    writeFileSync('out/keys.json', JSON.stringify({ priv: privateKey.export({ format: 'jwk' }), pub: publicKey.export({ format: 'jwk' }) }));
    writeFileSync('out/worker.env', [
      'TEST_PRIVATE_JWK=' + q(JSON.stringify(privateKey.export({ format: 'jwk' }))),
      'TEST_PUBLIC_JWK=' + q(JSON.stringify(publicKey.export({ format: 'jwk' }))),
      'FIREBASE_SA=' + q(JSON.stringify({ client_email: 'live@test', private_key: pem })),
      'EMULATOR_FIRESTORE=127.0.0.1:8085',
    ].join('\n') + '\n');
  "
  export TEST_PRIVATE_JWK="$(node -e "console.log(JSON.stringify(require('./out/keys.json').priv))")"

  start "$ROOT" firebase emulators:start --only auth,firestore --project demo-pointer
  wait_http http://127.0.0.1:8085/; wait_http http://127.0.0.1:9099/
  (cd "$ROOT" && node tools/test_env/seed.mjs >> "$HERE/out/services.log" 2>&1) || { echo "seed failed (out/services.log)" >&2; exit 1; }
  start "$ROOT/server" npx wrangler dev --config wrangler.live.toml --port 8793 --ip 127.0.0.1 --persist-to "$HERE/out/wrangler-state" --env-file "$HERE/out/worker.env"
  wait_http http://127.0.0.1:8793/heads/goa
  PORT=5050 start "$ROOT/tools/e2e" node serve.mjs
  wait_http http://127.0.0.1:5050/
else
  [ -n "${STAGING_PASSWORD:-}" ] || { echo "STAGING_PASSWORD is not set (the staging test accounts' password)." >&2; exit 1; }
fi

npx playwright test "$@"
code=$?
cleanup
exit $code
