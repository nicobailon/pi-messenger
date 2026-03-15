<!-- Codex Review: 5 rounds, max reached | model: gpt-5.3-codex | date: 2026-03-15 -->
<!-- Status: REVISED -->
<!-- Revisions: R1-delivery semantics clarified (best-effort), completedCollaborators added, crew-challenger.md mandatory, pollTimeoutMs renamed | R2-name collision guard, racy inbox test removed | R3-triple-gate for completedCollaborators, one-shot spawn auto-dismiss | R4-mesh registry check in triple gate, CLI/test state constructors | R5-spawn name collision checks mesh registry -->
---
title: "Plan: Structured phase protocol — deterministic collaboration termination"
date: 2026-03-15
bead: pi-messenger-3t0
---

# Implementation Plan

## Overview

Add a structured `phase` field to the `send` action with three enforcement layers for deterministic conversation termination. Eliminates the last-message stall where the driver blocks indefinitely after a collaborator has finished.

This plan was shaped interactively (6 shapes explored, Shape D selected) and stress-tested by a crew-challenger who caught two bugs the original design would have shipped (#2 registry race, #3 peerTerminal lost on collaborator exit).

## Architecture Decision: Layered Enforcement

Three layers, each progressively less trusting:

| Layer | Trigger | Mechanism | Trust level |
|-------|---------|-----------|-------------|
| D2 | Driver sends `phase: "complete"` | Non-blocking delivery + sync unregister + async dismiss | Agent cooperated |
| D4 | Collaborator sent `phase: "complete"`, driver sends anything | Same as D2, triggered by `peerTerminal` flag on entry | Agent didn't cooperate |
| D5 | No inbox message for `pollTimeoutMs` (default 5 min) | Stall result even if log is growing | Both failed |

**Key design decision (from challenger review):** The primary termination signal is `peerComplete` in the PollResult — the driver learns the conversation is over from the response that carried the terminal message. D4 (`peerTerminal` on the CollaboratorEntry) is a belt-and-suspenders fallback, not the primary mechanism.

**Driver-side terminal state (from Codex review):** When auto-dismissing on `peerComplete`, the collaborator name is recorded in `state.completedCollaborators: Set<string>`. This survives collaborator exit — if the driver sends again after the collaborator has died, `executeSend` checks this set only AFTER confirming no live agent exists for that name (both in-memory registry via `findCollaboratorByName` AND mesh registry via `validateTargetAgent`). This prevents stale terminal state from shadowing a live agent that reuses the same name.

**Name-collision guard (from Codex review round 2):** The name pool is only ~650 combinations. In `executeSpawn`, after `generateMemorableName()`, check `state.completedCollaborators` — if the name is in the set, remove it before proceeding. This ensures a fresh spawn never inherits stale terminal state from a completed collaborator that happened to have the same name.

**R2 delivery semantics (from Codex review):** The driver's final ack is **best-effort delivery**. The message file is written to the collaborator's inbox and persisted in the feed log, but `gracefulDismiss` may kill the collaborator before its watcher consumes the file. This is acceptable because the collaborator already declared itself done — it doesn't need the ack. The message persists for audit trail purposes regardless.

## Phase Values

| Phase | Meaning | Terminal? |
|-------|---------|-----------|
| `review` | Assessed the material | No |
| `challenge` | Disagree / have concerns | No |
| `revise` | Updated approach addressing concerns | No |
| `approved` | Proposal passes scrutiny (verdict) | No |
| `complete` | Done. No more messages. | **Yes** |

Only `complete` triggers system behavior. All other values are informational metadata stored in the message JSON.

## Changes by File

### 1. `lib.ts` — AgentMailMessage type (line 60)

Add `phase?: string` to the interface. Optional — existing messages without phase are valid (R6 backward compat).

```typescript
export interface AgentMailMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  replyTo: string | null;
  phase?: string;  // NEW: "review" | "challenge" | "revise" | "approved" | "complete"
}
```

### 2. `crew/types.ts` — CrewParams type (line 69)

Add `phase?: string` to the Coordination section:

```typescript
  // Coordination
  spec?: string;
  to?: string | string[];
  message?: string;
  replyTo?: string;
  phase?: string;   // NEW: conversation phase for send action
```

### 3. `crew/registry.ts` — CollaboratorEntry type (line 32)

Add `peerTerminal?: boolean`:

```typescript
export interface CollaboratorEntry extends BaseWorkerEntry {
  type: "collaborator";
  spawnedBy: number;
  startedAt: number;
  promptTmpDir: string | null;
  logFile: string | null;
  peerTerminal?: boolean;  // NEW: set when collaborator sends phase:"complete"
}
```

### 4. `store.ts` — sendMessageToAgent (line 1011)

Add `phase` parameter. Write it into message object:

```typescript
export function sendMessageToAgent(
  state: MessengerState,
  dirs: Dirs,
  to: string,
  text: string,
  replyTo?: string,
  phase?: string,       // NEW
): AgentMailMessage {
  const msg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to,
    text,
    timestamp: new Date().toISOString(),
    replyTo: replyTo ?? null,
    ...(phase ? { phase } : {}),  // NEW: only include when set
  };
  // ...rest unchanged
}
```

### 5. `crew/index.ts` — Dispatch (line 106)

Pass `params.phase` to executeSend:

```typescript
case 'send':
  return await handlers.executeSend(
    state, dirs, ctx.cwd ?? process.cwd(),
    params.to, false, params.message, params.replyTo,
    params.phase,  // NEW
    signal, onUpdate,
  );
```

### 6. `handlers.ts` — executeSend (line 262)

Core change. Add `phase` parameter. Before the blocking poll:

0. **Live-entry check first:** Call `findCollaboratorByName(recipient)`. If it returns a live entry, proceed to D2/D4/poll checks as normal — a live collaborator always takes precedence over stale terminal state.
1. **Dead-collaborator fallback:** If `findCollaboratorByName` returns null → check `validateTargetAgent(recipient, dirs)`. If that also returns `not_found`/`not_active` → check `state.completedCollaborators.has(recipient)`. Only if ALL THREE fail (no live collaborator, no live mesh agent, name IS in completed set) → return `{ conversationComplete: true }` immediately. This triple-gate prevents stale terminal state from shadowing a live non-collaborator agent that reuses the same name.
2. **D2 check:** If `phase === "complete"` AND recipient is collaborator → non-blocking path
3. **D4 check:** If `collabEntry.peerTerminal === true` → non-blocking path (same as D2)
3. **On poll success:** If `pollResult.peerComplete` → add to `state.completedCollaborators`, auto-dismiss, return `conversationComplete: true` immediately

Non-blocking path:
```typescript
// D2 + D4: terminal send — deliver and dismiss
const outbound = store.sendMessageToAgent(state, dirs, recipient, message, replyTo, phase);
messagesSentThisSession++;
logFeedEvent(cwd, state.agentName, "message", recipient, preview);

// Record terminal state on driver side (survives collaborator exit)
state.completedCollaborators.add(recipient);
// Sync unregister — entry disappears immediately from findCollaboratorByName
unregisterWorker(collabEntry.cwd, collabEntry.taskId);
// Fire-and-forget process cleanup (final ack is best-effort — file persists in inbox/feed)
gracefulDismiss(collabEntry).catch(() => {});
logFeedEvent(cwd, "crew", "dismiss", recipient);

return result(
  `Message delivered to ${recipient} (best-effort). Conversation complete — collaborator dismissed.`,
  { mode: "send", sent: [recipient], failed: [], conversationComplete: true, dismissed: recipient },
);
```

On poll success with peerComplete:
```typescript
if (pollResult.peerComplete) {
  // Collaborator signaled completion — record driver-side state + auto-dismiss
  state.completedCollaborators.add(recipient);
  unregisterWorker(collabEntry.cwd, collabEntry.taskId);
  gracefulDismiss(collabEntry).catch(() => {});
  logFeedEvent(cwd, "crew", "dismiss", recipient);

  return result(
    `Reply from ${recipient}:\n\n${pollResult.message.text}\n\nConversation complete — collaborator dismissed.`,
    { mode: "send", sent: [recipient], failed: [], reply: pollResult.message.text,
      conversationComplete: true, dismissed: recipient },
  );
}
```

### 7. `crew/handlers/collab.ts` — pollForCollaboratorMessage

**7a. PollResult type update:**

```typescript
export type PollResult =
  | { ok: true; message: AgentMailMessage; peerComplete?: boolean }  // NEW: peerComplete
  | { ok: false; error: "crashed" | "cancelled" | "stalled";
      exitCode?: number; logTail?: string; stallDurationMs?: number;
      stallType?: "log" | "timeout" };  // NEW: stallType
```

**7b. checkMessage → set peerTerminal + peerComplete:**

After `checkMessage` returns a matching message, before resolving:
```typescript
const peerComplete = msg.phase === "complete";
if (peerComplete) {
  entry.peerTerminal = true;  // D4 belt-and-suspenders
}
resolve({ ok: true, message: msg, peerComplete });
```

**7c. PollOptions update:**

Add `pollTimeoutMs` to PollOptions. Read from `crewConfig.collaboration.pollTimeoutMs` with same validation pattern as existing stallThresholdMs:

```typescript
export interface PollOptions {
  // ...existing fields...
  pollTimeoutMs?: number;  // NEW: absolute wall-clock timeout from poll start
}
```

Default: 300_000 (5 minutes). Minimum: same as MIN_STALL_THRESHOLD_MS.

**Note on D5 semantics (clarified during Codex review):** This is an **absolute timeout**, not an activity-based stall detector. It measures wall-clock time from poll start and never resets. This is intentionally different from the existing log-growth stall (which resets on log activity). The absolute timeout catches the exact failure case from the PureYak incident: collaborator log drips bytes indefinitely, preventing log-stall from ever firing.

**7d. Timeout check in poll loop:**

Independent of existing log-stall check. Runs AFTER the inbox check (a message at the timeout boundary is still a success):
```typescript
// D5: Absolute timeout — catches log-drip case
const resolvedPollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
if (now - startTime >= resolvedPollTimeoutMs) {
  clearInterval(timer);
  const logTail = readLogTail();
  resolve({
    ok: false, error: "stalled",
    logTail: logTail || undefined,
    stallDurationMs: now - startTime,
    stallType: "timeout",
  });
  return;
}
```

Existing log-stall check gets `stallType: "log"` added to its resolve.

### 8. `crew/handlers/collab.ts` — executeSpawn

**Name-collision avoidance (matching lobby pattern at crew/lobby.ts:70-76, extended to check mesh):**
```typescript
// Generate unique name with collision avoidance against BOTH
// in-memory collaborators AND live mesh agents (registry files)
let collabName = generateMemorableName();
for (let i = 0; i < 5; i++) {
  const existingCollab = findCollaboratorByName(collabName);
  const meshValidation = store.validateTargetAgent(collabName, dirs);
  // Retry if name collides with a live collaborator OR any live mesh agent
  if ((!existingCollab || existingCollab.proc.exitCode !== null) && !meshValidation.valid) break;
  collabName = generateMemorableName();
}
// Clear any stale terminal state for this name
state.completedCollaborators.delete(collabName);
```

**After poll success — auto-dismiss one-shot collaborators:**
If `pollResult.peerComplete`, mirror the send-path terminal handling (record, unregister, dismiss, return completion text without follow-up instructions):
```typescript
if (pollResult.peerComplete) {
  // One-shot collaborator — auto-dismiss
  state.completedCollaborators.add(collabName);
  unregisterWorker(cwd, taskId);
  gracefulDismiss(entry).catch(() => {});
  logFeedEvent(cwd, "crew", "dismiss", collabName);

  return result(
    `Collaborator "${collabName}" spawned (${agentName}). First message:\n\n` +
    `${pollResult.message.text}\n\nConversation complete — collaborator dismissed.`,
    { mode: "spawn", name: collabName, agent: agentName,
      firstMessage: pollResult.message.text, conversationComplete: true, dismissed: collabName },
  );
}

// Normal (non-terminal) spawn — existing path
return result(
  `Collaborator "${collabName}" spawned (${agentName}). First message:\n\n${pollResult.message.text}\n\n` +
  `Send messages: pi_messenger({ action: "send", to: "${collabName}", message: "..." })\n` +
  `Dismiss when done: pi_messenger({ action: "dismiss", name: "${collabName}" })`,
  { mode: "spawn", name: collabName, pid: proc.pid, agent: agentName, firstMessage: pollResult.message.text },
);
```

### 9. `index.ts` — Tool parameter schema (~line 430)

Add `phase` to messaging parameters section:
```typescript
phase: Type.Optional(StringEnum(
  ["review", "challenge", "revise", "approved", "complete"],
  { description: "Conversation phase. Only 'complete' is terminal — auto-dismisses collaborator." }
)),
```

### 10. `crew/agents/crew-challenger.md` — Collaborator agent prompt

Update the Phase 4 (Signal) section to instruct the collaborator to use structured `phase` parameter on its sends. Without this, the built-in collaborator never emits `phase: "complete"` and D2/D4 never fire — only D5 catches it.

Current instructions reference text markers `[PHASE:agree]`/`[PHASE:block]`. Update to:
```markdown
When you approve the proposal:
pi_messenger({ action: "send", to: "...", message: "...", phase: "approved" })

When you are completely done (no more messages):
pi_messenger({ action: "send", to: "...", message: "...", phase: "complete" })
```

Keep text markers `[PHASE:*]` in the message body for readability — the structured `phase` parameter is what the system acts on.

### 11. `MessengerState` — Driver-side terminal tracking

Add `completedCollaborators: Set<string>` to the `MessengerState` interface in `lib.ts`:

```typescript
export interface MessengerState {
  // ...existing fields...
  completedCollaborators: Set<string>;  // NEW: collaborator names that signaled complete
}
```

Initialize as `new Set()` in ALL MessengerState constructors:
- `index.ts` (~line 100) — extension entrypoint
- `cli/index.ts` (~line 37, `createMinimalState`) — standalone CLI
- `tests/crew/collab-blocking.test.ts` (~line 71, `makeMinimalState`) — test helper
- `tests/crew/router-status.test.ts` (~line 9, `createTestState`) — test helper
- Any other typed `MessengerState` constructor found via `rg "MessengerState ="` or `as MessengerState`

### 12. Config schema

Add `pollTimeoutMs` to crew config alongside existing `stallThresholdMs`:
```typescript
collaboration: {
  stallThresholdMs?: number;    // existing: log-growth stall
  pollTimeoutMs?: number;       // NEW: absolute timeout (D5)
}
```

## Requirement Traceability

| Req | How satisfied |
|-----|---------------|
| R0 (never block indefinitely) | D2 + D4 + D5 — three independent layers + completedCollaborators set for post-exit sends |
| R1 (collaborator done signal terminates) | peerComplete in PollResult → immediate return |
| R2 (driver final ack without blocking) | D2: phase:"complete" → non-blocking send (best-effort delivery — message persists in inbox/feed but collaborator may exit before consuming) |
| R3 (stall despite log growth) | D5: pollTimeoutMs — absolute wall-clock timeout, independent of log-stall |
| R4 (system enforceable) | D4 fires without agent cooperation; D5 fires regardless |
| R6 (backward compatible) | All new fields optional; no phase = existing blocking path |
| R7 (structured metadata) | phase is a typed field on tool call and message JSON |

## Test Plan

New tests in `tests/crew/collab-blocking.test.ts` (extends existing 895-line suite):

| Test | What it verifies |
|------|-----------------|
| D2: send with phase:"complete" returns immediately | Non-blocking path, no pollForCollaboratorMessage entered |
| D2: collaborator is dismissed after phase:"complete" send | gracefulDismiss called, entry unregistered |
| D4: receive phase:"complete", next send auto-terminates | peerTerminal flag set, subsequent send is non-blocking |
| D4-after-death: collaborator exits between messages | completedCollaborators set returns conversationComplete without delivery attempt |
| D5: pollTimeout fires at configured threshold despite log growth | Message-independent stall with stallType:"timeout" |
| D5: pollTimeoutMs configurable via crewConfig | Config value overrides default |
| Backward compat: send without phase blocks as before | Existing poll path unchanged |
| Phase in message JSON | sendMessageToAgent writes phase to file |
| Phase absent when not set | No phase key in JSON when undefined |
| peerComplete in PollResult | Poll returns peerComplete:true on phase:"complete" match |
| executeSpawn propagates peerComplete | Spawn result includes conversationComplete when first msg has phase:"complete" |
| stallType distinguishes log vs timeout | log-stall returns stallType:"log", timeout returns stallType:"timeout" |
| D2 feed event logged after dismiss | Verify logFeedEvent called with message preview on D2 terminal send (feed is the durable audit trail) |
| completedCollaborators prevents not_found after exit | Send to completed collaborator returns conversationComplete, not not_found |
| crew-challenger emits structured phase | Verify crew-challenger.md instructs phase parameter on sends |

## Doc Updates

- `crew/agents/crew-challenger.md` (this repo) — **Mandatory.** Update Phase 4 signal section to use structured `phase` parameter. Without this, the built-in collaborator never triggers D2/D4.
- `~/.agent-config/docs/agent-collaboration.md` (external repo) — Update phase table, document `phase` parameter on send, update examples. Note: this file is in agent-config, not pi-messenger.
- `~/.agent-config/commands/{shape,plan,implement}.md` (external repo) — Reference structured `phase` parameter alongside text markers.
