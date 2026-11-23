# Prod mirror

Turns a production Firestore export into an anonymised, production-shaped
dataset and loads it into the emulator or staging, so QA runs on data that
behaves like production. Plus a generator for a fully invented dataset of any
size. Dev-only: `tools/prod_mirror` is in `DEV_ONLY`, it never ships to beta or
stable.

```
 production ──export.mjs──▶ export/ ──anonymise.mjs──▶ anon/ ──load.mjs──▶ emulator | staging
                                                          ▲
              synth.mjs (invented, no production needed) ─┘
```

Nothing real is ever written inside the repo. `export.mjs`, `anonymise.mjs`
and the salt refuse paths inside the repository unless they are under
`sensitive_data_NO_COMMIT/` (git-ignored). Default home for everything:
`sensitive_data_NO_COMMIT/mirror/` (`export/`, `anon/`, `salt.txt`).

Setup once: `cd tools/prod_mirror && npm install` (or the symlinked
`node_modules` of `tools/test_env`). Node 22.

## File format (shared by every step)

`<dir>/docs.jsonl`: one `{"path":"col/id/sub/id","data":{…}}` per document.
Typed values: Timestamp `{"__t":"ts","s":…,"n":…}`, GeoPoint
`{"__t":"geo","lat","lng"}`, DocumentReference `{"__t":"ref","path"}`, Bytes
`{"__t":"bytes","b64"}`; a map that itself has a `__t` key is wrapped
`{"__t":"map","v":{…}}`. `<dir>/auth.json`: `firebase auth:export` shape,
`{"users":[{"localId","email","displayName",…}]}`. This is also what the
owner's one-off `prod_export_now.mjs` writes, so either exporter feeds the rest.

## 1. Export (the owner runs it)

```sh
GOOGLE_APPLICATION_CREDENTIALS=/path/to/prod-read-key.json \
  node tools/prod_mirror/export.mjs --project <prod-id> \
       --out sensitive_data_NO_COMMIT/mirror/export --max-reads 15000
# next day, until it says "Export complete":
  … same command … --resume
```

Reads every collection named by `firestore.rules` (top level, plus the
subcollections `offerings`, `entries`, `votes`, `reports`, `stats`, `campus`
through collection-group queries) and anything else the project holds (3
documents per collection are probed for subcollections the rules do not
name). Auth users come from the Auth API, which costs no Firestore reads.
`--collections users,group:entries` limits it. `--no-auth` skips Auth.

**Cost:** one read per document, plus ≈3 per collection for the probe. It
prints the count and keeps it in `manifest.json`. Production is on Spark
(50,000 reads a day, shared with live users): `--max-reads 15000` leaves them
room, so a 40,000-document project takes three days. Progress is
`manifest.json` (per-collection cursor); `--resume` continues from it.

## 2. Anonymise

```sh
head -c 32 /dev/urandom | base64 > sensitive_data_NO_COMMIT/mirror/salt.txt   # once; keep it
node tools/prod_mirror/anonymise.mjs \
     --in  sensitive_data_NO_COMMIT/mirror/export \
     --out sensitive_data_NO_COMMIT/mirror/anon \
     --salt-file sensitive_data_NO_COMMIT/mirror/salt.txt --shift-to-now
```

Deterministic: same salt, same fake identities on every run (so a nightly
re-mirror keeps the same fake people); not reversible without the salt.
Seconds, in memory (9,000 docs and 2,000 users: 6 s, 260 MB).

What changes, everywhere it appears (doc ids, map keys, nested `actor` /
`grantedBy` / `by` objects, audit `path` strings, values, free text):

