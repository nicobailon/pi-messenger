<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-12 -->
<!-- Status: REVISED -->
<!-- Revisions: AC5 updated to differentiate spawn vs send cancellation semantics; AC9 updated to include optional replyTo correlation -->
---
title: "Blocking Collaborator Exchange"
date: 2026-03-12
bead: pi-messenger-3np
shaping: specs/004-blocking-collab-exchange/shaping.md
---

# 004 — Blocking Collaborator Exchange

## Problem

After `pi_messenger({ action: "spawn" })` returns, the spawning LLM agent is told to "wait 3-10 minutes" via natural language for the collaborator's first response. LLMs are forward-biased — they reliably ping early, dismiss prematurely, or abandon the collaboration and proceed solo. This wastes 3-10 minutes of compute and forces users to restart.

The same gap exists for `send` — the tool returns immediately after delivery, leaving the agent in an ambiguous state between sending a message and receiving the reply.

Current mitigation is documentation warnings in `agent-collaboration.md` ("do not ping, silence means processing"). This hopes for compliance rather than enforcing it.

## Solution

**Shape A: Blocking tool call with inbox polling** (selected via shaping — see `shaping.md` for full requirements, fit check, and rejected alternatives).

Make `spawn` and `send` block inside the tool's `execute()` function by polling the spawner's own inbox directory for messages from the specific collaborator. The tool call returns only when the collaborator's response has arrived — or on timeout/crash/cancellation.

- **`spawn`** blocks until the collaborator sends its first message. Returns the message content alongside spawn metadata.
- **`send` to a collaborator** blocks until the collaborator replies. Returns the reply content alongside delivery confirmation.
- **`send` to a peer** is unchanged — returns immediately after delivery. No blocking.
- Routing is automatic based on whether the target is in the collaborator registry (`findCollaboratorByName`). No new params needed.

## Requirements

From shaping (R0-R5, R7-R9 — all must-have; R6 deferred):

| ID | Requirement |
|----|-------------|
| R0 | Spawning agent receives collaborator's first response without entering an ambiguous waiting state |
| R1 | Subsequent message exchanges are deterministic (send → receive is atomic) |
| R2 | User sees live activity indicators (elapsed time + evidence of work) during blocking waits |
| R3 | Spawning agent can cancel a blocking wait (Ctrl+C / session shutdown) |
| R4 | Collaborator crash during wait produces useful error with log context |
| R5 | No changes required to existing workflow commands (/shape, /plan, /implement) |
| R7 | Timeout produces clear error with actionable guidance, not silent fallback |
| R8 | Multiple concurrent collaborators don't interfere with each other's blocking waits |
| R9 | All agent communication flows through the inbox (mesh coherence) |

## Acceptance Criteria

### AC1: Spawn blocks until first message (R0)
- `executeSpawn` polls the spawner's inbox for a message where `from` matches the collaborator's name
- Tool call does not return until message is received, timeout, crash, or cancellation
- Result includes `firstMessage` in `details` and the message text in `content`
- Result includes send/dismiss affordances in `content` but NOT "wait patiently" language

### AC2: Send to collaborator blocks until reply (R1)
- When `executeSend` targets a name found via `findCollaboratorByName`, it writes the outbound message then polls for a reply
- Tool call blocks until reply is received, timeout, crash, or cancellation
- Result includes `reply` field in `details` and the reply text in `content`
- Backwards-compatible: existing `mode`, `to`, `delivered` fields unchanged; `reply` is additive

### AC3: Send to peer is unchanged (R1, R5)
- When `executeSend` targets a name NOT in the collaborator registry, behavior is identical to today — deliver and return immediately
- No `reply` field in result
- No blocking

### AC4: Progress streaming (R2)
- During blocking waits, `onUpdate` fires periodically with elapsed time and evidence of work (log file size delta)
- Updates are visible in the TUI while the tool is executing
- Update interval balances user visibility against context cost (30s recommended)

### AC5: Cancellation (R3)
- `signal.addEventListener('abort', ...)` breaks the polling loop
- **Spawn cancellation**: watcher filter cleaned up, collaborator dismissed, registry cleaned (never established contact)
- **Send cancellation**: watcher filter cleaned up, collaborator remains alive (may be mid-response), error returned
- Result indicates `error: "cancelled"`

### AC6: Crash detection (R4)
- Polling loop checks `proc.exitCode !== null` each cycle
- On crash: reads last 2KB of `entry.logFile` (if not null) for error context using `fs.openSync`/`fs.readSync`
- Result includes `exitCode` and `logTail` in details

### AC7: Timeout (R7)
- Configurable maximum wait duration: 10 minutes for spawn, 5 minutes for send
- On timeout: result includes `error: "timeout"` with actionable guidance
- Does NOT fall back to async — error is explicit
- Timeout values are parameters to the poll helper for test injection

### AC8: Watcher filter prevents double delivery (R8, R9)
- `blockingCollaborators: Set<string>` added to `MessengerState`
- Collaborator name added to set BEFORE `pollUntilReady` (race condition prevention) or BEFORE `sendMessageToAgent` (send path race prevention)
- `deliverMessage` in `index.ts` returns `false` for senders in `blockingCollaborators`; `processAllPendingMessages` does not delete file when `deliverFn` returns `false`
- Set entry removed in `finally` block — never leaked
- Filter is per-call, not per-collaborator-lifetime: between exchanges, normal watcher→steer delivery works

### AC9: Concurrent collaborators (R8)
- Inbox polling filters by `from` field (collaborator name) and optionally by `replyTo` correlation
- Messages from collaborator Y do not satisfy the wait for collaborator X
- Two concurrent blocking waits (spawn A + spawn B) operate independently
