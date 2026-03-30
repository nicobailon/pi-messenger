---
shaping: true
---

<!-- shape:complete:v1 | harness: pi/claude-sonnet-4-6 | date: 2026-03-30T15:12:16Z -->

# 009 — Deterministic Spawn Liveness: Shaping Transcript

**Date:** 2026-03-30  
**Driver:** LoudViper (claude-sonnet-4-6)  
**Collaborators:** GoldRaven (crew-challenger, R1 — stalled at 300s D5 before reviewing revisions), NiceKnight (crew-challenger, R2 — approved after 6 challenges)  
**Note:** GoldRaven stalled at 300s, proving the bug is still manifesting. Session continued with NiceKnight who completed the review.

---

## Source

> "I have done a few new sessions. it definitely doesn't feel solved. how can we better solve this and test its success?"
>
> The spec 055 Shape B fix (spawn-per-turn protocol documentation) is a workaround. The root problem — collaborator killed during API processing gap because log-growth stall detector fires — is not fixed. Spec 009 in `~/dev/pi-messenger` (deterministic spawn liveness) has a thorough spec and R0-R8 but was never planned or implemented.

---

## Problem

The spawn liveness detector uses log-file-growth as its signal: if the collaborator's log file hasn't grown in `stallThresholdMs` (default 120s), it declares "stalled." This is a heuristic that produces false positives during normal operation.

When an opus-class model processes a large context (50K+ tokens), the Anthropic API consumes all input, runs the thinking phase, and only then begins streaming output. During that gap — 3–5+ minutes — the Pi process is alive, the HTTP connection is active, the Node.js event loop is running, but **zero bytes are written to the log file**. The stall detector fires.

**Two affected code paths (independent implementations of the same broken logic):**
1. `crew/handlers/collab.ts:pollForCollaboratorMessage` — Pi-to-Pi extension path
2. `cli/index.ts:runSpawn` poll loop — CLI-to-Pi path

---

## Key Research Findings (from driver pre-shaping investigation)

