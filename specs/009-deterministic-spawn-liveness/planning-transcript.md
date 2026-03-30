---
planning: true
---

<!-- plan:complete:v1 | harness: pi/claude-sonnet-4-6 | date: 2026-03-30 -->

# 009 — Planning Transcript

**Date:** 2026-03-30  
**Driver:** LoudViper (claude-sonnet-4-6)  
**Collaborators:** TrueCastle (crew-challenger, R1 — stalled at 300s D5 proving the bug); HappyFalcon (crew-challenger, R2 — verified edge case and approved)

---

## Driver Pre-Planning Research

Before spawning collaborators, driver read:
- `cli/index.ts` lines 983–1237 (full `runSpawn`, stall/timeout/crash paths)
- `crew/handlers/collab.ts` lines 1–300 (`pollForCollaboratorMessage`), 304–580 (`executeSpawn`), 581–717 (`gracefulDismiss`, `shutdownCollaborators`, helpers)
- `crew/registry.ts` (full — `CollaboratorEntry` interface)
- `index.ts` lines 225–315 (`updateStatus`, `statusHeartbeatTimer`), 760–800 (`session_start`), 1025–1044 (`onDeactivate`)
- `handlers.ts` lines 390–450 (send path call to `pollForCollaboratorMessage`)
- `tests/crew/collab-blocking.test.ts` (existing stall test structure)

### Key findings before collaboration

1. `statusHeartbeatTimer` (index.ts:303) is a no-op for collaborators — `updateStatus()` returns immediately at line 231 (`!ctx.hasUI || !state.registered`). Confirmed.
2. `cli/index.ts` stall/timeout paths do NOT kill the process or clean up state — just `fs.closeSync(fifoWriteFd)`. Orphan bug confirmed.
3. `gracefulDismiss` called from 5 sites with no `dirs` parameter.
4. CLI already imports from `crew/utils/` — shared helper is accessible.
5. `dirs` is a parameter of `runSpawn` — `dirs.registry` available for heartbeat path.

**Initial gap (not yet identified):** `handlers.ts:406` send path — missed in initial research.

---

## Round 1 — TrueCastle (R1)

### Driver research summary sent to TrueCastle

File map, confirmed bugs with exact lines, proposed `isStalled()` interface, heartbeat path convention (initial proposal: no CollaboratorEntry field), proposed task list (T1–T6).

### TrueCastle's 5 challenges

**Challenge 1 (critical, verified by code read):** `handlers.ts:406` is a second independent call site for `pollForCollaboratorMessage`. Driver's file map omitted it. Send-path crash handler (handlers.ts:426) deliberately does NOT call `gracefulDismiss`.

**Challenge 2 (design, verified by code read):** `gracefulDismiss` signature is `(entry: CollaboratorEntry)` with no `dirs`. Called from 5 sites. Convention-based path derivation inside `gracefulDismiss` is fragile. `heartbeatFile?: string` on `CollaboratorEntry` is the right approach — spec R5.2 requires it.

**Challenge 3 (correctness):** D5 suppression cannot be implicit inside `isStalled()`. D5 is a structurally separate check. Three-tier explicit structure needed:
- Tier 1: `isStalled()` liveness
- Tier 2/3: `ceiling = heartbeatActive ? hardCeiling : resolvedPollTimeoutMs`

**Challenge 4 (code quality):** Switch from size to mtime for log is fine. Keep `isStalled()` pure (mtime-based). Let caller keep size tracking for progress reporting. Clean separation.

**Challenge 5 (correctness):** T1/T2/T3 are independent (no deps between them). T4 depends on T1+T3. T5 depends on T1.

### Driver acceptance of all 5 challenges

All accepted. Key additions:
- `handlers.ts` added to scope (T4d)
- `heartbeatFile?: string` committed to `CollaboratorEntry`
- Three-tier ceiling formulated explicitly
- Progress reporting remains size-based, stall decision moves to mtime

**TrueCastle stalled at 300s during review of driver's revision.** Irony noted — this is exactly the D5 timeout the spec fixes. Dismissed per recovery protocol.

---

## Round 2 — HappyFalcon (R2)

### Respawn context provided

Full accumulated context from TrueCastle R1: 5 challenges, 5 acceptances, revised file scope table.

### HappyFalcon's verification and approval

**Concrete verification (R4 formula):** Driver had identified a potential edge case: if `stallThresholdMs = 600s`, `gracePeriodMs` might exceed D5 timeout (300s), allowing D5 to fire during grace.

HappyFalcon verified: the edge case is **prevented by R4's `min(10000, ...)` cap**:
```
stallThresholdMs = 600,000ms → 600,000/8 = 75,000 → min(10000, 75000) = 10,000ms
heartbeatIntervalMs = 10s → gracePeriodMs = 20s
```
Grace (≤ 20s) is always much less than D5 (≥ 300s). The edge case cannot occur.

**Three-tier table verified:**

| stallResult.type | heartbeatActive | ceiling used | Correct? |
|---|---|---|---|
| `'not-stalled'` | true | hardCeilingMs | ✅ D5 suppressed |
| `'within-grace'` | false | resolvedPollTimeoutMs | ✅ Conservative; D5 never fires (grace << D5) |
| `'heartbeat+log'` | N/A | N/A — tier 1 resolves | ✅ Both signals confirm stall |
| `'log-only'` | N/A | N/A — tier 1 resolves | ✅ Fallback mode |

**Quality suggestion (accepted):** Add `heartbeatActive: boolean` to `StallResult` so callers use `stallResult.heartbeatActive` for ceiling logic instead of string-comparing `stallResult.type`. More robust to future type additions.

**HappyFalcon verdict:** Approved.

---

## Outcomes

### Key decisions

1. `isStalled()` returns `heartbeatActive: boolean` (not just `type`)
2. Three-tier ceiling logic explicit in all poll loops (never hidden inside isStalled)
3. `heartbeatFile?` on `CollaboratorEntry` AND `PollOptions`
4. `handlers.ts:406` send path in scope (T4d)
5. mtime for stall detection, size for progress display — separated
6. gracePeriodMs ≤ 20s always (R4 cap confirmed via HappyFalcon)
7. Extension stall path (R2d): preserve defer-to-agent, no auto-kill

### Files confirmed in scope

- `crew/utils/stall.ts` (NEW)
- `index.ts`
- `crew/registry.ts`
- `crew/handlers/collab.ts`
- `handlers.ts` (added by TrueCastle challenge 1)
- `cli/index.ts`
- `tests/crew/stall.test.ts` (NEW)
- `tests/crew/collab-blocking.test.ts`