| Original | Becomes |
|---|---|
| BITS student address | same letter, year, serial length and campus (`f20230802@goa…` → `f20230417@goa…`): the rules and the app derive campus, year and student-ness from it |
| other BITS address (faculty) | `u<hex>@<same campus>.bits-pilani.ac.in`: still valid, still not a student |
| any other address (owners) | `u<hex>@example.com` |
| uid | 28-character fake uid (same length) |
| names (people, actors, professors, aliases, timetable `prof`) | a first + last name from a list; one person has one name wherever they appear; titles (`Dr.`, `Prof.`) kept; a merge pair stays a pair; `nameTokens` rebuilt |
| phone / WhatsApp / public contact number | same shape, other digits |
| username (contributors, leaderboard keys, `usernames/` ids) | `u_<hex>` |
| review text, link titles, notes, report messages, free-text reasons | invented words of similar length (enum reasons such as `broken` stay) |
| link URLs | same host, path replaced |
| audit `summary` | the action; `before`/`after`/`path` rewritten |
| review, vote and report ids | recomputed (`sha256(uid + course)`, `sha256(uid + reviewId)`, `sha256(uid + resourceId)`) with the fake uid, so each fake user still owns their reviews and votes; the review mirror and index follow |
| `users/{uid}` grades, marks | re-rolled from the grades seen in the data (negative codes such as "not graded" stay), marks within each part's maximum, averages perturbed; profile names become `Profile N` |
| search hints | words replaced |

Kept as they are: course ids, campuses, departments, programmes, terms, counts,
catalogue, versions and head markers, structure. `--shift-to-now` moves every
timestamp so the newest past one is today (grants live at export time stay live
and the ones that had lapsed stay lapsed: the rules compare `expiresAt` to the
clock, so without it a month-old mirror has no working staff). `--shift-days N`
moves by a fixed amount.

**Leak check** (runs before anything is written; on failure nothing is
written and exit code is 1). It scans every id, key and string of the output
for: any original email, uid, hashed id, phone, username or name (word windows
of 1 to 5), and for any email-like or phone-like string that is *not* one of
the fakes it made. It prints the kind and the document path, never the value.
A false alarm on a long digit string can be waved through with
`--accept-unknown unknown-phone`; look at the paths first.

**Needs the owner's eye:** anything personal that is not in a field the tool
knows by name and not in a recognisable shape: a name in a field called
something unusual, a nickname inside free text of a *kept* field (titles of
timetable events, `config` values, course titles typed by users in a snapshot),
an address with a typo. The leak check finds what it was told about (every
name, email, uid, phone seen in a name/email/uid/phone field), so a person
named only in an unlisted field's free text is the gap. Skim 20 random
documents of `anon/docs.jsonl` once after the first run:
`shuf -n 20 …/anon/docs.jsonl`.

## 3. Load

```sh
# emulator (default; wiped first)
firebase emulators:start --only auth,firestore --project demo-pointer &
node tools/prod_mirror/load.mjs --in sensitive_data_NO_COMMIT/mirror/anon
node tools/prod_mirror/load.mjs --in … --sample 5      # a consistent subset

# staging (the owner, or the staging deploy key)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/staging-key.json STAGING_PASSWORD=… \
  node tools/prod_mirror/load.mjs --in … --target staging [--wipe] [--sample 200] [--daily-write-cap 18000]
# the next day, until it says it finished:
  … --target staging --resume
```

Staging safeguards: needs `--target staging` explicitly; the project is
`.firebaserc`'s `staging` alias and the key's `project_id` must equal it
(otherwise refused, production always); `FIRESTORE_EMULATOR_HOST` must be
unset. `--wipe` deletes **every document** of staging after you type its
project id; Auth users stay. A wipe deletes up to `--daily-delete-cap`
(18,000) a day and reads what it deletes: run it again next day if it says so.
The app's `?as=` accounts live in Auth, not Firestore, and survive.

**Cost:** 1 write per document (`docs.jsonl` lines after `--sample`), no
reads. Staging is Spark: 20,000 writes a day, so the load commits in batches
of 400, stops at `--daily-write-cap`, and records progress in
`.load_state.<project>.json` next to the input (the day is Pacific time, where
quotas reset). A full mirror of D documents takes ⌈D / 18,000⌉ days;
`--sample N` keeps N students per campus (chosen to differ), one person of
every role × campus × grant state, every multi-role person, every contributor
request status, and the N busiest courses plus every course with a hidden,
reported or voted review, with their reviews, votes, index entries and audit
rows; everything shared (catalogue, offerings, professors, resources,
timetable, heads) stays whole. The emulator takes about 1,000 documents a
second. `heads/*` and the catalogue marker are written last, so a client never
sees a marker ahead of its data.

