---
title: "Tasks — Harden PR #9 for Upstream Submission"
date: 2026-03-08
bead: pi-messenger-3
---

# Tasks — Harden PR #9

## Phase 1: Code Fixes (before reset)

- [x] **T1.1** Define `HandlerContext` interface in `lib.ts`
  - `export interface HandlerContext { cwd: string; hasUI: boolean; }`
  - Files: `lib.ts`

- [x] **T1.2** Widen handler signatures for CLI-called functions
  - `handlers.ts`: `executeReserve` and `executeRelease` — change `ctx: ExtensionContext` → `ctx: HandlerContext`
  - `crew/handlers/task.ts`: `execute()` — change `ctx: ExtensionContext` → `ctx: HandlerContext`
  - Import `HandlerContext` from `lib.ts`; keep `ExtensionContext` import for handlers that need it (e.g., `executeSwarm`)
  - Files: `handlers.ts`, `crew/handlers/task.ts`
  - Depends on: T1.1

- [x] **T1.3** Remove all `as any` casts from `cli/index.ts`
  - Replace 6× `{ cwd, hasUI: false } as any` with `{ cwd, hasUI: false }` (no cast needed with widened signatures)
  - Verify: `grep -c "as any" cli/index.ts` = 0
  - Files: `cli/index.ts`
  - Depends on: T1.2

- [x] **T1.4** Add `activeWorkerCount` to `InferenceContext`
  - Add optional field: `activeWorkerCount?: number`
  - Add guard in `inferTaskCompletion()`: when no reservedPaths AND activeWorkerCount > 1, return false
  - Files: `crew/completion-inference.ts`

- [x] **T1.5** Pass `activeWorkerCount` from callers
  - `crew/lobby.ts` close handler: `store.getTasks(cwd).filter(t => t.status === 'in_progress').length`
  - `crew/handlers/work.ts` result processing: same count
  - Files: `crew/lobby.ts`, `crew/handlers/work.ts`
  - Depends on: T1.4

- [x] **T1.6** Update R5 tests
  - Add test: multi-worker (activeWorkerCount=3) + no reservedPaths → returns false
  - Add test: single worker (activeWorkerCount=1) + no reservedPaths → current behavior (returns true)
  - Update existing tests to pass `activeWorkerCount: 1` where needed
  - Files: `tests/crew/completion-inference.test.ts`
  - Depends on: T1.4

- [x] **T1.7** Update nonce auth documentation (R6)
  - `cli/index.ts`: update `validateNonce()` JSDoc with defense-in-depth qualification
  - `crew/agents.ts`: update nonce generation comment
  - Files: `cli/index.ts`, `crew/agents.ts`

- [x] **T1.8** Run `npm test` — all 419 tests must pass
  - Verify: `npm test` exits 0
  - This is baseline verification, not a checkpoint (commit is orphaned after reset)
  - Depends on: T1.1-T1.7

## Phase 2: Reset

- [x] **T2.1** Create backup branch
  - `git branch backup/feat-002-pre-hardening`
  - Verify: `git branch -l backup/*` shows the branch

- [x] **T2.2** Execute mixed reset
  - `git reset --mixed main`
  - Verify: `git status` shows all changes as unstaged modifications
  - Verify: `git log --oneline -1` shows main's HEAD commit
  - Depends on: T2.1

## Phase 3: Restage (6 commits, npm test after each)

- [x] **T3.1** Commit 1: RuntimeAdapter + unified spawn engine
  - Stage: `crew/utils/adapters/types.ts`, `crew/utils/adapters/pi.ts`, `crew/utils/adapters/index.ts`, `crew/runtime-spawn.ts`, `crew/utils/model.ts`, `crew/spawn.ts`, `crew/utils/progress.ts`, `crew/utils/config.ts`, `lib.ts`, `store.ts`, `crew/lobby.ts`, `crew/agents.ts`, `crew/prompt.ts`, `crew/completion-inference.ts`, `crew/handlers/work.ts`, `handlers.ts`, `tests/crew/completion-inference.test.ts`
  - Do NOT stage: `specs/`, `thoughts/`, `.beads/`, `*.jsonl`
  - `git commit -m "feat(crew): add RuntimeAdapter interface and unified spawn engine"`
  - `npm test` — must pass
  - Depends on: T2.2

