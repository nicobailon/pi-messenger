<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-12 -->
<!-- Status: RECONCILED -->
<!-- Revisions: Task 5 updated with tiered correlation and type-safe comparison; Task 8 updated with 3 runtime + 5 test call sites and send-path cancel semantics; Task 9 updated with correlation and wrong-thread rejection tests -->
---
title: "Blocking Collaborator Exchange — Tasks"
date: 2026-03-12
bead: pi-messenger-3np
---

# 004 — Blocking Collaborator Exchange: Tasks

## Dependencies

```
1 → 4 (filter depends on boolean contract)
2 → 6, 8 (state field used by spawn/send)
3 → 6, 8 (history helper called by spawn/send)
5 → 6, 8 (poll helper called by spawn/send)
7 → 6, 8 (signal/onUpdate needed by spawn/send)
6, 8 → 9 (tests verify tasks 6 and 8)
```

Tasks 1-5 are independent of each other and can be done in parallel.
Tasks 6-8 depend on 1-5.
Task 9 depends on 6 and 8.
Task 10 can be done with task 6.

---

## Task 1: deliverFn boolean contract

**Files**: `store.ts`
**Estimated**: ~16 lines changed

- [x] Change `deliverFn` parameter type from `(msg: AgentMailMessage) => void` to `(msg: AgentMailMessage) => boolean` in:
  - `processAllPendingMessages` function signature
  - `pendingProcessArgs` type
  - `startWatcher` function signature
  - `renameAgent` callback parameter
- [x] In `processAllPendingMessages`, replace unconditional `fs.unlinkSync(msgPath)` with:
  ```typescript
  const handled = deliverFn(msg);
  if (handled !== false) {
    fs.unlinkSync(msgPath);
  }
  ```
- [x] In the catch block: parse failures (corrupt JSON) → always delete. After successful parse but failed deliver → check return value before deleting.
- [x] Update `DeliverFn` type alias in `crew/index.ts` line 16 from `void` to `boolean`
- [x] Verify: 8 type declarations total must be updated. Follow TypeScript errors.

**Note**: Using `!== false` — treats `undefined` as handled (backward-compatible, fail-safe).

---

## Task 2: Add blockingCollaborators to MessengerState

**Files**: `lib.ts`, `index.ts`
**Estimated**: ~3 lines

- [x] Add `blockingCollaborators: Set<string>` to `MessengerState` interface in `lib.ts`
- [x] Initialize `blockingCollaborators: new Set()` in state creation in `index.ts`

---

## Task 3: Extract recordMessageInHistory helper

**Files**: `store.ts`, `index.ts`
**Estimated**: ~20 lines

- [x] Extract chatHistory + unreadCounts update logic from `deliverMessage` into:
  ```typescript
  export function recordMessageInHistory(
    state: MessengerState,
    msg: AgentMailMessage,
    maxHistory?: number
  ): void
  ```
- [x] Updates `state.chatHistory` (push, trim to max)
- [x] Updates `state.unreadCounts` (increment)
- [x] Does NOT trigger overlay re-render or pi.sendMessage
- [x] Refactor `deliverMessage` in `index.ts` to call this helper instead of inline logic

---

## Task 4: Watcher filter in deliverMessage

**Files**: `index.ts`
**Estimated**: ~6 lines

- [x] At the top of `deliverMessage`, add:
  ```typescript
  if (state.blockingCollaborators.has(msg.from)) {
    return false;
  }
  ```
- [x] Change `deliverMessage` return type to `boolean`
- [x] Return `true` at end of function (normal path)

---

## Task 5: pollForCollaboratorMessage helper

**Files**: `crew/handlers/collab.ts`
**Estimated**: ~75 lines

- [x] Define `PollOptions` interface with `correlationId?: string` and `sendTimestamp?: number`
- [x] Define `PollResult` discriminated union type
- [x] Implement tiered message matching:
  - Tier 1: `msg.replyTo === correlationId` → match (strongest)
  - Tier 2: `msg.replyTo` is null AND `msg.from === collabName` AND `Date.parse(msg.timestamp) >= sendTimestampMs` (with `isNaN` guard) → match (fallback for agents that omit replyTo)
  - Tier 3: `msg.replyTo` is non-null AND `msg.replyTo !== correlationId` → **reject** (different conversation)
  - Tier 4: spawn path (no correlationId) → `msg.from === collabName` → match
- [x] Two-timer polling loop (100ms file check, 30s onUpdate progress)
- [x] Sort inbox files ascending by filename before iterating
- [x] Signal/crash/timeout checks each tick
- [x] On success: read, parse, unlinkSync, recordMessageInHistory, resolve
- [x] On crash: log tail via `fs.openSync` + `fs.readSync` at offset + `fs.closeSync`. Null guard for `logFile`.
- [x] Timeout values as parameters (not constants) for test injection

---

## Task 6: executeSpawn blocking

**Files**: `crew/handlers/collab.ts`
**Estimated**: ~25 lines changed

