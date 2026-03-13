<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.3-codex | date: 2026-03-12 -->
<!-- Status: REVISED -->
<!-- Revisions: Added handler-level tests for dismissal semantics (Task 8), config validation with MIN_STALL_THRESHOLD_MS clamping, explicit degraded-mode messaging for logFile:null, log-tail security noted as pre-existing concern -->
---
title: "Deterministic Collaborator Timeout — Implementation Plan"
date: 2026-03-12
bead: pi-messenger-2f7
---

# Implementation Plan

## Approach

Replace the fixed wall-clock timeouts in `pollForCollaboratorMessage` with stall detection based on log file growth. The poll loop already reads `entry.logFile` size for progress reporting — we split the tracking into two separate accumulators (stall detection vs progress reporting) and use the stall accumulator as the exit signal.

### Architecture Decision: Separate Accumulators

The current code uses one `lastLogSize` variable for both progress reporting and (now) stall detection. These have different update frequencies — stall detection needs 100ms granularity, progress reporting needs 30s accumulation. Sharing the variable breaks progress reports (they'd show ~100ms of output instead of 30s).

**Solution**: Two variables in the poll loop closure:
- `stallLastLogSize` — updated every 100ms cycle when `stat.size > stallLastLogSize`; resets `lastLogChangeTime`
- `progressLastLogSize` — updated only inside `emitProgress()` at 30s intervals; used for the human-readable delta

One `statSync()` call per cycle (the one in the stall check), result reused by progress if the interval is due.

### Architecture Decision: Poll Loop Check Ordering

Current order: cancel → crash → timeout → inbox → progress.

New order: cancel → crash → inbox → stall → progress.

Rationale (from challenger): if a message arrives at exactly the stall boundary, inbox-first picks it up as success rather than stalling. Costs nothing, semantically correct.

### Architecture Decision: Stall Does Not Auto-Dismiss

The current timeout path calls `gracefulDismiss(entry)` before checking the error type. This means ALL non-success results dismiss the collaborator. For stall, this is wrong — the collaborator may resume (e.g., slow model, large context).

**Solution**: Move `gracefulDismiss` into per-error-type branches. Dismiss on crashed and cancelled. Do NOT dismiss on stalled — return the error and let the spawning agent (or user) decide.

### Architecture Decision: stallDurationMs in PollResult

The deleted constants (`SPAWN_FIRST_MESSAGE_TIMEOUT_MS`, `SEND_REPLY_TIMEOUT_MS`) were used in error message formatting. Without them, callers have no value to include in error text.

**Solution**: Add `stallDurationMs?: number` to `PollResult` error shape. The poll function knows how long the stall lasted — it returns that in the result. Callers format messages using it: `"no output for ${Math.round(stallDurationMs / 1000)}s"`.

### Architecture Decision: Config Validation

The config loader (`loadCrewConfig`) performs deep merge with no runtime type validation. A user setting `stallThresholdMs: 0`, `stallThresholdMs: -1`, or `stallThresholdMs: "foo"` would cause instant stall or broken behavior.

**Solution**: After loading and merging config, validate `collaboration.stallThresholdMs`:
- If non-finite or non-numeric: fall back to default (120_000)
- If less than minimum floor (1_000ms): clamp to floor
- Applied in the poll call sites (`executeSpawn`, `executeSend`) when reading config, not in the config loader itself (keeps loader generic, validation close to usage)

### Architecture Decision: Degraded Mode Messaging (logFile: null)

When log file creation fails (disk full, permissions), `entry.logFile` is null. In this degraded mode:
- Stall detection is **skipped** entirely (no log evidence to assess)
- Only crash, cancel, and message-received exits apply
- Progress updates show elapsed time but no byte delta: `"Waiting for X... 120s elapsed (no log available)"`
- If the spawning agent asks "why isn't it stalling out?", the progress message explains the degraded state

This is already specified in AC2 but needs explicit handling in `executeSpawn` and `executeSend` error messages and progress text.

## Requirement-to-Change Traceability

| Requirement | Change |
|-------------|--------|
| R1 (no fixed timeout) | Remove `SPAWN_FIRST_MESSAGE_TIMEOUT_MS`, `SEND_REPLY_TIMEOUT_MS`, wall-clock check in poll loop |
| R2 (stall detection) | Add `lastLogChangeTime` + stall check in poll loop |
| R3 (stall error quality) | Log tail in stall result (reuse existing `readLogTail`), actionable error message, degraded-mode messaging when logFile is null |
| R4 (progress unchanged) | Separate `progressLastLogSize` accumulator |
| R5 (configurable threshold) | `collaboration.stallThresholdMs` in CrewConfig with validation/clamping |
| R6 (PollOptions change) | `timeoutMs` → `stallThresholdMs?` with default |
| R7 (tests updated) | 6 poll-level tests updated, 2 new poll-level tests added, 4 new handler-level tests for dismissal semantics and error payloads |
| R8 (existing exits unchanged) | cancel/crash/message paths untouched |

## Files Changed

### `crew/handlers/collab.ts` (primary)

| Section | Change |
|---------|--------|
| Constants (L45-50) | Remove `SPAWN_FIRST_MESSAGE_TIMEOUT_MS`, `SEND_REPLY_TIMEOUT_MS`, their export. Add `DEFAULT_STALL_THRESHOLD_MS = 120_000` and `MIN_STALL_THRESHOLD_MS = 1_000` constants |
| `PollOptions` (L55-66) | Replace `timeoutMs: number` with `stallThresholdMs?: number` |
| `PollResult` (L68-70) | Replace `"timeout"` with `"stalled"` in union; add `stallDurationMs?: number` |
| Poll loop variables (L89-92) | Add `stallLastLogSize`, `lastLogChangeTime`; rename existing to `progressLastLogSize` |
| Log init (L94-99) | Initialize both `stallLastLogSize` and `progressLastLogSize` |
| `emitProgress()` (L146-160) | Use `progressLastLogSize` instead of `lastLogSize`; when `entry.logFile` is null, emit `"(no log available)"` instead of byte delta |
| Poll loop body (L163-220) | Reorder to cancel→crash→inbox→stall→progress; replace timeout check with stall check; skip stall check when `entry.logFile` is null |
| `executeSpawn` (L410-450) | Remove `timeoutMs: SPAWN_FIRST_MESSAGE_TIMEOUT_MS`; read `stallThresholdMs` from config with validation (`Math.max(MIN_STALL_THRESHOLD_MS, value)`); restructure error handling — `gracefulDismiss` only for crashed/cancelled; stall branch returns error with `stallDurationMs` in message and does NOT dismiss |

### `handlers.ts` (send path)

| Section | Change |
|---------|--------|
| Import (L32) | Remove `SEND_REPLY_TIMEOUT_MS` import; import `DEFAULT_STALL_THRESHOLD_MS`, `MIN_STALL_THRESHOLD_MS` |
| Poll call (L361) | Replace `timeoutMs: SEND_REPLY_TIMEOUT_MS` with validated `stallThresholdMs` from config |
| Error handling (L387-392) | Replace `"timeout"` branch with `"stalled"` branch; use `stallDurationMs` from result in error message |

### `crew/utils/config.ts` (config)

| Section | Change |
|---------|--------|
| `CrewConfig` interface | Add `collaboration?: { stallThresholdMs?: number }` with JSDoc: "Stall threshold for collaborator blocking exchange — log must grow within this interval or the collaborator is considered stalled. Different from work.stuckTimeoutMs which controls crew worker idle detection." |
| `DEFAULT_CONFIG` | Add `collaboration: { stallThresholdMs: 120_000 }` |

### `tests/crew/collab-blocking.test.ts` (tests)

#### Poll-level tests (updated)

| Test | Change |
|------|--------|
| "resolves with timeout when no message arrives" (L177) | → "resolves with stalled when log stops growing". Add static log file, use `stallThresholdMs: 50` |
| "rejects mismatched replyTo (Tier 3)" (L277) | Add static log file, `stallThresholdMs: 50`, assert `"stalled"` |
| "handles unparseable timestamp (NaN guard)" (L340) | Add static log file, `stallThresholdMs: 50`, assert `"stalled"` |
| "messages from wrong collaborator" (L363) | Add static log file, `stallThresholdMs: 50`, assert `"stalled"` |
| "emits progress updates at 30s intervals" (L433) | Add static log file, `stallThresholdMs: 50` (exit mechanism) |
| "set is empty after timeout" (L597) | → "set is empty after stall". Add static log file, `stallThresholdMs: 50`, assert `"stalled"` |

#### Poll-level tests (new)

| Test | Description |
|------|-------------|
| "active log growth never triggers stall" | Write to log file every 20ms via `setInterval`, `stallThresholdMs: 100`. Cancel via `AbortController` after 300ms. Assert `"cancelled"` not `"stalled"`. Clean up interval. |
| "no log file skips stall detection" | `logFile: null`, cancel via `AbortController` after 200ms. Assert `"cancelled"` — stall detection not triggered. |

#### Handler-level tests (new — addresses Codex finding 1)

| Test | Description |
|------|-------------|
| "executeSpawn stall does NOT dismiss collaborator" | Mock `pollForCollaboratorMessage` to return `{ ok: false, error: "stalled" }`. Verify the collaborator entry is still in the registry after `executeSpawn` returns. Verify result contains `error: "stalled"` and does NOT contain "dismissed". |
| "executeSpawn crash DOES dismiss collaborator" | Mock poll to return `{ ok: false, error: "crashed", exitCode: 1 }`. Verify collaborator entry is removed from registry. Verify `gracefulDismiss` was called. |
| "executeSpawn cancel DOES dismiss collaborator" | Mock poll to return `{ ok: false, error: "cancelled" }`. Verify collaborator entry is removed. |
| "executeSend stalled error includes stallDurationMs" | Mock poll to return `{ ok: false, error: "stalled", stallDurationMs: 120000 }`. Verify result text contains "120s" or equivalent. Verify details include `error: "stalled"`. |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| `statSync()` every 100ms too frequent | Not a real risk. `statSync` on local filesystem is <1μs. Pi already does far heavier I/O — `readdirSync` + `readFileSync` on the inbox every 100ms. One `statSync` on the log file is negligible. |
| Collaborator stuck in infinite analysis (log growing, never sends) | Out of scope. User's Ctrl+C (cancel exit) handles this. Future spec could add a configurable hard ceiling, but the current problem is killing collaborators that ARE productive. |
| Config naming confusion (`stuckTimeoutMs` vs `stallThresholdMs`) | JSDoc on both fields. Different parent objects (`work.*` vs `collaboration.*`). |
| Invalid config values for `stallThresholdMs` | Validation at usage site: non-finite → default, < 1000ms → clamp to 1000ms. |
| `logFile: null` degraded mode | Stall detection skipped. Progress messages indicate degraded state. Only crash/cancel/message exits apply. Explicitly tested. |
| Log tail security (raw tail exposure) | Pre-existing pattern — crash path already surfaces raw tails. Stall reuses the same `readLogTail()` function with the same 2KB cap. Adding redaction is a separate concern that applies to both crash and stall paths equally. Out of scope for this spec — tracked as future improvement. |
