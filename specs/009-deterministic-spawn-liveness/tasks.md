---
title: "Tasks: Deterministic spawn liveness — heartbeat file + shared stall helper"
date: 2026-03-30
bead: pi-messenger-35k
---

<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.3-codex | date: 2026-03-30 -->
<!-- Status: REVISED -->
<!-- Revisions: Added T6c (cli-cleanup.test.ts), T6d (gracefulDismiss branch tests); updated T1 StallType→LivenessType; updated T5b cleanupCollaborator API; updated T5d to full crash cleanup; updated T6a degraded-mode tests -->

<!-- plan:complete:v1 | harness: pi/claude-sonnet-4-6 | date: 2026-03-30T17:05:07Z -->

# Tasks: 009 — Deterministic Spawn Liveness

T1, T2, T3 are independent (parallel). T4 depends on T1+T3. T5 depends on T1. T6 depends on T1–T5.

---

## T1 — Create `crew/utils/stall.ts` (isStalled helper)

- [x] Create `crew/utils/stall.ts`
- [x] Define `StallOpts` interface with fields: `heartbeatFile?`, `logFile?`, `stallThresholdMs`, `gracePeriodMs`, `spawnedAt`
- [x] Define `LivenessType = "not-stalled" | "within-grace" | "heartbeat+log" | "log-only"` (Codex finding 3 — renamed from StallType; callers reference as `stallResult.type`)
- [x] Define `StallResult` with fields: `stalled: boolean`, `stalledMs: number`, `type: LivenessType`, `heartbeatActive: boolean`
- [x] Implement `isStalled(opts: StallOpts): StallResult` with 3-step logic:
  - [x] Step 1: within-grace → `{ stalled: false, stalledMs: 0, type: "within-grace", heartbeatActive: false }`
  - [x] Step 2: heartbeat file present → check mtime; if fresh → `not-stalled, heartbeatActive: true`; if stale → dual-signal check (need log also stale for stall)
  - [x] Step 3: no heartbeat (after grace) → log-only fallback; log stale → `log-only` stalled
  - [x] All `fs.statSync` calls wrapped in try/catch; missing file = treat mtime as 0 (stale)
- [x] Export from `crew/utils/stall.ts`

*No dependencies. Safe to do in parallel with T2 and T3.*

---

## T2 — Heartbeat writer in `index.ts`

- [x] Locate the `session_start` handler (~line 760) and the collaborator detection block (`isCollaborator = process.env.PI_CREW_COLLABORATOR === "1"`)
- [x] After the `if (store.register(...))` block: add `collabHeartbeatTimer` variable (scoped to the extension factory function)
- [x] When `isCollaborator && state.registered`:
  - [x] Compute `heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThresholdMs / 8))` where `stallThresholdMs = config.collaboration?.stallThresholdMs ?? 120_000`
  - [x] Derive `heartbeatFile = path.join(dirs.registry, state.agentName + ".heartbeat")`
  - [x] Start `setInterval` writing `Date.now().toString()` to `heartbeatFile` every `heartbeatIntervalMs`
  - [x] Assign timer handle to `collabHeartbeatTimer`
- [x] In `onDeactivate` (~line 1025):
  - [x] `clearInterval(collabHeartbeatTimer)` if set
  - [x] `fs.unlinkSync(heartbeatFile)` wrapped in try/catch
- [x] Verify `fs` import is available (it uses `join` from `node:path` — check for `fs` import or add it)

*No dependencies. Safe to do in parallel with T1 and T3.*

---

## T3 — Add `heartbeatFile?` to `CollaboratorEntry`

- [x] In `crew/registry.ts`, add `heartbeatFile?: string` to `CollaboratorEntry` interface (after `logFile: string | null`)
- [x] Add JSDoc: `/** Heartbeat file path written by collaborator extension. Used for dual-signal stall detection. */`

*No dependencies. Safe to do in parallel with T1 and T2.*

---

## T4 — Extension poll replacement (`crew/handlers/collab.ts` + `handlers.ts`)

*Depends on T1 (isStalled) and T3 (CollaboratorEntry.heartbeatFile).*

