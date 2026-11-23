# Live-update and infrastructure tests

Proves that what one user changes reaches other users' **open** apps without a sign-out, and that every endpoint the app uses is up.

```
tools/live_tests/run.sh local                      # emulators + wrangler dev Worker + app build + Playwright
STAGING_PASSWORD=... tools/live_tests/run.sh staging   # https://pointer-staging.web.app + the staging Worker
tools/live_tests/run.sh local -g "roles"           # extra args go to `playwright test`
```

Wrap with `/tmp/pointer-heavy.sh` on a shared machine. The runner starts and stops everything it needs.

## Local

Needs `build/web` built for the emulators, with the Worker on :8793:

```
flutter build web --release --dart-define=POINTER_ENV=emulator --dart-define=POINTER_EMULATOR_HOST=127.0.0.1 \
  --dart-define=POINTER_HEADS_URL=http://127.0.0.1:8793 --dart-define=POINTER_LIVE_URL=ws://127.0.0.1:8793
```

The Worker is the real `server/src` code run by `wrangler dev --config server/wrangler.live.toml`; only its entry
(`server/test/live/entry.ts`, test-only) differs: it swaps the Google token endpoint, the JWKS and Firestore for the
emulators and re-signs the Auth emulator's unsigned ID tokens with a throwaway key. Nothing in `server/src` knows.

## Specs

| File | What |
|---|---|
| `infra.spec.mjs` | Firestore, `/heads`, CORS, timetable/calendar, socket auth refusals (none, garbage, expired, unknown campus), hello frame, poke -> head frame. Runs on staging too. |
| `fanout.spec.mjs` | A write on another campus's head, an every-campus write, and `pokeUser`, each reaching the right sockets on other campuses' hubs; `pokeUser` rate limit. Runs on staging too (marker bumps are allowed to any signed-in user). |
| `instant.spec.mjs` | Browser: user B's open screen shows another user's shared-data edit, a role appointed, a role revoked, a cross-campus appointment, within seconds. Local only (needs rules-bypass writes). |
| `failure.spec.mjs` | Reconnect after a drop gets the missed markers; Worker unreachable -> app still loads via Firestore heads; dropped socket -> app reconnects. |

The "other user" in `instant`/`fanout` is a script: it writes Firestore and sends the frames the app sends after such a
write (`poke` with its `campuses`, `pokeUser`). What the app sends is covered by Dart unit tests
(`test/core/live_heads_test.dart`).

The staging run writes only head markers (`bumpHeads`, as any signed-in user may); never production.
