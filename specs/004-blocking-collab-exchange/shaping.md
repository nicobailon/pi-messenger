---
shaping: true
---

# Blocking Collaborator Exchange — Shaping

## Frame

**Source**: Cross-repo collaboration between JadeDragon (pi-messenger) and HappyFalcon (agent-config). HappyFalcon identified a recurring failure mode: after `spawn` returns, the spawning LLM agent is told to "wait" via natural language, but LLMs are forward-biased — they ping early, dismiss prematurely, or go solo, wasting 3-10 minutes of compute. Current mitigation is documentation warnings in `agent-collaboration.md` ("do not ping, silence means processing") but this hopes for compliance rather than enforcing it.

**Problem**: The collaboration protocol has an inherent gap between "collaborator is running" and "collaborator has produced a response." During this gap, the spawning agent has no blocking primitive — it's an LLM in an ambiguous waiting state with nothing to do but generate its next action. This reliably leads to premature intervention.

**Outcome**: Collaborator exchanges are deterministic — each tool call returns the information the agent needs. No ambiguous waiting states exist in the protocol.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Spawning agent receives collaborator's first response without entering an ambiguous waiting state | Core goal |
| R1 | Subsequent message exchanges are deterministic (send → receive is atomic) | Must-have |
| R2 | User sees live activity indicators (elapsed time + evidence of work) during blocking waits, updated periodically | Must-have |
| R3 | Spawning agent can cancel a blocking wait (Ctrl+C / session shutdown) | Must-have |
| R4 | Collaborator crash during wait produces useful error with log context, not a hang | Must-have |
| R5 | No changes required to existing workflow commands (/shape, /plan, /implement) | Must-have |
| R6 | ~~Works across all runtimes~~ | Deferred |
| R7 | Timeout produces clear error with actionable guidance, not silent fallback | Must-have |
| R8 | Multiple concurrent collaborators don't interfere with each other's blocking waits | Must-have |
| R9 | All agent communication flows through the inbox (mesh coherence) | Must-have |

---

## Shapes

### A: Blocking tool call with inbox polling

Spawn and send block inside `execute()` by polling the spawner's own inbox directory for a message from the specific collaborator. `onUpdate` streams progress. Watcher filter (`blockingCollaborators: Set<string>`) prevents double delivery.

| Part | Mechanism |
|------|-----------|
| **A1** | `executeSpawn` polls inbox for first message after mesh join, returns message content in result |
| **A2** | `executeSend` polls inbox for reply from collaborator after writing outbound message |
| **A3** | Watcher filter: `blockingCollaborators` set installed BEFORE mesh polling; `deliverMessage` skips messages from senders in set; cleanup in finally/abort handler |
| **A4** | Progress: `onUpdate` fires periodically with elapsed time + log file size delta |
| **A5** | Cancellation: `signal.addEventListener('abort', ...)` breaks polling loop, cleans up filter set |
| **A6** | Crash detection: polling loop checks `proc.exitCode`, reads log tail on crash |
| **A7** | Timeout: configurable max wait, returns error result with `timeout: true` |

### B: Protocol-level RPC (stdin/stdout round-trip)

Instead of polling the filesystem inbox, route collaborator responses through the RPC stdin/stdout pipe.

| Part | Mechanism |
|------|-----------|
| **B1** | `executeSpawn` writes prompt to stdin (already happens), then reads stdout for first JSON response line |
| **B2** | `executeSend` writes message as JSON to stdin, reads reply JSON from stdout |
| **B3** | No watcher filter needed — collaborator messages never hit the inbox |
| **B4** | Progress: parse stdout JSON lines for progress events between response lines |
| **B5** | Cancellation: close stdin pipe, same as current dismiss |
| **B6** | Crash detection: stdout EOF or process exit |
| **B7** | Timeout: same as A — configurable, error on expiry |

**Rejected**: Collaborators communicate via `pi_messenger send` → inbox files, not via stdout. Stdout is pi's internal output (tool calls, thinking traces). Making B work requires a parallel IPC channel that breaks the invariant that all agent communication flows through the inbox. Breaks mesh coherence (R9) and creates asymmetric communication channels.

---

## Fit Check

| Req | Requirement | Status | A | B |
|-----|-------------|--------|---|---|
| R0 | Spawning agent receives collaborator's first response without entering an ambiguous waiting state | Core goal | ✅ | ✅ |
| R1 | Subsequent message exchanges are deterministic (send → receive is atomic) | Must-have | ✅ | ✅ |
| R2 | User sees live activity indicators during blocking waits, updated periodically | Must-have | ✅ | ✅ |
| R3 | Spawning agent can cancel a blocking wait | Must-have | ✅ | ✅ |
| R4 | Collaborator crash produces useful error with log context | Must-have | ✅ | ✅ |
| R5 | No changes required to existing workflow commands | Must-have | ✅ | ✅ |
| R7 | Timeout produces clear error, not silent fallback | Must-have | ✅ | ✅ |
| R8 | Multiple concurrent collaborators don't interfere | Must-have | ✅ | ❌ |
| R9 | All agent communication flows through the inbox (mesh coherence) | Must-have | ✅ | ❌ |