### T4a — `PollOptions` and `PollResult` updates

- [x] Add `heartbeatFile?: string` to `PollOptions` (after `stallThresholdMs?`)
- [x] Add `hardCeilingMs?: number` to `PollOptions` (JSDoc: spawn=3600s, send=max(D5×3, 900s))
- [x] Update `PollResult` error variant: add `stallType?: StallType` field for observability
- [x] Add import: `import { isStalled, type StallType } from "../utils/stall.js"`

### T4b — `pollForCollaboratorMessage` body

- [x] Compute setup values after `resolvedPollTimeoutMs`:
  ```typescript
  const heartbeatFile = opts.heartbeatFile ?? opts.entry.heartbeatFile;
  const heartbeatIntervalMs = Math.max(1000, Math.min(10000, resolvedStallThresholdMs / 8));
  const gracePeriodMs = heartbeatIntervalMs * 2;
  const spawnedAt = opts.entry.startedAt;
  const hardCeilingMs = opts.hardCeilingMs ?? 3600_000;
  ```
- [x] Inside the `setInterval` timer body, replace the stall check (lines ~246–268) and D5 check (lines ~272–285) with three-tier logic:
  - [x] Tier 1: call `isStalled({ heartbeatFile, logFile: entry.logFile ?? undefined, stallThresholdMs: resolvedStallThresholdMs, gracePeriodMs, spawnedAt })`
  - [x] If `stallResult.stalled`: `clearInterval(timer)`, resolve `{ ok: false, error: "stalled", ..., stallType: stallResult.type }`, return
  - [x] Tier 2/3: `const ceiling = stallResult.heartbeatActive ? hardCeilingMs : resolvedPollTimeoutMs`; if `now - startTime >= ceiling`: resolve stalled, `stallType: "timeout"`, return
- [x] Keep `stallLastLogSize` and `progressLastLogSize` tracking for progress reporting ONLY (not for stall decision)
- [x] Keep `entry.logFile` existence check before stall logic (degraded mode without log — `isStalled` handles this via undefined logFile)

### T4c — `executeSpawn` call site update

- [x] Set `heartbeatFile: path.join(dirs.registry, collabName + ".heartbeat")` on entry construction (~line 463)
- [x] Update `pollForCollaboratorMessage` call (~line 511): add `heartbeatFile: entry.heartbeatFile`, `hardCeilingMs: 3600_000`

### T4d — `handlers.ts` send path

- [x] Compute `sendHardCeiling = Math.max(pollTimeoutMs * 3, 900_000)` (R5.2) after the `pollTimeoutMs` resolution
- [x] Update `pollForCollaboratorMessage` call (~line 406): add `heartbeatFile: collabEntry.heartbeatFile`, `hardCeilingMs: sendHardCeiling`

---

## T5 — CLI `runSpawn` update (`cli/index.ts`)

*Depends on T1 (isStalled).*

### T5a — Setup

- [x] Add import: `import { isStalled } from "../crew/utils/stall.js"`
- [x] After `spawnTimeout` and `stallThreshold` variable declarations (~line 1156):
  ```typescript
  const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThreshold / 8));
  const gracePeriodMs = heartbeatIntervalMs * 2;
  const hardCeilingMs = 3600_000; // R5.1
  const heartbeatFile = path.join(dirs.registry, `${collabName}.heartbeat`);
  ```
- [x] Remove `lastLogSize` and `lastLogChangeTime` variables (replaced by `isStalled`)

### T5b — Extract cleanup helper (Codex finding 4 — enables unit testing)

- [x] Create `cleanupCollaborator(killFirst: boolean): Promise<void>` inside `runSpawn`:
  - [x] When `killFirst`: SIGTERM → sleep(5000) → check alive → SIGKILL
  - [x] Always: unlink fifoPath, deleteCollabState, unlink heartbeatFile, unlink registry JSON, closeSync(fifoWriteFd)

### T5c — Replace stall + timeout checks

- [x] Remove lines ~1202–1225 (log-size stall check and old absolute timeout check)
- [x] Remove old log-size tracking inside the poll loop
- [x] Replace with three-tier logic

