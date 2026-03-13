# Planning Transcript — Spec 003 PR #9 Hardening

**Date:** 2026-03-08
**Participants:** OakEagle (pi/claude-opus-4-6, proposer), SageNova (crew-challenger/claude-sonnet-4-6, challenger)

---

## OakEagle: Codebase Research

Before engaging SageNova, I conducted deep codebase research:

### R3 Investigation
- Identified 6 `as any` casts in cli/index.ts (lines 319, 326, 343, 356, 362, 374)
- All create `{ cwd, hasUI: false } as any` to satisfy `ExtensionContext`
- Mapped ctx property usage across ALL handlers: `ctx.cwd` (everywhere), `ctx.hasUI` (1 place), `ctx.sessionManager.getSessionId()` (1 place, executeSwarm only, never called from CLI)
- Full ExtensionContext has 13+ required fields; handlers only use 2-3

### R4 Investigation
- lobby.ts (lines 158-174) and agents.ts (lines 251-270) have identical stuck detection pattern
- Both: `lastOutputTimestamp`, `stuckWarned`, `setInterval`, `clearInterval`, reset on output, warning on timeout
- Differences: variable names only (`worker.assignedTaskId` vs `task.taskId`)

### R5 Investigation
- `inferTaskCompletion()` in completion-inference.ts returns true on exit 0 with changes even when no reservedPaths
- Callers: lobby.ts close handler (line 230), work.ts result processing (line 230)
- Count of in_progress tasks available via `store.getTasks(cwd).filter(t => t.status === 'in_progress')`

### R7 File-to-Commit Mapping
- agents.ts: 5 commits across V1/V3/V4 — assigned to commit 1 (primary group)
- lobby.ts: 7 commits — assigned to commit 1
- work.ts: 5 commits — assigned to commit 1
- Initial plan: 7 commits with separate V4 inference commit

---

## OakEagle → SageNova: Plan Proposal

Shared full research findings and proposed:
- R3 Option A (cast-wrapper function)
- R5: `activeWorkerCount` param on InferenceContext
- 7-commit restaging table with files assigned to logical groups

---

## SageNova → OakEagle: Three Challenges (all evidence-backed)

### BLOCKER 1: lobby.ts imports completion-inference.ts
```
grep -n "inferTaskCompletion\|completion-inference" crew/lobby.ts
28: import { inferTaskCompletion } from "./completion-inference.js";
```
Commit 1 (lobby.ts) → commit 4 (completion-inference.ts) = TypeScript compile failure.

### BLOCKER 2: adapters.test.ts imports all three adapters
```
grep -c "ClaudeAdapter\|CodexAdapter" tests/crew/adapters.test.ts
20
```
Commit 1 has adapters.test.ts, but ClaudeAdapter (commit 3) and CodexAdapter (commit 5) don't exist yet.

### PROBLEM 3: R3 Option A is `as unknown as ExtensionContext` — a double-cast
Full ExtensionContext has 13 required fields. Option A moves the lie, doesn't eliminate it.

---

## OakEagle → SageNova: Revisions (all accepted)

1. **BLOCKER 1 fix:** Move completion-inference.ts + test to commit 1
2. **BLOCKER 2 fix:** Move adapters.test.ts to commit 4 (Codex, when all adapters exist)
3. **PROBLEM 3 fix:** Abandon Option A, use Option B (HandlerContext interface with structural subtyping)
4. **Table revision:** 7 commits → 6 commits (V4 inference folded into commit 1 since completion-inference.ts is there)

*SageNova went idle after delivering challenges. Plan written incorporating all three corrections.*

---

## Key Decisions Made During Planning

| Decision | Rationale | Source |
|----------|-----------|--------|
| HandlerContext over cast function | Double-cast is worse than `as any`; structural subtyping is correct TS pattern | SageNova PROBLEM 3 |
| completion-inference.ts in commit 1 | lobby.ts import dependency | SageNova BLOCKER 1 |
| adapters.test.ts in commit 4 | Imports all 3 adapters; can only go where all exist | SageNova BLOCKER 2 |
| 6 commits not 7 | V4 inference changes folded into commit 1 (same files) | OakEagle revision |
| `git add -p` only for commit 5 | R4 refactor modifies agents.ts/lobby.ts after commit 1 | ZenCastle shaping |
| R4 NOT applied before reset | Import dependency would break bisectability | ZenCastle shaping |