**Notes:**
- B fails R8: Hybrid model (send via inbox, receive via stdout) creates asymmetric channels; concurrent collaborator multiplexing requires process-level tracking that the inbox model handles naturally via `from` field
- B fails R9: Requires parallel IPC channel that bypasses the inbox, breaking mesh coherence

---

## Selected Shape: A — Blocking tool call with inbox polling

**Rationale**: Passes all requirements. Uses proven patterns from existing codebase (polling loops in `pollUntilReady` and `pollUntilExited`). Minimal code change (~80-100 new lines, ~10 modified). Preserves the mesh invariant.

---

## Breadboard

### Flow 1: Spawn + First Message (A1, A3, A4, A7)

```
Agent calls: pi_messenger({ action: "spawn", agent: "crew-challenger", prompt: "..." })

TUI shows:
  [pi_messenger] Spawning crew-challenger...
  [pi_messenger] CalmNova joined mesh
  [pi_messenger] Waiting for CalmNova's first response...
  [pi_messenger] Waiting... 1m20s (log: +12KB)
  [pi_messenger] Waiting... 2m45s (log: +38KB)
  [pi_messenger] Waiting... 4m10s (log: +71KB)

Tool returns:
  content: "Collaborator \"CalmNova\" spawned (crew-challenger). First message:\n\n
            [collaborator's analysis]\n\n
            Send messages: pi_messenger({ action: \"send\", to: \"CalmNova\", message: \"...\" })\n
            Dismiss when done: pi_messenger({ action: \"dismiss\", name: \"CalmNova\" })"
  details: { mode: "spawn", name: "CalmNova", agent: "crew-challenger",
             firstMessage: "I've read the spec. Three concerns: ..." }
```

### Flow 2: Send + Reply (A2, A4)

```
Agent calls: pi_messenger({ action: "send", to: "CalmNova", message: "[PHASE:revise] Updated approach..." })

TUI shows:
  [pi_messenger] Message sent to CalmNova
  [pi_messenger] Waiting for CalmNova's reply...
  [pi_messenger] Waiting... 45s (log: +8KB)

Tool returns:
  content: "Message sent to CalmNova. Reply from CalmNova:\n\n
            [PHASE:agree] Updated approach is solid."
  details: { mode: "send", to: "CalmNova", delivered: true,
             reply: "[PHASE:agree] Updated approach is solid." }
```

### Flow 3: Timeout (A7)

```
TUI shows:
  [pi_messenger] Waiting... 9m30s (log: +142KB)
  [pi_messenger] Timeout — no response after 10m

Tool returns:
  content: "CalmNova did not respond within 10 minutes. The collaborator may still
            be processing. Dismiss and retry, or ask the user for guidance."
  details: { mode: "spawn", error: "timeout", name: "CalmNova" }
```

### Flow 4: Crash (A6)

```
TUI shows:
  [pi_messenger] Waiting... 2m10s (log: +34KB)
  [pi_messenger] CalmNova process exited (code 1)

Tool returns:
  content: "CalmNova crashed during initial processing. See logTail for details."
  details: { mode: "spawn", error: "collaborator_crashed", name: "CalmNova",
             exitCode: 1, logTail: "Error: Failed to read specs/014/spec.md..." }
```

### Flow 5: User Cancellation (A5)

```
TUI shows:
  [pi_messenger] Waiting... 1m40s (log: +22KB)
  [user presses Ctrl+C]

Tool returns:
  content: "Spawn cancelled by user. CalmNova has been dismissed."
  details: { mode: "spawn", error: "cancelled", name: "CalmNova" }
```

Cleanup: watcher filter removed, collaborator process dismissed, registry cleaned.

### Flow 6: Send to Peer (unchanged)

```
Agent calls: pi_messenger({ action: "send", to: "FastLion", message: "FYI: I updated the plan" })

Tool returns immediately:
  content: "Message sent to FastLion. (N messages remaining)"
  details: { mode: "send", to: "FastLion", delivered: true }
```

No blocking. No reply field. Routing decision based on whether target is in the collaborator registry.

---

## Design Decisions

1. **Watcher filter lifecycle**: Per-call, not per-collaborator-lifetime. `blockingCollaborators` entries are added before each blocking poll and removed after. Between exchanges, the normal watcher → steer delivery path works. Unsolicited collaborator messages (unlikely) are delivered normally between exchanges.

2. **Collaborator vs peer routing**: The `send` action checks whether the target name exists in the collaborator registry (`findCollaboratorByName`). If yes → block for reply. If no → deliver and return immediately. No new params needed.

3. **Result shape**: Both `content` (human-readable, includes full message text) and `details` (structured, includes `firstMessage`/`reply` field) contain the collaborator's response. Backwards-compatible — adds fields, doesn't change existing ones.

---

## Cross-references

- Depends on: pi SDK `onUpdate` + `signal` in tool `execute()` (confirmed available)
- Consumer spec: agent-config spec 016 (HappyFalcon) — will simplify `agent-collaboration.md`
- Prior discussion: HappyFalcon ↔ JadeDragon exchange (2026-03-11)
