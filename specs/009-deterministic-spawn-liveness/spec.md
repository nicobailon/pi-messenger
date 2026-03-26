---
title: "Deterministic spawn liveness — replace log-growth heuristic with real activity signal"
date: 2026-03-19
updated: 2026-03-25
bead: pi-messenger-35k
---

<!-- issue:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T19:40:00Z -->

# 009 — Deterministic Spawn Liveness

## Problem

The CLI `spawn` command uses log-file-growth as its liveness signal: if the collaborator's log file hasn't grown in `stallThresholdMs` (default 120s), it declares the collaborator stalled and exits. This is a heuristic, not a deterministic signal. It produces false positives during normal operation.

### How it fails

When an opus-class model processes a large context (50K+ tokens), the Anthropic API consumes all input, runs the thinking phase, and only then begins streaming output. During this processing gap — which can last 3-5+ minutes — the pi process is alive, the API connection is active, the model is working, but **zero bytes are written to the log file**. The stall detector sees static log size and fires.

### Observed failure (2026-03-19)

Codex agent "RedUnion" in MiroFish spawned challenger "YoungViper" via `pi-messenger-cli spawn`. YoungViper joined the mesh, called `pi_messenger({ action: "join" })`, read 4 spec files, entered a large thinking pass, then called `pi_messenger({ action: "send", to: "RedUnion" })` — **successfully**. But by then, the CLI spawn had already exited due to stall timeout. RedUnion was gone. YoungViper's second send failed: "RedUnion (not found)." Two subsequent attempts (LoudHawk, SwiftQuartz) hit the same pattern.

Both YoungViper (PID 48921) and CalmMoon (PID 83110) were still running as orphaned pi processes, never cleaned up.

### What the log proves

```
# YoungViper's log — 558 pi_messenger calls, actively working
tool_execution_end: pi_messenger send → "Message sent to RedUnion" (SUCCESS)
tool_execution_end: pi_messenger send → "Failed to send: RedUnion (not found)" (TOO LATE)
```

The collaborator did everything right. The spawn command gave up too early.

### The pattern across specs

This is the THIRD spec addressing poll/timeout behavior:

| Spec | Problem | Fix | What it got wrong |
|------|---------|-----|-------------------|
| 005 | Fixed 10-min timeout killed working challengers | Log-based stall detection (120s of no growth) | Assumed log growth = alive. Wrong during API processing gaps. |
| 008 | Spec 006 D5 (300s absolute timeout) killed working spawns | Context-aware poll timeout (spawn=900s, send=300s) | Right direction, still a guess. Doesn't fix the log-growth heuristic. |
| **009** | **Log-growth heuristic fires false positives during normal model processing** | **Deterministic liveness signal** | — |

Any fixed threshold will be wrong for some workload. **This spec must break the pattern.**

## Root Cause

The CLI spawn (`cli/index.ts runSpawn`, lines 963-1220) and the extension's `pollForCollaboratorMessage` (`crew/handlers/collab.ts`) both use log file size delta for stall detection. This conflates two very different states:

