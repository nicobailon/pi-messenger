---
title: "pi-messenger-cli global install — make CLI reachable from non-pi runtimes"
date: 2026-03-18
bead: pi-messenger-32a
---

<!-- issue:complete:v1 | harness: unknown | date: 2026-03-18T17:15:07Z -->
<!-- Codex Review: APPROVED after 3 rounds | model: gpt-5.4 | date: 2026-03-18 -->
<!-- Status: UNCHANGED -->
<!-- Revisions: none -->

# 007 — pi-messenger-cli Global Install

## Problem

`pi-messenger-cli` is the standalone CLI that lets non-pi runtimes (Claude Code, Codex, Gemini CLI) interact with the pi-messenger mesh. It exists in the codebase, has tests, has an adapter system that injects its usage into worker prompts, and the README documents it — but **it is never actually made available on PATH**.

### What happens today

1. `install.mjs` copies the extension to `~/.pi/agent/extensions/pi-messenger/`. It does not create any PATH entries for the CLI binary.
2. `package.json` declares `"pi-messenger-cli": "cli/index.ts"` in its `bin` field, but this only takes effect through `npm install -g` or `npm link` — neither of which is part of the install workflow.
3. The globally installed npm package (upstream v0.13.0) doesn't include the CLI at all — it was added in our fork.
4. When Crew spawns a non-pi worker, `buildCliInstructions()` in `crew/prompt.ts` tells the worker to use `pi-messenger-cli` commands. The worker tries, gets "command not found", and either fails or falls back to working without mesh coordination.
5. `runtime-spawn.ts` validates the **runtime command** (e.g., `claude`, `codex`) is in PATH, but never checks that `pi-messenger-cli` is available for the worker to call back to the mesh.
6. `cli/index.ts` uses `#!/usr/bin/env -S npx tsx` shebang — but tsx is not globally installed (`which tsx` → exit 127). The CLI was doubly broken: not on PATH AND not executable.

### Impact

The entire multi-runtime story — Claude Code adapter, Codex adapter, CLI mesh access, worker prompt injection — is wired end-to-end but broken at the last mile. Non-pi workers can't coordinate, can't mark tasks done, can't reserve files, can't send messages. The feature is documented but non-functional.

## Selected Shape: H — jiti wrapper

*Shaped collaboratively: TrueBear + Dale (user) + UltraDragon (challenger). 8 shapes explored (A-H), 5 eliminated on requirements, 2 superseded by H. See `shaping-transcript.md` for full exploration.*

### Key discoveries during shaping

1. **Pi has a managed bin directory**: `~/.pi/agent/bin/` with `getShellEnv()` prepending it to PATH for every subprocess. Currently contains `fd`. This is the standard — no new conventions needed.

2. **Node's built-in TS support doesn't work**: `--experimental-strip-types` and `--experimental-transform-types` (Node 25.6.1) both fail on the `.ts` → `.js` import extension convention used throughout this codebase. Verified experimentally.

3. **Pi ships with jiti**: `@mariozechner/jiti` handles the `.ts` → `.js` import convention correctly. Verified: `node jiti-cli.mjs cli/index.ts --help` works perfectly from any directory. jiti is a required dependency of pi — always present.

### Shape H mechanism

| Part | Mechanism |
|------|-----------|
| H1 | `install.mjs` resolves pi's jiti path (via `which pi` → symlink → node_modules) |
| H2 | Writes a shell wrapper to `~/.pi/agent/bin/pi-messenger-cli` that invokes `node "$JITI_PATH" "$EXT_DIR/cli/index.ts" "$@"` |
| H3 | Wrapper always executes source from extension dir — changes are immediately live |
| H4 | Graceful failure: if baked jiti path doesn't exist, prints clear error + exit 1 |
| H5 | `--remove` deletes the wrapper from `~/.pi/agent/bin/` |
| H6 | Re-running `install.mjs` regenerates the wrapper (idempotent) |
| H7 | `buildRuntimeSpawn()` validates `which pi-messenger-cli` for non-pi runtimes |

### Why H, not bundling

Bundling (esbuild) was the initial proposal but was superseded after challenger review found:
- `__dirname` / `import.meta.url` breaks after relocation (version command crashes)
- Dynamic `await import()` becomes static in single-file bundles (startup cost)
- 7,400-line transitive import explosion from `handlers.ts`
- esbuild adds ~10MB runtime dependency
- R7 dev-workflow gap (bundled snapshot vs live source)

Shape H avoids all of these: zero dependencies, zero bundling, ~10 lines of code.

## Requirements

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | After extension install, `pi-messenger-cli` is callable from any directory on the machine | Core goal |
| R1 | Non-pi Crew workers (Claude Code, Codex) can call `pi-messenger-cli` from their spawned subprocess without extra user setup | Must-have |
| R2 | `install.mjs --remove` fully cleans up CLI access — no orphaned binaries, links, or PATH artifacts | Must-have |
| R3 | Running `install.mjs` multiple times is idempotent — no errors, no duplicates | Must-have |
| R4 | Spawn-time validation: non-pi workers get a clear error at spawn time if CLI is unreachable, not a mystery failure mid-task | Must-have |
| R5 | CLI invocation has no dependency on dev tooling (`tsx`, `npx`) and no resolution overhead at runtime | Must-have |
| R6 | New tests cover install/remove/idempotent scenarios; existing CLI test suite continues to pass | Must-have |
| R7 | Extension update (`node install.mjs` after code changes) automatically makes CLI changes live — no second step, no stale binary | Must-have |

## Acceptance Criteria

1. `node install.mjs` → `which pi-messenger-cli` returns `~/.pi/agent/bin/pi-messenger-cli`
2. `pi-messenger-cli --help` works from any directory (not just the repo)
3. `node install.mjs --remove` → `which pi-messenger-cli` returns nothing
4. Running `install.mjs` twice in a row succeeds without errors
5. A Crew-spawned Claude Code or Codex worker can call `pi-messenger-cli task.list` from its subprocess
6. All existing tests pass (`npx vitest run`)
7. New tests cover install/remove/idempotent/spawn-validation scenarios
8. `install.mjs` validates jiti exists at resolved path before writing wrapper; clear error if not found
9. Wrapper prints clear error if baked jiti path is stale (pi reinstalled)

## Out of Scope

- npm publish (we don't own upstream)
- Upstream merge
- Changing the CLI's command set or behavior (that's spec 002 territory)
- Windows/Linux support (macOS only per user direction)
- Changing the tsx shebang in `cli/index.ts` (it's unused by the wrapper; kept for dev convenience)

## Constraints

- Must work with the dev-repo install flow (`node install.mjs` from the fork checkout)
- Must not break pi-native workflows (workers using the pi extension directly)
- Wrapper lives in `~/.pi/agent/bin/` (pi's managed bin dir, already in PATH)
- jiti path is baked at install time; if pi is reinstalled, re-run `npx pi-messenger` to fix

## Known Risk

jiti path is baked into the wrapper at install time. If pi is reinstalled to a different location (e.g., switching from Homebrew npm to nvm), the wrapper breaks until `npx pi-messenger` is re-run. Same class of issue as any path-dependent binary. Documented in troubleshooting, not blocking.
