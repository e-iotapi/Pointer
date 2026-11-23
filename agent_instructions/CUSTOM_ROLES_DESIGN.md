# Custom roles — design

Status: **built** (Phase A and B on `pointer-dev` and staging, 2026-11-23): `roles/builtin`,
`roles/{id}`, grants `custom|{email}`, rules `may()`, `MyRoles.may/reach`; only owners cross campuses;
a live `pokeUser` makes the grantee re-read roles. Not in production. **Stable-app caveat (open,
owner-only):** the stable app crashes on a custom grant, so create no custom roles in production until
a stable release tolerates them. A Roles-page warning for this needs a UI Directions design first.
`MyRoles` honours only the grants the rules do: a built-in role needs a student address, and a
department or CR grant must be on the address's own campus. Spec of record stays `ARCHITECTURE.md` §4;
this document says what changed there and why. The build plan is `deprecated/CUSTOM_ROLES_PLAN.md`.

## Intent

Department presidents and secretaries are being appointed now, and several
departments have other positions (resources lead, reviews lead, …) that need
some staff rights but not a whole president's. Today there are only four
fixed roles (owner, admin, president with its secretary flag, CR). Owners and
admins need to build a role from a list of permissions and give it to a
person for one department, for every department on one campus, or everywhere.

## Owner decisions

1. **Admins gain six rights**: rows *Course structures, eval schemes*, *Bulk
   upload*, *Degree requirements*, *Averages*, *Professors — create, rename*,
   *Moderate reviews* get ✓ in the admin column. Ships first, on its own.
2. **Custom roles pick only from the table in `capabilities.dart`** (the §4
   rows), plus one new row, *Manage custom roles*. Rules-only rights (contributor
   approval, GEN claims, forced-review switch, timetable, catalog, handover,
   secretaries) stay with the built-in roles.
3. **Managing custom roles is itself a row**: owner ✓, admin ✓, president —,
   CR —. A custom role may include it.
4. **No escalation**: a role may contain only rows its author holds, and only
   the owner can put every row into a role (so rows *Add / remove owners*,
   *Appoint / revoke admins* and *Grant terms — admin length* are owner-only in
   practice).
5. **Data shape: the grant points at the role** (option 1). The rules read the
   holder's grant, then the role: two lookups. Editing a role changes every
   holder at once. **One custom role per person**; someone who needs two gets a
   combined role. Built-in grants (president, CR, …) stack with it as today.
6. **No new backend server.** Firestore rules stay the enforcement point; the
   Worker is untouched.
7. **Holders are students only**, like presidents and CRs.
8. **Custom grants expire after the president term** and are renewed like
   presidents'.
9. **Built-in roles are editable too** (owner, 2026-11-16): the admin,
   president and CR rows become data the owner ticks in the same editor, so a
   future capability is code once (its row and its rules check) and then
   assigned to any role without code. Builder's calls, owner may overrule:
   - Only **owners** edit built-in roles (an admin editing the admin role
     would be editing their own rights).
   - The **owner role is fixed**: always every row, never editable, so nobody
     can lock the owners out.
   - The *reach* of a built-in role stays in code: admin everywhere (rows
     13–14 own campus), president their department, CR their course;
     "never themselves" and "pick only" stay fixed rules. The editor ticks
     rows only.
   - A new capability starts **off** for every role until ticked.
10. **A custom role's scope is set in the role editor, not when appointing**
    (owner, 2026-11-16). The role holds one scope: one department on one
    campus, a whole campus, or every campus. Appointing picks only the person.
    Rows that only make sense everywhere (*Manage roles*, *Publish the
    timetable*, …) work everywhere whatever the role's scope; campus-level rows
    (*Read the audit log and roster*, *Compulsory reviews switch*) in a
    department-scoped role cover that department's campus. This supersedes
    every "reach chosen at grant time" below. Drawn on the UI board.

