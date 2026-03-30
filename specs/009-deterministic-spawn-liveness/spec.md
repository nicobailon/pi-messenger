---
title: "Deterministic spawn liveness — heartbeat file replaces log-growth heuristic"
date: 2026-03-19
updated: 2026-03-30
bead: pi-messenger-35k
shaped: true
---

<!-- issue:complete:v1 | harness: pi/claude-sonnet-4-6 | date: 2026-03-30T16:40:04Z -->

# 009 — Deterministic Spawn Liveness

## Problem

The spawn liveness detector uses log-file-growth as its signal: if the collaborator's log file hasn't grown in `stallThresholdMs` (default 120s), it declares "stalled." This is a heuristic that produces false positives during normal operation.

When an opus-class model processes a large context (50K+ tokens), the Anthropic API consumes all input, runs the thinking phase, and only then begins streaming output. During that gap — 3–5+ minutes — the Pi process is alive, the HTTP connection is active, the Node.js event loop is running, but **zero bytes are written to the log file**. The stall detector fires and kills the collaborator. The collaborator was working correctly.

### Two affected code paths (independent implementations of the same broken logic)

1. `crew/handlers/collab.ts:pollForCollaboratorMessage` — Pi-to-Pi extension path
2. `cli/index.ts:runSpawn` poll loop — CLI-to-Pi path

### History

This is the fourth spec addressing poll/timeout behavior:

| Spec | Problem | Fix | What it got wrong |
|------|---------|-----|-------------------|
| 005 | 10-min timeout killed working challengers | Log-based stall detection (120s) | Assumed log growth = alive |
| 006 | Idle collaborator drips bytes to fool log-growth | D5 absolute timeout (300s/900s) | D5 fires on working spawns too |
| 008 | D5 killed working spawns | Context-aware timeout (spawn=900s) | Still a guess, doesn't fix log-growth |
| **009** | **Log-growth fires during API processing gap** | **Deterministic heartbeat** | — |

Any fixed threshold will be wrong for some workload. This spec breaks the pattern.

### Key research findings (confirmed during shaping)

- `statusHeartbeatTimer` in `index.ts:303`: fires every 15s but `updateStatus()` returns immediately at line 231 (`if (!ctx.hasUI || !state.registered) return`). Collaborators are headless. This timer is a **no-op**. A new `setInterval` is required.
- `scheduleRegistryFlush` in `index.ts:626`: triggered only on `tool_call`/`tool_result` hooks. Does NOT fire during API processing gaps.
- `PI_CREW_COLLABORATOR === "1"` is already set in the spawned Pi process's env.
- Both poll-path stall handlers exit without killing the orphan process (confirmed: PIDs 48921 and 83110 were left running after stall).
- D5 absolute timeout: 300s (send context), 900s (spawn context). Must be suppressed when heartbeat is active.

---

## Shapes Considered and Eliminated

**Shape B (periodic registry flush):** `lastActivityAt` semantics corruption; heavyweight serialization every 10s; no file locking.

**Shape C (lsof process inspection):** TCP keep-alive connections are always visible; provider diversity; not available in sandboxed environments.

---

## Selected Shape: A — Extension heartbeat file + shared stall helper

### Parts

