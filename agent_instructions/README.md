# Agent instructions

Plans, handoffs and records for agents working on Pointer. Code cites them by
name (for example "ARCHITECTURE.md §7"); they all live here.

## Rule: backend work names its screens

Any design or plan for new backend infrastructure (rules, stores, data
model, permissions) lists every UI screen it changes, including screens that
only change who can open them or how they are reached. If a screen is new or
changes, it is drawn first on a **new page of the Pointer-UI directions
artifact**, and the plan's UI tasks cite that page. Owner rule, 2026-11-16.

## Current

| File | What it is |
|---|---|
| `ARCHITECTURE.md` | The design of record: data, roles, routes, rules. `test/core/capabilities_test.dart` reads its §4 table. `docs/ARCHITECTURE.md` is the contributor overview. |
| `CUSTOM_ROLES_DESIGN.md` | Modular and custom roles: owner decisions, data, rules, M1-M10, test matrix. Built (Phase A and B, on staging); the stable app crashes on custom grants, so create none in production. |
| `PROD_DEPLOY.md` | The owner's production deploy order: Worker, indexes, rules, site, data, rollback. |
| `PROPOSED_FEATURES.md` | The owner's 16 features as users see them. Built, except the timetable generator (deferred). |
| `QUOTA.md` | Firestore reads and writes per user against Spark's caps; `tools/e2e/specs/quota.spec.mjs` writes it. |
| `DISCIPLINES_GOA_HYD.md` | Reference data: programmes per campus (`lib/core/models/programmes.dart` is built from it). |
| `TEST_ARCHITECTURE_PLAN.md` | Tiers T0-T4 and `tools/qa/run.sh`: being built. |

## Deprecated

`deprecated/` holds only plans that no longer match the code, each with a
banner naming its current source of truth. Read them for history only. Code
comments still cite some of them by name and section (`PERF_TEST_PLAN.md §A.1`,
`UI_REBUILD_HANDOFF.md §3.9`, `BUILDOUT_CONTRACTS.md`, `DATA_SYNC_PLAN.md`,
`LOADING_SERVER_PLAN.md`); `python3 agent_toolchains/plan/plan.py get <id>`
reads PERF_TEST_PLAN's by id.

Newly deprecated (2026-11-23; all eight built but now stale in places):
`BUILDOUT_PLAN`, `BUILDOUT_CONTRACTS`, `UI_IMPLEMENTATION_GUIDE`,
`UI_CHANGES_BRIEF`, `UI_MAP`, `LOADING_SERVER_PLAN`, `CUSTOM_ROLES_PLAN`,
`DATA_SYNC_PLAN`. Older: `PLAN`, `UI`, `UI_HANDOFF`, `UI_REBUILD_HANDOFF`,
`UI_OPT`, `UI_PERF_BASELINE`, `PERF_BASELINE`, `PERF_TEST_PLAN`,
`PREREGISTERED_10_11`, `MANUAL_QA`, `COURSE_GAPS`.
