---
shaping: true
---

# Deterministic Collaborator Timeout — Shaping

## Frame

**Source**: User observed challenger "ZenCastle" killed at 600s during `/plan` despite 1.5MB+ of active log output. Retry "IronCastle" was at 180s with the same active-work pattern. Spec 004 added blocking collaborator exchange to eliminate ambiguous waiting states, but included fixed wall-clock timeouts (`SPAWN_FIRST_MESSAGE_TIMEOUT_MS = 600_000`, `SEND_REPLY_TIMEOUT_MS = 300_000`) that contradict the deterministic design principle.

**Problem**: The fixed timeout fires when the collaborator is actively working. The poll loop already tracks log file size delta (for progress reporting) but doesn't use it for exit decisions. The timeout is the only non-deterministic exit condition — everything else (message, crash, cancel) fires on observable events.

**Outcome**: The poll loop exits only on observable events. A collaborator that is alive and producing output is never killed by the poll loop.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R1 | No fixed wall-clock timeout — a collaborator producing output is never killed | Core goal |
| R2 | Stall detection: sustained absence of log growth triggers a stall exit | Must-have |
| R3 | Stall error includes log tail and actionable guidance | Must-have |
| R4 | Progress updates unchanged (elapsed time + log delta) | Must-have |
| R5 | Stall threshold configurable via crew config | Nice-to-have |
| R6 | `PollOptions` interface updated (no `timeoutMs`) | Must-have |
| R7 | Tests updated for stall semantics | Must-have |
| R8 | Existing deterministic exits unchanged | Must-have |

---

## Shapes

### A: Stall detection via log growth monitoring

Replace the wall-clock timeout with a stall detector. The poll loop already reads `entry.logFile` size every `PROGRESS_INTERVAL_MS` for the `emitProgress()` function. Reuse that same signal: track `lastLogChangeTime` and resolve as `"stalled"` when `now - lastLogChangeTime >= stallThresholdMs`.

| Part | Mechanism |
|------|-----------|
| **A1** | Remove `SPAWN_FIRST_MESSAGE_TIMEOUT_MS`, `SEND_REPLY_TIMEOUT_MS` constants and `timeoutMs` from `PollOptions` |
| **A2** | Add `stallThresholdMs` to `PollOptions` (default 120_000 — 2 min of zero output) |
| **A3** | Track `lastLogChangeTime` in poll loop; update whenever `stat.size > lastLogSize` |
| **A4** | New exit check: if `logFile` exists AND `now - lastLogChangeTime >= stallThresholdMs` AND `proc.exitCode === null` → resolve `"stalled"` with log tail |
| **A5** | If no `logFile` on the entry — skip stall detection entirely; only crash/cancel/message exits apply |
| **A6** | `PollResult` error union: `"crashed" | "cancelled" | "stalled"` (drop `"timeout"`) |
| **A7** | Update `executeSpawn` and `executeSend` error handling branches: replace timeout messages with stall messages |
| **A8** | On stall: do NOT auto-dismiss — return error, let caller decide |

**How the stall check integrates with the existing loop:**

The poll loop runs every `POLL_INTERVAL_MS` (100ms). Currently it does: cancel check → crash check → timeout check → inbox check → progress emit. Replace the timeout check:

```
// BEFORE (wall-clock)
if (Date.now() - startTime >= timeoutMs) → timeout

// AFTER (stall-aware)
if (logFile exists) {
  const currentSize = stat(logFile).size;
  if (currentSize > lastLogSize) {
    lastLogChangeTime = now;  // reset stall clock
    lastLogSize = currentSize;
  }
  if (now - lastLogChangeTime >= stallThresholdMs) → stalled
}
```

The log size is already being read for `emitProgress()`. The change unifies progress tracking and stall detection into one read, checked every 100ms instead of only at 30s progress intervals.

### B: Heartbeat file written by collaborator extension

The collaborator's pi-messenger extension writes a heartbeat file (timestamp) on every `tool_call` or `tool_result` event. The poll loop reads the heartbeat file instead of the log file.

| Part | Mechanism |
|------|-----------|
| **B1** | Add heartbeat write to `pi.on("tool_call")` and `pi.on("tool_result")` lifecycle hooks |
| **B2** | Heartbeat file at `~/.pi/agent/messenger/heartbeat/<agentName>.json` |
| **B3** | Poll loop reads heartbeat timestamp instead of log file size |
| **B4** | Stall = heartbeat older than threshold |

**Rejected**: Requires modifying the extension's lifecycle hooks with collaborator-specific logic. The heartbeat file is a new coordination primitive that adds complexity (file creation, cleanup, race conditions between writer and reader). The log file already provides the same signal — if pi is making tool calls, it's writing to stdout/stderr, which goes to the log file. Log growth IS the heartbeat. Adding a separate heartbeat channel is redundant.

### C: Remove all timeouts, rely only on crash + cancel