- `statusHeartbeatTimer` in `index.ts:303`: fires every 15s but `updateStatus()` immediately returns at `index.ts:231` (`if (!ctx.hasUI || !state.registered) return;`). Collaborators are headless. This timer is a **no-op** for collaborators. A **new** `setInterval` is needed.
- `scheduleRegistryFlush` in `index.ts:626`: only triggers on `tool_call`/`tool_result` hooks. Does not fire during API processing gaps.
- `PI_CREW_COLLABORATOR === "1"` is already set in the env of spawned Pi collaborator processes.
- D5 absolute timeout: 300s for send context, 900s for spawn context. Added in spec 006 to catch "log-drip stalls" — idle process dripping bytes to fool log-growth detection.
- Lobby workers use `aliveFile` (existence-based) for presence. This is a separate system from collaborator spawn; it tracks crew workers, not collaborators.
- Both poll path stall handlers currently exit without killing the collaborator process (orphan bug, confirmed by spec 009's "Observed failure" section: PIDs 48921 and 83110 left running).

---

## Shapes Considered

### Shape B (Periodic registry flush) — ELIMINATED
Rejected: (1) `flushActivityToRegistry` serializes full `AgentRegistration` JSON — too heavy for 10s writes. (2) `lastActivityAt` would change semantics from "last tool call" to "process alive" — corrupts existing reads. (3) No file locking between CLI reads and extension writes.

### Shape C (OS process inspection via lsof) — ELIMINATED
Rejected: (1) `lsof -p PID -i TCP:443` shows keep-alive connections, not active API calls. (2) Provider diversity — multiple API endpoints. (3) macOS-specific behavior; not available in sandboxed environments.

### Shape A: Extension heartbeat file + shared stall helper — **SELECTED**

---

## Requirements (Final — negotiated through two challengers)

**Chunked to ≤9 top-level:**

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Collaborator never declared stalled while its heartbeat file has been updated within stallThresholdMs | Core goal |
| R1 | Stall condition requires BOTH heartbeat AND log to be stale for ≥ stallThresholdMs; active heartbeat alone prevents stall regardless of log activity | Must-have |
| R2 | On stall or crash, all collaborator state cleaned up — heartbeat file, collab state JSON, FIFO, registry entry | Must-have |
| R2a | CLI `runSpawn` stall path: SIGTERM PID (before FIFO close), 5s grace, SIGKILL; then deleteCollabState, unlink FIFO, unlink heartbeat file | Must-have |
| R2b | CLI `runSpawn` absolute timeout path: same cleanup as R2a | Must-have |
| R2c | CLI `runSpawn` crash path: add heartbeat file unlink (currently missing from `cli/index.ts:1173-1178`) | Must-have |
| R2d | Extension `pollForCollaboratorMessage` stall path: returns `{ error: "stalled" }` WITHOUT killing process — preserves existing defer-to-agent behavior; `gracefulDismiss` handles cleanup including heartbeat | Must-have |
| R2e | Extension `executeSpawn` crash path (`collab.ts:530-535`): add heartbeat file unlink | Must-have |
| R3 | Heartbeat mechanism uses `setInterval` on Node.js event loop — fires during API processing gaps. Writes to `<messengerDir>/registry/<name>.heartbeat` | Must-have |
| R4 | Heartbeat interval formula: `heartbeatIntervalMs = max(1000, min(10000, stallThresholdMs/8))`. Default stallThresholdMs=120s → 10s interval → 12 missed beats minimum. Minimum 8 missed beats for stallThresholdMs ≥ 8000ms | Must-have |
| R5 | Both poll paths updated to use shared `isStalled()` helper; D5 absolute timeout suppressed when heartbeat is fresh | Must-have |
| R5.1 | CLI `runSpawn`: use isStalled(); suppress D5 when heartbeat fresh; spawn hard ceiling 3600s (configurable) | Must-have |
| R5.2 | Extension `pollForCollaboratorMessage`: add `heartbeatFile?` to PollOptions/CollaboratorEntry; use isStalled(); suppress D5 when heartbeat fresh; spawn ceiling = 3600s (same as R5.1); send ceiling = `max(resolvedPollTimeoutMs * 3, 900s)` | Must-have |
| R6 | Grace period at spawn start = `heartbeatIntervalMs * 2`; missing heartbeat during grace = R7 fallback, not stall. No new config surface. | Must-have |
| R7 | If heartbeat missing after grace period, fall back to log-only stall detection. Backward compatible with collaborators on older extension versions. | Must-have |
| R8 | Shared `isStalled()` helper in `crew/utils/stall.ts` — used by both R5.1 and R5.2 to prevent independent implementations from drifting. Stall threshold remains configurable via `crew.collaboration.stallThresholdMs` | Must-have |

---

## Selected Shape: A — Extension heartbeat file + shared stall helper

| Part | Mechanism |
|------|-----------|
| A1 | **Extension heartbeat writer**: new `setInterval(heartbeatIntervalMs)` in `index.ts` when `PI_CREW_COLLABORATOR === "1"`; writes `Date.now().toString()` to `dirs.registry/<name>.heartbeat`; cleanup in `onDeactivate`. `heartbeatIntervalMs` computed per R4. Note: `statusHeartbeatTimer` (existing, 15s) is a no-op for collaborators — this is a NEW timer. |
| A2 | **Shared `isStalled()` helper** (`crew/utils/stall.ts`): `isStalled(opts: { heartbeatFile?: string; logFile?: string; stallThresholdMs: number; gracePeriodMs: number; spawnedAt: number })` → `{ stalled: boolean; stalledMs: number; type: 'not-stalled' | 'within-grace' | 'heartbeat+log' | 'log-only' }`. Within grace → not stalled. Heartbeat exists + mtime within threshold → not stalled. Heartbeat missing after grace → log-only mode. Stall = log also stale for ≥ stallThresholdMs. |
| A3 | **CLI `runSpawn` update**: replace log-size check with `isStalled()`; suppress D5 when heartbeat fresh; hard ceiling 3600s; on stall/timeout: SIGTERM PID → 5s → SIGKILL → deleteCollabState → unlink FIFO → unlink heartbeat; on crash: add heartbeat unlink (R2c) |
| A4 | **Extension `pollForCollaboratorMessage` update**: add `heartbeatFile?: string` to PollOptions and CollaboratorEntry (`crew/handlers/collab.ts`); replace log-size stall check with `isStalled()`; suppress D5 when heartbeat fresh; spawn ceiling 3600s, send ceiling `max(pollTimeoutMs*3, 900s)`; stall path: RETURN error without kill (R2d); extension spawn crash path: add heartbeat unlink (R2e) |
| A5 | **Extension cleanup**: `onDeactivate` unlinks `dirs.registry/<name>.heartbeat`. Convention-based path — no CollabState field required (both sides derive `path.join(dirs.registry, name + '.heartbeat')`). `gracefulDismiss` also unlinks. |

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
| R5.2 | pollForCollaboratorMessage: isStalled + per-context ceilings | Must-have | ✅ |
| R6 | Grace period | Must-have | ✅ |
| R7 | Log-only fallback | Must-have | ✅ |
| R8 | Shared isStalled() | Must-have | ✅ |

Shape A passes all requirements.

---

## Challenger Findings (summary)

**GoldRaven (R1)** — 10 concrete challenges, all verified and accepted:
1. `updateStatus()` no-op for headless collaborators (confirmed at `index.ts:231`)
2. Two distinct orphan bugs in runSpawn stall and timeout paths
3. R4 `max(10000, ...)` formula gives SLOWER beats — needs `min()` not `max()` for interval
4. R9: SIGTERM before FIFO close (FIFO close is not a reliable kill signal)
5. R10: crash check must precede heartbeat check
6. R11: grace period at startup for missing heartbeat
7. R12: shared isStalled() helper to prevent drift
8. Shape B eliminated (semantics corruption)
9. Shape C eliminated (lsof shows keep-alive connections)
10. D5 suppression needed when heartbeat is fresh

**NiceKnight (R2)** — 6 concrete challenges after GoldRaven stalled:
1. R4 formula direction was wrong: `max(10000, stallThresholdMs/8)` should be `max(1000, min(10000, stallThresholdMs/8))`
2. 3600s ceiling context-blind — send path needs separate ceiling
3. Heartbeat file path: extension uses `dirs.registry`, not `getCollabStateDir()` — use registry dir
4. `gracePeriodMs` undefined config value — simplify to `heartbeatIntervalMs * 2`
5. Crash paths don't clean heartbeat file — stale heartbeat persists
6. Extension stall path deliberately defers to agent (existing behavior) — CLI auto-kills, extension does not

---

## Session Notes

Both shaping collaborators (GoldRaven, NiceKnight) operated within the very problem being fixed. GoldRaven stalled at exactly 300s — the D5 absolute timeout firing while reviewing the driver's revisions. NiceKnight completed the session successfully. The bug manifested during the shaping session for the spec that fixes it.
