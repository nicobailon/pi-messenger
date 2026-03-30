---
title: "Plan: Deterministic spawn liveness — heartbeat file + shared stall helper"
date: 2026-03-30
bead: pi-messenger-35k
---

<!-- plan:complete:v1 | harness: pi/claude-sonnet-4-6 | date: 2026-03-30T17:05:07Z -->
<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.3-codex | date: 2026-03-30 -->
<!-- Status: REVISED -->
<!-- Revisions: (1) CLI crash path R2c expanded to include FIFO+registry unlink; (2) gracefulDismiss heartbeat unlink added to early-return branch; (3) StallType split into LivenessType+PollStallType; (4) cli-cleanup.test.ts added; (5) logFile=null degraded mode preserved as not-stalled -->

# Plan: 009 — Deterministic Spawn Liveness

## Background

This plan was built with two crew-challenger agents (TrueCastle stalled at 300s proving the
bug mid-session; HappyFalcon completed the review). See `planning-transcript.md`.

The spec defined Shape A: Extension heartbeat file + shared `isStalled()` helper, with 5
named parts (A1–A5). This plan maps those parts to concrete code changes with exact
insertion points, interfaces, and task dependencies.

---

## Architecture Decisions

### AD1 — `isStalled()` uses mtime, returns `heartbeatActive`

`isStalled()` reads `fs.statSync(file).mtimeMs` for both heartbeat and log files. Size-based
tracking kept only for progress reporting. `StallResult` includes `heartbeatActive: boolean`:

```typescript
const ceiling = stallResult.heartbeatActive ? hardCeilingMs : resolvedPollTimeoutMs;
```

**Degraded mode (logFile is null):** When `logFile` is null/undefined and no heartbeat exists
(or heartbeat is stale), `isStalled()` returns `stalled: false`. Preserves backward
compatibility — current code skips stall detection when no log file present. Ceiling handles
max wait. **(Codex finding 5 — previous plan would have caused false stalls in degraded mode.)**

### AD2 — Three-tier timeout structure (per poll loop)

The three checks are sequenced in every poll loop:

```typescript
// Tier 1 — liveness: isStalled() replaces old log-size stall + log-drip grace
const stallResult = isStalled({ heartbeatFile, logFile, stallThresholdMs, gracePeriodMs, spawnedAt });
if (stallResult.stalled) { resolve({ ok: false, error: "stalled", stallType: stallResult.type }); return; }

// Tier 2/3 — ceiling: heartbeat freshness selects which ceiling applies
const ceiling = stallResult.heartbeatActive ? hardCeilingMs : resolvedPollTimeoutMs;
if (now - startTime >= ceiling) { resolve({ ok: false, error: "stalled", stallType: "timeout" }); return; }
```

- **`hardCeilingMs`**: spawn = 3600s; send = `max(resolvedPollTimeoutMs * 3, 900_000)`
- **When heartbeat is active**: only hard ceiling applies (D5 suppressed)
- **When no heartbeat**: old D5 threshold applies (backward compat for old extension versions)
- **isStalled() is pure**: no ceiling logic inside it