| Part | Mechanism |
|------|-----------|
| A1 | **Extension heartbeat writer**: new `setInterval(heartbeatIntervalMs)` in `index.ts` when `PI_CREW_COLLABORATOR === "1"`; writes `Date.now().toString()` to `dirs.registry/<name>.heartbeat`; cleanup in `onDeactivate`. Convention-based path — no new CollabState field needed. |
| A2 | **Shared `isStalled()` helper** (`crew/utils/stall.ts`): `isStalled(opts)` → `{ stalled, stalledMs, type }`. Within grace → not stalled. Heartbeat mtime within threshold → not stalled. Heartbeat missing after grace → log-only fallback. Stall = log also stale for ≥ stallThresholdMs. |
| A3 | **CLI `runSpawn` update**: replace log-size check with `isStalled()`; suppress D5 when heartbeat fresh; hard ceiling 3600s; on stall/timeout: SIGTERM → 5s → SIGKILL → full cleanup; on crash: add heartbeat unlink. |
| A4 | **Extension `pollForCollaboratorMessage` update**: add `heartbeatFile?` to PollOptions/CollaboratorEntry; replace log-size stall check with `isStalled()`; suppress D5 when heartbeat fresh; spawn ceiling 3600s; send ceiling `max(resolvedPollTimeoutMs * 3, 900s)`; stall path: RETURN error without kill (preserves defer-to-agent). |
| A5 | **Extension cleanup**: `onDeactivate` unlinks heartbeat file. `gracefulDismiss` also unlinks. |

---

## Requirements

**Top-level (9):**

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Collaborator never declared stalled while its heartbeat file has been updated within stallThresholdMs | Core goal |
| R1 | Stall condition requires BOTH heartbeat AND log to be stale for ≥ stallThresholdMs; active heartbeat alone prevents stall regardless of log activity | Must-have |
| R2 | On stall or crash, all collaborator state cleaned up — heartbeat file, collab state JSON, FIFO, registry entry | Must-have |
| R3 | Heartbeat mechanism uses `setInterval` on Node.js event loop — fires during API processing gaps. Writes to `<messengerDir>/registry/<name>.heartbeat` | Must-have |
| R4 | Heartbeat interval formula: `heartbeatIntervalMs = max(1000, min(10000, stallThresholdMs/8))`. Default stallThresholdMs=120s → 10s interval → 12 missed beats minimum | Must-have |
| R5 | Both poll paths updated to use shared `isStalled()` helper; D5 absolute timeout suppressed when heartbeat is fresh | Must-have |
| R6 | Grace period at spawn start = `heartbeatIntervalMs * 2`; missing heartbeat during grace → R7 fallback, not stall. No new config surface. | Must-have |
| R7 | If heartbeat missing after grace period, fall back to log-only stall detection. Backward compatible with collaborators on older extension versions. | Must-have |
| R8 | Shared `isStalled()` helper in `crew/utils/stall.ts` — used by both R5.1 and R5.2 to prevent independent drift. Stall threshold remains configurable via `crew.collaboration.stallThresholdMs` | Must-have |

**Sub-requirements:**

| ID | Requirement | Status |
|----|-------------|--------|
| R2a | CLI `runSpawn` stall path: SIGTERM PID (before FIFO close), 5s grace, SIGKILL; then deleteCollabState, unlink FIFO, unlink heartbeat file | Must-have |
| R2b | CLI `runSpawn` absolute timeout path: same cleanup as R2a | Must-have |
| R2c | CLI `runSpawn` crash path: add heartbeat file unlink (currently missing from `cli/index.ts:1173-1178`) | Must-have |
| R2d | Extension `pollForCollaboratorMessage` stall path: returns `{ error: "stalled" }` WITHOUT killing process — preserves existing defer-to-agent behavior | Must-have |
| R2e | Extension `executeSpawn` crash path (`collab.ts:530-535`): add heartbeat file unlink | Must-have |
| R5.1 | CLI `runSpawn`: use isStalled(); suppress D5 when heartbeat fresh; spawn hard ceiling 3600s (configurable) | Must-have |
| R5.2 | Extension `pollForCollaboratorMessage`: add `heartbeatFile?` to PollOptions/CollaboratorEntry; use isStalled(); suppress D5 when heartbeat fresh; spawn ceiling 3600s; send ceiling `max(resolvedPollTimeoutMs * 3, 900s)` | Must-have |

---

## Acceptance Criteria

