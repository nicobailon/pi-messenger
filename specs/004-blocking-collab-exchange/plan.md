<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-12 -->
<!-- Status: REVISED -->
<!-- Revisions: R1: deliverFn boolean return + 8-site type cascade; R2: tiered reply correlation with type-safe timestamp comparison and wrong-thread rejection; R3: send-path cancellation keeps collaborator alive; R4: 3 runtime + 5 test executeSend call sites; R5: log tail via openSync/readSync with null guard; R6: inbox spoofing documented as known limitation -->
---
title: "Blocking Collaborator Exchange — Implementation Plan"
date: 2026-03-12
bead: pi-messenger-3np
---

# 004 — Blocking Collaborator Exchange: Implementation Plan

## Approach

Make `spawn` and `send` tool calls block for collaborator exchanges by polling the spawner's inbox directory for messages from the specific collaborator. The tool `execute()` function returns only when a response arrives, or on timeout/crash/cancellation.

Selected shape: **A — Blocking tool call with inbox polling** (see `shaping.md` for fit check and rejected alternatives).

## Architecture Changes

### 1. deliverFn boolean contract (store.ts)

**Current**: `deliverFn` has type `(msg: AgentMailMessage) => void`. `processAllPendingMessages` calls it, then unconditionally `unlinkSync`s the file.

**Change**: `deliverFn` returns `boolean`. `true` = handled (delete file), `false` = blocked (leave file for blocking poll). In `processAllPendingMessages`:

```typescript
const handled = deliverFn(msg);
if (handled !== false) {
  fs.unlinkSync(msgPath);
}
```

In the catch block: parse failures (corrupt JSON) → always delete. After successful parse but failed deliver → check return value before deleting.

Using `!== false` instead of `if (handled)` ensures backward compatibility — `undefined` is treated as "handled." Fail-safe against missed type cascade.

**Type cascade** (8 declarations, all enforced by TypeScript):
- `processAllPendingMessages` parameter type (store.ts)
- `pendingProcessArgs` type (store.ts)
- `startWatcher` parameter type (store.ts)
- `renameAgent` callback parameter (store.ts)
- `executeJoin` deliverFn parameter (handlers.ts)
- `executeRename` deliverFn parameter (handlers.ts)
- `deliverMessage` return type (index.ts)
- `DeliverFn` type alias (crew/index.ts line 16)

### 2. Watcher filter (index.ts)

In `deliverMessage`, check `state.blockingCollaborators` before any processing:

```typescript
function deliverMessage(msg: AgentMailMessage): boolean {
  if (state.blockingCollaborators.has(msg.from)) {
    return false;  // leave file for blocking poll
  }
  // ... existing chatHistory, unread, overlay, steer logic ...
  return true;
}
```

### 3. recordMessageInHistory helper

Extract from `deliverMessage` the chatHistory and unreadCounts update logic into a standalone function. Called from both:
- `deliverMessage` (normal path — also does overlay render + steer)
- Blocking poll (after reading message — does NOT do overlay render or steer)

Located in store.ts. Signature:
```typescript
export function recordMessageInHistory(
  state: MessengerState,
  msg: AgentMailMessage,
  maxHistory: number
): void
```

No overlay render trigger from the blocking poll path. The LLM gets the message via tool result; overlay shows it when next opened.

### 4. pollForCollaboratorMessage helper (crew/handlers/collab.ts)

Shared polling function used by both `executeSpawn` and `executeSend`:

```typescript
interface PollOptions {
  inboxDir: string;
  collabName: string;
  correlationId?: string;      // outbound message ID for reply correlation
  sendTimestamp?: number;       // timestamp of outbound send (for fallback matching)
  entry: CollaboratorEntry;
  signal?: AbortSignal;
  onUpdate?: OnUpdateFn;
  timeoutMs: number;           // parameter for test injection
  state: MessengerState;
}

type PollResult =
  | { ok: true; message: AgentMailMessage }
  | { ok: false; error: "timeout" | "crashed" | "cancelled"; exitCode?: number; logTail?: string };
```

