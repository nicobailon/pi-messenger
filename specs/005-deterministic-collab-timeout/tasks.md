<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.3-codex | date: 2026-03-12 -->
<!-- Status: REVISED -->
<!-- Revisions: Added Task 8 (handler-level tests), config validation steps in Tasks 3-4, degraded-mode progress messaging in Task 2 -->
---
title: "Deterministic Collaborator Timeout — Tasks"
date: 2026-03-12
bead: pi-messenger-2f7
---

# Tasks

## Task 1: Update types, remove constants, add validation constants
**File**: `crew/handlers/collab.ts`
**Deps**: none

- [x] Remove `SPAWN_FIRST_MESSAGE_TIMEOUT_MS` and `SEND_REPLY_TIMEOUT_MS` constants (L45-46)
- [x] Remove their export (L50)
- [x] Add `DEFAULT_STALL_THRESHOLD_MS = 120_000` and `MIN_STALL_THRESHOLD_MS = 1_000` constants (exported for test injection and handler usage)
- [x] Replace `timeoutMs: number` with `stallThresholdMs?: number` in `PollOptions` (L64)
- [x] Replace `"timeout"` with `"stalled"` in `PollResult` error union (L70)
- [x] Add `stallDurationMs?: number` to `PollResult` error shape (L70)

## Task 2: Rewrite poll loop stall detection
**File**: `crew/handlers/collab.ts`
**Deps**: Task 1

- [x] Add `stallLastLogSize` variable alongside renamed `progressLastLogSize` (was `lastLogSize`)
- [x] Add `lastLogChangeTime` initialized to `startTime`
- [x] Initialize both size vars from log file stat (L94-99)
- [x] In `emitProgress()`: use `progressLastLogSize` for delta calculation; when `entry.logFile` is null, emit `"(no log available)"` instead of byte delta
- [x] Reorder poll loop checks: cancel → crash → inbox → stall → progress
- [x] Add one-line comment explaining inbox-before-stall ordering
- [x] Replace timeout check with stall check:
  - Read `stallThresholdMs` from options, default to `DEFAULT_STALL_THRESHOLD_MS`
  - `statSync` the log file
  - If `currentSize > stallLastLogSize`: update `stallLastLogSize = currentSize`, reset `lastLogChangeTime = now`
  - If log file exists AND `now - lastLogChangeTime >= resolvedStallThresholdMs`: resolve `{ ok: false, error: "stalled", logTail, stallDurationMs: now - lastLogChangeTime }`
  - If no log file (`entry.logFile` is null): skip stall check entirely

## Task 3: Restructure executeSpawn error handling ✅
**File**: `crew/handlers/collab.ts`
**Deps**: Task 1

- [x] Read `stallThresholdMs` from crew config: `config.collaboration?.stallThresholdMs`
- [x] Validate: if non-finite or non-numeric, use `DEFAULT_STALL_THRESHOLD_MS`; if < `MIN_STALL_THRESHOLD_MS`, clamp to `MIN_STALL_THRESHOLD_MS`
- [x] Pass validated `stallThresholdMs` to poll call instead of `timeoutMs: SPAWN_FIRST_MESSAGE_TIMEOUT_MS`
- [x] Move `gracefulDismiss(entry)` out of the unconditional pre-check position
- [x] Add per-error-type handling:
  - `crashed` → `gracefulDismiss(entry)`, return crash error (unchanged logic)
  - `cancelled` → `gracefulDismiss(entry)`, return cancel error (unchanged logic)
  - `stalled` → do NOT dismiss, return stall error with `stallDurationMs` in message: `"Collaborator appears stalled — no output for ${N}s"`
- [x] Keep "Do NOT proceed without a collaborator" guidance in stall error

## Task 4: Update executeSend blocking path
**File**: `handlers.ts`
**Deps**: Task 1