### Signing in as a mirrored person

After the data is in, the loader creates Auth users (password: staging's
`STAGING_PASSWORD`, the emulator's `test_env/accounts.json` one) for one person per
kind: owner, admin, president, secretary, CR, contributor, custom-role holder, a
lapsed grant, and a student per campus (`--all-auth`: everyone in `auth.json`).
They get the uid the export linked to the email, so `users/{uid}` and their reviews
match. It prints the `{key, email}` list for the `mirror` section of
`test_env/accounts.json` (CI's `--passwords-only` step gives those accounts the
staging password, `gen_accounts.mjs` bakes the keys into the build, `seed.mjs`
writes no data for them): `?as=mirror_president`, `mirror_cr`, … Without `auth.json`
in the export the people exist only as data: export without `--no-auth`.

## 4. Synthesise (no production data needed)

```sh
node tools/prod_mirror/synth.mjs --users 2000 --out /tmp/synth [--seed 1] [--like <anon dir>] [--now <epoch s>]
node tools/prod_mirror/load.mjs  --in /tmp/synth [--target staging --sample 8]
```

About 2,000 invented people and ≈9,100 documents (= 9,100 staging writes, one
day at the 18,000 cap; more `--users` or a richer `--like` makes more).
Courses and credits come from `assets/catalog.json`; everything else is drawn
from lists. Same `--seed` and `--now` give identical data.

Coverage, systematically, then filled to `--users`: every **campus** (4) ×
**kind** (CR, president, secretary, admin, custom-role holder, contributor)
× **grant state** (live, expiring within 14 days, expired, revoked, handed over;
contributors also pending), refused addresses (faculty, gmail, address with no
campus) per campus, owners, plain students per campus × **activity** (CGPA
only, marks, timetable, review writer, volunteer, dual degree, brand new,
dormant), every batch year 2020–2025, and three multi-role people per
campus (president + CR, admin + president, CR + contributor + custom). Every
campus/kind/state is paired with every activity by a greedy assignment. The run
prints the table (`campus | kind | state → people, example address`) and the
two counters of missing cells and pairs (0 expected).

`--like <anonymised dir>` reads the campus split, courses per user, grade mix,
review rate and votes per review from a mirror, so the invented set has the
same proportions at any size. Every collection `firestore.rules` names gets
documents; staff index, `repIndex`, audit rows, review counters and head
markers agree with the grants and entries they describe.
`tools/prod_mirror/synth_rules.test.mjs` loads a set into the emulator and
reads it back through the real rules as each kind of person.

## 5. One dataset from several (`combine.mjs`) and the staging plan

Loading anonymised prod and a synthetic set one after the other makes the
second overwrite the first's shared documents (`heads`, `repIndex`, review
index, resource mirror, leaderboard…). Combine them first:

```sh
node tools/prod_mirror/synth.mjs --users 2000 --like <anon> --avoid <anon> --out <synth>
node tools/prod_mirror/combine.mjs --out <combined> <anon> <synth>     # first wins on a clash
```

`--avoid` keeps synthetic addresses and uids away from the mirror's and the seed's `?as=` accounts. In `combine`: people and everything
keyed by them are simply added; **merged** (not replaced) are `heads` (markers
and offerings take the max), `repIndex`, `reviewIndex` (counters summed),
review mirrors, review `stats` (summed), `resourceVersions`, `leaderboard`,
`searchHints`, `activity`, `pending`; the **first set wins** for catalogue,
config, timetable (a campus that has one), offerings and any other clash. A
synthetic set's professors are replaced by the earlier sets' professors of the
same campus and department (its reviews, stats and offerings follow), so it
reuses real courses and professors. It prints, per set, how many documents were
added, merged and left out, and the combined write count.

Measured with a 2,874-document stand-in for the mirror and 2,000 synthetic
users (9,121 documents): 11,373 combined documents, 8,499 + 260 merged from the
synthetic set and 170 left out: about 11.4k writes, one day under the 18,000
cap. With the real mirror (~2.6k) expect about 11.1k
If the mirror alone is already loaded, `load.mjs --skip-same-as <anon>` writes
only the difference (new documents and the merged ones).

