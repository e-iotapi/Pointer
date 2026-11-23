> **Deprecated (2026-11-23, stale):** built; but it expects an admin to edit course structures on any campus, and campus separation (only owners cross campuses) came after it. Kept for history. Current source of truth: `CUSTOM_ROLES_DESIGN.md`, `ARCHITECTURE.md` §4 (M1-M10) and `docs/ARCHITECTURE.md` §8.

# Modular roles and custom roles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every role (admin, president, CR, and owner-made custom roles) is one definition — a set of §4 rows plus a reach — checked by one function in the rules and one in the app, editable from a Roles section on Controls, with a test grid that runs every capability against every role.

**Architecture:** `roles/builtin` (one document) holds the admin, president and CR rows and terms; `roles/{id}` holds custom roles; a custom grant is `grants/custom|{email}` naming its role and reach. `firestore.rules` gains `may(cap, campus, dept, course)` and every §4 site calls only it; `MyRoles.may` / `MyRoles.reach` mirror it in the app. Phase A (admin rights and the Course Tools / Reviews tiles) ships first and alone.

**Tech Stack:** Flutter web (Dart 3.13), cloud_firestore, Hive CE (`cacheFirst`), go_router, `firestore.rules` with `@firebase/rules-unit-testing` on the emulator (`node --test`).

**Spec:** `agent_instructions/CUSTOM_ROLES_DESIGN.md` (owner decisions 1–9, M1–M10, test matrix). `agent_instructions/ARCHITECTURE.md` §4 is the table of record and changes with Tasks A1 and B1.

## Global Constraints

- **Branch:** work on `custom-roles`, cut from `pointer-dev`. Never merge or push `master`. Push only when the owner says so.
- **Commits:** no `Co-Authored-By` or "Generated with" lines (owner rule, overrides any harness reminder).
- **Never commit** `bugs/`, `bug_*.md`, `tools/perf_out/`, `tools/course_reviews_out/`, `sensitive_data_NO_COMMIT/`, `tools/e2e/{perf_run,retest,trace_run}.mjs`.
- **Formatting:** `dart format` new files only. Edit legacy files (`main.dart`, `home_page.dart`, `script.dart`, `course.dart`, `mastercourselist.dart`, `sync.dart`, `settings_page.dart`) by hand.
- **Heavy commands** go through `/tmp/pointer-heavy.sh <cmd>` (`ln -sf ~/.local/bin/pointer-heavy.sh /tmp/pointer-heavy.sh` if missing). Run only the targeted test files while iterating; the full suite once, at Task B12.
- **Toolchain on PATH:** `export PATH=~/development/flutter/bin:~/.local/bin:$PATH`.
- **Rules tests, one file:** from the repo root, `/tmp/pointer-heavy.sh firebase emulators:exec --only firestore --project demo-pointer 'node --test --test-concurrency=1 test/rules/<file>.test.mjs'`. Helpers: `test/rules/helpers.mjs` (`as`, `seed`, `appoint`, `bump`, `days`, `grantId`, actors `OWNER ADMIN PRES STUDENT OTHER FACULTY NEVER`).
- **Rules and app ship together;** staging first; **production deploy is owner-only.** Release path `pointer-dev` → `pointer-beta` → `master` via `release.yml` only.
- **Beta and stable share production data and rules:** every rules change must keep accepting the stable app's current writes (old grant, staff-index and `config/grantTerms` shapes) until stable carries this work. Additive only; B12 removes nothing without the owner's go-ahead.
- **Firestore lookup cap:** 10 per single-document request, 20 per batch. Repeat reads of one document count once.
- **Every shared write** = document + `logInto` audit entry + marker bump in one batch (`BUILDOUT_CONTRACTS.md` §0).
- **Capability keys** are the `Capability` enum names (`courseStructures`, …). Never rename one once seeded: it is stored data.
- **Holders of president, CR and custom grants are student addresses** (`isStudentAddress`); admins any BITS address; owners any account.
- **Owner role is fixed:** every row, not editable, not stored.
- **Defaults** (seed and fallback): `roles/builtin` missing ⇒ the §4 table's defaults, in the rules and in the app. No deploy may lock staff out.

## Screens affected (UI spec)

