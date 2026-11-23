# pointer-heads

Cloudflare Worker that reads Firestore via the REST API using a service-account token.

## Owner setup

1. Create a service account with the **Datastore Viewer** role only (no write access).
2. `cd server && npx wrangler secret put FIREBASE_SA` — paste the full service-account JSON key when prompted.
3. `npx wrangler deploy`.

Staging (its own Worker, `pointer-heads-staging`) uses `[env.staging]` in `wrangler.toml`:
`npx wrangler secret put FIREBASE_SA --env staging` (a service account of the staging project), then `npx wrangler deploy --env staging`.

`PROJECT_ID` is per environment, in `wrangler.toml`: `cgpa-calculator-fb90c` for production, `pointer-staging` for staging. It must match the Firebase project of the ID tokens and of the `FIREBASE_SA` key.

Note: the edge cache (`caches.default`) only works on a custom-domain route, not on `workers.dev`.

## Development

```
npm i
npx vitest run
```

## Staging parity

Staging must differ from production only in names, URLs and the project id. Checked 2026-11-23 from the repo (the Cloudflare account was not queried; the secret check below is left to whoever deploys):

| Item | Production | `[env.staging]` | Same? |
|---|---|---|---|
| Worker name | `pointer-heads` | `pointer-heads-staging` | name only |
| `compatibility_date`, flags | `2026-09-01`, none | inherited, same | yes |
| `PROJECT_ID` | `cgpa-calculator-fb90c` | `pointer-staging` | project id only |
| `ALLOWED_ORIGINS` | `https://pointer-bits-pilani.pages.dev` | `https://pointer-staging.web.app` | URL only |
| Durable Object `HUB` -> `CampusHub` | yes | yes (bindings are not inherited, so repeated) | yes |
| Migration `v1` (`new_sqlite_classes = ["CampusHub"]`) | yes | yes (repeated) | yes |
| Routes / `workers_dev` | none (workers.dev) | none | yes |
| Secrets the code reads | `FIREBASE_SA` (Datastore Viewer SA of `cgpa-calculator-fb90c`) | `FIREBASE_SA` (SA of `pointer-staging`) | names only |
| App build vars (`deploy.yml` / `deploy-staging.yml`) | `PROD_POINTER_HEADS_URL`, `PROD_POINTER_LIVE_URL` | `POINTER_HEADS_URL`, `POINTER_LIVE_URL` | names/URLs only |

Whenever a binding, migration or var is added to the top level, add it under `[env.staging]` too (Wrangler does not inherit bindings, migrations or `[vars]`).

Not parity, by design: the `staging-wasm` and `staging-profile` preview builds set neither Worker URL (they read heads from Firestore, no live push) and run on preview-channel origins that `ALLOWED_ORIGINS` does not list; do not use them to judge live updates.

Check the staging secret exists with `npx wrangler secret list --env staging` (names only). No workflow deploys the Worker; both environments are deployed by hand.

## HTTP routes

`GET /heads/<campus>` (markers, 60 s per instance), `/timetable/<campus>.json` and `/calendar/<campus>.ics` (the academic calendar feed), all built from Firestore. `src/index.ts` has the full list.

## Live socket frames

`wss://<worker>/live/<campus>`, token in `Sec-WebSocket-Protocol: pointer, <idToken>`. Server to client: `hello {head, me, roles}`, `head {v}`, `me {v}`, `roles {v}`. `head.v` and `hello.head` map each marker path to a number: the head doc's `v` map, the scheme versions as `o:<course|term>`, and a hash of the public contact as `#contact` (so a contact edit moves a marker; nothing else of the head leaves). Client to server:

- `poke {path, campuses?}`: a marker moved on those campuses' heads (default: this socket's own). Each named hub arms its own head read (at most one per 20 s per hub), so a write on another campus, or on every campus, reaches those clients. At most one fan-out a second per socket.
- `pokeUser {email}`: that person's roles changed. Every hub bumps a counter for the address and sends `roles {v}` to the person's sockets (tagged by the token's verified email); `hello.roles` carries the counter for devices that were closed. 4 a second per socket, 30 an hour per sender; no data travels.
- `pokeMe`: this account changed on another device (`me`).

Tests: `npm test` (frames, fan-out, limits) and `tools/e2e/specs/live/` (`npm run live`) (the real Worker under `wrangler dev` against the emulators, `wrangler.live.toml` + `test/live/entry.ts`).
