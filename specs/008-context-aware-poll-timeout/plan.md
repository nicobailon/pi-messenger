---
title: "Plan — context-aware poll timeout (spec 008)"
date: 2026-03-18
bead: pi-messenger-26f
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-18T18:18:33Z -->
<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.4 | date: 2026-03-18 -->
<!-- Status: REVISED -->
<!-- Revisions: Added resolveSpawnPollTimeout helper + config wiring test (T3b), fixed config path bug in handlers.ts (T0), moved spec R0 update to pre-implementation (T0), added R7/R8 requirements -->

# Plan: Context-Aware Poll Timeout

## Summary

Fix the D5 spawn regression by passing a larger `pollTimeoutMs` to `executeSpawn` than to `executeSend`. No new types, no D5 gating logic, no PollOptions schema change. Additionally fix a pre-existing config path inconsistency where `executeSend` loads config from `.pi-crew` instead of the canonical `.pi/messenger/crew`.

## Approach

### What changes

**T0: Pre-implementation — update spec.md R0 and fix config path inconsistency**

The checked-in spec.md R0 says "D5 does not apply during spawn" with a `context` field. The plan uses a different (simpler, challenger-approved) approach: keep D5 with a larger threshold. Update spec.md R0 FIRST so the spec and plan agree before implementation.

Fix `handlers.ts:392` — change `path.join(cwd, ".pi-crew")` to `crewStore.getCrewDir(cwd)`. This ensures executeSend reads config from the same directory as executeSpawn (`.pi/messenger/crew`). Pre-existing bug, directly relevant to config behavior.

**T1: Config type** (`crew/utils/config.ts`, line 90)

Add `spawnPollTimeoutMs: number` to the `collaboration` type. Add default `900_000` (15 min) to `DEFAULT_CONFIG`.

**T2: Spawn timeout constant** (`crew/handlers/collab.ts`)

Add `export const DEFAULT_SPAWN_POLL_TIMEOUT_MS = 900_000` alongside existing `DEFAULT_POLL_TIMEOUT_MS = 300_000`.

**T3: executeSpawn reads `spawnPollTimeoutMs`** (`crew/handlers/collab.ts`, lines 490-493)

Extract a `resolveSpawnPollTimeout(config)` helper that reads `spawnPollTimeoutMs` from config with validation (same pattern as existing `pollTimeoutMs` resolution). `executeSpawn` calls this helper. This creates a testable seam for the config wiring.

**T3b: Config wiring test** (`tests/crew/collab-blocking.test.ts`)

Test `resolveSpawnPollTimeout` directly:
- Config has `spawnPollTimeoutMs: 600_000` → returns 600_000
- Config has no `spawnPollTimeoutMs` → returns DEFAULT_SPAWN_POLL_TIMEOUT_MS (900_000)
- Config has invalid value → returns default

This proves the config wiring works and catches typos in the key name.

**T4: Poll-level test** (`tests/crew/collab-blocking.test.ts`)

"Spawn context survives past default D5 when pollTimeoutMs is larger":
- Set `pollTimeoutMs: 800` (simulates spawn ceiling)
- Set `stallThresholdMs: 60_000` (prevent log-stall)
- Drip log bytes, deliver message at 400ms
- Assert: `result.ok === true`

**T5: Run full test suite** — `npx vitest run`

### What does NOT change

- `PollOptions` interface — no new fields
- `PollResult` type — no new variants
- `pollForCollaboratorMessage` internals — no gating logic, no branching
- Log-based stall detection — still 120s default for both contexts
- All 23 existing test call sites — no modifications needed

### Why this approach

An adversarial challenger (SwiftCastle) identified that the original `context` field approach would:
1. Leave spawn with zero ceiling (unbounded — runaway risk)
2. Require updating 23 existing test call sites
3. Create a dead `pollTimeoutMs` parameter in executeSpawn
4. Leave spawn-with-no-logFile with zero timeout protection

The revised approach (different `pollTimeoutMs` per caller) resolves all 4 while being simpler.

Codex review (Round 1) identified 3 additional gaps:
1. No test proving executeSpawn reads the new config key → added `resolveSpawnPollTimeout` helper with tests
2. Config path inconsistency between spawn and send → fixed `.pi-crew` to use `crewStore.getCrewDir(cwd)`
3. Spec drift (plan changed requirements without updating spec first) → spec.md updated in T0

### Architecture

```
executeSpawn                     executeSend
     │                               │
     │ resolveSpawnPollTimeout()      │ pollTimeoutMs from config
     │ → 900s default                 │ → 300s default
     │                               │
     │ config: .pi/messenger/crew     │ config: .pi/messenger/crew (FIXED)
     │                               │
     └───────────┬────────────────────┘
                 │
      pollForCollaboratorMessage
                 │
          ┌──────┴──────┐
          │             │
     Log-stall       D5 timeout
     (120s)         (900s or 300s
     same for        depending on
     both)           caller)
```

## Requirement Traceability

| Req | How satisfied |
|-----|---------------|
| R0 | executeSpawn passes `spawnPollTimeoutMs` (900s default) via `resolveSpawnPollTimeout` helper |
| R1 | executeSend unchanged, passes `pollTimeoutMs` (300s default) |
| R2 | pollForCollaboratorMessage unchanged — no branching |
| R3 | New test: poll with `pollTimeoutMs: 800`, message at 400ms → succeeds |
| R4 | Existing test `"log-stall returns stallType:'log'"` (line 634) |
| R5 | Existing test `"pollTimeout fires despite active log growth (D5)"` (line 605) |
| R6 | PollResult, PollOptions shapes unchanged |
| R7 | New test: `resolveSpawnPollTimeout` with present/absent/invalid config |
| R8 | T0 fixes `handlers.ts:392` to use `crewStore.getCrewDir(cwd)` |

## Blast Radius

| File | Change | Risk |
|------|--------|------|
| `specs/008-context-aware-poll-timeout/spec.md` | Update R0 wording | None |
| `crew/utils/config.ts` | Add `spawnPollTimeoutMs` to type + default | Low — additive |
| `crew/handlers/collab.ts` | Add constant + helper + executeSpawn reads new config | Low — ~15 lines |
| `handlers.ts` | Fix `.pi-crew` → `crewStore.getCrewDir(cwd)` | Low — 1 line |
| `tests/crew/collab-blocking.test.ts` | 2 new tests | None — additive |

Total: ~20 lines of production code, ~50 lines of test code.
