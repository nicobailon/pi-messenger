---
title: "Tasks — context-aware poll timeout (spec 008)"
date: 2026-03-18
bead: pi-messenger-26f
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-18T18:18:33Z -->
<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.4 | date: 2026-03-18 -->
<!-- Status: REVISED -->
<!-- Revisions: Added T0 (spec update + config path fix), T3b (config wiring test), reordered tasks -->

# Tasks: Context-Aware Poll Timeout

## Prerequisites

- [x] Verify all existing tests pass: `npx vitest run tests/crew/collab-blocking.test.ts`

## Implementation

- [x] **T0: Pre-implementation — update spec + fix config path**
  - Update `specs/008-context-aware-poll-timeout/spec.md` R0: change "D5 does not apply during spawn" to "Spawn polls use a larger D5 threshold (900s default, configurable)"
  - Update spec.md requirements table: add R7 (config wiring tested) and R8 (same config path)
  - Update spec.md acceptance criteria to match revised approach
  - Fix `handlers.ts:392`: change `path.join(cwd, ".pi-crew")` to `crewStore.getCrewDir(cwd)`
  - This fixes a pre-existing bug where executeSend loaded config from a different directory than executeSpawn

- [x] **T1: Add `spawnPollTimeoutMs` to config type and defaults**
  - File: `crew/utils/config.ts`
  - Line 90: Add `spawnPollTimeoutMs: number` to `collaboration` type
  - Line 110: Add `spawnPollTimeoutMs: 900_000` to `DEFAULT_CONFIG.collaboration`
  - Update the JSDoc comment above `collaboration` to document the new field

- [x] **T2: Add spawn timeout constant**
  - File: `crew/handlers/collab.ts`
  - Add `export const DEFAULT_SPAWN_POLL_TIMEOUT_MS = 900_000;` alongside `DEFAULT_POLL_TIMEOUT_MS`

- [x] **T3: Extract `resolveSpawnPollTimeout` helper, wire into executeSpawn**
  - File: `crew/handlers/collab.ts`
  - Extract a `resolveSpawnPollTimeout(config: CrewConfig)` helper that reads `config.collaboration.spawnPollTimeoutMs` with the same validation pattern (isFinite, Math.max(MIN_STALL_THRESHOLD_MS, ...))
  - Export the helper for testing
  - In `executeSpawn` (lines 490-493): replace the existing `rawPollTimeout` / `pollTimeoutMs` block with a call to `resolveSpawnPollTimeout(config)`

- [x] **T3b: Test config wiring — `resolveSpawnPollTimeout`**
  - File: `tests/crew/collab-blocking.test.ts`
  - Add a new describe block for `resolveSpawnPollTimeout`:
    - Config has `collaboration.spawnPollTimeoutMs: 600_000` → returns `600_000`
    - Config has no `spawnPollTimeoutMs` → returns `DEFAULT_SPAWN_POLL_TIMEOUT_MS` (900_000)
    - Config has `spawnPollTimeoutMs: -1` (invalid) → returns default (clamped by `Math.max(MIN_STALL_THRESHOLD_MS, ...)`)

- [x] **T4: Test poll-level — spawn survives past default D5**
  - File: `tests/crew/collab-blocking.test.ts`
  - Add in the D5 section (after line ~687):
    ```
    it("spawn context survives past default D5 when pollTimeoutMs is larger", ...)
    ```
  - Set `pollTimeoutMs: 800`, `stallThresholdMs: 60_000`
  - Drip log bytes every 50ms
  - Write inbox message at 400ms
  - Assert: `result.ok === true`

## Verification

- [x] **T5: Run full test suite**
  - `npx vitest run` — all tests must pass
  - Specifically verify:
    - New tests pass (T3b + T4)
    - `"pollTimeout fires despite active log growth (D5)"` still passes (line 605) — proves send-context D5 unchanged
    - `"log-stall returns stallType:'log'"` still passes (line 634) — proves log-stall unchanged

- [x] **T6: Install and manual smoke test**
  - `node install.mjs` — update extension
  - Spawn a collaborator in a real session to verify it doesn't stall at 300s