Drawn on the **Pointer — UI Directions** board, page **"Roles & course tools"**
(https://claude.ai/artifact/K4H9w2Ad9cwdTqxPSAiWMW). Every UI task builds to
these artboards; anything not listed stays as staging.

| Artboard | Screen | Task |
|---|---|---|
| `Rl_Controls` | Controls (changed: People · Tools [Course tools, Reviews, Roles] · Owners and admins · Owner only) | A2, B8, B10 |
| `Rl_CourseTools` | Course tools (new) | A2 |
| `Rl_Reviews` | Reviews (new) | A2 |
| `Rl_Roles` | Roles list (new) | B10 |
| `Rl_RoleEditor` | Custom role editor (new: name, **scope**, term, permissions) | B10 |
| `Rl_RoleBuiltin` | Built-in role editor, owner only (new; replaces the Grant terms page) | B9, B10 |
| `Rl_Appoint` | Appoint someone (changed: custom roles listed; scope shown read-only from the role; role term) | B9 |
| `Rl_People` | Maintainers (changed: custom grants with role tag and reach; no contributors) | B10, B11 |
| `Rl_OpenAs` | Open Pointer as (changed: Custom role › opens at the role's own scope) | B11 |

Changed by gating only (no new drawing): `DeptHome` without its Reviews tile
when opened from Course tools (A2); Settings entries, the department and
course screens, Approvals and the professor pickers for custom holders (B8).

## Review Focus

1. **Rules deployed before `roles/builtin` exists.** Admins, presidents and CRs keep exactly today's rights (the inline defaults). Test: B3 `builtin defaults when the document is missing`.
2. **An older cached app build appoints or revokes** (no `reach` field in its staff write, old grant shapes). Its writes still succeed until B12's cleanup. Test: B6 `a staff write without reach is still accepted`.
3. **A role is edited or deleted while its holder's app has the old copy.** The rules deny at once; the app stops offering the tool on its next refresh, and a denied write shows the denied notice, not a crash. Test: B7 `a missing custom role gives no rights`.
4. **A custom holder who is also a CR (or president) uses a heavy batch** (resource approve, link with audit and markers). It stays within 20 lookups. Test: B4 matrix `worst-case actor` column.
5. **A campus-reach custom grant whose holder's address is on another campus** grants nothing there (mirrors presidents). Test: B3 `custom grant used off its holder's campus is refused`.

---

## Phase A — admin rights and the two tiles (ships alone)

### Task A1: Admin column gains six rows

**Files:**
- Modify: `agent_instructions/ARCHITECTURE.md:157-164` (admin cells for rows *Course structures*, *Bulk upload*, *Degree requirements*, *Averages*, *Professors — create, rename*, *Moderate reviews* → `✓`); rewrite the "Admin is deliberately narrow" paragraph (line 168) to say admins also run course tools and moderation.
- Modify: `lib/core/roles/capabilities.dart:26-55` (the same six admin cells)
- Modify: `firestore.rules` — `maintains()` (1087) gains `|| isAdmin()`; the moderation write in `match /reviews/{c}/entries/{id}` and the read helper `readsModeration` accept admins (`isAdmin()` / `s.admin == true`); `courses/{c}/stats` writes accept admins wherever they accept a president.
- Test: `test/core/capabilities_test.dart`, `test/rules/maintain.test.mjs`, `test/rules/reviews.test.mjs`, `test/rules/professors.test.mjs`

**Interfaces:**
- Produces: `can(Role.admin, c)` true for `courseStructures, bulkUpload, degreeRequirements, averages, professors, moderateReviews`.

- [ ] **Step 1: Write the failing tests**

```dart
test('admins run course tools and moderation', () {
  for (final c in [Capability.courseStructures, Capability.bulkUpload,
      Capability.degreeRequirements, Capability.averages,
      Capability.professors, Capability.moderateReviews]) {
    expect(can(Role.admin, c), isTrue, reason: c.label);
  }
  expect(can(Role.admin, Capability.publish), isFalse);
  expect(can(Role.admin, Capability.appointAdmins), isFalse);
});
```
Replace the `admin is narrow` test's `courseStructures` expectation with the publish/appointAdmins/grantTermsAdmin ones above. Rules: in `maintain.test.mjs` add `an admin edits a course structure on any campus` (`assertSucceeds` as `ADMIN` on a Goa and a Hyderabad course); in `reviews.test.mjs` `an admin hides a review` (succeeds) and `a student cannot` (fails); in `professors.test.mjs` `an admin creates and renames a professor`.

- [ ] **Step 2: Run, expect FAIL** — `/tmp/pointer-heavy.sh flutter test test/core/capabilities_test.dart` (the admin test fails; the table test passes only once both copies change), and each rules file (the admin cases fail).

- [ ] **Step 3: Change the six cells in both copies and the four rules sites.**

- [ ] **Step 4: Run, expect PASS** — the same commands, plus `test/rules/roles.test.mjs` (no regressions).

- [ ] **Step 5: Commit** — `git commit -m "Admins run course tools and moderate reviews (§4 admin column)"`

### Task A2: Course Tools and Reviews tiles on Controls

**Files:**
- Create: `lib/admin/course_tools.dart` — `CourseToolsPage` (artboard `Rl_CourseTools`): campus pills, then one group: "By department ›" (`ViewAsDeptPage(tools: true)`), "By course ›" (`ViewAsCoursePage(tools: true)`), "Merge professors ›" (the existing merge route), "Bulk upload ›"; two notes under it.
- Create: `lib/admin/reviews_tools.dart` — `ReviewsToolsPage` (artboard `Rl_Reviews`; campus pills on top): "Review moderation ›" (campus → department → `Routes.deptReviews`), "Compulsory reviews" (the existing switch row, moved).
- Modify: `lib/admin/open_as.dart:274-470` — `ViewAsDeptPage` and `ViewAsCoursePage` take `{bool tools = false}`: in tools mode they `context.push(Routes.dept(...)/crCourse(...))` without setting `viewAs`.
- Modify: `lib/admin/maintain.dart:157` — `DeptHome` takes `hideReviews` (router passes it from `?tools=1`) and drops its Reviews tile when set.
- Modify: `lib/admin/admin_home.dart:94-150` — a new section labelled **TOOLS** after People, holding "Course tools" and "Reviews" (each with the board's NEW badge); remove the *Merge professors*, *Contributor approvals* and *Compulsory reviews* rows from "Owners and admins". *Grant terms* stays until B10. Artboard `Rl_Controls` shows the end state after B10.
- Modify: `lib/app/routes.dart` (`adminCourseTools = '/admin/course-tools'`, `adminReviews = '/admin/reviews'`), `lib/app/router.dart` (two `_admin(...)` routes, guard `_adminOnly`).
- Test: `test/roles/step11_screens_test.dart`

**Interfaces:**
- Produces: `Routes.adminCourseTools`, `Routes.adminReviews`; `Routes.dept(campus, dept)` accepts `?tools=1`.

- [ ] **Step 1: Write the failing widget tests**

```dart
testWidgets('Controls groups course tools and reviews', (t) async {
  signIn('owner@example.com', roles: const MyRoles(email: 'owner@example.com', owner: true));
  await t.pumpWidget(app(const AdminHome()));
  await t.pumpAndSettle();
  expect(find.text('Course tools'), findsOneWidget);
  expect(find.text('Reviews'), findsOneWidget);
  expect(find.text('TOOLS'), findsOneWidget);
  expect(find.text('Merge professors'), findsNothing); // on Controls; it is inside Course tools
  expect(find.text('Contributor approvals'), findsNothing);
  expect(find.text('Compulsory reviews'), findsNothing);
});
testWidgets('Reviews holds moderation and the compulsory switch', ...); // pump ReviewsToolsPage: both texts findsOneWidget
testWidgets('a department opened from Course tools hides Reviews', ...); // pump the dept screen with hideReviews: true: find.text('Reviews') findsNothing; without it findsOneWidget
```

- [ ] **Step 2: Run, expect FAIL** — `/tmp/pointer-heavy.sh flutter test test/roles/step11_screens_test.dart`
- [ ] **Step 3: Implement the two pages, the picker flag, the tile changes and the routes.**
- [ ] **Step 4: Run, expect PASS** — the same file, plus `test/app/routes_test.dart`.
- [ ] **Step 5: Commit** — `git commit -m "Controls: Course tools and Reviews tiles; their rows move inside"`

**Phase A done:** tell the owner it is ready for staging. Do not push without their go-ahead.

---

## Phase B — modular roles

### Task B1: Capability rows, keys, reach kinds and defaults

**Files:**
- Modify: `lib/core/roles/capabilities.dart`
- Modify: `agent_instructions/ARCHITECTURE.md` §4 table (seven new rows; same text as the Dart cells)
- Test: `test/core/capabilities_test.dart`

**Interfaces:**
- Produces:
  - `enum CapReach { everywhere, campus, dept }` — the narrowest reach a row is meaningful at.
  - `Capability` gains `final CapReach reach;` and `String get key => name;`.
  - New rows, appended in this order (key — label — owner/admin/president/CR cells — reach):
    - `manageRoles` — "Manage roles" — `✓`/`✓`/`—`/`—` — everywhere
    - `approveContributors` — "Approve contributors" — `✓`/`✓`/`✓`/`—` — dept
    - `claimElectives` — "Claim elective courses" — `✓`/`✓`/`✓`/`—` — dept
    - `reviewGateSwitch` — "Compulsory reviews switch" — `✓`/`✓`/`✓ own campus`/`—` — campus
    - `publishTimetable` — "Publish the timetable" — `✓`/`✓`/`—`/`—` — everywhere
    - `openAs` — "Open Pointer as" — `✓`/`—`/`—`/`—` — everywhere
    - `publishDirectly` — "Links publish without approval" — `✓`/`✓`/`✓`/`—` — dept
  - Reach of the existing rows: everywhere = `addRemoveOwners, appointAdmins, publish, publicContact, grantTermsCrPresident, grantTermsAdmin`; campus = `readAuditAndRoster, contribute`; dept = the rest.
  - `const builtinRoleKeys = ['admin', 'president', 'cr'];`
  - `Map<String, Set<Capability>> defaultBuiltinCaps()` — the ticked cells per column (`✓…` counts as ticked).
  - `const defaultTermDays = {'admin': 730, 'president': 365, 'cr': 183};`

- [ ] **Step 1: Failing tests**

```dart
test('defaults follow the table', () {
  final d = defaultBuiltinCaps();
  expect(d['admin'], contains(Capability.courseStructures));
  expect(d['admin'], isNot(contains(Capability.publish)));
  expect(d['cr'], {Capability.courseStructures, Capability.courseResources,
      Capability.averages, Capability.contribute});
});
test('default CR ⊆ president ⊆ admin, so today\'s appointments still pass M1', () {
  final d = defaultBuiltinCaps();
  expect(d['president']!.difference(d['admin']!), isEmpty);
  expect(d['cr']!.difference(d['president']!), isEmpty);
});
test('every row has a reach and a stable key', () {
  expect(Capability.values.map((c) => c.key).toSet().length, Capability.values.length);
  expect(Capability.openAs.reach, CapReach.everywhere);
});
```
The literal-copy test keeps passing only when the §4 table has the seven rows.

- [ ] **Step 2: Run, expect FAIL** — `/tmp/pointer-heavy.sh flutter test test/core/capabilities_test.dart`
- [ ] **Step 3: Implement.** If CR ⊆ president ⊆ admin fails on the seeded table, stop and report to the owner (it decides whether admins can still appoint everyone).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Capabilities: keys, reach kinds, seven new rows, built-in defaults"`

### Task B2: Role definitions in the app and the store

**Files:**
- Create: `lib/core/roles/role_defs.dart`
- Modify: `lib/core/roles/role_store.dart` (role reads and writes), `lib/core/heads/paths.dart` (`static const roles = 'roles';`)
- Test: `test/core/role_defs_test.dart`, `test/core/role_store_roles_test.dart` (`FakeFirebaseFirestore`)

**Interfaces:**
- Consumes: B1's `Capability.key`, `defaultBuiltinCaps()`, `defaultTermDays`.
- Produces:
  - `enum ReachKind { everywhere, campus, dept, course }`
  - `class RoleDef { final String id, name, tag; final Set<Capability> caps; final int termDays; final bool builtin; final String? campus, dept; final ReachKind? fixedReach; }` — built-ins: `admin` (Admin, ADMIN, everywhere), `president` (Department president, PRESIDENT, dept), `cr` (Course manager, CR, course); `owner` (Owner, OWNER, every capability, not stored). Custom: `fixedReach == null` (chosen per grant), `tag` defaults to `ROLE`.
  - `class RoleDefs { final Map<String, RoleDef> byId; RoleDef? operator [](String id); static RoleDefs defaults(); static RoleDefs fromDocs(Map<String, dynamic>? builtin, Map<String, Map<String, dynamic>> custom); }` — unknown capability keys in stored data are ignored (an app older than the data).
  - `RoleStore.roleDefs() → Future<RoleDefs>` (`cacheFirst`, key `roles`, marker `Paths.roles` on `goa`); `RoleStore.peekRoleDefs() → RoleDefs?`.
  - `RoleStore.saveBuiltin(String id, Set<Capability> caps, int termDays) → Future<void>` (owner only; merges into `roles/builtin.<id>`).
  - `RoleStore.saveCustomRole({String? id, required String name, required Set<Capability> caps, required int termDays, required String campus, required String dept}) → Future<String>` (returns the id; random id when new).
  - `RoleStore.deleteCustomRole(String id) → Future<void>`.
  - `GrantRole.custom('custom', 'Custom role', 'ROLE')`; `Grant` gains `final String? roleId;` (read and written by `fromMap`/`toMap`); `grantId(GrantRole.custom, _, _, email)` returns `custom|$email`.
  - Each write: audit (`path: 'roles/<id>'`), `bumpPathOnAllHeads(b, db, Paths.roles)`, `LiveHeads.poke(Paths.roles)`, `forget('roles')`.
  - Stored shapes: `roles/builtin = {admin: {caps: [keys], termDays: 730}, president: {...}, cr: {...}, auditId}`; `roles/{id} = {name, caps: [keys], termDays, createdBy: {email, name}, updatedAt, auditId}`.

- [ ] **Step 1: Failing tests** — `defaults() has admin, president, cr with the B1 caps and terms`; `fromDocs with a missing builtin falls back to defaults`; `an unknown key in stored caps is dropped`; store: `saveCustomRole then roleDefs() returns it`, `saveBuiltin writes an audit entry and bumps roles`, `deleteCustomRole removes it from roleDefs()`.
- [ ] **Step 2: Run, expect FAIL** — `/tmp/pointer-heavy.sh flutter test test/core/role_defs_test.dart test/core/role_store_roles_test.dart`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Role definitions: built-in and custom roles as data, with store reads and writes"`

### Task B3: Rules — the `roles` collection, `may()` and custom grants

**Files:**
- Modify: `firestore.rules` (helpers block after `isCr`, a new `match /roles/{id}`, and the `grants` create/update paths for `custom|{email}`)
- Create: `test/rules/custom_roles.test.mjs`
- Modify: `test/rules/helpers.mjs` (exports `seedBuiltin(caps?)`, `customRole(id, caps, termDays, campus, dept)` (scope on the role), `customGrant(email, roleId, opts)`, actor `CUSTOM = 'f20231234@goa.bits-pilani.ac.in'`)

**Interfaces:**
- Produces (rules functions, used by B4–B6):
  - `builtin()` — `exists(roles/builtin) ? get(...).data : <inline defaults identical to defaultBuiltinCaps()/defaultTermDays>`.
  - `customMay(cap, c, d)` — the design's check (live custom grant at `grants/custom|me()`, `isStudent(me())`; `r = get(roles/g.roleId).data`; `cap in r.caps`; `c == 'all'` (an everywhere row: any role scope) or `r.campus == 'all'` or (`r.campus == c && campusOf(me()) == c` and (`r.dept == 'all' || r.dept == d || d == 'all'`))).
  - `may(cap, c, d, k)` — `''` means "no department/course at this site":
```
function may(cap, c, d, k) {
  let b = builtin();
  return isOwner()
    || (cap in b.admin.caps && isAdmin()
        && (!(cap in ['departmentResources', 'courseResources']) || c == campusOf(me())))
    || (d != '' && cap in b.president.caps && isPresident(c, d))
    || (k != '' && cap in b.cr.caps && isCr(c, k))
    || customMay(cap, c, d);
}
```
  (cap tests sit before the grant reads so an unticked role costs no lookup; `customMay` is last because its missing grant errors.)
  - `match /roles/{id}`: read `mayUse()`; `builtin` create/update `isOwner()` only, keys `hasOnly(['admin','president','cr','auditId'])`, each `caps is list`, `termDays` int 1–1095, audited; custom create/update: author `isOwner()` or (`may('manageRoles','all','all','')` and `request.resource.data.caps.hasOnly(myCaps())` and, on update, `resource.data.caps.hasOnly(myCaps())`), `name` 1–60 chars, `termDays` 1–1095, audited, marker bumped; delete same author test on `resource.data`.
  - `myCaps()` — the author's own rows: `b.admin.caps` for an admin; the custom role's `caps` for a custom manager (owners skip the check).

- [ ] **Step 1: Failing tests** (`custom_roles.test.mjs`)
  - `builtin defaults when the document is missing` — no `roles/builtin`; `ADMIN` passes a `publicContact` write, `PRES` an ELEC course-structure write.
  - `only owners write roles/builtin` — `OWNER` succeeds; `ADMIN` fails.
  - `an admin creates a custom role inside their rows` — succeeds with `['averages']`; fails with `['publish']`.
  - `a custom manager cannot create a role with a row they lack` and `cannot edit a role that already has one`.
  - `a custom role gives exactly its ticked row inside its scope` — `CUSTOM` holding a role `['averages']` scoped `goa|ELEC`: an ELEC stats write passes; a CS one fails; a Hyderabad one fails; with `['courseResources']` only, the stats write fails.
  - `expired, revoked or deleted-role custom grants give nothing`.
  - `custom grant used off its holder's campus is refused` — grant `campus: 'hyderabad'` for a Goa address fails on a Hyderabad write.
  - `a faculty address cannot hold a custom grant`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Custom grant writes: id `custom|{email}`, fields as other grants plus `roleId`; `campus == campusOf(email)`, `scope == 'role'`; the role exists and, unless `r.campus == 'all'`, `r.campus == campusOf(email)`. Role writes: `campus` ∈ campuses ∪ `{'all'}`, `dept` ∈ `deptOf` keys ∪ `{'all'}`, `campus == 'all'` ⇒ `dept == 'all'`. Granter rule comes in B5 — for now `isOwner()` only. Extra tests: `an everywhere row in a department-scoped role works on every campus` (`publishTimetable` in a `goa|ELEC` role passes a timetable write); `a campus row in a department-scoped role covers that campus` (`readAuditAndRoster` in `goa|ELEC` lists the Goa roster, not Hyderabad's).
- [ ] **Step 4: Run, expect PASS**, plus `roles.test.mjs`.
- [ ] **Step 5: Commit** — `git commit -m "Rules: roles collection, one may() check, custom grants"`

### Task B4: Rules — every §4 site calls `may()`, with the probe matrix

**Files:**
- Modify: `firestore.rules` — each site below swaps its role terms for `may(...)`, keeping its other conditions (shape, audit, markers, "never themselves", "pick only"):

| Row key | Site | `may(...)` args |
|---|---|---|
| addRemoveOwners | `match /owners/{email}` create/update | `'all','all',''` |
| publish | `match /catalog/{doc}`, analytics reads | `'all','all',''` |
| publicContact | `match /config/public` | `'all','all',''` |
| grantTermsCrPresident, grantTermsAdmin | `roles/builtin` termDays (B5 moves terms) | — |
| mergeProfessors | `editsProfessors` when `mergedIds` changes | `campus, dept, ''` |
| professors | `editsProfessors` otherwise | `campus, dept, ''` |
| courseStructures, bulkUpload | `maintains(campus, courseId)` | `campus, managingDept(campus, courseId), courseId` |
| degreeRequirements | **no site yet** (no writer exists) | listed in `UNENFORCED` |
| departmentResources | `match /resources/{id}` dept-scoped links | `campus, dept, ''` |
| courseResources | the same, course-scoped (`crOn`) | `campus, managingDept(campus, a), a` |
| averages | `match /courses/{c}/stats/{s}` writes | `campus, managingDept(campus, c), c` |
| moderateReviews | review moderation update + `readsModeration` | `d.campus, d.department, ''` |
| readAuditAndRoster | `readsRoster`, `match /audit` read | `campus, 'all', ''` |
| contribute | pending link create | `campusOf(me()), 'all', ''` |
| approveContributors | `approves(campus, dept)` | `campus, dept, ''` |
| claimElectives | `match /courseClaims` create/delete | `campus, d.dept, ''` |
| reviewGateSwitch | `match /reviewGate/{campus}` | `campus, 'all', ''` |
| publishTimetable | `match /timetable/{id}` | `'all','all',''` |
| publishDirectly | resource create with `approved == true` | `campus, dept, course` |
| openAs | app only | listed in `APP_ONLY` |

- Create: `test/rules/capability_probes.mjs`, `test/rules/capability_matrix.test.mjs`

**Interfaces:**
- Consumes: B3 `may`, helpers `seedBuiltin`, `customRole`, `customGrant`.
- Produces: `export const PROBES = { [capKey]: { setup(env): Promise<void>, inScope(db, actor): Promise, outOfScope(db, actor): Promise } }`, `export const UNENFORCED = ['degreeRequirements']`, `export const APP_ONLY = ['openAs']`.

- [ ] **Step 1: Write the matrix test**

`CAPABILITY_KEYS`: parse `lib/core/roles/capabilities.dart` — the identifiers matching `/^  (\w+)\(/m` between `enum Capability {` and its first `;`. In-scope target: Goa, ELEC, `EEE F211` (`PRES` is the Goa ELEC president; the CR actor holds `EEE F211`). Out-of-scope target: Hyderabad, CS, `CS F211`. `expected(cap, actor)`: owner ⇒ both true; otherwise `cap` ticked in the actor's role (seeded `roles/builtin` or its custom role, minus `CUSTOM_EXCLUDED` for custom) **and** the actor's reach covers the target at the row's `CapReach` (a dept-reach actor never covers a `campus` or `everywhere` row; `ADMIN` is a Pilani address, so `departmentResources`/`courseResources` are false for admin on both targets); expired, revoked and deleted-role actors ⇒ false.

```js
for (const cap of CAPABILITY_KEYS) {          // read from lib/core/roles/capabilities.dart enum names
  if (UNENFORCED.includes(cap) || APP_ONLY.includes(cap)) continue;
  for (const actor of ACTORS) {               // owner, admin, president, secretary, cr, student,
                                              // custom@{dept,campus,all} ticked/unticked, expired, revoked, deletedRole,
                                              // worst-case (custom@dept ticked + also a CR)
    test(`${cap} × ${actor.name}`, async () => {
      await PROBES[cap].setup(env); await actor.setup(env, cap);
      const want = expected(cap, actor);      // from the seeded builtin caps + actor's reach — same seed the rules read
      await (want.in ? assertSucceeds : assertFails)(PROBES[cap].inScope(as(actor.email), actor.email));
      await assertFails(PROBES[cap].outOfScope(as(actor.email), actor.email)) // owners and everywhere actors: assertSucceeds
    });
  }
}
test('every capability has a probe or is listed', () => {
  for (const cap of CAPABILITY_KEYS) assert.ok(PROBES[cap] || UNENFORCED.includes(cap) || APP_ONLY.includes(cap), cap);
});
test('toggling a tick flips the answer', ...) // seed builtin without 'averages' for president: PRES averages probe fails
```
- [ ] **Step 2: Run, expect FAIL** (probes for unmigrated sites disagree with the seed for custom actors).
- [ ] **Step 3: Migrate the sites in the table**, one row at a time, rerunning the matrix. A site whose worst-case column errors with a lookup limit: keep its built-in terms, drop `customMay` there, add the row to `CUSTOM_EXCLUDED` (exported from `capability_probes.mjs`, mirrored in Dart in B7), and note it in `ARCHITECTURE.md` §4 as "not available to custom roles".
- [ ] **Step 4: Run, expect PASS** — the matrix, then every `test/rules/*.test.mjs` (`cd test/rules && /tmp/pointer-heavy.sh npm test`).
- [ ] **Step 5: Commit** — `git commit -m "Rules: every §4 site checks may(); capability × role matrix"`

### Task B5: Rules — one appointment rule (M1) and terms on the role (M7)

**Files:**
- Modify: `firestore.rules` — `mayGrant(d)`, `expiryOk(d)`, `termDays(role)`, `terms()`; `match /config/grantTerms` stays readable, writes refused.
- Test: `test/rules/roles.test.mjs`, `test/rules/custom_roles.test.mjs`

**Interfaces:**
- Consumes: B3 `builtin()`, `may()`, `customMay()`.
- Produces:
  - `targetCaps(d)` — `builtin()[kind].caps` for `admin`→`admin`, `dept`→`president`, `course`→`cr`; `get(roles/d.roleId).data.caps` for `custom`.
  - `appointRow(d)` — `appointAdmins` / `appointPresidents` / `appointCrs` / `manageRoles`.
  - `mayGrant(d)` keeps today's role-specific shape checks (student address, campus match, programme, secretary/handover/GEN branches) and replaces the "who" with: `isOwner() || (via admin: isAdmin() && appointRow in b.admin.caps && targetCaps(d).hasOnly(b.admin.caps)) || (via president: isPresident(d.campus, targetDept(d)) && appointRow in b.president.caps && targetCaps(d).hasOnly(b.president.caps)) || (via custom: the granter's role scope covers the target's scope — for a custom target, the target role's `campus`/`dept`; for built-ins, `d.campus`/`targetDept(d)` — && appointRow in its role caps && targetCaps(d).hasOnly(its role caps) && d.email != me())`. Role create/edit/delete: the role's scope (before and after) lies inside the author's scope.
  - `termDays(kind)` — `builtin()[kind].termDays`; custom grants use `get(roles/d.roleId).data.termDays`. Rows `grantTermsCrPresident` / `grantTermsAdmin` gate who may change those `termDays` in `roles/builtin` (owner: any; admin: president and CR only).

- [ ] **Step 1: Failing tests** — `a president still appoints a CR in their department` (unchanged behaviour); `an admin still appoints a president` (default seed); `a president cannot appoint a CR once cr has a row president lacks` (seed `cr` with `publish`: fails); `an admin with manageRoles grants a custom role inside admin rows`; `a custom manager at goa|CS grants at goa|CS, not at goa|all or hyderabad`; `nobody grants themselves a custom role`; `custom grant expiry follows the role's termDays`; `an admin changes the CR term but not the admin term`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The existing `roles.test.mjs` cases must keep passing unchanged except the grant-terms ones, which move from `config/grantTerms` to `roles/builtin`.
- [ ] **Step 4: Run, expect PASS** — `roles.test.mjs`, `custom_roles.test.mjs`, `capability_matrix.test.mjs`.
- [ ] **Step 5: Commit** — `git commit -m "Rules: one appointment rule for every role; terms live on the role"`

### Task B6: Generic staff index (M3)

**Files:**
- Modify: `lib/core/roles/roles.dart:239-300` (`StaffEntry` gains `final List<Reach> reach;`, `after(Grant)` maintains it), `lib/core/roles/role_store.dart` (`_staffInto` writes `reach`; custom grants write the index too)
- Modify: `firestore.rules` — `staffListed` also checks `reach` when present; `readsRoster`, `readsModeration`, `readsFlags`, `staffOn`, `isPresidentOn` read `s.reach` (`{role, campus, dept, course}` entries); old `presidentOf`/`courses` read as a fallback while `reach` is absent.
- Test: `test/rules/roles.test.mjs`, `test/rules/contacts.test.mjs`, `test/roles/staff_entry_test.dart` (new)

**Interfaces:**
- Produces: `class Reach { final String role, campus; final String? dept, course; Map<String, Object?> toMap(); static Reach fromMap(Map); bool covers(String? campus, String? dept, String? course); }` in `lib/core/roles/roles.dart` (B7 reuses it).

- `privileged()` (contacts) counts only non-custom `reach` entries (or `admin`/`presidentOf`/`courses`), so custom holders stay out of the contacts directory (design non-goal).

- [ ] **Step 1: Failing tests** — Dart: `after(custom grant at goa|CS) adds {role: custom, campus: goa, dept: CS}`; `revoking removes it`. Rules: `a custom holder with readAuditAndRoster at goa|all lists the Goa roster`; `a staff write without reach is still accepted` (old build shape); `a custom-only holder cannot write staffContacts` (`contacts.test.mjs`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS** — the files above plus `capability_matrix.test.mjs`.
- [ ] **Step 5: Commit** — `git commit -m "Staff index: one reach list for every role"`

### Task B7: `MyRoles` answers through role definitions (and M2 `reach`)

**Files:**
- Modify: `lib/core/roles/roles.dart:305-387` (`MyRoles`), `lib/core/roles/role_store.dart:176-206` (`loadMine`), `lib/core/roles/session.dart` (restore/refresh carry defs)
- Create: `test/core/capability_matrix_test.dart`
- Modify: `test/core/capabilities_test.dart` (move the `may` cases if any)

**Interfaces:**
- Consumes: B2 `RoleDefs`, `RoleDef`; B6 `Reach`.
- Produces:
  - `MyRoles({..., RoleDefs? defs, Grant? custom})` (`defs` null ⇒ `RoleDefs.defaults()`) — `custom` is the live `custom|{email}` grant (B2's `GrantRole.custom`).
  - `bool may(Capability c, {String? campus, String? scope})` — same answer as the rules' `may()`: owner; admin if `defs['admin'].caps` has it (`departmentResources`/`courseResources` own campus only); each presidency / CR grant if its def has it and the target is inside; the custom grant if its role has it and its reach covers; `CUSTOM_EXCLUDED` rows never through custom.
  - `List<Reach> reach(Capability c)` — every place the person may do `c`: owner/admin ⇒ `[Reach(role: 'admin', campus: 'all')]`; president ⇒ `(campus, dept)`; CR ⇒ `(campus, course)`; custom ⇒ its role's scope (`Reach(role: 'custom', campus: r.campus, dept: r.dept)`; everywhere rows ⇒ `campus: 'all'`).
  - `bool get reachesAdmin` ⇒ `owner || admin || custom != null`.
  - `loadMine` takes the custom grant from its existing `email ==` query and calls `roleDefs()`.
  - `const customExcluded = <Capability>{...}` — copy of B4's `CUSTOM_EXCLUDED`.

- [ ] **Step 1: Failing tests** — the app matrix: for every `Capability` × the same actor list as B4 (built from `Grant`s and `RoleDefs`), `may` equals the expected answer computed from the defs (no hand-written table); `a missing custom role gives no rights`; `reach(averages) for a goa|ELEC president is [goa/ELEC]`; `unticking averages for president in defs makes may false`; `every Capability appears in the matrix`.
- [ ] **Step 2: Run, expect FAIL** — `/tmp/pointer-heavy.sh flutter test test/core/capability_matrix_test.dart test/core/capabilities_test.dart`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `test/roles/`.
- [ ] **Step 5: Commit** — `git commit -m "MyRoles: may() and reach() through role definitions and custom grants"`

### Task B8: Screens declare their capability (M4, M2, M6, M10)

**Files:**
- Modify: `lib/app/router.dart:229-260, 405-440` — `_admin(path, page, Capability cap)`; guard `myRoles.value.reach(cap).isNotEmpty`. Mapping: people/grant → `appointCrs` (any appoint row: use `anyOf([...])`), owners → `addRemoveOwners`, analytics → `publish`, terms → `grantTermsCrPresident`, contact → `publicContact`, audit/roster/volunteers → `readAuditAndRoster`, merge → `mergeProfessors`, approvals → `approveContributors`, publish → `publish`, open-as → `openAs`, course-tools → any of the Course Tools rows, reviews → `moderateReviews`/`reviewGateSwitch`, roles → `manageRoles`. `/admin` itself: `reachesAdmin || presidencies.isNotEmpty`.
- Modify: `lib/features/settings/settings_page.dart:138-176` (by hand: legacy file) — entries use `may`/`reachesAdmin`.
- Modify: `lib/admin/admin_home.dart` — each tile shows only when `reach(<its cap>)` is non-empty.
- Modify: `lib/features/contribute/contribute_data.dart:48,110`, `contribute_widgets.dart:174` — `.staff` → `may(Capability.publishDirectly, ...)` with the link's campus and department.
- Modify: `lib/admin/professors.dart:565-615`, `config_pages.dart:983-985`, `roster.dart:52-53,113,179`, `volunteers.dart:21-80`, `maintain.dart:126,232,389,589`, `succession.dart:36,267,478`, `people.dart:322-331` — campus/department from `reach(cap)` and permission from `may(...)`.
- Modify: `lib/app/prefetch_levels.dart:96-113` — prefetch per `reach(cap)` entry.
- Test: `test/app/routes_test.dart`, `test/roles/step11_screens_test.dart`, `test/features/contribute/*` (the one covering direct publish)

**Interfaces:**
- Consumes: B7 `may`, `reach`.
- Produces: `bool anyOf(Iterable<Capability> cs) => cs.any((c) => myRoles.value.reach(c).isNotEmpty);` in `lib/app/router.dart`.

- [ ] **Step 1: Failing tests** — `a custom holder with averages at goa|ELEC opens Course tools and the ELEC course screen, not Reviews`; `a custom holder without readAuditAndRoster is redirected from the roster`; `a CR's link still waits for approval; a custom holder with publishDirectly publishes at once`; `the professors picker for a custom holder at goa|CS starts on goa/CS`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Grep to finish: `grep -rnE "\.(staff|presidencies|admin\b|reachesAdmin)" lib` returns only display uses (names, badges, counts), each with a one-line comment saying so.
- [ ] **Step 4: Run, expect PASS** — the three test paths plus `test/admin/`.
- [ ] **Step 5: Commit** — `git commit -m "Screens and routes ask may()/reach() for their capability"`

### Task B9: One appointment path in the app (M1, M7)

**Files:**
- Modify: `lib/admin/grant_form.dart` — the tier list becomes the role list from `RoleDefs` filtered by `mayAppoint`; a custom role shows its scope read-only ("SCOPE · SET BY THE ROLE", artboard `Rl_Appoint`); expiry max = the role's `termDays`.
- Modify: `lib/admin/people.dart:318-335` — revoke allowed by `mayAppoint(def, reachOf(grant))`.
- Term editing moves into the built-in role editor (B10, artboard `Rl_RoleBuiltin`, term stepper; owner: all three; admin: President and CR terms only). `lib/admin/config_pages.dart`'s Grant terms page is retired: `Routes.adminTerms` redirects to `Routes.adminRoles` once B10 lands.
- Modify: `lib/admin/grant_form.dart` copy — the "TIER" section label becomes "ROLE"; custom roles follow the built-in pills; a custom role replaces the SCOPE card with "SCOPE · SET BY THE ROLE" (read-only scope label + "Change it in Roles"); EXPIRES says "The term comes from the role" (artboard `Rl_Appoint`).
- Modify: `lib/core/roles/role_store.dart` — `appoint` accepts `GrantRole.custom` with `roleId` and writes `grants/custom|{email}`; `terms()`/`saveTerms()` read and write `roles/builtin`.
- Modify: `lib/core/roles/roles.dart` — `bool MyRoles.mayAppoint(RoleDef target, {Reach? at})` (`at` for built-ins: the department/course picked; custom roles use their own scope): owner true; else some role of mine holds the target's appoint row (B5's `appointRow`), `target.caps ⊆ that role's caps`, the target's scope inside that role's scope, and the target is not me for custom.
- Test: `test/core/capability_matrix_test.dart` (mayAppoint cases), `test/roles/step11_screens_test.dart`

- [ ] **Step 1: Failing tests** — `mayAppoint` agrees with B5's rules cases (same five scenarios); `the form lists a custom role only to someone who may appoint it`; `a custom grant's expiry picker stops at the role's termDays`; `an admin's terms page edits president and CR, not admin`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Appoint and revoke any role through one check; terms live on the role"`

### Task B10: Roles section on Controls

**Files:**
- Create: `lib/admin/roles_page.dart` — `RolesPage` (Owner row read-only "Every permission"; Admin, President, CR, then custom roles with holder counts), `RoleEditor` (artboards `Rl_RoleEditor`, `Rl_RoleBuiltin`: name for custom; **scope for custom** — One department / Whole campus / Every campus, then campus pills and a department picker, limited to the author's own scope; term stepper; a tick list of `Capability.values` grouped by `reach`, each row disabled unless the author holds it, rows needing a wider reach labelled "campus" / "everywhere"; Delete for custom, disabled with "Revoke its N holders first" while live holders exist).
- Modify: `lib/admin/admin_home.dart` — "Roles" (NEW badge, subtitle "What each role may do, its scope and term", gated `manageRoles`) becomes the first row of "Owners and admins" and **replaces** *Grant terms* (artboard `Rl_Controls`); add a footer note that grant terms moved into Roles. Roles list, editors: artboards `Rl_Roles`, `Rl_RoleEditor`, `Rl_RoleBuiltin`. `lib/app/routes.dart` (`adminRoles = '/admin/roles'`, `adminRole(String id) => '/admin/roles/$id'`), `lib/app/router.dart`.
- Modify: `lib/admin/people.dart`, `lib/admin/roster.dart` — custom grants listed under the role's name and tag.
- Test: `test/admin/roles_page_test.dart`

- [ ] **Step 1: Failing tests** — `an admin sees Admin/President/CR read-only and can create a custom role`; `the owner edits President's ticks`; `a row the author lacks is disabled`; `delete is disabled while a holder is live`; `a saved role appears with 0 holders`.
- [ ] **Step 2: Run, expect FAIL** — `/tmp/pointer-heavy.sh flutter test test/admin/roles_page_test.dart`
- [ ] **Step 3: Implement** with the existing admin widgets (`PageFrame`, `PageHeader`, `SectionLabel`, `PrimaryButton`, `CountBadge`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Controls: Roles section to edit built-in roles and make custom ones"`

### Task B11: Open as any role (M8) and display from the role (M9)

**Files:**
- Modify: `lib/core/roles/session.dart:63-75` — `ViewAs(RoleDef role, {Reach? at})` (`at` only for built-in president/CR; a custom role uses its own scope); the lens builds a `MyRoles` from that definition so `may`/`reach` answer as the holder would.
- Modify: `lib/admin/open_as.dart` — a "Custom role ›" entry: pick a role; it opens at the role's own scope (artboard `Rl_OpenAs`).
- Modify: `lib/admin/widgets.dart:110` (`TierTag.of(RoleDef)`), `grant_form.dart:36-44` (title from `def.name`), `admin_home.dart:107-110` (counts per def), `roster.dart:42-43` (filter chips from defs), `roles.dart` `Grant.scopeLabel` (custom: "ELEC · Goa", "Every department · Goa", "Every campus").
- Test: `test/roles/step11_screens_test.dart`

- [ ] **Step 1: Failing tests** — `Open as a custom role scoped goa|ELEC shows Course tools, not Roles`; `a custom grant's badge shows the role's name and its scope label`; `roster filter chips list each role by name`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Open as any role at any reach; names and badges come from the role"`

### Task B12: Documentation, full suite and rollout order

**Files:**
- Modify: `agent_instructions/ARCHITECTURE.md` §4 — the table becomes "defaults, editable in Controls › Roles"; describe `roles/builtin`, custom roles, `may()`, reach kinds, M1 and the lookup budget; list `CUSTOM_EXCLUDED`/`UNENFORCED` rows.
- Modify: `agent_instructions/README.md` — add this plan and the design.
- Modify: `firestore.rules` — drop the `presidentOf`/`courses` fallbacks from B6 **only** if the owner confirms every live client has updated (otherwise leave them and note it).

- [ ] **Step 1: Full suite** — `/tmp/pointer-heavy.sh flutter analyze`, `/tmp/pointer-heavy.sh flutter test`, `cd test/rules && /tmp/pointer-heavy.sh npm test`. Expected: all pass.
- [ ] **Step 2: Write the rollout checklist into the commit body:** (1) deploy rules + app to staging together; (2) owner opens Controls › Roles once (writes `roles/builtin` from the defaults — rules fall back to the same defaults until then); (3) Tester QA: appoint a president, a CR, a custom role at each reach; (4) owner deploys production.
- [ ] **Step 3: Commit** — `git commit -m "Docs: modular roles in §4; rollout order"`
