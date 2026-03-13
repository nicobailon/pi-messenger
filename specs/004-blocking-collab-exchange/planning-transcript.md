# Planning Transcript — 004 Blocking Collaborator Exchange

**Date**: 2026-03-12
**Participants**: JadeDragon (pi-messenger, pi/claude-sonnet-4) · GoldHawk (crew-challenger, claude-sonnet-4-6)
**Protocol**: pi_messenger (spawn → exchange → dismiss)

---

## Research Phase (JadeDragon, pre-challenger)

JadeDragon performed codebase research on all integration points before engaging the challenger:

- Read `crew/handlers/collab.ts` — `executeSpawn`, `pollUntilReady`, `pollUntilExited`, `gracefulDismiss`
- Read `handlers.ts` — `executeSend` (lines 259-388), current synchronous flow
- Read `crew/index.ts` — action router, how spawn/send are dispatched
- Read `store.ts` — `processAllPendingMessages` (file read/deliver/unlink flow), `startWatcher`, `getMyInbox`, `sendMessageToAgent`
- Read `index.ts` — `deliverMessage` closure, `pi.sendMessage(steer)` delivery, tool execute signature (signal, onUpdate)
- Read `lib.ts` — `MessengerState` interface, `Dirs` interface
- Read pi SDK docs — `onUpdate` streaming, `signal` abort, `deliverAs: "steer"` queuing behavior
- Verified: `executeSend` has exactly 2 call sites (crew/index.ts lines 105, 108)
- Verified: `executeRename` does NOT call `executeSend`
- Verified: 427 existing tests across the suite

Proposed implementation approach with 8 integration points and 10-task order, then spawned GoldHawk for adversarial review.

---

## Challenger Review (GoldHawk)

### Round 1: 7 findings (4 critical, 3 significant)

**Critical #1 — Filter placement fatally wrong**: `processAllPendingMessages` calls `deliverFn(msg)` then unconditionally `unlinkSync(msgPath)`. Filtering at `deliverMessage` (returning early) doesn't prevent file deletion. The blocking poll finds an empty inbox. GUARANTEED FAILURE.

**Critical #2 — Steer during blocking undefined**: `pi.sendMessage(steer)` called from FSWatcher during a blocking `execute()` — is the message queued, delivered, or dropped?

**Critical #3 — chatHistory never updated**: Blocking poll reads/deletes the file, bypassing `deliverMessage`. `state.chatHistory` and `state.unreadCounts` never updated. Overlay shows no conversation history for collaborator.

**Critical #4 — blockingCollaborators cleanup not guaranteed**: Existing `executeSpawn` has no try/finally. If `pollUntilReady` throws, the name leaks in `blockingCollaborators` permanently.

**Significant #5 — executeSend call sites**: Claimed `executeRename` calls `executeSend`. (Later disproven by JadeDragon — only 2 call sites exist.)

**Significant #6 — Poll/update intervals conflated**: Need two cadences: 100ms file check, 30s progress update. One-timer design not specified.

**Significant #7 — Timeout TBD fails AC7**: Can't pass acceptance if timeout is "likely 10-15 minutes."

### Round 1 Response (JadeDragon)

**Critical #1**: Accepted. Changed architecture: `deliverFn` returns `boolean`. `processAllPendingMessages` only deletes when `handled !== false`. Filter stays in `deliverMessage` (has access to state). Blocking poll owns file lifecycle for filtered messages.

**Critical #2**: Quoted pi SDK docs lines 979, 1005: steer is "Delivered after current tool finishes." Messages are queued, not dropped. Added AC8 test to verify. Documented as accepted tradeoff.

**Critical #3**: Accepted. Extract `recordMessageInHistory` helper. Called by both `deliverMessage` and blocking poll. No overlay render from poll path (Option 2).

**Critical #4**: Accepted. try/finally wrapping entire blocking section. `blockingCollaborators.delete` in finally.

**Significant #5**: Disproven via grep. Only 2 call sites.

**Significant #6**: Accepted. One setInterval, two cadences with separate counters.

**Significant #7**: Concrete values: 10 min spawn, 5 min send. Passed as parameters for test injection.

### Round 2: 3 findings (2 blocking, 1 significant)

**Blocking A — SDK steer verification**: Demanded evidence, not assertion. JadeDragon quoted exact lines (979, 1005) from pi SDK extensions.md. Agreed to add verification test in AC8 suite.

**Blocking B — executeSend filter ordering**: Adding to `blockingCollaborators` AFTER sending creates race window. Fast collaborator responds before filter active. Must add BEFORE sending. try/finally wraps entire sequence.

**Significant C — overlayTui inaccessible from collab.ts**: `recordMessageInHistory` can't trigger overlay render. Three options evaluated; Option 2 (no render from poll path) selected.

### Round 2 Response (JadeDragon)

All three accepted with specific resolutions. Task order updated.

### Implementation notes from GoldHawk (non-blocking)

1. Type cascade is 7 declarations, not 2. Follow TypeScript errors.
2. Use `!== false` instead of `if (handled)` for backward compatibility.
3. Sort inbox files by filename before iterating (OS-dependent readdir order).

### Sign-off

GoldHawk: "SDK quote verified at lines 979 and 1005. All blockers resolved. The design is sound. Proceed."

[PHASE:agree] — both participants.