1. **Model processing** — pi process alive, active HTTPS connection, event loop running, zero log output (API hasn't started streaming yet).
2. **Process stuck** — pi process alive but genuinely hung (deadlock, infinite loop, network timeout).

These states look identical to a log-growth observer. No fixed threshold distinguishes them.

### What signal IS deterministic?

The pi process runs Node.js. During an API call, the event loop is active (the HTTP request is async). A `setInterval` timer WILL fire even while waiting for the API response. This means the extension can emit a heartbeat that continues during API processing gaps — the one time log-growth fails.

**Current extension timers (neither writes to disk during API gaps):**
- **Status heartbeat** (`setInterval`, 15s) — calls `updateStatus(ctx)`, but only updates UI (`ctx.ui.setStatus()`). No disk writes.
- **Registry flush** (`setTimeout`, 10s, one-shot) — writes `registry/<name>.json`, but only triggers on `scheduleRegistryFlush()` which is called from `tool_call`/`tool_result` hooks. No tool calls during API processing = no flush.

Neither writes to disk during the exact gap where liveness detection fails.

## Changes Since Original Spec

### Spec 010 (CLI Messaging Round-Trip) — 2026-03-25

Spec 010 significantly improved CLI infrastructure but did NOT touch the spawn liveness problem:

- **Identity stability**: `findSessionByCwd()` + CWD fallback means the CLI session identity no longer rotates between commands. `spawn` → `dismiss` sequences now reliably target the same agent.
- **`receive` command**: Non-pi agents can now read their inbox. If the spawner exits, the orphaned collaborator's messages ARE accessible via `pi-messenger-cli receive`.
- **`send --wait`**: The spawner could theoretically use `send --wait` instead of the in-process poll loop, but this doesn't fix the core problem — the spawner still needs to know if the collaborator is alive.
- **`NO_REGISTER_COMMANDS`**: Read-only commands no longer clobber spawn registrations. This eliminates a class of "not found" errors where `list` or `status` would overwrite the spawner's PID.

**Net impact on 009**: The CLI plumbing is more reliable. Identity rotations and PID clobbering that caused secondary failures are fixed. The PRIMARY problem (log-growth heuristic false positives) is unchanged.

### Extension `pollForCollaboratorMessage` — current state

The extension's poll loop (`collab.ts:107-230`) has:
- `stallThresholdMs` (default 120s) — log file unchanged = stalled
- `pollTimeoutMs` (default 300s send / 900s spawn) — absolute wall-clock cutoff
- Stall type distinguishes `"log"` vs `"timeout"` but both are heuristics

The CLI's `runSpawn` poll loop (lines 1138-1200) has its own independent implementation:
- `stallThreshold` (120s default from config)
- `spawnTimeout` (900s absolute)
- Same log-size-delta logic
- **No orphan cleanup on stall** — just closes FIFO write end and exits

## What Needs Shaping

### Candidate A: Extension heartbeat file
Have the extension write a heartbeat timestamp to a known path (e.g., `<collabStateDir>/<name>.heartbeat`) every N seconds via `setInterval`. The CLI poll checks this file's mtime instead of log size. Fires during API processing because the Node.js event loop runs timers during async HTTP.

**Pros**: Simple, deterministic, uses existing timer infrastructure.
**Cons**: New file to manage, new cleanup concern.

### Candidate B: Registry mtime as heartbeat
Modify the extension's registry flush to fire on a periodic `setInterval` (not just on tool calls). The CLI poll checks `registry/<name>.json` mtime. Piggybacks on existing infrastructure.

**Pros**: No new files, uses existing registry mechanism.
**Cons**: Registry writes are heavier (full JSON serialize), increases disk I/O, changes semantics of `lastActivityAt`.

### Candidate C: OS-level process inspection
Check the pi process for active network connections (`lsof -p PID -i TCP:443`). Active HTTPS = model processing.

**Pros**: No extension changes needed.
**Cons**: `lsof` is expensive per poll iteration, macOS-specific behavior, fragile.

### Candidate D: Hybrid — heartbeat + log fallback
Extension heartbeat (Candidate A) as primary signal. Log-growth as fallback if heartbeat file doesn't exist (legacy/non-extension contexts). Stall = heartbeat AND log both stale for N seconds.

**Pros**: Best of both worlds, graceful degradation.
**Cons**: Two signals to track, more complex logic.

### Questions for shaping

1. Should the CLI spawn share the extension's `pollForCollaboratorMessage` logic, or is the separate implementation acceptable? (DRY vs. independence)
2. Must the solution work for non-pi runtimes (Claude Code workers) where the pi-messenger extension is NOT loaded? (Collaborators are always pi processes — Claude Code workers don't use FIFO spawn.)
3. How should orphan cleanup work when stall fires? Currently `runSpawn` exits without killing the collaborator process.

## Requirements

| ID | Requirement |
|----|-------------|
| R0 | Collaborator is never killed while the pi process event loop is responsive (heartbeat active) |
| R1 | Stall detection fires only when heartbeat AND log are both stale for the configured threshold |
| R2 | Orphan pi processes are killed when stall is detected (not left running) |
| R3 | Heartbeat mechanism works during API processing gaps (the exact failure case for log-growth) |
| R4 | Extension heartbeat adds < 1 disk write per 15s per collaborator |
| R5 | CLI `runSpawn` poll loop replaced or updated to check heartbeat signal |
| R6 | Extension `pollForCollaboratorMessage` updated to check heartbeat signal |
| R7 | Graceful degradation: if heartbeat file doesn't exist (non-extension context), fall back to existing log-growth stall detection |
| R8 | Configurable stall threshold preserved (default 120s of no heartbeat + no log growth) |

## Acceptance Criteria

### AC1: Heartbeat mechanism
- Extension writes a heartbeat file (or equivalent) at a regular interval (≤15s) that continues during API processing gaps
- File path is discoverable by the CLI poll loop from the collab state
- Heartbeat writes use `setInterval` on the Node.js event loop (proven to fire during async HTTP)

### AC2: Stall detection uses heartbeat
- CLI `runSpawn` checks heartbeat freshness instead of (or in addition to) log size
- Extension `pollForCollaboratorMessage` checks heartbeat freshness
- Stall = heartbeat stale for ≥ `stallThresholdMs` AND log file stale for ≥ `stallThresholdMs`
- Active heartbeat with stale log = model processing (NOT stalled)

### AC3: Orphan cleanup
- When CLI `runSpawn` detects stall, it kills the collaborator process before exiting
- `SIGTERM` → grace period → `SIGKILL` if still alive
- Collab state file cleaned up
- Registry entry cleaned up

### AC4: Tests
- Test: active heartbeat with static log → NOT stalled (the key false-positive case)
- Test: stale heartbeat + stale log → stalled
- Test: no heartbeat file → falls back to log-only stall detection
- Test: orphan cleanup on stall (process killed, state cleaned)

### AC5: Backward compatibility
- Extension that doesn't write heartbeat (older version, non-collaborator) → existing behavior unchanged
- Stall threshold still configurable via `crew.collaboration.stallThresholdMs`

## Scope

**In scope:**
- Extension heartbeat mechanism (`index.ts` — new `setInterval` for collaborators)
- CLI spawn poll loop (`cli/index.ts` `runSpawn`)
- Extension `pollForCollaboratorMessage` (`crew/handlers/collab.ts`)
- Orphan process cleanup
- Collab state management (`cli/index.ts` collab state helpers)
- Tests for heartbeat-based stall detection

**Out of scope:**
- Crew worker spawn (different system, different lifecycle)
- Non-pi runtime adapters (Claude Code workers don't use FIFO spawn)
- The FIFO-based process lifecycle itself (load-bearing, not changing)
- UI/overlay changes
- `POLL_TIMEOUT_MS` (30s mesh-join timeout) — different concern