### More shared data on top of a loaded set (`synth.mjs --shared-delta`)

```sh
node tools/prod_mirror/synth.mjs --shared-delta --base <combined> --out <dir> [--seed 9] [--scale 1.8] [--budget 6000]
node tools/prod_mirror/load.mjs --in <dir> --target staging --skip-same-as <combined> --dry     # the write count
```

Reads the base and adds, using only its people, courses and professors:
course links on ~70 courses per campus in every state (live, pinned, flagged
open and closed, reported, removed, unapproved contributor batches) with their
reports and flags; contributors at eight point levels with usernames, grants,
requests and the leaderboard; pending, declined and withdrawn requests;
offerings with professors and components; a 2026-2 timetable per campus;
votes and reports on existing reviews; course claims; volunteers; directory
and staffContacts for holders that lack them; search hints; activity. The
derived documents (`resourceVersions`, `leaderboard`, `repIndex`, `searchHints`,
`activity`, `pending`, the review entries and their campus mirrors, `heads`
markers and offerings map) are rewritten to agree. `--out` is base + delta;
the load writes only what differs (the count `--dry` prints) and refuses to run
over `--budget`. On a 11.4k-document base: 2,869 writes at `--scale 1`, 4,905
at the default 1.8.

### Does a staging reseed wipe everything?

No. `deploy-staging.yml` reseeds on a push to `pointer-dev` when `tools/test_env/`
or `test_env/` changed (or `[reseed]` is in the commit message), and
`seed.mjs`'s staging wipe deletes only: documents with `seed: true` (or
`touchedBy: 'seed'`), the seed accounts' `people/` docs, and a fixed list
(`catalog/*`, `config/public`, `config/grantTerms`, `leaderboard/goa`,
`activity/goa`, `pending/goa|ELEC`, the seed's own timetable). Mirror and
synthetic documents carry no `seed` flag, so they stay. What a reseed does
change: it rewrites those singletons (so the goa leaderboard, goa ELEC pending
batches, goa activity, config and catalogue become the seed's), `set`s
`resourceVersions/goa` (the goa resource list shows only the seed's links until
repaired) and recomputes `repIndex`, `reviewIndex` and the review mirrors from
all documents (consistent). Merging this branch does **not** trigger it: it
changes nothing under `tools/test_env` or `test_env`. If a reseed happens anyway,
repair with
`load.mjs --in <combined> --target staging --only resourceVersions/goa,leaderboard/goa,pending/goa,activity/goa,config,catalog,heads`.

## 6. Pointing the backtest at it

The backtest toolset reads an export with `--export <dir>`. The anonymised
output has the same layout (`docs.jsonl`, `auth.json`), so
`--export sensitive_data_NO_COMMIT/mirror/anon` works, and so does a
synthetic directory. It contains no real people, but treat it as private all
the same.

## Tests

```sh
cd tools/prod_mirror
npm test                 # anonymiser, loader, synthesiser: no emulator
npm run test:emulator    # round trip + rules, starts and stops the emulators
```

`anonymise.test.mjs`: consistency, id and map-key rewriting, campus/year kept,
hash recomputation, grade/marks shape, planted leaks caught. `load.test.mjs`:
guards, cap/resume, sample, identity pick. `synth.test.mjs`: coverage,
determinism, staff/grant/review consistency, sample. `roundtrip.test.mjs`:
fixture → anonymise → load → export again (types intact, `--max-reads` and
`--resume`) and reads as mirrored people through the rules.
`synth_rules.test.mjs`: the synthetic set through the rules, including expired
and revoked staff being refused. Fixtures: `fixtures/build.mjs` (all invented;
`fixtures/export/` is its output).

## Limits

- The Auth user list is exported, not the Firebase Auth passwords or providers.
- `--sample` thins people-keyed and review data; resources, offerings and
  professors are kept whole.
- Reviews whose author has no `users/{uid}` doc, and votes by such people, get
  fresh stable ids nobody owns (the original uid is unknowable).
- Rules are only exercised by reads and one `users` push here; write paths of
  the whole app are the rules suite's job (`test/rules`).