11. **Decision 11 (owner, 2026-11-17): campus separation.** Only owners cross
    campuses for campus data. The §4 rows split in two:
    - *Campus data*: every non-owner (admin, president, CR, custom) acts only
      on the campus of their own address. Rows: merge professors, course
      structures, bulk upload, degree requirements, department resources,
      course resources, averages, professors, moderate reviews, approve
      contributors, claim electives, compulsory reviews switch, publish the
      timetable, links publish without approval, contribute. The admin column
      reads "✓ own campus" on them.
    - *People and config*: admins keep every campus (appoint presidents and
      CRs, public contact, grant terms, read the audit log and roster, manage
      roles). Owner-only rows are unchanged.
    - **Presidents lose the compulsory reviews switch** (reverses ruling 3 of
      2026-10-03); they stay off it in the defaults, and an owner may tick it.
    - A custom role keeps the "Every campus" scope option, but it now means the
      holder's own campus, every department (the reach of "Whole campus").
      `customMay`, `customMayAny` and `customAppoints` never cross campuses,
      for any row: a custom manager appoints only people on their own campus.
      Only a site that names no campus (c == 'all') on a people/config row is
      satisfied by the row alone.
    - `courses/{id}` drafts stay global by design: one shared catalogue; a
      draft goes live only when an owner publishes.

## Goals

- G1. Admin column change (decision 1), in `ARCHITECTURE.md` §4,
  `capabilities.dart`, its test, and the rules sites behind those rows.
- G2. New row *Manage custom roles* (decision 3).
- G3. Owners, admins and custom-role managers create, edit and delete roles
  (a name and a set of rows) in a new admin-dashboard section.
- G4. They give a custom role a scope (one department on one campus, every
  department on one campus, or everywhere) in the role editor, then grant it
  to a person, and revoke it.
- G5. A holder can do exactly the ticked rows inside their reach, in the app
  and in the rules, with no extra rights anywhere else.
- G6. Every role and custom-grant write is audited like grants are today.

## Non-goals

- Several custom roles per person.
- Turning the built-in roles into custom roles (they become editable, but
  keep their grants, scopes, terms and handover flows).
- Creating a capability from the dashboard: a capability is code.
- Rules-only rights in custom roles (decision 2).
- Listing custom-role holders in the contacts directory (they are in the
  staff index, M3, but `privileged()` ignores custom entries).
- Any Worker, Durable Object or Cloud Function work.

## Anti-goals (a failure even if it works)

- Anyone gains a right they could not have granted themselves.
- An existing president, secretary, CR or admin loses a right, or an older
  app build's writes start being refused.
- A protected write starts failing because the rules ran out of lookups.

## Constraints

- Firestore rules may open at most 10 documents per single write, 20 per
  batch; a custom-role check costs 2 (repeat gets of one document count once).
- Spark plan; no Admin SDK, no custom claims.
- Rules and app ship together; staging first, production deploy is
  owner-only. Rules tests run on the emulator (`test/rules/*.test.mjs`).
- `capabilities_test.dart` keeps `capabilities.dart` a literal copy of the §4
  table, so every table change edits both.
- House rules: format only new files; never commit `bugs/`, `bug_*.md`,
  `tools/perf_out/`, the e2e scratch scripts.

## Approaches considered

| | How a check finds the rights | Lookups | Trade-off |
|---|---|---|---|
| **1. Grant points at role (picked)** | grant → role doc | 2 | Role edits apply at once; one custom role per person. |
| 2. Rights copied into the grant | grant only | 1 | Every role edit rewrites all holders' grants; copies can drift. |
| 3. Several roles per person | up to 3 grants → 3 roles | up to 6 | Big batches (approvals, handovers) already use ~5 and would hit the cap. |

Picked 1: owner's call; custom roles will be few, and stale rights are worse
than one extra lookup.

## Design

### Data

- `roles/{roleId}`: a custom role. `name` (1–60 chars), `caps` (list of
  capability keys, the enum names in `capabilities.dart`), `createdBy
  {email, name}`, `updatedAt`, `auditId`.
- `roles/builtin`: one document, `admin`, `president`, `cr` (each a list of
  capability keys). One document so every built-in check costs one shared
  lookup. Seeded from the §4 table (with decision 1 applied) **before** the
  rules that read it deploy: a missing document denies every built-in check.
  The §4 table and `capabilities.dart` become the seed and the reference for
  the defaults; `capabilities_test.dart` keeps checking they agree.