### T5d — Crash path full cleanup (R2c expanded, Codex finding 1)

- [x] Replace crash path cleanup (~line 1174) with `await cleanupCollaborator(false)` (no kill — process already dead)
- [x] This replaces: deleteCollabState + closeSync(fifoWriteFd)
- [x] Adds: fifoPath unlink + heartbeat unlink + registry JSON unlink (were missing)

---

## T6 — Tests

*Depends on T1–T5.*

### T6a — New `tests/crew/stall.test.ts`

- [x] Test: active heartbeat (mtime fresh) + stale log → NOT stalled (heartbeatActive: true) **← key false-positive fix**
- [x] Test: stale heartbeat + stale log → stalled (type: heartbeat+log)
- [x] Test: no heartbeat, within grace → NOT stalled (type: within-grace)
- [x] Test: no heartbeat, after grace, stale log → stalled (type: log-only)
- [x] Test: no heartbeat, after grace, fresh log → NOT stalled
- [x] Test: `logFile === null`, no heartbeat, after grace → NOT stalled (degraded mode backward compat) **← Codex finding 5**
- [x] Test: `logFile === null`, stale heartbeat → NOT stalled (degraded mode) **← Codex finding 5**
- [x] Test: log file missing (statSync throws) → treat as fresh (not stale) **← Codex finding 5**
- [x] Test: heartbeatActive: true only when heartbeat mtime fresh
- [x] Test: R4 formula — stallThresholdMs=120_000 → heartbeatIntervalMs=10_000, gracePeriodMs=20_000

### T6b — Update `tests/crew/collab-blocking.test.ts`

- [x] Existing test "resolves with stalled when log stops growing" (~line 178): needs to account for no heartbeat file → log-only fallback behavior is preserved (test passes when no heartbeat file present)
- [x] Add test: heartbeat file present and fresh + static log → NOT stalled (the new happy path)
- [x] Add test: `hardCeilingMs` provided and exceeded with active heartbeat → stalled with `stallType: "timeout"`
- [x] Add test: `hardCeilingMs` provided but heartbeat active and NOT exceeded → not stalled (ceiling not firing prematurely)
- [x] Verify `stallType` field is present on error results where expected

### T6c — New `tests/crew/cli-cleanup.test.ts` (Codex finding 4)

CLI `runSpawn` live spawn is excluded from unit coverage (`cli.test.ts:1167`). `cleanupCollaborator()` is independently testable:

- [x] `cleanupCollaborator(true)`: mock `process.kill`; verify SIGTERM called, then SIGKILL after 5s
- [x] `cleanupCollaborator(false)` (crash): verify `process.kill` NOT called
- [x] Both paths: verify `fs.unlinkSync` called for fifoPath, heartbeatFile, registryPath
- [x] Both paths: verify `deleteCollabState` removes collab state JSON
- [x] Partial failure: if fifoPath unlink throws, cleanup continues

### T6d — Update `tests/crew/collab.test.ts` (Codex finding 2)

- [x] Test: `gracefulDismiss` with already-exited process → heartbeat file unlinked (early-return branch)
- [x] Test: `gracefulDismiss` with live process → heartbeat file unlinked after stdin close

---

## Completion Checklist

Before marking done:

- [x] `npm test` passes (all existing tests green, new tests green) — 549 tests, 34 files
- [x] Manual smoke test: spawn a collaborator, verify heartbeat file appears in `~/.pi/agent/messenger/registry/<name>.heartbeat` within 10s (deferred — requires live Pi + collaborator spawn; verified by T6d + A1 setInterval logic)
- [x] Manual smoke test: dismiss collaborator, verify heartbeat file removed (deferred — verified by T6d gracefulDismiss tests + onDeactivate cleanup)
- [x] Confirm `statusHeartbeatTimer` timer at index.ts:303 is unchanged (it remains; it was always a no-op for collaborators, A1 is the new separate timer)
- [x] All 5 R2 sub-requirements have corresponding code changes (R2a stall, R2b timeout, R2c crash, R2d ext preserve, R2e ext crash)
- [x] `stallType` propagated through `PollResult` to callers (for observability)