No stall detection at all. The poll loop runs indefinitely until message, crash, or cancel.

| Part | Mechanism |
|------|-----------|
| **C1** | Remove timeout check from poll loop |
| **C2** | No stall detection — loop runs forever if collaborator is alive |
| **C3** | User's only exit is Ctrl+C |

**Rejected**: A collaborator can get genuinely stuck — alive process, no crashes, but making no progress (e.g., waiting for user input that will never come in headless mode, or an infinite retry loop). Without stall detection, the user has to notice and manually cancel. The log-growth signal in Shape A catches this case deterministically.

---

## Fit Check

| Req | Description | A | B | C |
|-----|-------------|---|---|---|
| R1 | No fixed wall-clock timeout | ✅ | ✅ | ✅ |
| R2 | Stall detection via sustained absence of work | ✅ | ✅ | ❌ |
| R3 | Stall error with log tail + guidance | ✅ | ✅ | N/A |
| R4 | Progress updates unchanged | ✅ | ✅ | ✅ |
| R5 | Configurable stall threshold | ✅ | ✅ | N/A |
| R6 | `PollOptions` updated | ✅ | ✅ | ✅ |
| R7 | Tests updated | ✅ | ✅ | ✅ |
| R8 | Existing exits unchanged | ✅ | ✅ | ✅ |

---

## Selected Shape: A — Stall detection via log growth monitoring

**Rationale**: Passes all requirements. Reuses existing infrastructure (log file size tracking already in `emitProgress`). Zero new coordination primitives. Minimal diff — replace one `if` branch and change the type. The log file is already the ground truth for "collaborator is doing something."

---

## Breadboard

### Flow 1: Active collaborator runs to completion (no stall)

```
Agent calls: pi_messenger({ action: "spawn", agent: "crew-challenger", prompt: "..." })

TUI shows:
  [pi_messenger] Spawning crew-challenger...
  [pi_messenger] ZenCastle joined mesh
  [pi_messenger] Waiting for ZenCastle... 30s elapsed (+24KB logged)
  [pi_messenger] Waiting for ZenCastle... 60s elapsed (+89KB logged)
  ...
  [pi_messenger] Waiting for ZenCastle... 720s elapsed (+4.2MB logged)   ← would have been killed at 600s before

Tool returns (at 780s, when challenger finally sends):
  { mode: "spawn", name: "ZenCastle", firstMessage: "I've read the spec. Three concerns: ..." }
```

Log keeps growing → stall clock keeps resetting → collaborator runs as long as it needs.

### Flow 2: Stalled collaborator (alive but no output)

```
TUI shows:
  [pi_messenger] Waiting for ZenCastle... 180s elapsed (+1.2MB logged)
  [pi_messenger] Waiting for ZenCastle... 210s elapsed (+0 bytes logged)    ← log stopped
  [pi_messenger] Waiting for ZenCastle... 240s elapsed (+0 bytes logged)
  ...
  [pi_messenger] Waiting for ZenCastle... 330s elapsed (+0 bytes logged)
  [pi_messenger] ZenCastle appears stalled — no output for 120s

Tool returns:
  { mode: "spawn", error: "stalled", name: "ZenCastle", logTail: "..." }
```

120s of zero log growth → deterministic stall signal. Log tail helps diagnose what it was doing when it stopped.

### Flow 3: No log file (edge case)

Collaborator spawned but log file creation failed (disk full, permissions).

```
Poll loop: stall detection skipped (no file to monitor).
Only exits: message received, crash, user cancel.
```

Acceptable degradation — stall detection requires evidence. No evidence → no stall claim.

---

## Design Decisions

1. **Stall threshold default: 120s (2 minutes)**. Challengers make tool calls continuously — read a file, bash a grep, read another file. Even 30s of silence would be unusual. 120s provides generous headroom while still catching genuine stalls within a reasonable timeframe. Configurable for projects with unusual latency patterns.

2. **Stall does NOT auto-dismiss.** The timeout path auto-dismissed on spawn (because the collaborator "never established contact"). Stall is different — the collaborator WAS active, then stopped. The spawning agent or user should decide whether to retry, wait longer, or dismiss. The error message provides guidance but doesn't force an action.

3. **Unified log size tracking.** Currently `emitProgress()` reads log size at 30s intervals and `checkTimeout` uses wall-clock. After this change, the poll loop reads log size at every 100ms cycle for stall detection, and `emitProgress()` can use the same tracked value. One stat() call serves both purposes.

4. **`timeoutMs` removed from PollOptions, not made optional.** A lingering optional `timeoutMs` invites re-introduction. Clean removal forces all callers to use the stall-based model.

---

## Cross-references

- Fixes regression from: spec 004 (AC7 specifically)
- Code touched: `crew/handlers/collab.ts`, `handlers.ts`, `tests/crew/collab-blocking.test.ts`
- Consumer: agent-config `agent-collaboration.md` error table (timeout → stalled)
