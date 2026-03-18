---
title: "pi-messenger-cli global install — make CLI reachable from non-pi runtimes"
date: 2026-03-18
bead: pi-messenger-32a
---

<!-- issue:complete:v1 | harness: unknown | date: 2026-03-18T17:15:07Z -->

# 007 — pi-messenger-cli Global Install

## Problem

`pi-messenger-cli` is the standalone CLI that lets non-pi runtimes (Claude Code, Codex, Gemini CLI) interact with the pi-messenger mesh. It exists in the codebase, has tests, has an adapter system that injects its usage into worker prompts, and the README documents it — but **it is never actually made available on PATH**.

### What happens today

1. `install.mjs` copies the extension to `~/.pi/agent/extensions/pi-messenger/`. It does not create any symlinks or PATH entries for the CLI binary.
2. `package.json` declares `"pi-messenger-cli": "cli/index.ts"` in its `bin` field, but this only takes effect through `npm install -g` or `npm link` — neither of which is part of the install workflow.
3. The globally installed npm package (upstream v0.13.0) doesn't include the CLI at all — it was added in our fork.
4. When Crew spawns a non-pi worker, `buildCliInstructions()` in `crew/prompt.ts` tells the worker to use `pi-messenger-cli` commands. The worker tries, gets "command not found", and either fails or falls back to working without mesh coordination.
5. `runtime-spawn.ts` validates the **runtime command** (e.g., `claude`, `codex`) is in PATH, but never checks that `pi-messenger-cli` is available for the worker to call back to the mesh.

### Impact

The entire multi-runtime story — Claude Code adapter, Codex adapter, CLI mesh access, worker prompt injection — is wired end-to-end but broken at the last mile. Non-pi workers can't coordinate, can't mark tasks done, can't reserve files, can't send messages. The feature is documented but non-functional.

## Requirements

### R1: `install.mjs` makes `pi-messenger-cli` executable and reachable

After running `node install.mjs`, the `pi-messenger-cli` command must be available on PATH for any process on the same machine. The mechanism must survive across terminal sessions (not just the current shell).

### R2: Symlink, don't copy

The binary should be a symlink to the installed extension copy, not a second copy. When `install.mjs` updates the extension (clean + re-copy), the symlink target is recreated and the symlink remains valid.

### R3: `--remove` cleans up

`npx pi-messenger --remove` (or `node install.mjs --remove`) must remove the symlink along with the extension directory.

### R4: Idempotent

Running `node install.mjs` multiple times must not create duplicate symlinks or fail on existing ones. Overwrite/recreate on each install.

### R5: Spawn-time validation

When `buildRuntimeSpawn()` prepares a non-pi worker, it should validate that `pi-messenger-cli` is in PATH and emit a clear error if not (similar to how it validates the runtime command itself).

### R6: Shebang correctness

`cli/index.ts` uses `#!/usr/bin/env -S npx tsx`. This requires `tsx` to be available. Verify this works from the symlink location. If not, consider alternatives (e.g., shipping a compiled JS wrapper, or using a shell wrapper that resolves the path).

### R7: Tests

- Unit test: `install.mjs` creates the symlink, `--remove` removes it, idempotent re-install works.
- Integration test: spawned non-pi worker can actually call `pi-messenger-cli --help` (or `pi-messenger-cli join`) from a subprocess.
- Existing CLI tests (`tests/crew/cli.test.ts`, 301 lines) must continue to pass.

### R8: Documentation

README already documents `pi-messenger-cli` usage. Add an installation note clarifying it's installed automatically with the extension. No separate install step needed.

## Acceptance Criteria

1. `node install.mjs` → `which pi-messenger-cli` returns a valid path
2. `pi-messenger-cli --help` works from any directory
3. `node install.mjs --remove` → `which pi-messenger-cli` returns nothing
4. Running `install.mjs` twice in a row succeeds without errors
5. A Crew-spawned Claude Code or Codex worker can call `pi-messenger-cli task.list` from its subprocess
6. All existing tests pass (`npx vitest run`)
7. New tests cover install/remove/idempotent/spawn-validation scenarios

## Out of Scope

- npm publish (we don't own upstream)
- Upstream merge
- Changing the CLI's command set or behavior (that's spec 002 territory)
- Windows support

## Constraints

- Must work with the dev-repo install flow (`node install.mjs` from the fork checkout)
- Must not break pi-native workflows (workers using the pi extension directly)
- Symlink target should be inside `~/.pi/agent/extensions/pi-messenger/` so it updates atomically with the extension

## Open Questions

1. **Where to put the symlink?** Options: `/usr/local/bin/`, `~/.local/bin/`, `~/.pi/bin/` (with PATH setup). `/usr/local/bin/` is simplest but may need sudo. `~/.local/bin/` is in PATH on most modern systems. A `~/.pi/bin/` approach would need PATH modification instructions.
2. **tsx dependency** — Is `tsx` reliably available? If the user hasn't installed it, the shebang fails. May need a bootstrap wrapper.
