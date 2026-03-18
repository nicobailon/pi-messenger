---
title: "Context-aware poll timeout — fix D5 spawn regression"
date: 2026-03-18
bead: pi-messenger-26f
---

<!-- issue:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-18T18:02:12Z -->
<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.4 | date: 2026-03-18 -->
<!-- Status: UNCHANGED — R0 wording update deferred to implementation T0 per plan -->
<!-- Revisions: none (spec update is first implementation task) -->

# 008 — Context-aware poll timeout: fix D5 spawn regression

## Problem

Spec 006 D5 introduced an absolute wall-clock timeout (300s, never resets) to `pollForCollaboratorMessage` to catch a specific bug: collaborators whose conversation is logically done but whose process stays alive dripping heartbeat bytes, fooling spec 005's log-based stall detection (the PureYak/YoungYak case).

D5 was correct for that case — **send context**, where the collaborator is expected to have already composed and sent a reply. But D5 applies uniformly to **all** polls, including **spawn context**, where the collaborator is booting up, joining the mesh, reading files, and composing its first response. This undoes spec 005's correct behavior for spawn.

### The contradiction

1. **Spec 005** replaced fixed timeouts with log-based stall detection (120s of no log growth). Correct for spawn — an opus agent reading 7 files produces real log output, so stall detection correctly distinguishes "working" from "stuck."

2. **Spec 006 D5** added an absolute wall-clock timeout that never resets — because spec 005's log-based stall detection was fooled by heartbeat bytes from an idle collaborator. Spec 006 spec explicitly states: "Out of scope: Changing the spawn protocol (works fine)."

3. **But D5 fires during spawn too.** The collaborator is NOT idle, NOT dripping heartbeats — it's actively reading files, which DOES produce log output that correctly resets the log-stall timer. D5 kills it at 300s anyway.

### Root cause

`pollForCollaboratorMessage` uses one undifferentiated timeout strategy for two fundamentally different contexts:

- **Spawn:** Collaborator is booting. Log growth = alive. Log-based stall detection (spec 005) is correct here. D5 should NOT apply.
- **Send:** Collaborator received a message and should reply. Idle heartbeat drip can fool log-based stall. D5 IS correct here.

The function has no way to distinguish these contexts.

### Impact

Every collaborator spawn with a heavy boot sequence (large system prompt, multiple file reads, thinking time) risks hitting the 300s absolute timeout while actively working. Observed: PureMoon and LoudMoon both timed out at 300s with zero messages but active log growth, during a `/shape` session in the pi-messenger repo with opus-4-6.

## Requirements

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Spawn polls use a larger D5 threshold (900s default, configurable) — active collaborators not killed at 300s | Core goal |
| R1 | Send polls retain D5 absolute timeout at 300s — idle heartbeat drip protection preserved | Must-have |
| R2 | Both contexts share the same poll function — no code duplication | Must-have |
| R3 | Test proves spawn survives past 300s with active log growth | Must-have |
| R4 | Test proves spawn correctly detects stall when log growth stops (120s) | Must-have |
| R5 | Test proves send still fires D5 at 300s regardless of log growth | Must-have |
| R6 | No API contract change — PollResult shape unchanged, spawn/send callers get same result types | Must-have |
| R7 | Config wiring is tested — a typo in the config key is caught by tests | Must-have |
| R8 | Spawn and send load config from the same path | Must-have |

## Fix

### Approach (revised per challenger + Codex review)

The original approach (add `context` field to PollOptions, gate D5 conditionally) was replaced during planning with a simpler approach: pass a larger `pollTimeoutMs` value from `executeSpawn` via a new `spawnPollTimeoutMs` config key. No new types, no D5 gating logic. Additionally fix a pre-existing config path bug where `executeSend` loads config from `.pi-crew` instead of the canonical `.pi/messenger/crew`.

### Code changes

1. **Config type** (`crew/utils/config.ts`): Add `spawnPollTimeoutMs: number` to collaboration type. Default: `900_000` (15 min).
2. **Spawn constant** (`crew/handlers/collab.ts`): Add `DEFAULT_SPAWN_POLL_TIMEOUT_MS = 900_000`.
3. **Config wiring helper** (`crew/handlers/collab.ts`): Extract `resolveSpawnPollTimeout(config)` — reads `spawnPollTimeoutMs` with validation.
4. **executeSpawn** (`crew/handlers/collab.ts`): Call `resolveSpawnPollTimeout(config)` instead of reading `pollTimeoutMs`.
5. **Config path fix** (`handlers.ts`): Change `.pi-crew` to `crewStore.getCrewDir(cwd)`.

## Acceptance Criteria

1. `spawnPollTimeoutMs` exists in config with 900_000 default
2. `executeSpawn` reads `spawnPollTimeoutMs` (not `pollTimeoutMs`)
3. `executeSend` continues reading `pollTimeoutMs` (unchanged, 300s)
4. Both executeSpawn and executeSend load config from `.pi/messenger/crew`
5. Test: spawn with active log growth past 300s is NOT killed by D5
6. Test: config wiring — `resolveSpawnPollTimeout` correctly reads config
7. Existing tests for log-stall and D5-send continue to pass
8. All existing tests pass (`npx vitest run`)

## Out of scope

- Changing the poll mechanism (file-based inbox polling stays as-is)
- Changing the stall threshold defaults (120s stall, 300s D5)
- Changing the spawn API contract (PollResult shape, executeSpawn return shape)
- Level 1 bandaid (early ack in crew-challenger.md) — unnecessary if this fix ships
- Event-driven spawn completion — correct long-term direction but larger change than needed

## Prior art

| Spec | What it did | Relationship |
|------|-------------|-------------|
| 001 | Introduced spawn + blocking poll | Created the pattern |
| 004 | Made spawn AND send block until reply | Unified poll function |
| 005 | Replaced fixed timeouts with log-based stall detection | Correct for spawn, fooled by heartbeats in send |
| 006 D5 | Added absolute wall-clock timeout to catch heartbeat drip | Correct for send, regressed spawn |
| **008** | **Context-aware timeout — D5 for send only** | **Reconciles 005 + 006** |
