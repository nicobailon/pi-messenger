---
title: "Shaping transcript — spec 007 cli global install"
date: 2026-03-18
bead: pi-messenger-32a
shaping: true
---

<!-- shape:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-18T19:37:38Z -->

# Shaping Transcript: Spec 007 — CLI Global Install

**Driver:** TrueBear (pi/claude-opus-4-6)
**User:** Dale (present, approved requirements)
**Challenger Round 1:** PureMoon, LoudMoon (both stalled at 300s — led to spec 008)
**Root Cause Assist:** LoudArrow (Mode 2, diagnosed D5 spawn regression)
**Challenger Round 2:** UltraDragon (crew-challenger, approved Shape H)

## Requirements (R)

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

R0-R4, R6 established by TrueBear, approved by Dale. R5 hardened from "Undecided" to "Must-have" based on investigation of tsx shebang overhead. R7 added based on Dale's "repeatable ability to update" feedback. macOS-only constraint noted (Dale's direction).

## Shapes Explored

### A: Symlink to .ts with tsx shebang — DEAD (fails R5)
Symlink in bin dir → cli/index.ts. Relies on `#!/usr/bin/env -S npx tsx` shebang. Every invocation does npx resolution (200-500ms overhead, fragile). tsx not even globally installed (`which tsx` → exit 127).

### B: Shell wrapper calling npx tsx — DEAD (fails R5)
Same npx overhead, same tsx dependency. Wrapping it in bash doesn't fix the underlying problem.

### C: Env-injected PATH (workers only) — DEAD (fails R0)
Don't install globally, just inject extension's cli/ dir into worker PATH. Workers can call it, but nobody else can. Fails core goal.

### D: Bundle to JS during install (original esbuild proposal) — SUPERSEDED
Compile cli/index.ts → single .mjs via esbuild, copy to ~/.pi/agent/bin/. Eliminated by challenger (UltraDragon) findings: R7 concern (dev workflow gap), __dirname breaks version command, dynamic imports become static, 7,400-line bundle bloat from transitive imports, esbuild adds ~10MB dependency.

### E: Bundle to JS + drop in ~/.pi/agent/bin/ — SUPERSEDED
Refinement of D. Same mechanism, leveraging pi's existing `getShellEnv()` PATH convention. Challenger identified same bundling issues as D.

### E' (esbuild, revised): — VIABLE but complex
Original E with __dirname fix (inject version at bundle time). Accepts findings 2-5 as tradeoffs. Works but carries esbuild dependency and bundle baggage.

### F (thin wrapper + extension-local tsx): — VIABLE but operationally complex
Wrapper in bin/ runs tsx from extension's node_modules. But install.mjs SKIP set excludes node_modules, requiring post-copy `npm install tsx --prefix`. Adds network dependency to install.

### G (thin wrapper + esbuild-compiled dist/): — NOT WORTH IT
esbuild compiles to dist/ inside extension dir, wrapper points to dist/. Same esbuild dep as E'. Indirection doesn't justify the complexity.

### H: jiti wrapper — SELECTED ✅
Discovery: Pi ships with jiti (@mariozechner/jiti) which handles the .ts → .js import convention that kills Node's built-in TS support. Verified end-to-end: `node jiti-cli.mjs cli/index.ts --help` works perfectly from any directory.

## Shape H Detail

| Part | Mechanism |
|------|-----------|
| H1 | install.mjs resolves pi's jiti path (via `which pi` → symlink → node_modules) |
| H2 | Writes a shell wrapper to `~/.pi/agent/bin/pi-messenger-cli` |
| H3 | Wrapper: `#!/bin/bash` + resolves jiti + `exec node "$JITI" "$EXT_DIR/cli/index.ts" "$@"` |
| H4 | Graceful failure: if jiti path doesn't exist, prints clear error + exit 1 |
| H5 | --remove deletes the wrapper |
| H6 | Re-running install.mjs regenerates the wrapper (idempotent) |
| H7 | `buildRuntimeSpawn()` validates `which pi-messenger-cli` for non-pi runtimes |

**Challenger conditions (accepted):**
1. Wrapper must have graceful failure if baked jiti path is stale
2. install.mjs must validate jiti exists before writing wrapper

**Known risk (documented, not blocking):**
jiti path is baked at install time. If pi is reinstalled to a different location, wrapper breaks until `npx pi-messenger` is re-run. Same class of issue as any symlinked binary.

## Fit Check: R × H

| Req | Requirement | Status | H |
|-----|-------------|--------|---|
| R0 | Callable from any directory | Core goal | ✅ |
| R1 | Non-pi workers can call without setup | Must-have | ✅ |
| R2 | --remove cleans up | Must-have | ✅ |
| R3 | Idempotent re-install | Must-have | ✅ |
| R4 | Spawn-time validation | Must-have | ✅ |
| R5 | No tsx/npx, no resolution overhead | Must-have | ✅ |
| R6 | Tests | Must-have | ✅ |
| R7 | Extension update = CLI live | Must-have | ✅ |

**Notes:**
- R5: Uses node + pi's jiti (ships with pi, not a new dependency)
- R7: Wrapper always executes source from extension dir — changes are immediately live

## Key Discovery: Pi's Managed Bin Dir

Pi already has `~/.pi/agent/bin/` with `getShellEnv()` prepending it to PATH for every subprocess. Currently contains `fd`. This is the standard place for managed binaries — no new conventions needed.

Evidence: `getShellEnv()` in pi's `utils/shell.ts` (line 121-133, confirmed via source map), and `~/.pi/agent/bin` is in the current process PATH.

## Key Discovery: Node Built-in TS Doesn't Work

Node 25.6.1 with `--experimental-strip-types` and `--experimental-transform-types` both fail on the `.ts` file imported with `.js` extension convention used throughout this codebase. Tested and confirmed. This eliminates "just use node" wrapper approaches.

## Outcome

Selected: **Shape H (jiti wrapper)**
Rationale: Zero new dependencies, zero bundling, R7 naturally satisfied, verified working end-to-end by adversarial challenger. Simplest viable approach — ~10 lines of implementation in install.mjs + a shell wrapper.
