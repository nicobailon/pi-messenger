---
title: "Tasks — CLI global install (spec 007)"
date: 2026-03-18
bead: pi-messenger-32a
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-18T20:26:17Z -->

# Tasks: CLI Global Install

## Prerequisites

- [ ] Verify all existing tests pass: `npx vitest run`

## Implementation

- [ ] **T1: Add constants + jiti resolver to install.mjs**
  - Add `BIN_DIR` and `CLI_WRAPPER_PATH` constants (line ~24)
  - Add `resolveJitiPath()` function: uses `npm prefix -g` → builds jiti path → validates existence
  - Import `execFileSync` from `node:child_process`

- [ ] **T2: Update --remove section in install.mjs**
  - File: `install.mjs`, lines 108-115
  - Add unconditional `CLI_WRAPPER_PATH` deletion BEFORE extension dir removal
  - Wrapper cleanup happens even if extension dir doesn't exist

- [ ] **T3: Add collision guard comment**
  - File: `install.mjs`, line ~147 (after collision guard exit)
  - Add comment: "Collision guard skips both extension copy AND CLI wrapper creation. Dev workflow uses tsx from the repo directly — wrapper is for end-user installs only."

- [ ] **T4: Add wrapper creation after copyDir**
  - File: `install.mjs`, after the existing `copyDir(PACKAGE_DIR, EXTENSION_DIR)` call
  - Call `resolveJitiPath()` → if jiti found, write wrapper script to `CLI_WRAPPER_PATH` with mode 0o755
  - Wrapper content: bash script with graceful jiti-not-found check, exec node + jiti + cli/index.ts
  - If jiti not found: print warning, skip wrapper creation (don't crash install)
  - Add "CLI: pi-messenger-cli → path" to the install success output

- [ ] **T5: Add CLI validation warning to runtime-spawn.ts**
  - File: `crew/runtime-spawn.ts`, inside the `if (runtime !== "pi" && !options?.skipCommandCheck)` block (line ~48)
  - After `validateCommandAvailable(command)`, add `which pi-messenger-cli` check
  - On failure: add warning to `warnings[]` (not a fatal error)
  - Workers can still function without mesh coordination

- [ ] **T6: Add wrapper creation/removal tests**
  - Test wrapper creation: verify file exists at BIN_DIR, is executable (mode 0o755), contains correct jiti path and extension dir
  - Test unconditional removal: verify wrapper deleted even when extension dir is missing
  - Test idempotent: run creation twice → no errors, correct content

- [ ] **T7: Add graceful-failure test**
  - Create wrapper with non-existent jiti path
  - Execute wrapper via `execFileSync`
  - Assert: exit code 1, stderr contains "jiti not found" and "Re-run: npx pi-messenger"

- [ ] **T8: Add runtime-spawn CLI warning test**
  - Mock `which pi-messenger-cli` to fail (or use a temp PATH without it)
  - Call `buildRuntimeSpawn()` with a non-pi runtime
  - Assert: `warnings` array contains a message about `pi-messenger-cli not found`

## Verification

- [ ] **T9: Run full test suite**
  - `npx vitest run` — all tests must pass (existing 477 + new)
  - Specifically verify existing `tests/crew/cli.test.ts` (17 tests) still passes

- [ ] **T10: Manual smoke test**
  - `node install.mjs --force` (override collision guard for testing)
  - `which pi-messenger-cli` → returns `~/.pi/agent/bin/pi-messenger-cli`
  - `pi-messenger-cli --help` from `/tmp` → shows help
  - `node install.mjs --remove` → `which pi-messenger-cli` returns nothing