- [x] **T3.2** Commit 2: pi-messenger-cli
  - Stage: `cli/index.ts`, `tsconfig.cli.json`, `package.json`, `tests/crew/cli.test.ts`
  - `git commit -m "feat(cli): add pi-messenger-cli for non-pi runtimes"`
  - `npm test` — must pass
  - Depends on: T3.1

- [x] **T3.3** Commit 3: Claude Code adapter
  - Stage: `crew/utils/adapters/claude.ts`, `tests/crew/claude-integration.test.ts`
  - `git commit -m "feat(crew): add Claude Code adapter with prompt injection"`
  - `npm test` — must pass
  - Depends on: T3.2

- [x] **T3.4** Commit 4: Codex CLI adapter
  - Stage: `crew/utils/adapters/codex.ts`, `tests/crew/adapters.test.ts`
  - `git commit -m "feat(crew): add Codex CLI adapter"`
  - `npm test` — must pass (adapters.test.ts now has all 3 adapters available)
  - Depends on: T3.3

- [x] **T3.5** Commit 5: Extract stuck detection (R4)
  - Create `crew/utils/stuck-timer.ts` with `createStuckTimer()` function
  - Modify `crew/agents.ts`: replace inline stuck detection with `createStuckTimer()` import
  - Modify `crew/lobby.ts`: same replacement
  - Stage: `git add crew/utils/stuck-timer.ts` then `git add -p crew/agents.ts crew/lobby.ts` (stuck-timer hunks only)
  - `git commit -m "refactor(crew): extract stuck detection to shared utility"`
  - `npm test` — must pass
  - Depends on: T3.4

- [x] **T3.6** Commit 6: Documentation
  - Stage: `README.md`
  - `git commit -m "docs: add multi-runtime configuration guide"`
  - `npm test` — must pass
  - Depends on: T3.5

## Phase 4: PR Update

- [x] **T4.1** Verify clean state
  - `git log --oneline main..HEAD` — should show exactly 6 commits
  - `git diff --stat main..HEAD` — verify no specs/, thoughts/, .beads/, or JSONL files
  - `grep -r "dalecarman\|Groove Jones" $(git diff --name-only main..HEAD)` — must return nothing
  - Depends on: T3.6

- [x] **T4.2** Update PR description
  - Run `git diff --stat main..HEAD` for accurate file/insertion counts
  - Write concise PR description with:
    - Feature summary (RuntimeAdapter, 3 runtimes, CLI, inference)
    - Design decisions (CLI over MCP, adapter pattern)
    - Backward compatibility note
    - Nonce qualified as "defense-in-depth worker identity verification"
  - Depends on: T4.1



## Phase 5: Codex Validation (R8, before push)

- [x] **T5.1** Run Codex multi-turn tasks
  - Execute 3 real tasks: multi-file edit, sandbox error trigger, 3+ turn task
  - Capture JSONL output for each
  - If Codex CLI unavailable, document gap and proceed

- [x] **T5.2** Verify adapter coverage
  - Check that CodexAdapter parses all observed event types
  - Add tests for any new event types discovered
  - Document intentionally ignored event types

## Phase 6: Pre-push Verification

- [x] **T6.1** Run deterministic personal data scan
  - `grep -r "dalecarman\|Groove Jones\|/Users/dalecarman" $(git diff --name-only main..HEAD)` — must return nothing
  - `git diff --name-only main..HEAD | grep -E "^(specs/|thoughts/|\.beads/)"` — must return nothing
  - `grep -c "as any" cli/index.ts` — must be 0
  - Depends on: T4.1

- [x] **T6.2** Force-push
  - `git push --force-with-lease origin feat/002-multi-runtime-support`
  - Verify PR #9 on GitHub shows 6 commits
  - Depends on: T6.1

- [x] **T6.3** Post-push verification
  - Verify old JSONL file not reachable from new branch HEAD
  - Verify PR description is accurate
  - Depends on: T6.2

---

## Summary

| Phase | Tasks | Requirement coverage |
|-------|-------|---------------------|
| Phase 1: Code fixes | T1.1-T1.8 | R3, R5, R6 |
| Phase 2: Reset | T2.1-T2.2 | R1, R2 (foundation) |
| Phase 3: Restage | T3.1-T3.6 | R1, R2, R4, R7 |
| Phase 4: PR update | T4.1-T4.2 | R0, R6 |
| Phase 5: Codex validation | T5.1-T5.2 | R8 |
| Phase 6: Push + verify | T6.1-T6.3 | R1 (final), R0 |

Total: 21 tasks