- Custom grant: `grants/custom|{email}` (one per person, so the rules find it
  from the signed-in address alone). Fields as other grants plus `roleId`;
  `campus` is the holder's campus (for roster listing), `scope` is `'role'`.
  The role holds the scope: `roles/{id}.campus` (a campus key or `all`) and
  `roles/{id}.dept` (a department key or `all`; `all` campus implies `all`). *Builder's call:* the id breaks the
  `role|campus|scope|email` pattern on purpose; `grantId` special-cases it.
- `GrantRole.custom` (`'custom'`, label from the role's name, tag `ROLE`).

### Rules

- `customMay(cap, campus, dept)`: the signed-in person's custom grant is
  live (active, unexpired, `isStudent(me())`), `r = get(roles/{roleId})`,
  `cap in r.caps`, and either the row is an everywhere row (passed as
  `campus == 'all'`) or the role's scope covers the target: `r.campus ==
  'all'` or (`r.campus == campus` and `campusOf(me()) == campus` and
  (`r.dept == 'all'` or `r.dept == dept` or `dept == 'all'` for a campus-level
  row)). Always the **last** term of an `||` chain,
  because a missing grant is an error, and an error only denies when nothing
  before it allowed.
- `builtinMay(role, cap)`: `cap in get(roles/builtin).data[role]`. Each §4
  site's `isAdmin()` / `isPresident(...)` / `isCr(...)` term becomes
  `isAdmin() && builtinMay('admin', '<row>')` and so on. Worst-case lookups
  for one check: owner 1 + builtin 1 + admin, president, CR grants 3 +
  custom grant and role 2 = 7, before the site's own (batches allow 20);
  Phase B's first task measures this per site.
- Every rules site that enforces a §4 row gains `|| customMay('<row>', c, d)`
  with that site's campus and department. Rows with no department (publish,
  public contact, grant terms, owners, admins) pass `'all', 'all'`, so they
  work only for an everywhere reach.
- Read sites that trust the staff index today (roster, moderation lists, link
  flags) read its generic `reach` list, which includes custom holders (M3).
- `roles/{id}` writes (custom; `roles/builtin` is owner-only): author is owner, admin, or `customMay('manageCustomRoles',
  'all', 'all')`; `caps` (before and after) ⊆ the author's own rows: owner
  anything, admin the admin role's current rows, a custom manager their
  role's `caps`.
- Custom-grant writes: granter as above; the granted role's `caps` ⊆ the
  granter's rows; the role's scope lies inside the granter's own scope; the holder is not
  the granter; holder is a **student** address (owner, 2026-11-16) on that
  campus (any campus for `all`), and `customMay` also requires
  `isStudent(me())`, as `isPresident`/`isCr` do. Expiry follows the
  **president term** (`termDays('dept')`, owner, 2026-11-16); renewing
  extends it.
  Audited, and bumps the `grants` marker, like other grants.

### App

- `Capability` gains `manageCustomRoles` and a stable `key` (its enum name).
- `MyRoles` gains the person's live custom grant and its role (loaded with
  their grants, cached the same way). `may()` also answers through it, using
  the same reach rule as the rules.
- UI gates that guard a §4 row through `.admin`, `.presidencies`, `.staff`
  or `reachesAdmin` move to `may(...)`, so a custom holder sees exactly their
  rows. `reachesAdmin` becomes true for anyone with a custom role.
- `MyRoles.may()` reads built-in rows from `roles/builtin` (loaded and cached
  with the person's grants; the §4 defaults while it loads or offline), and
  keeps the reach and the fixed nuances ("never themselves", "pick only",
  admin "own campus") in code.
- Admin dashboard, new section **Roles**: Owner (read-only, every row),
  Admin, President, CR (owner edits the ticks), then the custom roles.
  For custom roles: list (name, rows, holders);
  create/edit (name and a tick list limited to the author's rows, rows that
  need an everywhere reach marked); delete (only with no live holders);
  a scope picker (one department / whole campus / every campus, then the
  campus and department) in the editor; grant (address, role) and revoke.
  Holders show in the roster with the role's name.

### Controls layout (owner, 2026-11-16; Phase A)

Two new tiles on the admin Controls page, for owners and admins:

```
Controls
  People              Maintainers · Appoint someone · Roster
  Tools               Course tools › (campus pills; By department · By course
                        · Merge professors · Bulk upload)
                      Reviews › (campus pills; Review moderation · Compulsory
                        reviews)
  Owners and admins   Roles (replaces Grant terms, Phase B) · Public contact
                        · Audit log
  Owner only          Owners · Publish catalogue · Open Pointer as · Site analytics
```

- Course tools reuses the existing department and course (`/maintain/...`)
  screens and the Open as department/course pickers; no new tool screens.
  Opened from Course tools, a department screen hides its Reviews tile.
- *Merge professors*, *Contributor approvals* and *Compulsory reviews* leave
  the Owners and admins group (they live under the new tiles).
- Presidents' and CRs' own screens are unchanged.
- In Phase B, a custom-role holder sees the tiles and the tools inside them
  that their rows allow.

### Screens

Drawn on the Pointer — UI Directions board, page "Roles & course tools"
(https://claude.ai/artifact/K4H9w2Ad9cwdTqxPSAiWMW); the plan's "Screens
affected" table maps each artboard to its task.

### Rollout

1. **Phase A — admin rights** (G1): table, Dart copy, test, rules sites, rules
   tests. Staging, then owner deploys.
2. **Phase B — custom roles** (G2–G6): rules + tests on the emulator first,
   then store, `MyRoles`, gate migration, dashboard section. Staging, Tester
   QA, owner deploys.

### Every role is a module (owner, 2026-11-16)

- A role, built-in or custom, is one definition: its rows (data) plus its
  reach kind (code: everywhere / campus / department / course). Nothing else
  in the app or the rules says what a role may do.
- **One check in the rules**: `may(cap, campus, dept, course)` answers for
  owner, admin, president (and secretary), CR and custom grants together.
  Every §4 site calls only `may(...)`; no site names a role any more.
  Lifecycle rules that are not §4 rows (handover, secretaries, contributor
  approval, GEN claims, forced-review switch, timetable, catalog) keep their
  own checks.
- **One check in the app**: `MyRoles.may(cap, campus:, scope:)`. Every UI gate
  for a §4 row calls it; `.admin`, `.presidencies`, `.staff` and
  `reachesAdmin` stop being used as permission checks.

### Further modularisation (owner, 2026-11-16: "add all of these")

- **M1. One appointment rule.** Granting or revoking any role, built-in or
  custom, is allowed when the role's rows ⊆ the granter's rows and its reach
  ⊆ the granter's reach (owners: anything). Replaces the per-role branches in
  `mayGrant` (firestore.rules), the tier list in `grant_form.dart` and the
  revoke switch in `people.dart`. Rows 2–4 (*Appoint / revoke admins,
  presidents, CRs*) stay as rows: holding the row is required **in addition**
  to the subset rule, so a role without "Appoint CRs" cannot appoint CRs even
  if it holds every CR row. Handover, secretaries and GEN presidents keep
  their extra conditions on top.
- **M2. "Where can I do X?"** `MyRoles.reach(Capability) → List<Reach>`
  (campus, dept or null for every department, course or null). Every screen
  that picks a campus or department from `presidencies.firstOrNull` uses it.
- **M3. Generic staff index.** `staff/{email}` gains `reach: [{role, campus,
  dept, course}]` written with every grant change, built-in and custom; the
  index-trusting read rules check `reach` instead of `presidentOf`/`courses`.
  The old fields stay until every reader has moved, then are dropped.
- **M4. Screens declare their capability.** Each admin and `/maintain` route
  names the capability it needs; the router guard is `may(cap)` (any reach).
  Settings entries and Controls tiles follow the same list.
  Built-in president and CR access to Controls stays as today; the
  capability guard decides which admin-level routes owners, admins and custom
  holders see.
- **M5. Rules-only rights become rows** (tickable, seeded with today's
  holders): *Approve contributors* (owner, admin, president),
  *Claim elective courses* (owner, admin, president), *Compulsory reviews
  switch* (owner, admin, president own campus), *Publish timetable* (owner,
  admin), *Open Pointer as* (owner). Publishing the catalogue is already row 5
  (*Publishing, analytics*). Handover and secretaries stay fixed processes.
- **M6. "Publish links without approval" becomes a row**, seeded owner,
  admin, president (what `.staff` means today); CRs and contributors still go
  through approval.
- **M7. Term length lives on the role.** Each role definition has `termDays`;
  `config/grantTerms` moves into `roles/builtin` (admin 730, president 365,
  CR 183 defaults) and custom roles carry their own. Supersedes decision 8's
  "president term" for custom roles: the custom role's own `termDays`,
  defaulting to 365.
- **M8. Open as takes a role definition**, so an owner can preview any custom
  role at its own scope (built-in roles keep their department/course pickers).
- **M9. Display metadata on the role** (name, badge tag, reach kind) instead
  of switches in five files.
- **M10. Prefetch by capability**: background loading keys off `reach(cap)`
  rather than role.

### Test matrix (owner, 2026-11-16)

- **One probe per capability**: a registry (`test/rules/capability_probes.mjs`)
  maps every capability key to the smallest real request that exercises its
  rules site (a write or a read), with an in-scope and an out-of-scope target.
- **Rules matrix** (emulator, `test/rules/capability_matrix.test.mjs`): for
  every capability × every actor (owner, admin, president, secretary, CR,
  student, a custom holder at each reach with the row ticked, the same holder
  with it unticked, expired, revoked, deleted role) it asserts allowed exactly
  when `roles/builtin` (or the custom role) ticks the row and the target is in
  reach. The expected answer comes from the same seed the rules read, so
  toggling a tick in the seed flips the expectation with no test edit.
- **App matrix** (`test/core/capability_matrix_test.dart`): the same grid
  against `MyRoles.may`.
- **Exhaustiveness**: both matrices fail if a `Capability` has no probe, so a
  new capability cannot ship without its test.
- **Escalation cases**: an admin or custom manager tries to create, edit or
  grant a role with a row they lack, or a reach wider than theirs, or to
  grant themselves; a non-owner edits `roles/builtin`. All denied.
- **Lookup budget**: each probe runs with the worst-case actor (a custom
  holder who is also a CR), so a site that runs out of lookups fails here.

### Calls made after the builder check (Builder's, owner may overrule)

- **Reach matching per site.** Every site passes its real campus and
  department. A site with no department (contribute, roster/audit reads)
  passes `dept = 'all'`, which only a campus or everywhere reach covers. A site
  with no campus (publish, public contact, grant terms, owners, admins) passes
  `'all', 'all'`, which only an everywhere reach covers. The role editor marks
  each row "department", "campus" or "everywhere" from the same list.
- **Who manages what.** A role's scope must lie inside its author's scope
  (owner and admin: anything), before and after an edit. Granting or revoking
  a custom role needs the granter's scope to cover the role's scope, so
  nobody hands out or removes a role wider than their own.
- **Lookup budget.** Phase B's first task measures each §4 rules site on the
  emulator with `customMay` added. A site that would exceed the cap keeps its
  built-in check only; its row is hidden from the role editor and listed in
  §4 as "not available to custom roles". No row is non-negotiable.
- **Deleted roles.** The rules allow deleting a role with holders; their grants
  then deny cleanly (the role `get` errors). The app blocks the delete while
  live holders exist. No holder counter.
- **Staff index.** Superseded by M3 (owner, 2026-11-16): custom grants write
  the index too, as `reach` entries `{role: 'custom', campus, dept}` taken from
  the role's scope, so index-trusting read sites read `s.reach` (one lookup)
  instead of calling `customMay`. `privileged()` (contacts) counts only
  non-custom entries, so holders stay out of the contacts directory (non-goal).

## Left to the builder

- The exact rules site for each row (the plan maps them).
- Role ids (*builder's call:* random document ids).
- The cache key and marker path for `roles`.
