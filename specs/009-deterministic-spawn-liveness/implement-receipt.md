---
baseline_sha: ec695fecb335fbba6318a3c3a1479173f031e4a7
end_sha: 78113ae
test_command: npm test
test_result: pass
test_count: 549
---

<!-- implement:complete:v1 | harness: pi/claude-sonnet-4-6 | date: 2026-03-30T18:49:07Z -->

# Implementation Receipt

## Changed Files

```
cli/index.ts
crew/handlers/collab.ts
crew/registry.ts
crew/utils/stall.ts          (NEW)
handlers.ts
index.ts
tests/crew/cli-cleanup.test.ts    (NEW)
tests/crew/collab-blocking.test.ts
tests/crew/collab.test.ts
tests/crew/stall.test.ts          (NEW)
```

## Commits

| SHA | Description |
|-----|-------------|
| 584ef12 | feat(009): T1/T2/T3 — isStalled helper, heartbeat writer, CollaboratorEntry.heartbeatFile |
| 9c458bd | feat(009): T4/A4/A4b/A5 — poll replacement, gracefulDismiss fix, send path ceiling |
| 7a98f30 | feat(009): T5 — CLI runSpawn three-tier stall detection + full cleanup |
| 78113ae | feat(009): T6 — tests for isStalled, cleanup helper, poll, gracefulDismiss |

## Test Output Summary

```
Test Files  34 passed (34)
     Tests  549 passed (549)
  Start at  13:43:41
  Duration  134.48s
```

29 new tests added across 4 test files. All 520 pre-existing tests pass (no regressions).

## What Changed

### crew/utils/stall.ts (NEW — T1)
Pure `isStalled()` helper with `LivenessType` type. Dual-signal detection:
heartbeat mtime + log mtime. Degraded mode (logFile=null) → never stalls.
Missing log treated as fresh (not stale). R4 formula: max(1000, min(10000, stallThresholdMs/8)).

### index.ts (T2)
`collabHeartbeatTimer` added. When `PI_CREW_COLLABORATOR=1` and registration succeeds,
starts `setInterval` writing `Date.now()` to `dirs.registry/<name>.heartbeat` every
`heartbeatIntervalMs`. Cleared + file unlinked in `session_shutdown`.

### crew/registry.ts (T3)
`heartbeatFile?: string` added to `CollaboratorEntry` interface with JSDoc.

### crew/handlers/collab.ts (T4/A4/A5)
- `PollStallType = LivenessType | "timeout"` exported
- `PollOptions`: `heartbeatFile?`, `hardCeilingMs?` added
- `pollForCollaboratorMessage`: three-tier logic (isStalled + ceiling)
- `executeSpawn`: `entry.heartbeatFile` set, passed to poll with 3600s ceiling
- `gracefulDismiss`: heartbeat unlink in BOTH branches (early-return + normal)

### handlers.ts (T4d/A4b)
Send path: `sendHardCeiling = max(pollTimeoutMs * 3, 900_000)`, `heartbeatFile` + `hardCeilingMs` passed.

### cli/index.ts (T5/A3)
`isStalled` imported. `cleanupCollaborator(killFirst)` helper extracted (SIGTERM→5s→SIGKILL + full cleanup: FIFO, state JSON, heartbeat, registry entry). Three-tier stall detection replaces log-size heuristic. All 3 exit paths (stall/timeout/crash) use `cleanupCollaborator`.

## Completion Checklist Status

- ✅ 549 tests pass (34 files, no regressions)
- ✅ statusHeartbeatTimer unchanged (no-op for collaborators, separate timer added)
- ✅ All 5 R2 sub-requirements implemented (R2a stall, R2b timeout, R2c crash, R2d ext preserve, R2e ext crash)
- ✅ stallType propagated through PollResult (PollStallType export)
- ⬜ Manual smoke test: heartbeat file appears in registry (requires live collaborator spawn)