**Tiered message matching** (in order of preference):
1. If `correlationId` is provided AND message has `msg.replyTo === correlationId` → match (strongest: exact reply correlation)
2. If `correlationId` is provided AND `msg.replyTo` is `null` AND `msg.from === collabName` AND `Date.parse(msg.timestamp) >= sendTimestampMs` (with NaN guard — skip if parse fails) → match (timestamp-bounded sender match for agents that don't populate replyTo)
3. If `msg.replyTo` is non-null AND `msg.replyTo !== correlationId` → **reject** (message belongs to a different conversation thread)
4. For spawn path (no correlationId, no sendTimestamp): `msg.from === collabName` → match (first message from collaborator)

**Important constraints**:
- `sendTimestamp` is `number` (milliseconds, from `Date.now()`). `msg.timestamp` is ISO string (from `new Date().toISOString()`). Comparison must use `Date.parse(msg.timestamp)` to convert to milliseconds, with `isNaN` guard to skip unparseable timestamps.
- Tier-2 fallback ONLY applies when `msg.replyTo` is null/absent. If `msg.replyTo` exists but doesn't match `correlationId`, the message is rejected — it belongs to a different conversation. This prevents accepting wrong-thread messages via the fallback path.
- This tiered approach handles current agents that don't pass `replyTo` in their `pi_messenger send` calls, while automatically using stronger correlation when agents start passing it.

**Two-timer structure** (one setInterval, two cadences):
- Fast path (100ms): `readdirSync` + check for matching files. **Sort files ascending by filename** before iterating.
- Slow path (30s): `onUpdate` call with elapsed time + log file size delta.
- Each tick checks: `signal?.aborted` (cancel), `entry.proc.exitCode !== null` (crash), elapsed >= timeoutMs (timeout).

On success: read file, parse, `unlinkSync`, call `recordMessageInHistory`, resolve with message.
On crash: read last 2KB of `entry.logFile` using `fs.openSync` + `fs.readSync` at calculated offset + `fs.closeSync`. Guard for `logFile === null` (return empty logTail).

### 5. executeSpawn blocking (crew/handlers/collab.ts)

Add `signal?: AbortSignal` and `onUpdate?: OnUpdateFn` to `executeSpawn` signature.

Add `state.blockingCollaborators.add(collabName)` BEFORE `registerWorker` call (before mesh polling — closes race window).

Wrap from `registerWorker` through return in `try/finally` — `finally` block: `state.blockingCollaborators.delete(collabName)`.

After successful `pollUntilReady`, call `pollForCollaboratorMessage` with no `correlationId` (first message — no prior ID) and `timeoutMs = SPAWN_FIRST_MESSAGE_TIMEOUT_MS` (600,000ms = 10 min).

On poll error (timeout/crash/cancel): call `gracefulDismiss(entry)` — collaborator never established contact, so dismiss is correct.

On success: return result with `firstMessage` in both content and details. Remove "Wait for first message" language. Keep send/dismiss affordances.

### 6. Signal/onUpdate threading (index.ts → crew/index.ts)

In `index.ts` tool `execute()` (~line 430): rename `_onUpdate` to `onUpdate`, pass through `executeCrewAction`.

In `crew/index.ts` `executeCrewAction`: add `onUpdate?: OnUpdateFn` parameter, forward to `case 'spawn'` and `case 'send'` handlers. Update `DeliverFn` type alias from `void` to `boolean`.

### 7. executeSend blocking (handlers.ts)

Make `executeSend` async. Add `signal?: AbortSignal` and `onUpdate?: OnUpdateFn` parameters.

After detecting a collaborator target (via `findCollaboratorByName`):

**Critical ordering**: Add to `blockingCollaborators` BEFORE sending the message.

```typescript
const collabEntry = findCollaboratorByName(recipient);
if (collabEntry && recipients.length === 1 && !broadcast) {
  state.blockingCollaborators.add(recipient);
  try {
    const sendTimestamp = Date.now();
    const outbound = store.sendMessageToAgent(state, dirs, recipient, message, replyTo);
    // ... feed logging, budget tracking ...
    const pollResult = await pollForCollaboratorMessage({
      inboxDir: path.join(dirs.inbox, state.agentName),
      collabName: recipient,
      correlationId: outbound.id,
      sendTimestamp,
      entry: collabEntry,
      signal, onUpdate,
      timeoutMs: SEND_REPLY_TIMEOUT_MS,  // 300_000 (5 min)
      state,
    });
    // return with reply or error
  } finally {
    state.blockingCollaborators.delete(recipient);
  }
}
```

**Send-path cancellation semantics**: On cancel/timeout/crash during a blocking send, the collaborator is NOT dismissed. Unlike spawn (where cancel means "never established contact"), during send the collaborator is already working and may be mid-response. The blocking wait ends with an error result, but the collaborator remains alive. The spawning agent can retry or dismiss explicitly.

**Call site updates (3 runtime + existing tests)**:
- `crew/index.ts:105` (`case 'send'`): `return await handlers.executeSend(..., signal, onUpdate)`
- `crew/index.ts:108` (`case 'broadcast'`): `return await handlers.executeSend(...)`
- `cli/index.ts:310`: `printResult(await handlers.executeSend(...))` — CLI has no collaborator registry, so blocking never triggers, but async signature requires `await`.
- `tests/crew/worker-coordination.test.ts`: Lines 511, 534, 563, 589, 597 — all direct `executeSend` calls need `await`. These are existing tests for broadcast filtering that will fail at compile time when the return type changes to `Promise`.

## Behavioral Tradeoff: Peer Messages During Blocking Wait

Pi SDK docs (extensions.md line 979): `"steer"` delivery mode is "Delivered after current tool finishes, remaining tools skipped."

During a blocking spawn/send, peer messages are queued by pi until the blocking tool call returns. Accepted tradeoff — user can Ctrl+C to break out.

## Known Limitation: Inbox Message Authentication

Inbox messages are JSON files with no sender authentication. Pre-existing condition — not introduced by this change. Future spec could add HMAC signing.

## Constants

| Constant | Value | Rationale |
|----------|-------|-----------|
| `SPAWN_FIRST_MESSAGE_TIMEOUT_MS` | 600,000 (10 min) | Collaborators need 3-10 min. |
| `SEND_REPLY_TIMEOUT_MS` | 300,000 (5 min) | Running collaborators respond faster. |
| `POLL_INTERVAL_MS` | 100 (existing) | Fast inbox check. |
| `PROGRESS_INTERVAL_MS` | 30,000 (30s) | Balance visibility vs context cost. |

All timeouts are parameters to `pollForCollaboratorMessage` — tests inject 50ms.

## Files Changed

| File | Change | Lines (est.) |
|------|--------|-------------|
| `store.ts` | deliverFn boolean contract in `processAllPendingMessages` + catch block | ~10 |
| `store.ts` | Type declarations for `startWatcher`, `renameAgent`, `pendingProcessArgs` | ~6 |
| `store.ts` | `recordMessageInHistory` helper | ~15 |
| `lib.ts` | Add `blockingCollaborators: Set<string>` to `MessengerState` | ~2 |
| `index.ts` | `deliverMessage` returns boolean, filter check at top | ~6 |
| `index.ts` | State initialization: `blockingCollaborators: new Set()` | ~1 |
| `index.ts` | Thread `onUpdate` through `executeCrewAction` | ~3 |
| `crew/index.ts` | `DeliverFn` type update, forward `onUpdate` to spawn/send, `await` send | ~10 |
| `crew/handlers/collab.ts` | `pollForCollaboratorMessage` helper with tiered correlation | ~75 |
| `crew/handlers/collab.ts` | `executeSpawn` try/finally + blocking poll | ~25 |
| `handlers.ts` | `executeSend` async + collaborator blocking with correlation | ~35 |
| `cli/index.ts` | `await` executeSend call | ~2 |
| `tests/crew/worker-coordination.test.ts` | `await` existing executeSend calls (5 locations) | ~5 |
| `tests/crew/collab.test.ts` | Tests for all flows + correlation + steer verification | ~160 |
| **Total** | | **~355** |

## Requirement Traceability

| Req | Addressed by |
|-----|-------------|
| R0 | executeSpawn blocking (§5) |
| R1 | executeSend blocking with tiered correlation (§7) |
| R2 | pollForCollaboratorMessage progress path (§4) |
| R3 | signal handling in poll helper (§4) |
| R4 | crash detection in poll helper (§4) + logTail via openSync/readSync |
| R5 | No param changes — collaborator detection is automatic (§7) |
| R7 | timeout handling in poll helper (§4) |
| R8 | Filter per collaborator name + tiered correlation + steer test (§2, §4, tests) |
| R9 | All communication via inbox files (architecture preserved) |
