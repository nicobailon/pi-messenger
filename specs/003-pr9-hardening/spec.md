---
title: "Harden PR #9 for upstream submission"
date: 2026-03-08
bead: pi-messenger-3
---

# Spec 003 — Harden PR #9 for Upstream Submission

## Problem

PR #9 (spec 002, multi-runtime agent support) implements a working feature — 419 tests pass, three runtimes supported, E2E verified. But an adversarial review found 8 issues that make it unfit for submission to `nicobailon/pi-messenger`. The PR would likely be closed on sight: it's 5,600 lines with process artifacts, personal environment data, type-unsafe production code, duplicated logic, and a commit history that reads like a session log.

This isn't about the feature being wrong. It's about the *contribution* not meeting the standard we'd want to receive ourselves.

## Context

- **Repo:** `nicobailon/pi-messenger` (MIT, Nico Bailon)
- **Fork:** `carmandale/pi-messenger`
- **Branch:** `feat/002-multi-runtime-support` (23 commits, 36 files)
- **PR:** #9 on fork
- **Current state:** All 47 tasks done, 419 tests pass, no functional blockers

## Requirements

### R1: Remove personal environment data from committed files

**What:** `specs/002-multi-runtime-support/claude-stream-format.jsonl` contains a raw Claude Code `system.init` dump with full home directory paths, 300+ skill/command names, MCP server configs, API key source, and plugin paths. This is Dale's entire dev environment fingerprint.

**Acceptance criteria:**
- `claude-stream-format.jsonl` removed from branch history (or at minimum from HEAD)
- No file in the PR contains paths matching `/Users/dalecarman/` or `Groove Jones`
- Add `*.jsonl` to `.gitignore` for the specs directory (or remove specs from PR entirely — see R2)

### R2: Strip process artifacts from PR

**What:** The PR includes 2,266 lines of spec docs (plan.md, shaping.md, shaping-transcript.md, planning-transcript.md, codex-review.md, codex-review-fresh.md, tasks.md, log.md) plus a 89-line handoff YAML. These are internal planning artifacts from our shaping/planning process. They're valuable to *us* but are process noise to an upstream reviewer.