*Verified during planning*: the `within-grace` case maps to `heartbeatActive: false`, using the
old D5 ceiling. This is correct — during grace we haven't confirmed heartbeat support. And
`gracePeriodMs ≤ 20s` always (R4's `min(10000, ...)` cap ensures this), so D5 (≥300s) cannot
fire during grace.

### AD3 — Separate `LivenessType` and `PollStallType` (Codex finding 3)

`StallType` was used for both `isStalled()` returns and `PollResult.stallType`, but `"timeout"`
is emitted by the poll loop ceiling hit, not by `isStalled()`. Split into:

```typescript
// crew/utils/stall.ts — what isStalled() returns
export type LivenessType = "not-stalled" | "within-grace" | "heartbeat+log" | "log-only";

// crew/handlers/collab.ts — what PollResult.stallType contains
export type PollStallType = LivenessType | "timeout";
```

Note: `StallResult.type` is `LivenessType`. Callers reference it as `stallResult.type` — the
`stallResult.livenessType` name appearing in one AD2 snippet is a typo; use `stallResult.type`.

### AD3b — `heartbeatFile?` on both `CollaboratorEntry` and `PollOptions`

`gracefulDismiss(entry: CollaboratorEntry)` is called from 5 sites with no `dirs` parameter.
`heartbeatFile?: string` stored on `CollaboratorEntry` at spawn time, read in `gracefulDismiss`.
Mirrored on `PollOptions` for test convenience.

### AD4 — `gracefulDismiss` heartbeat unlink in BOTH branches (Codex finding 2)

`gracefulDismiss` early-returns when process already exited (`collab.ts:625`). Heartbeat unlink
at end-of-function never runs on crash path. Fix: add unlink to BOTH branches:

```typescript
const unlinkHeartbeat = () => {
  if (entry.heartbeatFile) { try { fs.unlinkSync(entry.heartbeatFile); } catch {} }
};
if (entry.proc.exitCode !== null) {
  unregisterWorker(entry.cwd, entry.taskId);
  cleanupTmpDir(entry.promptTmpDir);
  unlinkHeartbeat();   // ← ADDED to early-return branch
  return;
}
// ... SIGTERM/SIGKILL ...
unregisterWorker(entry.cwd, entry.taskId);
cleanupTmpDir(entry.promptTmpDir);
unlinkHeartbeat();     // ← normal path
```

### AD5 — CLI crash path full cleanup (Codex finding 1)

Spec R2 requires "all collaborator state cleaned up — heartbeat file, collab state JSON, FIFO,
registry entry." Original plan left CLI crash FIFO + registry as "pre-existing bug, out of scope."
This contradicts R2. **Fix:** `cleanupCollaborator(killFirst: boolean)` helper handles all cleanup
uniformly. Crash path calls `cleanupCollaborator(false)` (no kill — process already dead).

### AD6 — `handlers.ts` send path is in scope

`pollForCollaboratorMessage` is called from two independent sites:
- `crew/handlers/collab.ts:511` — spawn path
- `handlers.ts:406` — send path (independently reads stallThresholdMs/pollTimeoutMs)

Both must receive `heartbeatFile`, apply the appropriate hard ceiling, and use `isStalled()`.
The send-path crash handler (handlers.ts:426) deliberately does NOT call `gracefulDismiss`
(existing behavior preserved). Heartbeat file orphan on OOM/SIGKILL in the send path is
accepted operational debt — same as the existing registry JSON orphan; out of scope here.

### AD5 — heartbeat file path convention

Both writer (extension, `index.ts`) and readers (`isStalled()`) derive:
```
path.join(PI_MESSENGER_DIR || homedir()/.pi/agent/messenger, "registry", name + ".heartbeat")
```

The extension writes to `dirs.registry` (same base path). `gracefulDismiss` reads from
`entry.heartbeatFile` (set at spawn). CLI reads `dirs.registry` (passed into `runSpawn`).
No new config surface.

---

## File Map

| File | Role |
|------|------|
| `crew/utils/stall.ts` (NEW) | `isStalled()` helper — pure, synchronous, exports `LivenessType` |
| `index.ts` | Heartbeat `setInterval` (collaborator mode) + `onDeactivate` cleanup |
| `crew/registry.ts` | `heartbeatFile?: string` on `CollaboratorEntry` |
| `crew/handlers/collab.ts` | `PollOptions.heartbeatFile?`, `PollStallType`, entry construction, poll logic, `gracefulDismiss` unlink in BOTH branches |
| `handlers.ts` | Send path: `heartbeatFile` from entry, hard send ceiling, three-tier timeout |
| `cli/index.ts` | `runSpawn`: `isStalled`, `cleanupCollaborator()`, full cleanup on stall/timeout/crash |
| `tests/crew/stall.test.ts` (NEW) | Unit tests for `isStalled()` including degraded-mode cases |
| `tests/crew/collab-blocking.test.ts` | Update stall tests for heartbeat-aware behavior |
| `tests/crew/cli-cleanup.test.ts` (NEW) | Unit tests for `cleanupCollaborator()` helper (Codex finding 4) |

---

## Part A1 — Heartbeat writer in `index.ts`

**Insertion point:** `session_start` handler, after the `if (store.register(...))` block
that handles `isCollaborator`. Currently at `index.ts:778-800`.

**New code:**
```typescript
const isCollaborator = process.env.PI_CREW_COLLABORATOR === "1";
// ... existing register block ...

// A1: Heartbeat writer for collaborator mode
// statusHeartbeatTimer (line 303) is a no-op for headless collaborators
// because updateStatus() returns immediately when !ctx.hasUI. A new timer
// is required to keep the heartbeat file fresh during API processing gaps.
let collabHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
if (isCollaborator && state.registered) {
  const stallThresholdMs = config.collaboration?.stallThresholdMs ?? 120_000;
  const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThresholdMs / 8));
  const heartbeatFile = path.join(dirs.registry, `${state.agentName}.heartbeat`);
  collabHeartbeatTimer = setInterval(() => {
    try { fs.writeFileSync(heartbeatFile, Date.now().toString()); } catch {}
  }, heartbeatIntervalMs);
}
```

**Cleanup in `onDeactivate`** (`index.ts:1025-1044`):
```typescript
if (collabHeartbeatTimer) {
  clearInterval(collabHeartbeatTimer);
  collabHeartbeatTimer = null;
  // Unlink heartbeat file so stale files don't fool the next poll
  try { fs.unlinkSync(path.join(dirs.registry, `${state.agentName}.heartbeat`)); } catch {}
}
```

---

## Part A2 — Shared `isStalled()` helper

**New file:** `crew/utils/stall.ts`

**Full interface:**
```typescript
import * as fs from "node:fs";

export interface StallOpts {
  heartbeatFile?: string;    // path to <name>.heartbeat; undefined → log-only fallback
  logFile?: string | null;   // path to collab.log; null/undefined → degraded mode
  stallThresholdMs: number;
  gracePeriodMs: number;     // = heartbeatIntervalMs * 2 (never exceeds 20s via R4 cap)
  spawnedAt: number;         // Date.now() at spawn time (ms)
}

export type LivenessType = "not-stalled" | "within-grace" | "heartbeat+log" | "log-only";

export interface StallResult {
  stalled: boolean;
  stalledMs: number;
  type: LivenessType;
  heartbeatActive: boolean;  // used for ceiling logic by callers
}

export function isStalled(opts: StallOpts): StallResult
```

**Logic (revised for Codex finding 5 — null logFile backward compat):**
```
now = Date.now()
elapsed = now - spawnedAt

1. Within grace period: elapsed < gracePeriodMs
   → { stalled: false, stalledMs: 0, type: "within-grace", heartbeatActive: false }

2. Heartbeat file check (if heartbeatFile provided):
   try: heartbeatMtimeMs = statSync(heartbeatFile).mtimeMs
   catch: heartbeatMtimeMs = 0 (missing = treat as stale)

   if now - heartbeatMtimeMs < stallThresholdMs:
     → { stalled: false, stalledMs: 0, type: "not-stalled", heartbeatActive: true }

   // Heartbeat stale → dual-signal required
   if logFile is null/undefined:
     → { stalled: false, stalledMs: 0, type: "not-stalled", heartbeatActive: false }
     // Degraded mode: cannot determine via log. Ceiling handles max wait.
   logMtimeMs = try statSync(logFile).mtimeMs catch → now (missing = treat as fresh)
   logStaleMs = now - logMtimeMs
   if logStaleMs >= stallThresholdMs:
     → { stalled: true, stalledMs: max(now-heartbeatMtimeMs, logStaleMs), type: "heartbeat+log", heartbeatActive: false }
   → { stalled: false, stalledMs: 0, type: "not-stalled", heartbeatActive: false }

3. No heartbeat (after grace) → log-only fallback (R7):
   if logFile is null/undefined:
     → { stalled: false, stalledMs: 0, type: "not-stalled", heartbeatActive: false }
     // Degraded mode: cannot determine liveness. Ceiling handles max wait.
   logMtimeMs = try statSync(logFile).mtimeMs catch → now (missing = treat as fresh, not stale)
   logStaleMs = now - logMtimeMs
   if logStaleMs >= stallThresholdMs:
     → { stalled: true, stalledMs: logStaleMs, type: "log-only", heartbeatActive: false }
   → { stalled: false, stalledMs: logStaleMs, type: "not-stalled", heartbeatActive: false }
```

**Missing log file:** `statSync` throws → treat mtime as `now` (fresh/unknown), NOT 0 (stale).
Preserves backward compat: degraded mode previously never stalled when log absent.

---

## Part A3 — CLI `runSpawn` update

**File:** `cli/index.ts`, function `runSpawn` (lines 991–1237)

**Replace** `lastLogSize`/`lastLogChangeTime` log-size tracking with `isStalled()`:

```typescript
// Replace:
let lastLogSize = 0;
let lastLogChangeTime = startTime;
// ... try { const stat = fs.statSync(logFile); lastLogSize = stat.size; } ...

// With:
import { isStalled } from "../crew/utils/stall.js";
const stallThreshold = config.collaboration?.stallThresholdMs ?? 120_000;
const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThreshold / 8));
const gracePeriodMs = heartbeatIntervalMs * 2;
const hardCeilingMs = 3600_000; // R5.1
const heartbeatFile = path.join(dirs.registry, `${collabName}.heartbeat`);
```

**Replace stall + timeout checks** (lines 1202–1225) with:
```typescript
// Tier 1: liveness
const stallResult = isStalled({
  heartbeatFile,
  logFile,
  stallThresholdMs: stallThreshold,
  gracePeriodMs,
  spawnedAt: startTime,
});
if (stallResult.stalled) {
  process.stderr.write(`✗ Collaborator "${collabName}" stalled (${Math.round(stallResult.stalledMs / 1000)}s, ${stallResult.type}).\n`);
  // SIGTERM → 5s grace → SIGKILL (R2a)
  try { process.kill(proc.pid, "SIGTERM"); } catch {}
  await sleep(5000);
  try { process.kill(proc.pid, 0); process.kill(proc.pid, "SIGKILL"); } catch {}
  // Full cleanup
  try { fs.unlinkSync(fifoPath); } catch {}
  deleteCollabState(collabName);
  try { fs.unlinkSync(heartbeatFile); } catch {}
  const regPath = path.join(dirs.registry, `${collabName}.json`);
  try { fs.unlinkSync(regPath); } catch {}
  process.exitCode = 1;
  return;
}

// Tier 2/3: ceiling
const ceiling = stallResult.heartbeatActive ? hardCeilingMs : spawnTimeout;
if (now - startTime >= ceiling) {
  process.stderr.write(`✗ Collaborator "${collabName}" timed out (${Math.round((now - startTime) / 1000)}s, ceiling ${Math.round(ceiling/1000)}s).\n`);
  // Same kill + cleanup sequence as stall path
  try { process.kill(proc.pid, "SIGTERM"); } catch {}
  await sleep(5000);
  try { process.kill(proc.pid, 0); process.kill(proc.pid, "SIGKILL"); } catch {}
  try { fs.unlinkSync(fifoPath); } catch {}
  deleteCollabState(collabName);
  try { fs.unlinkSync(heartbeatFile); } catch {}
  const regPath = path.join(dirs.registry, `${collabName}.json`);
  try { fs.unlinkSync(regPath); } catch {}
  process.exitCode = 1;
  return;
}
```

**Add heartbeat unlink to crash path** (R2c, ~line 1174):
```typescript
// Existing crash path already does: deleteCollabState(collabName); fs.closeSync(fifoWriteFd);
// Add after deleteCollabState:
try { fs.unlinkSync(heartbeatFile); } catch {}
```

**Extract `cleanupCollaborator(killFirst: boolean)` helper** (enables unit testing, Codex finding 4):
```typescript
async function cleanupCollaborator(killFirst: boolean): Promise<void> {
  if (killFirst) {
    try { process.kill(proc.pid, "SIGTERM"); } catch {}
    await sleep(5000);
    try { process.kill(proc.pid, 0); process.kill(proc.pid, "SIGKILL"); } catch {}
  }
  // Full cleanup (R2a/R2b stall/timeout, R2c crash — expanded per Codex finding 1)
  try { fs.unlinkSync(fifoPath); } catch {}       // FIFO
  deleteCollabState(collabName);                   // collab state JSON
  try { fs.unlinkSync(heartbeatFile); } catch {}   // heartbeat file (new)
  const regPath = path.join(dirs.registry, `${collabName}.json`);
  try { fs.unlinkSync(regPath); } catch {}          // registry entry
  try { fs.closeSync(fifoWriteFd); } catch {}       // close fd
}
```

Crash path calls `cleanupCollaborator(false)` (no kill — process already dead, R2c expanded).

---

## Part A4 — Extension `pollForCollaboratorMessage` update

**File:** `crew/handlers/collab.ts`

**1. Add to `PollOptions` interface:**
```typescript
/** Heartbeat file for dual-signal stall detection. Falls back to entry.heartbeatFile. */
heartbeatFile?: string;
```

**2. Add to `CollaboratorEntry` interface (`crew/registry.ts`):**
```typescript
/** Heartbeat file path written by the collaborator's extension heartbeat writer. */
heartbeatFile?: string;
```

**3. Set at entry construction in `executeSpawn` (collab.ts ~line 463):**
```typescript
const entry: CollaboratorEntry = {
  type: "collaborator",
  name: collabName,
  cwd,
  proc,
  taskId,
  spawnedBy: process.pid,
  startedAt: Date.now(),
  promptTmpDir,
  logFile,
  heartbeatFile: path.join(dirs.registry, `${collabName}.heartbeat`),   // A4
};
```

**4. Replace stall + D5 checks in `pollForCollaboratorMessage` timer** (lines 246–285):
```typescript
import { isStalled } from "../utils/stall.js";

// At top of pollForCollaboratorMessage, after resolvedPollTimeoutMs:
const heartbeatFile = opts.heartbeatFile ?? opts.entry.heartbeatFile;
const stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThresholdMs / 8));
const gracePeriodMs = heartbeatIntervalMs * 2;
const spawnedAt = opts.entry.startedAt;
// Hard ceiling for spawn context (send context sets this via opts.hardCeilingMs or default)
// spawn = 3600s, send = max(resolvedPollTimeoutMs * 3, 900_000)
// Pass as opts.hardCeilingMs from callers; default to 3600s
const hardCeilingMs = opts.hardCeilingMs ?? 3600_000;

// In the setInterval timer, replacing lines 246-285:
const now = Date.now();

// Tier 1: liveness
const stallResult = isStalled({
  heartbeatFile,
  logFile: entry.logFile ?? undefined,
  stallThresholdMs,
  gracePeriodMs,
  spawnedAt,
});
if (stallResult.stalled) {
  clearInterval(timer);
  const logTail = readLogTail();
  resolve({
    ok: false,
    error: "stalled",
    logTail: logTail || undefined,
    stallDurationMs: stallResult.stalledMs,
    stallType: stallResult.type,
  });
  return;
}

// Tier 2/3: ceiling
const ceiling = stallResult.heartbeatActive ? hardCeilingMs : resolvedPollTimeoutMs;
if (now - startTime >= ceiling) {
  clearInterval(timer);
  const logTail = readLogTail();
  resolve({
    ok: false,
    error: "stalled",
    logTail: logTail || undefined,
    stallDurationMs: now - startTime,
    stallType: "timeout",
  });
  return;
}
```

**5. `PollOptions` additions:**
```typescript
/** Hard ceiling — fires regardless of heartbeat. spawn=3600s, send=max(D5×3, 900s) */
hardCeilingMs?: number;
```

**6. Update `executeSpawn` call to `pollForCollaboratorMessage`** (collab.ts ~line 511):
```typescript
const pollResult = await pollForCollaboratorMessage({
  inboxDir: path.join(dirs.inbox, state.agentName),
  collabName,
  entry,
  signal,
  onUpdate,
  stallThresholdMs,
  pollTimeoutMs: resolveSpawnPollTimeout(config),  // becomes the D5 fallback ceiling
  heartbeatFile: entry.heartbeatFile,
  hardCeilingMs: 3600_000,  // R5.1 spawn ceiling
  state,
});
```

**7. `stallType` propagation:** `PollResult` type needs `stallType?: StallType` for observability.
Update the error variant in `PollResult`.

---

## Part A4b — `handlers.ts` send path update

**File:** `handlers.ts`, lines 406–415.

**Add `heartbeatFile` and `hardCeilingMs` to poll call:**
```typescript
const rawPollTimeout = crewConfig.collaboration?.pollTimeoutMs;
const pollTimeoutMs = typeof rawPollTimeout === "number" && Number.isFinite(rawPollTimeout)
  ? Math.max(MIN_STALL_THRESHOLD_MS, rawPollTimeout)
  : DEFAULT_POLL_TIMEOUT_MS;
const sendHardCeiling = Math.max(pollTimeoutMs * 3, 900_000);  // R5.2

const pollResult = await pollForCollaboratorMessage({
  inboxDir: path.join(dirs.inbox, state.agentName),
  collabName: recipient,
  correlationId: outbound.id,
  sendTimestamp,
  entry: collabEntry,
  signal,
  onUpdate,
  stallThresholdMs,
  pollTimeoutMs,                                    // D5 fallback (used when no heartbeat)
  heartbeatFile: collabEntry.heartbeatFile,         // from CollaboratorEntry (set at spawn)
  hardCeilingMs: sendHardCeiling,                   // R5.2 send ceiling
  state,
});
```

---

## Part A5 — Extension cleanup

**File:** `crew/handlers/collab.ts`, `gracefulDismiss` function (lines 622+):

**Heartbeat unlink in BOTH branches** (Codex finding 2 — early-return fix):
```typescript
export async function gracefulDismiss(entry: CollaboratorEntry): Promise<void> {
  // Local helper — called from both paths
  const unlinkHeartbeat = () => {
    if (entry.heartbeatFile) { try { fs.unlinkSync(entry.heartbeatFile); } catch {} }
  };

  // Already exited? (crash path takes this branch)
  if (entry.proc.exitCode !== null) {
    unregisterWorker(entry.cwd, entry.taskId);
    cleanupTmpDir(entry.promptTmpDir);
    unlinkHeartbeat();   // ← ADDED: was missing, early return bypassed tail cleanup
    return;
  }

  try { entry.proc.stdin!.end(); } catch {}
  const exited = await pollUntilExited(entry.proc, STDIN_CLOSE_GRACE_MS);
  if (!exited) {
    try { entry.proc.kill("SIGTERM"); } catch {}
    const killed = await pollUntilExited(entry.proc, SIGKILL_DELAY_MS);
    if (!killed) { try { entry.proc.kill("SIGKILL"); } catch {} }
  }

  unregisterWorker(entry.cwd, entry.taskId);
  cleanupTmpDir(entry.promptTmpDir);
  unlinkHeartbeat();     // ← normal path
}
```

- R2d preserved: stall path does NOT call `gracefulDismiss` — defer-to-agent unchanged
- R2e covered: crash path calls `gracefulDismiss` → now takes early-return branch → unlinks
- Send-path crash: does NOT call `gracefulDismiss` — accepted operational debt (existing)

---

## Dependency Graph

```
T1 (crew/utils/stall.ts)            ──┬→ T4 (collab.ts + handlers.ts poll replacement)
T2 (index.ts heartbeat writer)        │ └→ T5 (cli/index.ts poll replacement)
T3 (crew/registry.ts CollaboratorEntry)→ T4 (entry.heartbeatFile available in poll)
T4 depends on: T1 + T3
T5 depends on: T1
T6 (tests) depends on: T1, T2, T3, T4, T5
T1, T2, T3 can be done in parallel
```

---

## Acceptance Criteria Traceability

| AC | Where verified |
|----|---------------|
| AC1: Heartbeat writes during API gaps | A1 (`setInterval` fires on Node.js event loop, not model output) |
| AC2: isStalled uses heartbeat, prevents false positive | A2 (`isStalled`) + A3/A4 (callers) |
| AC3: Orphan cleanup — all 5 paths | A3 (R2a/R2b/R2c), A5 (R2d preserved, R2e via gracefulDismiss) |
| AC4: D5 suppression + new ceilings | AD2 three-tier structure, A3 hardCeiling=3600s, A4b sendHardCeiling |
| AC5: Tests | T6 |
| AC6: Backward compat (no heartbeat → log-only) | A2 step 3 in isStalled logic |

---

## Out of Scope (confirmed)

- Crew worker spawn (different lifecycle)
- Non-pi runtime adapters
- The FIFO-based process lifecycle itself
- UI/overlay changes
- `POLL_TIMEOUT_MS` (30s mesh-join timeout)
- Send-path heartbeat orphan on OOM/SIGKILL (`gracefulDismiss` not called in send path — existing operational debt)
- ~~CLI crash path FIFO omission~~ **REMOVED: now included in plan as part of `cleanupCollaborator()` (Codex finding 1)**
