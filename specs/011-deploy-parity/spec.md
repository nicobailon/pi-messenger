---
title: "Deploy Parity — Bulletproof Laptop/Mini-ts Sync"
date: 2026-03-25
bead: pi-messenger-3c6
shaped: true
---

<!-- gate:issue:complete pi/claude-opus-4-6 | date: 2026-03-25T15:05:00Z -->
<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-25 -->
<!-- Status: UNCHANGED -->
<!-- Revisions: none -->

# 011 — Deploy Parity: Bulletproof Laptop/Mini-ts Sync

## Problem

pi-messenger is integral infrastructure — the extension powers all multi-agent coordination and the CLI is the only mesh access for non-pi agents. A broken or stale install on either machine silently breaks agent workflows.

### Current state (verified 2026-03-25)

**Laptop (working):** Settings.json local path → dev repo (live). CLI wrapper → dev repo. Dual-push configured. ✅

**Mini-ts (fixed manually, fragile):** Settings.json `../../dev/pi-messenger-fork` → working copy. Code synced via `updateInstead`. CLI wrapper manually created pointing to dev repo. **But:**
- Post-receive hook doesn't run install.mjs → wrapper won't be recreated if deleted
- install.mjs has collision guard bug → running it creates stale extensions copy
- No health check to verify setup is correct

### Root causes

1. **Post-receive hook gap:** Only runs `npm install` when package.json changes. Never runs `node install.mjs` which creates the CLI wrapper + Homebrew symlink.

2. **Collision guard bug in install.mjs:** Checks `path.basename(entry) === "pi-messenger"`. Mini-ts has `../../dev/pi-messenger-fork` → basename `pi-messenger-fork` ≠ `pi-messenger`. Guard misses → creates stale extensions copy → CLI wrapper points to copy instead of live dev repo.

3. **No health check:** No way to detect wrapper pointing to wrong directory, stale extensions copy, or missing CLI.

## Requirements

Shaped with adversarial challenger (LoudTiger). See `shaping-transcript.md`.

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | After git push, both machines have identical pi-messenger: extension loads, CLI works, same version | Core goal |
| R1 | Post-receive runs `node install.mjs` from `$REPO_DIR` on every push | Must-have |
| R2 | Standalone health check: settings.json path valid, CLI reachable, wrapper SOURCE_DIR matches repo, jiti exists | Must-have |
| R3 | First-time setup: `scripts/setup-machine.sh [path]` adds to settings.json, runs install, verifies | Must-have |
| R4 | Collision guard matches variants: `name === "pi-messenger" || name.startsWith("pi-messenger-")` | Must-have |
| R5 | On collision, wrapper SOURCE_DIR = resolved path from settings.json (three-way: npm prefix -g / absolute / relative) | Must-have |
| R6 | Zero manual steps after push | Must-have |
| R7 | Post-receive runs from worktree ($REPO_DIR), not .git dir | Must-have |

## Selected Shape: B — Dedicated Scripts

| Part | Mechanism |
|------|-----------|
| **B1** | Collision guard fix: `name === "pi-messenger" \|\| name.startsWith("pi-messenger-")` |
| **B2** | On collision: three-way resolution (npm → `npm prefix -g` + node_modules path, absolute → use directly, relative → resolve against settings.json dir), pass to `installCliWrapper()` |
| **B3** | Post-receive: `cd "$REPO_DIR" && node install.mjs && bash scripts/health-check.sh --quiet` |
| **B4** | `scripts/health-check.sh` — standalone bash. Checks: `which pi-messenger-cli`, parse wrapper SOURCE_DIR, validate jiti, compare versions, check settings.json. Exit 0 = healthy, exit 1 = problems with fix instructions |
| **B5** | `scripts/setup-machine.sh [path]` — add to settings.json (CWD default), validate package.json name, run install.mjs, run health-check.sh |
| **B6** | Post-receive failure: stderr warning + `.pi-messenger-health-failed` marker. No mesh messaging (circular dependency). |

## Acceptance Criteria

1. `git push` from laptop → mini-ts CLI works (`pi-messenger-cli --help` returns 0)
2. `scripts/health-check.sh` reports all green on both machines
3. `scripts/setup-machine.sh` on a clean settings.json produces a working install
4. Running `node install.mjs` on mini-ts (with `pi-messenger-fork` in settings.json) does NOT create an extensions copy
5. CLI wrapper SOURCE_DIR matches the settings.json entry path
6. Post-receive completes in <3s (install + health check combined)
7. Health check failure in post-receive: stderr warning visible in push output + marker file

## Constraints

- Post-receive total time: <3s for install.mjs + health-check.sh
- Health check is pure bash — no node dependency (must work even if node is broken)
- setup-machine.sh takes `[path]` argument, defaults to CWD
- No mesh messaging from health check (pi-messenger may be the broken thing)
- Cross-repo parity-check.sh update is a follow-up in agent-config, not part of this spec

## File Impact

| File | Change |
|------|--------|
| `install.mjs` | Collision guard fix (startsWith) + three-way resolution for wrapper SOURCE_DIR |
| `scripts/health-check.sh` | New — standalone setup verification |
| `scripts/setup-machine.sh` | New — first-time machine setup |
| `mini-ts:.git/hooks/post-receive` | Add install.mjs + health-check.sh calls |
