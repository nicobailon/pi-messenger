---
title: "Deploy Parity — Bulletproof Laptop/Mini-ts Sync"
date: 2026-03-25
bead: pi-messenger-3c6
---

<!-- issue:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T15:04:46Z -->

# 011 — Deploy Parity: Bulletproof Laptop/Mini-ts Sync

## Problem

pi-messenger is integral infrastructure — the extension powers all multi-agent coordination and the CLI is the only mesh access for non-pi agents (Claude Code, Codex). A broken or stale install on either machine silently breaks agent workflows with no warning.

### Current state (verified 2026-03-25)

**Laptop (working):**
- Settings.json local path → dev repo (extension loads live from source) ✅
- CLI wrapper at `/opt/homebrew/bin/pi-messenger-cli` → dev repo ✅
- Dual-push configured (GitHub + mini-ts) ✅
- HEAD: `fc79541` (spec 010 complete) ✅

**Mini-ts (broken):**
- Settings.json relative path `../../dev/pi-messenger-fork` → working copy ✅
- Code synced via `receive.denyCurrentBranch = updateInstead` ✅
- Post-receive hook runs `npm install` when package.json changes ✅
- HEAD: `fc79541` (in sync after push) ✅
- **CLI wrapper: NOT INSTALLED** ❌ — `which pi-messenger-cli` → not found
- **Homebrew bin symlink: MISSING** ❌ — `/opt/homebrew/bin/pi-messenger-cli` doesn't exist
- **Pi bin wrapper: MISSING** ❌ — `~/.pi/agent/bin/pi-messenger-cli` doesn't exist

**Impact:** Any agent running on mini-ts that tries to use `pi-messenger-cli` (Claude Code, Codex, crew workers) gets "command not found". The entire multi-runtime story is broken on mini-ts.

### Root causes

1. **Post-receive hook gap:** The post-receive hook on mini-ts only runs `npm install` when package.json changes. It never runs `node install.mjs` which creates the CLI wrapper + Homebrew symlink. The CLI wrapper was never set up on mini-ts because nobody ran `node install.mjs` there.

2. **Collision guard bug in install.mjs:** The collision guard checks `path.basename(entry) === "pi-messenger"`. Mini-ts settings.json has `../../dev/pi-messenger-fork` → basename is `pi-messenger-fork` ≠ `pi-messenger`. Guard misses, creates an extensions dir copy that competes with the local path package. CLI wrapper then points to the stale extensions copy instead of the live dev repo. Verified: running `node install.mjs` on mini-ts created `/Users/chipcarman/.pi/agent/extensions/pi-messenger/` and the wrapper pointed there.

3. **No health check:** No way to detect that the CLI wrapper points to the wrong directory, or that an extensions copy exists when it shouldn't.

### How agent-config solves this

Agent-config's post-receive hook on mini-ts runs `install.sh` on **every push** — not just when config files change. This ensures symlinks, hooks, and generated artifacts are always current. Pi-messenger should follow the same pattern.

## Requirements

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | After `git push`, both laptop and mini-ts have identical pi-messenger functionality — extension loads, CLI works, same version | Core goal |
| R1 | Mini-ts post-receive hook creates/updates the CLI wrapper + Homebrew symlink on every push | Must-have |
| R2 | A health check script verifies setup correctness on both machines: settings.json path valid, CLI reachable, jiti exists, versions match | Must-have |
| R3 | First-time setup on a new machine is a single command (like agent-config's `setup.sh`) | Must-have |
| R4 | `parity-check.sh` in agent-config gains a CLI-availability check alongside the existing version/branch/source checks | Must-have |
| R5 | The napkin is corrected — no more "must re-run install.mjs" (local path mode makes code changes live; CLI wrapper persists) | Must-have |
| R6 | Zero manual steps after `git push` — everything auto-deploys | Must-have |
| R7 | install.mjs collision guard matches `pi-messenger-fork` and other variants, not just exact `pi-messenger` basename | Must-have |
| R8 | CLI wrapper always points to the live dev repo path (from settings.json), never to a stale extensions copy | Must-have |

## Scope

### In scope

1. **Post-receive hook enhancement** — Add `node install.mjs` to the mini-ts post-receive hook. Runs after every push (like agent-config's pattern). Creates CLI wrapper + Homebrew symlink if missing, updates if stale.

1b. **Collision guard fix in install.mjs** — Change basename match to substring: `name.includes("pi-messenger")` instead of `name === "pi-messenger"`. This catches `pi-messenger-fork`, `pi-messenger-dev`, etc. When collision detected, CLI wrapper must point to the settings.json path (the live dev repo), not PACKAGE_DIR or the extensions dir.

2. **Health check script** (`scripts/health-check.sh`) — Verifies:
   - Settings.json contains pi-messenger entry and path resolves to a directory
   - `pi-messenger-cli --help` works (exit 0)
   - CLI wrapper SOURCE_DIR matches the settings.json path
   - jiti exists at baked path
   - package.json version matches between settings path and HEAD
   - Outputs clear PASS/FAIL per check with fix instructions

3. **First-time setup** (`scripts/setup-machine.sh`) — Single command:
   - Checks if pi-messenger is in settings.json; if not, adds it
   - Runs `node install.mjs` to create CLI wrapper
   - Runs health check to verify
   - Idempotent — safe to re-run

4. **Parity check enhancement** — Add `pm_cli_available` check to `~/.agent-config/scripts/parity-check.sh`:
   - Local: `which pi-messenger-cli` → found/not found
   - Remote: same check over SSH
   - Verdict: PASS if both found, DRIFT/MISSING otherwise

5. **Napkin correction** — Remove stale "must re-run install.mjs" entries. Replace with:
   - "Local path mode: code changes live immediately. CLI wrapper created once by install.mjs and persists across commits."
   - "After first-time setup: `git push` is the only deploy step."

6. **Immediate fix** — Run `node install.mjs` on mini-ts via SSH to create the CLI wrapper now. Don't wait for the spec to be implemented.

### Out of scope

- Changing pi's package loading mechanism
- npm publish to upstream
- Windows/Linux support
- Changing the dual-push or receive.denyCurrentBranch mechanism (already working)

## Acceptance Criteria

1. After `git push` from laptop, mini-ts has `pi-messenger-cli` in PATH and it works
2. `scripts/health-check.sh` reports all green on both machines
3. `parity-check.sh` shows `pm_cli_available: PASS` on both machines
4. `scripts/setup-machine.sh` on a fresh machine produces a working install
5. Napkin no longer mentions "re-run install.mjs"
6. No manual steps between commit and working deploy on both machines

## File Impact

| File | Change |
|------|--------|
| `install.mjs` | Fix collision guard substring match + CLI wrapper points to settings.json path |
| `mini-ts:~/dev/pi-messenger-fork/.git/hooks/post-receive` | Add `node install.mjs` call |
| `scripts/health-check.sh` | New — setup verification |
| `scripts/setup-machine.sh` | New — first-time setup |
| `~/.agent-config/scripts/parity-check.sh` | Add pm_cli_available check |
| `.claude/napkin.md` | Correct stale install instructions |

## Constraints

- Post-receive hook must be fast — `node install.mjs` with collision guard (local path mode) only creates the CLI wrapper, no file copy. Should be <2s.
- Health check must work without SSH (local-only mode) and with SSH (cross-machine mode).
- Setup script must be idempotent — running it twice does nothing harmful.
- CLI wrapper path is `/opt/homebrew/bin/pi-messenger-cli` (Homebrew bin, universal PATH on macOS).