- [x] Add `signal?: AbortSignal` and `onUpdate?: OnUpdateFn` to signature
- [x] Add `state.blockingCollaborators.add(collabName)` BEFORE `registerWorker`
- [x] Wrap from `registerWorker` through return in `try/finally`
- [x] After `pollUntilReady`, call `pollForCollaboratorMessage` with no `correlationId` (first message), `timeoutMs = 600_000`
- [x] On poll error: `gracefulDismiss(entry)` (never established contact), return error result
- [x] On success: return result with `firstMessage`, remove "wait patiently" language, keep send/dismiss affordances
- [x] `finally`: `state.blockingCollaborators.delete(collabName)`

---

## Task 7: Thread signal/onUpdate through action router

**Files**: `index.ts`, `crew/index.ts`
**Estimated**: ~11 lines

- [x] In `index.ts` `execute()`: rename `_onUpdate` to `onUpdate`
- [x] Pass `onUpdate` to `executeCrewAction` call
- [x] In `crew/index.ts` `executeCrewAction`: add `onUpdate?` parameter
- [x] Forward `signal` and `onUpdate` to spawn and send handlers

---

## Task 8: executeSend collaborator blocking

**Files**: `handlers.ts`, `crew/index.ts`, `cli/index.ts`
**Estimated**: ~37 lines

- [x] Make `executeSend` async, add `signal?` and `onUpdate?` parameters
- [x] Detect collaborator: `findCollaboratorByName(recipient)`
- [x] Blocking conditions: single recipient AND is collaborator AND not broadcast
- [x] **Critical ordering**: `blockingCollaborators.add` BEFORE `sendMessageToAgent`
- [x] Capture `outbound.id` from `sendMessageToAgent` return and `Date.now()` for `sendTimestamp`
- [x] Call `pollForCollaboratorMessage` with `correlationId: outbound.id`, `sendTimestamp`, `timeoutMs = 300_000`
- [x] **Send-path cancellation**: do NOT dismiss collaborator on cancel/timeout/crash (collaborator is alive, may be mid-response)
- [x] On success: return result with `reply` in content and details
- [x] try/finally for `blockingCollaborators` cleanup
- [x] Update 3 runtime call sites:
  - `crew/index.ts:105` (`case 'send'`): `return await handlers.executeSend(..., signal, onUpdate)`
  - `crew/index.ts:108` (`case 'broadcast'`): `return await handlers.executeSend(...)`
  - `cli/index.ts:310`: `printResult(await handlers.executeSend(...))`
- [x] Update 5 test call sites in `tests/crew/worker-coordination.test.ts` (lines 511, 534, 563, 589, 597): add `await`

---

## Task 9: Tests

**Files**: `tests/crew/collab.test.ts` (extend or new file `tests/crew/collab-blocking.test.ts`)
**Estimated**: ~160 lines

- [x] **Flow 1 — Spawn + first message**: Spawn, write fake message to inbox from collab name, verify `firstMessage` in result
- [x] **Flow 2 — Send + reply**: Send to collaborator, write fake reply, verify `reply` in result
- [x] **Flow 3 — Timeout**: 50ms timeout, no message, verify `error: "timeout"`
- [x] **Flow 4 — Crash**: Set `proc.exitCode = 1`, write log content, verify `error: "collaborator_crashed"` with `logTail`
- [x] **Flow 5 — Cancel (spawn)**: Abort signal, verify `error: "cancelled"` and collaborator dismissed
- [x] **Flow 5b — Cancel (send)**: Abort signal, verify `error: "cancelled"` and collaborator NOT dismissed
- [x] **Flow 6 — Peer send unchanged**: Non-collaborator, verify immediate return, no `reply` field
- [x] **AC8 — Concurrent collaborators**: Two collabs in filter, verify message from A doesn't satisfy wait for B
- [x] **AC8 — Watcher filter**: `deliverMessage` returns `false` for blocked sender, `true` for non-blocked
- [x] **Correlation — replyTo match**: Message with correct `replyTo` is accepted
- [x] **Correlation — wrong thread rejection**: Message with non-null `replyTo !== correlationId` is rejected
- [x] **Correlation — fallback**: Message with null `replyTo` from correct sender after sendTimestamp is accepted
- [x] **Correlation — type-safe timestamp**: Verify `Date.parse` comparison works correctly
- [x] **Boolean contract**: Verify `processAllPendingMessages` does NOT unlink when `deliverFn` returns `false`
- [x] **recordMessageInHistory**: Verify chatHistory and unreadCounts updated after blocking poll
- [x] **Cleanup**: Verify `blockingCollaborators` is empty after success, timeout, crash, and cancel

---

## Task 10: Result text updates

**Files**: `crew/handlers/collab.ts`
**Estimated**: ~5 lines

- [x] Spawn success content includes collaborator's first message text
- [x] No "Wait for first message" / "Do not ping" language
- [x] Send/dismiss affordances preserved
- [x] Details include `firstMessage` (spawn) or `reply` (send) field

**Note**: Largely done as part of tasks 6 and 8. This task is for final review.