**Acceptance criteria:**
- PR diff does not include `specs/` directory, `thoughts/` directory, or `.beads/` artifacts
- Process artifacts either: (a) live on a separate branch/commit, (b) are referenced in the PR description as a link, or (c) are `.gitignore`d for the PR
- PR description retains a concise summary of the design decisions (what shape D' is, why CLI over MCP) without requiring the reviewer to read 992 lines of plan.md

**Open question:** Does Nico want specs in the repo? If so, what's the right format? This may require a conversation before submitting.

### R3: Replace `as any` type bypasses in CLI with proper types

**What:** `cli/index.ts` uses `{ cwd, hasUI: false } as any` in 6 places to satisfy the `ExtensionContext` parameter that handlers expect. This bypasses all type checking for every task/reserve/release operation. The handlers actually only use `ctx.cwd`, `ctx.hasUI`, and occasionally `ctx.sessionManager.getSessionId()` — a narrow surface that should have a proper interface.

**Acceptance criteria:**
- Zero `as any` casts in `cli/index.ts` production code (test files exempt)
- Either: (a) define a `CliContext` type that satisfies the handler requirements, or (b) extract the minimal interface that handlers need and have both `ExtensionContext` and `CliContext` implement it
- `(reg.reservations ?? []).map((r: any) => r.pattern)` replaced with proper `FileReservation` type import (appears twice: lobby.ts completion-inference callsite and work.ts callsite)

### R4: Extract stuck detection to shared utility

**What:** The stuck detection timer (~15 lines) is copy-pasted between `lobby.ts` and `agents.ts` with only variable name differences (`worker.assignedTaskId` vs `task.taskId`, `name` vs `workerName`). Both implementations:
- Track `lastOutputTimestamp` and `stuckWarned`
- Create a `setInterval` capped at `min(stuckTimeoutMs, 60s)`
- Call `store.appendTaskProgress` + `logFeedEvent` on timeout
- Reset on new output, clear on process close

**Acceptance criteria:**
- Single implementation in a shared module (e.g., `crew/utils/stuck-timer.ts`)
- Both `lobby.ts` and `agents.ts` import and use the shared utility
- Behavior identical to current (tests still pass)
- Adding stuck detection to a future spawn path requires 1-2 lines, not 15

### R5: Gate repo-wide completion inference

**What:** When a worker has no `reservedPaths`, `inferTaskCompletion()` uses a repo-wide `git diff` and can attribute another worker's commits to the wrong task. It logs a warning but still marks the task as "done." In multi-worker mode, this is a false-positive risk.

**Acceptance criteria:**
- When `reservedPaths` is absent/empty AND multiple workers are active, inference returns `false` (does not auto-complete). The task resets to todo instead.
- When `reservedPaths` is absent/empty AND only one worker is active, current behavior is preserved (repo-wide diff is reasonable for single-worker).
- "Multiple workers active" is determined by counting `in_progress` tasks (already tracked in store).
- Existing tests updated, new test for multi-worker fallback.

### R6: Qualify nonce auth in PR description and code comments

**What:** The nonce is an env var (readable by same-user processes) with unsalted SHA-256. The PR description says "Worker nonce auth" which oversells it. This is defense-in-depth against accidental cross-talk, not a security boundary.

**Acceptance criteria:**
- PR description qualifies nonce as "defense-in-depth identity verification" not "auth"
- Code comment at `validateNonce()` in `cli/index.ts` documents the threat model: prevents accidental CLI invocation from wrong worker process, NOT a security boundary against same-user attackers
- No code changes needed — just documentation accuracy

### R7: Squash commits to clean logical history

**What:** 23 commits include 5 "chore: update tasks.md" commits and 3 incremental task-count updates. The history reads like a session log, not a feature progression.

**Acceptance criteria:**
- Squash to 5-7 logical commits:
  1. `feat(crew): add RuntimeAdapter interface and unified spawn engine` (V1 refactor)
  2. `feat(cli): add pi-messenger-cli for non-pi runtimes` (V2)
  3. `feat(crew): add Claude Code adapter, prompt injection, and pre-registration` (V3)
  4. `feat(crew): add completion inference and lifecycle hardening` (V4)
  5. `feat(crew): add Codex CLI adapter` (Codex)
  6. `docs: update README with multi-runtime configuration` (docs)
- Each commit compiles and tests pass independently (bisectable)
- No "chore: update tasks.md" commits in final history

### R8: Validate CodexAdapter against real multi-turn workloads

**What:** The CodexAdapter was built from observing 2 Codex executions (single-turn prompt, single file create). We haven't tested: multi-turn with tool use, `turn.failed` recovery, sandbox permission errors, or what `item.started` looks like for non-command types.

**Acceptance criteria:**
- Run Codex on at least 3 real-world tasks: (a) multi-file edit with tool use, (b) task that triggers a sandbox error, (c) task with 3+ turns
- Capture the JSONL output, verify adapter parses all event types correctly
- Add tests for any new event types discovered
- Document any Codex event types that are intentionally ignored (and why)

## Out of Scope

- **Functional changes to the feature itself** — the RuntimeAdapter, CLI, adapters, inference, and nonce auth all work correctly. This spec is about contribution quality, not feature correctness.
- **Breaking the PR into multiple PRs** — that's a possible approach but it's a /shape decision, not predetermined here.
- **Upstream maintainer preferences** — we may need to talk to Nico about what he wants in the repo (specs? docs format? commit style?). That conversation is prerequisite to some of these requirements but outside this spec's scope.

## Constraints

- Must stay on `feat/002-multi-runtime-support` branch (or a child branch)
- Cannot break the public API surface — all existing callers must work unchanged. Widening parameter types (e.g., `ExtensionContext` → `HandlerContext` where the former structurally satisfies the latter) is permitted as backward-compatible.
- All 419 tests must continue to pass
- The feature must remain backward compatible (existing pi-only setups unaffected)

## Risks

- **R7 (squash) is destructive** — interactive rebase on a pushed branch requires force-push. If anyone else has the branch checked out, their history diverges.
- **R2 (strip artifacts) may require R7 first** — removing files from HEAD without rewriting history leaves them in the diff. If we squash first, we can simply not include them.
- **R5 (multi-worker gate) changes behavior** — existing tests may assume repo-wide inference works. Need careful test updates.