### AC1: Heartbeat mechanism
- Extension writes `dirs.registry/<name>.heartbeat` at `heartbeatIntervalMs` intervals when `PI_CREW_COLLABORATOR === "1"`
- Default: 10s interval (stallThresholdMs=120s → formula gives 10s)
- Timer fires during API processing gaps (proven by Node.js async I/O model)

### AC2: Stall detection uses heartbeat
- `isStalled()` in `crew/utils/stall.ts` used by both `runSpawn` and `pollForCollaboratorMessage`
- Active heartbeat → stall never fires regardless of log activity
- `type: 'heartbeat+log'` when both signals stale; `type: 'log-only'` when in fallback mode

### AC3: Orphan cleanup
- CLI stall path: SIGTERM → 5s → SIGKILL; deleteCollabState; unlink FIFO; unlink heartbeat (R2a)
- CLI timeout path: same (R2b)
- CLI crash path: unlink heartbeat (R2c) — currently missing
- Extension crash path: unlink heartbeat (R2e) — currently missing
- Extension stall path: defer-to-agent, no auto-kill (R2d) — preserved intentionally

### AC4: D5 suppression
- When heartbeat is fresh, D5 absolute timeout is suppressed
- New ceilings: spawn=3600s, send=`max(pollTimeoutMs*3, 900s)`
- Hard ceiling fires regardless of heartbeat (safety net for pathological cases)

### AC5: Tests
- Active heartbeat + static log → NOT stalled (the key false-positive case)
- Stale heartbeat + stale log → stalled
- No heartbeat file (within grace) → not stalled
- No heartbeat file (after grace) → log-only fallback active
- On stall: process killed + state cleaned (CLI paths)
- On stall: error returned, process NOT killed (extension path)

### AC6: Backward compatibility
- Collaborator on old extension (no heartbeat) → R7 log-only fallback
- Stall threshold configurable as before

---

## Fit Check

| Req | Requirement | Status | A |
|-----|-------------|--------|---|
| R0 | Never stalled while heartbeat current | Core goal | ✅ |
| R1 | Dual-signal stall condition | Must-have | ✅ |
| R2 | All state cleaned on stall/crash | Must-have | ✅ |
| R2a | runSpawn stall cleanup | Must-have | ✅ |
| R2b | runSpawn timeout cleanup | Must-have | ✅ |
| R2c | runSpawn crash adds heartbeat unlink | Must-have | ✅ |
| R2d | Extension poll preserves defer-to-agent | Must-have | ✅ |
| R2e | Extension spawn crash adds heartbeat unlink | Must-have | ✅ |
| R3 | Heartbeat fires during API gaps | Must-have | ✅ |
| R4 | Interval formula correct | Must-have | ✅ |
| R5 | Both paths use isStalled() | Must-have | ✅ |
| R5.1 | runSpawn: isStalled + ceiling | Must-have | ✅ |
| R5.2 | pollForCollaboratorMessage: per-context ceilings | Must-have | ✅ |
| R6 | Grace period | Must-have | ✅ |
| R7 | Log-only fallback | Must-have | ✅ |
| R8 | Shared isStalled() | Must-have | ✅ |

---

## Scope

**In scope:**
- New `setInterval` heartbeat writer in `index.ts` (collaborator mode only)
- New `crew/utils/stall.ts` shared helper
- `cli/index.ts runSpawn` poll loop replacement
- `crew/handlers/collab.ts pollForCollaboratorMessage` poll replacement
- Orphan cleanup additions to all four paths (stall, timeout, crash × CLI/extension)
- D5 suppression when heartbeat active; new hard ceilings
- Tests: AC4/AC5 above

**Out of scope:**
- Crew worker spawn (different system, different lifecycle)
- Non-pi runtime adapters
- The FIFO-based process lifecycle itself
- UI/overlay changes
- `POLL_TIMEOUT_MS` (30s mesh-join timeout) — different concern
- Shape A FIFO keepalive for CLI multi-turn (that's spec 055 Shape A, bead `.agent-config-23q`)
