---
title: "Plan — Harden PR #9 for Upstream Submission"
date: 2026-03-08
bead: pi-messenger-3
---

# Plan — Harden PR #9 for Upstream Submission

## Overview

Implement Shape C'' from shaping: `git reset --mixed main` + selective restaging into 6 bisectable commits. Apply R3, R4, R5 code fixes, strip personal data and process artifacts, update docs, and force-push a clean PR.

## Selected Shape: C'' (Soft Reset + Restage)

See `shaping.md` for full analysis. C'' was selected over:
- **A (Fix-in-Place):** Fails R2 — removing specs/ mid-rebase of 23 commits is too complex
- **B (Fresh Branch):** Fails R7 — cherry-picking doesn't produce clean grouped commits

## Implementation Approach

### Phase 1: Code Fixes (on current branch, before reset)

Apply R3, R5 code fixes. R4 is applied AFTER reset as commit 6 (import dependency — ZenCastle shaping finding).

**R3: Replace `as any` with `HandlerContext` interface (SageNova planning correction)**

Original plan was a cast-wrapper function. SageNova correctly identified that `as unknown as ExtensionContext` is a worse lie than `as any`. The fix is structural subtyping (spec AC option b):

1. Define `HandlerContext` in `lib.ts`:
   ```ts
   export interface HandlerContext {
     cwd: string;
     hasUI: boolean;
   }
   ```

2. Change handler signatures for CLI-called functions:
   - `handlers.ts`: `executeReserve(state, dirs, ctx: HandlerContext, ...)`, `executeRelease(state, dirs, ctx: HandlerContext, ...)`
   - `crew/handlers/task.ts`: `execute(op, params, state, ctx: HandlerContext)`
   - Handlers that use `ctx.sessionManager` (e.g., `executeSwarm`) keep `ExtensionContext`

3. CLI passes `{ cwd, hasUI: false }` with zero casts

4. Backward-compatible: `ExtensionContext` already has `cwd` and `hasUI`, so all existing pi extension callers still work (widening parameter type is always safe)

**R5: Multi-worker inference gate**

Add `activeWorkerCount` to `InferenceContext` in `completion-inference.ts`:
```ts
export interface InferenceContext {
  // ... existing fields ...
  /** Number of currently in_progress tasks. When > 1 and no reservedPaths, inference returns false. */
  activeWorkerCount?: number;
}
```

In `inferTaskCompletion()`, before the "no reservedPaths" fallback:
```ts
if ((!ctx.reservedPaths || ctx.reservedPaths.length === 0) && (ctx.activeWorkerCount ?? 1) > 1) {
  logFeedEvent(..., "Skipping inference: no reservedPaths with multiple active workers");
  return false;
}
```

Callers pass count:
- `lobby.ts` close handler: `store.getTasks(cwd).filter(t => t.status === 'in_progress').length`
- `work.ts` result processing: same

**R6: Nonce auth documentation**

Update JSDoc on `validateNonce()` in `cli/index.ts`:
```ts
/**
 * Defense-in-depth identity verification for crew-spawned workers.
 * Prevents accidental CLI invocation from wrong worker process.
 * NOT a security boundary — nonce is an env var readable by same-user processes,
 * hashed with unsalted SHA-256. Protects against cross-talk, not adversaries.
 */
```

Update comment in `agents.ts`:
```ts
// Defense-in-depth nonce: prevents accidental cross-talk between crew sessions
```

### Phase 2: Reset and Restage

**Prerequisite safety:** Create a backup branch before the destructive reset:
```bash
git branch backup/feat-002-pre-hardening
```

**Execute reset:**
```bash
git reset --mixed main
```

Working tree now has all changes, index matches main. R1/R2 handled naturally by never staging excluded files (specs/, thoughts/, .beads/, claude-stream-format.jsonl).

### Phase 3: Commit in 6 Groups

Each commit followed by `npx tsc --noEmit && npm test` (compile check + test run). If either fails, fix and amend.

**Commit grouping (SageNova-validated, import dependencies verified):**