- [x] Remove `SEND_REPLY_TIMEOUT_MS` import (L32)
- [x] Import `DEFAULT_STALL_THRESHOLD_MS`, `MIN_STALL_THRESHOLD_MS` from `crew/handlers/collab.js`
- [x] Read `stallThresholdMs` from crew config (config is already loaded at L285 as `crewConfig`)
- [x] Validate same as Task 3: non-finite → default, < min → clamp
- [x] Replace `timeoutMs: SEND_REPLY_TIMEOUT_MS` with validated `stallThresholdMs` in poll call (L361)
- [x] Replace `"timeout"` error branch with `"stalled"` branch (L387-392)
- [x] Update error message: use `stallDurationMs` from result: `"no reply — collaborator appears stalled (no output for ${N}s)"`
- [x] Keep "Do NOT proceed without a collaborator" guidance

## Task 5: Add config support
**File**: `crew/utils/config.ts`
**Deps**: none

- [x] Add `collaboration?: { stallThresholdMs?: number }` to `CrewConfig` interface
- [x] Add JSDoc: "Stall threshold for collaborator blocking exchange — log must grow within this interval or the collaborator is considered stalled. Different from work.stuckTimeoutMs which controls crew worker idle detection."
- [x] Add `collaboration: { stallThresholdMs: 120_000 }` to `DEFAULT_CONFIG`

## Task 6: Update existing poll-level tests
**File**: `tests/crew/collab-blocking.test.ts`
**Deps**: Tasks 1-4

- [x] Update 6 existing tests that use `timeoutMs` as exit mechanism:
  - Each gets a static log file created in test setup
  - Replace `timeoutMs: N` with `stallThresholdMs: 50`
  - Assert `error === "stalled"` instead of `error === "timeout"`
  - Tests: L177 (basic timeout→stall), L277 (Tier 3 rejection), L340 (NaN guard), L363 (wrong sender), L433 (progress), L597 (cleanup)
- [x] Update all remaining tests that pass `timeoutMs` as safety bound:
  - Replace `timeoutMs` with `stallThresholdMs` in poll options
  - These exit via message/crash/cancel — `stallThresholdMs` is just a safety net

## Task 7: Add new poll-level tests
**File**: `tests/crew/collab-blocking.test.ts`
**Deps**: Tasks 1-2

- [x] Add test: "active log growth never triggers stall"
  - Create log file, write to it every 20ms via `setInterval`
  - `stallThresholdMs: 100`
  - Cancel via `AbortController` after 300ms
  - Assert result is `"cancelled"` not `"stalled"` (log was growing)
  - Clean up the write interval in test cleanup
- [x] Add test: "no log file skips stall detection"
  - `logFile: null`, no stallThresholdMs needed
  - Cancel via `AbortController` after 200ms
  - Assert result is `"cancelled"` (stall detection didn't fire)

## Task 8: Add handler-level tests for dismissal semantics
**File**: `tests/crew/collab-blocking.test.ts`
**Deps**: Tasks 1-4

- [ ] ~~Add test: "executeSpawn stall does NOT dismiss collaborator"~~ ESM limitation: same-module internal call to `pollForCollaboratorMessage` cannot be mocked without DI refactoring. Verified by poll-level tests + code review (stall branch returns without calling `gracefulDismiss`).
- [ ] ~~Add test: "executeSpawn crash DOES dismiss collaborator"~~ Same ESM limitation.
- [ ] ~~Add test: "executeSpawn cancel DOES dismiss collaborator"~~ Same ESM limitation.
- [x] Add test: "executeSend stalled error includes stallDurationMs" — implemented via `vi.doMock` (cross-module call, fully mockable)
- [x] Add test: "executeSend crashed error propagates exit code and log tail"
- [x] Add test: "executeSend cancelled error returns correct shape"

## Task 9: Verify and commit
**Deps**: Tasks 1-8

- [x] Run `npx vitest run tests/crew/collab-blocking.test.ts` — 27 tests pass
- [x] Run `npx vitest run` — 448 tests pass, 31 files, 0 regressions
- [x] Run `node install.mjs` to update extensions directory
- [x] Commit: 2 commits — `feat(collab): replace fixed timeouts with stall detection` + `test(collab): handler-level tests`
