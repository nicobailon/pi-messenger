---
title: "Tasks — CLI global install (spec 007)"
date: 2026-03-18
bead: pi-messenger-32a
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-18T20:26:17Z -->
<!-- Codex Review: APPROVED after 3 rounds | model: gpt-5.4 | date: 2026-03-18 -->
<!-- Status: REVISED -->
<!-- Revisions: Aligned with Codex-approved plan — decoupled wrapper from collision guard, hard error for R4, crew-spawned T9, collision guard exits 0 -->

# Tasks: CLI Global Install

## Prerequisites

- [x] Verify all existing tests pass: `npx vitest run`

## Implementation

- [x] **T1: Add constants + jiti resolver + wrapper function to install.mjs**
  - Add `BIN_DIR`, `CLI_WRAPPER_PATH` constants (line ~24)
  - Import `execFileSync` from `node:child_process`
  - Add `resolveJitiPath()`: uses `npm prefix -g` → builds jiti path → validates existence
  - Add `installCliWrapper(sourceDir)`: resolves jiti → writes bash wrapper to BIN_DIR with mode 0o755
  - Wrapper has graceful failure checks: jiti-not-found + source-not-found → exit 1 with instructions
  - If jiti not found: `process.exitCode = 1`, print error, return false

- [x] **T2: Update --remove section**
  - Unconditional `CLI_WRAPPER_PATH` deletion BEFORE extension dir removal
  - Wrapper cleanup happens even if extension dir doesn't exist

- [x] **T3: Add wrapper creation call + collision guard flow update**
  - Call `installCliWrapper(PACKAGE_DIR)` BEFORE the collision guard (runs unconditionally)
  - Update collision guard: if collision AND wrapper succeeded → exit 0 with note. If wrapper failed → exit 1.
  - Add comment explaining why: "Dev workflow uses tsx from repo directly — wrapper is for CLI access"
  - After `copyDir` succeeds: re-run `installCliWrapper(EXTENSION_DIR)` to update wrapper to canonical path
  - Add "CLI: pi-messenger-cli" line to post-install output

- [x] **T4: Add CLI hard error to runtime-spawn.ts**
  - File: `crew/runtime-spawn.ts`
  - AFTER `adapter.buildArgs()` and `adapter.buildEnv()`, inside `if (runtime !== "pi" && !options?.skipCommandCheck)`
  - Check `which pi-messenger-cli` with the CONSTRUCTED worker env (pass `env` to execFileSync)
  - On failure: throw Error with install instructions (same pattern as runtime command validation)
  - This is the only change to runtime-spawn — existing runtime-command check stays parent-env-based (out of scope)

- [x] **T5: Tests — wrapper creation/removal (T6)**
  - Verify wrapper exists at BIN_DIR, is executable (0o755), contains correct jiti + source paths
  - Verify --remove deletes wrapper even when extension dir is missing
  - Verify idempotent: run creation twice → correct content, no errors

- [x] **T6: Tests — graceful failure (T7)**
  - Wrapper with non-existent jiti path → execute → exit 1, stderr contains "jiti not found"
  - Wrapper with non-existent source dir → execute → exit 1, stderr contains "source not found"

- [x] **T7: Tests — spawn-time validation (T8)**
  - Mock env without CLI in PATH → `buildRuntimeSpawn()` with non-pi runtime → throws with install instructions
  - Same with `skipCommandCheck: true` → no throw

- [x] **T8: Tests — AC5 crew-spawned integration (T9)**
  - Create temp dirs for registry + inbox + messenger state
  - Write pre-registration JSON to temp registry (name matches PI_AGENT_NAME, pid = current process)
  - Create wrapper pointing to real CLI source + real jiti
  - Execute `pi-messenger-cli task.list` with env: PI_CREW_WORKER=1, PI_AGENT_NAME=TestWorker, PI_MESSENGER_DIR=temp, PATH includes wrapper dir
  - Assert: exit 0 (empty task list OK — proves crew-spawned bootstrap + CLI execution)

## Verification

- [x] **T9: Run full test suite**
  - `npx vitest run` — all tests must pass (existing + new)

- [x] **T10: Manual smoke test**
  - `node install.mjs` → exits 0 (collision guard path, but wrapper created)
  - `which pi-messenger-cli` → returns `~/.pi/agent/bin/pi-messenger-cli`
  - `pi-messenger-cli --help` from `/tmp` → shows help
  - `node install.mjs --remove` → wrapper + extension cleaned up