| # | Message | Production files | Test files |
|---|---------|-----------------|------------|
| 1 | `feat(crew): add RuntimeAdapter interface and unified spawn engine` | `crew/utils/adapters/types.ts`, `crew/utils/adapters/pi.ts`, `crew/utils/adapters/index.ts`, `crew/runtime-spawn.ts`, `crew/utils/model.ts`, `crew/spawn.ts` (re-exports), `crew/utils/progress.ts`, `crew/utils/config.ts`, `lib.ts` (HandlerContext + pathMatchesReservation), `store.ts` (registerSpawnedWorker), `crew/lobby.ts`, `crew/agents.ts`, `crew/prompt.ts`, `crew/completion-inference.ts`, `crew/handlers/work.ts`, `handlers.ts` (signature widening) | `tests/crew/completion-inference.test.ts` |
| 2 | `feat(cli): add pi-messenger-cli for non-pi runtimes` | `cli/index.ts`, `tsconfig.cli.json`, `package.json` | `tests/crew/cli.test.ts` |
| 3 | `feat(crew): add Claude Code adapter with prompt injection` | `crew/utils/adapters/claude.ts` | `tests/crew/claude-integration.test.ts` |
| 4 | `feat(crew): add Codex CLI adapter` | `crew/utils/adapters/codex.ts` | `tests/crew/adapters.test.ts` |
| 5 | `refactor(crew): extract stuck detection to shared utility` | `crew/utils/stuck-timer.ts` (NEW), `crew/agents.ts` (amend import), `crew/lobby.ts` (amend import) | — |
| 6 | `docs: add multi-runtime configuration guide` | `README.md` | — |

**Import dependency analysis (preventing bisectability breaks):**

- ✅ Commit 1: lobby.ts imports completion-inference.ts — both in commit 1 (SageNova BLOCKER 1 fix)
- ✅ Commit 1: completion-inference.ts imports lib.ts (pathMatchesReservation) — both in commit 1
- ✅ Commit 2: cli/index.ts imports handlers.ts — handlers.ts in commit 1
- ✅ Commit 3: claude.ts imports types.ts — types.ts in commit 1
- ✅ Commit 4: codex.ts imports types.ts — types.ts in commit 1
- ✅ Commit 4: adapters.test.ts imports all adapters — all exist by commit 4 (SageNova BLOCKER 2 fix)
- ✅ Commit 5: stuck-timer.ts is NEW, agents.ts/lobby.ts import it — all in same commit (ZenCastle shaping fix)

**Commit 5 mechanism (R4):**
Apply R4 code changes (create stuck-timer.ts, update agents.ts/lobby.ts imports) AFTER commits 1-4, then:
```bash
# Create the new file
git add crew/utils/stuck-timer.ts
# Stage only the import/usage changes in agents.ts and lobby.ts
git add -p crew/agents.ts crew/lobby.ts  # select stuck-timer hunks only
git commit -m "refactor(crew): extract stuck detection to shared utility"
npx tsc --noEmit && npm test
```

### Phase 4: PR Update

**R0: Accurate PR description:**
- Update file count and insertion stats from actual `git diff --stat`
- Summarize design decisions (CLI over MCP, adapter pattern) concisely
- Note backward compatibility (existing pi-only setups unaffected)

**R6: Nonce qualification in PR description:**
- Change "Worker nonce auth" to "Defense-in-depth worker identity verification"
- Add note: "Not a security boundary — prevents accidental cross-talk"

### Phase 5: Codex Validation (R8 — before push)

R8 was classified as "nice-to-have" in shaping, but Codex review correctly noted it has concrete ACs in the spec. Execute BEFORE force-push to avoid publishing unvalidated adapter code:

1. Run 3 Codex multi-turn tasks: (a) multi-file edit with tool use, (b) task triggering sandbox error, (c) task with 3+ turns
2. Capture JSONL output for each
3. Verify CodexAdapter parses all observed event types
4. Add tests for any new event types discovered
5. Document intentionally ignored event types (and why)

If Codex CLI is unavailable or rate-limited, document the gap and proceed — but attempt validation first.

### Phase 6: Post-validation Verification

Before force-push, run deterministic scans:
```bash
# Verify no personal data in any file in the diff
grep -r "dalecarman\|Groove Jones\|/Users/dalecarman" $(git diff --name-only main..HEAD) && echo "FAIL: personal data found" || echo "PASS"

# Verify no specs/ or process artifacts
git diff --name-only main..HEAD | grep -E "^(specs/|thoughts/|\.beads/)" && echo "FAIL: process artifacts" || echo "PASS"

# Verify no as-any in cli
grep -c "as any" cli/index.ts  # must be 0
```

### Phase 7: Force-Push

```bash
git push --force-with-lease origin feat/002-multi-runtime-support
```

Post-push verification:
```bash
# Confirm JSONL file is not reachable from the feature branch (branch-specific, not --all)
git log origin/feat/002-multi-runtime-support --oneline -- specs/002-multi-runtime-support/claude-stream-format.jsonl
# Must return empty — file should not be in any commit on the rewritten branch
```

## Architecture Decisions

### Why `HandlerContext` instead of cast functions (R3)
SageNova showed that `as unknown as ExtensionContext` is a double-cast bypassing stricter TypeScript checks. Structural subtyping via `HandlerContext = { cwd: string; hasUI: boolean }` is the correct TypeScript pattern — handlers declare what they need, callers provide it, no casts required. Only `executeSwarm` uses `ctx.sessionManager` — it keeps `ExtensionContext`.

**API constraint compliance (Codex review finding):** Widening a parameter type (`ExtensionContext` → `HandlerContext`) is backward-compatible — all existing callers pass `ExtensionContext` which structurally satisfies `HandlerContext`. This is not a breaking change. No existing code needs modification. The public API surface is preserved (callers keep working identically). This is TypeScript's structural typing working as designed.

### Why completion-inference.ts in commit 1, not commit 4 (R7)
SageNova found that lobby.ts (commit 1) imports completion-inference.ts. Moving it to commit 4 would break bisectability. Since completion-inference is foundational infrastructure (both lobby.ts and work.ts need it), it belongs in the core commit.

### Why R4 is commit 5, not applied before reset (R7)
ZenCastle found that stuck-timer.ts is a NEW file creating import dependencies. If applied before reset and agents.ts/lobby.ts are committed in commit 1 with the new import, TypeScript fails because stuck-timer.ts doesn't exist until commit 5. Solution: keep inline stuck detection in commits 1-4, then refactor to shared utility as commit 5.

### Why adapters.test.ts in commit 4 (R7)
SageNova found that adapters.test.ts has 20 references to ClaudeAdapter and CodexAdapter. It can only go in the commit where all three adapters exist (commit 4 = Codex).

### Why `git add -p` is needed for commit 5 only
The shaping ruled out hunk-level surgery for the main file assignments. But commit 5 (R4 refactor) modifies agents.ts and lobby.ts AFTER they were committed in commit 1. This is the only case where `git add -p` is needed — selecting only the stuck-timer import/usage hunks in two files. Manageable (2-3 hunks per file).

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Destructive reset loses work | `git branch backup/feat-002-pre-hardening` before reset |
| Force-push breaks fork PR | Only our fork, no other contributors |
| JSONL file in old commits | File never in main, soft reset excludes it, GitHub GCs old refs |
| Commit 1 too large (17 files) | All interdependent — can't split without breaking imports |
| `git add -p` error in commit 5 | Only 2 files, 2-3 hunks each — verify with `git diff --cached` |
| R5 change breaks existing tests | `activeWorkerCount` defaults to 1 (optional param, preserves existing behavior) |

## Traceability

| Req | Where addressed | Verification |
|-----|----------------|--------------|
| R0 | Phase 4 (PR description) | `git diff --stat` matches PR description |
| R1 | Phase 2 (never stage JSONL) + Phase 6 (scan) | `grep -r "dalecarman\|Groove Jones" $(git diff --name-only main..HEAD)` = empty |
| R2 | Phase 2 (never stage specs/) | `git diff main..HEAD --name-only \| grep -c specs/` = 0 |
| R3 | Phase 1 + commit 1 (HandlerContext) | `grep -c "as any" cli/index.ts` = 0 |
| R4 | Commit 5 (stuck-timer.ts) | `diff <(grep stuck crew/lobby.ts) <(grep stuck crew/agents.ts)` shows shared import |
| R5 | Phase 1 + commit 1 (activeWorkerCount) | New test: multi-worker + no paths → returns false |
| R6 | Phase 1 + Phase 4 (JSDoc + PR) | `grep "defense-in-depth" cli/index.ts` |
| R7 | Phase 3 (6 commits) | `git log --oneline main..HEAD \| wc -l` = 6, `npx tsc --noEmit && npm test` after each |
| R8 | Phase 5 (before push) | Codex JSONL captured, adapter tests added |
