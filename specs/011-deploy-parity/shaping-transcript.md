---
shaping: true
---

<!-- shape:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T15:42:09Z -->

# 011 — Deploy Parity: Shaping Transcript

**Participants:** PureStorm (pi/claude-opus-4-6, proposer) × LoudTiger (crew-challenger, pi/claude-opus-4-6)
**Date:** 2026-03-25
**Rounds:** 2 (challenge → revise → challenge → revise/approved)

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | After git push, both machines have identical pi-messenger: extension loads, CLI works, same version | Core goal |
| R1 | Post-receive runs `node install.mjs` from `$REPO_DIR` on every push | Must-have |
| R2 | Standalone health check: settings.json path valid, CLI reachable, wrapper SOURCE_DIR matches repo, jiti exists | Must-have |
| R3 | First-time setup: `scripts/setup-machine.sh [path]` adds to settings.json, runs install, verifies | Must-have |
| R4 | Collision guard matches variants: `name === "pi-messenger" || name.startsWith("pi-messenger-")` | Must-have |
| R5 | On collision, wrapper SOURCE_DIR = resolved path from settings.json (three-way: npm/absolute/relative) | Must-have |
| R6 | Zero manual steps after push | Must-have |
| R7 | Post-receive runs from worktree ($REPO_DIR), not .git dir | Must-have |

### Requirement Evolution

- R0-R6 proposed from initial spec investigation
- R4 refined: `includes()` → `startsWith()` after LoudTiger caught false positive risk
- R5 refined: three-way resolution (npm/absolute/relative) after LoudTiger identified `npm:pi-messenger` edge case
- R7 added: post-receive CWD is .git, not worktree — caught by LoudTiger

---

## Shapes Explored

### Shape A: Fix-in-Place — Patch install.mjs + post-receive

Bundle everything into install.mjs: collision guard fix, health check (`--check` flag), setup (`--setup` flag).

**Outcome:** Passes all R except R2 is weak (health check bundled into installer, not standalone).

### Shape B: Dedicated Scripts

Fix install.mjs collision guard + three-way resolution. Add `scripts/health-check.sh` (standalone bash) and `scripts/setup-machine.sh` (first-time setup). Post-receive runs both.

**Outcome:** Selected. Standalone health check usable from parity-check.sh, cron, post-receive, and debugging.

### Shape C: Post-Receive Only — Minimal

Fix collision guard, enhance post-receive, defer health check to parity-check.sh in agent-config.

**Outcome:** Killed. Fails R2 (no standalone health check) and R3 (no setup automation).

---

## Fit Check: R × Shapes

| Req | Requirement | A | B | C |
|-----|-------------|---|---|---|
| R0 | Identical functionality after push | ✅ | ✅ | ✅ |
| R1 | Post-receive runs install.mjs from $REPO_DIR | ✅ | ✅ | ✅ |
| R2 | Standalone health check | ❌ | ✅ | ❌ |
| R3 | First-time setup single command | ✅ | ✅ | ❌ |
| R4 | Collision guard matches variants | ✅ | ✅ | ✅ |
| R5 | Wrapper → resolved settings.json path | ✅ | ✅ | ✅ |
| R6 | Zero manual steps after push | ✅ | ✅ | ✅ |
| R7 | Post-receive runs from worktree | ✅ | ✅ | ✅ |

**Notes:**
- A's health check is bundled into install.mjs (not standalone) — weaker than B for tooling integration
- C fails R2 (no standalone check) and R3 (documented steps, not automated)

---

## Selected Shape: B — Dedicated Scripts

| Part | Mechanism |
|------|-----------|
| **B1** | Collision guard fix: `name === "pi-messenger" \|\| name.startsWith("pi-messenger-")` |
| **B2** | On collision: three-way resolution (npm → npm prefix -g, absolute → use directly, relative → resolve against settingsDir), pass resolved path to `installCliWrapper()` |
| **B3** | Post-receive: `cd "$REPO_DIR" && node install.mjs && bash scripts/health-check.sh --quiet` |
| **B4** | `scripts/health-check.sh` — standalone bash. Checks: which pi-messenger-cli, parse wrapper SOURCE_DIR, validate jiti, compare versions, check settings.json. Exit 0/1. |
| **B5** | `scripts/setup-machine.sh [path]` — add to settings.json (CWD default), validate package.json name, run install.mjs, run health-check.sh |
| **B6** | Post-receive failure: stderr warning + `.pi-messenger-health-failed` marker. No mesh messaging (circular dependency). |

---

## Challenger's Concerns and Resolutions

### Round 1 (LoudTiger → PureStorm, 7 concerns)

| # | Concern | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Immediate fix runs install.mjs before collision guard fix → creates broken state | 🔴 | Already fixed manually via SSH, not via install.mjs. Removed from scope. |
| 2 | `includes("pi-messenger")` matches unrelated packages | 🔴 | Changed to `startsWith("pi-messenger-")` |
| 3 | Post-receive CWD is .git, not worktree | 🟡 | R7 added: must cd to $REPO_DIR first |
| 4 | Wrapper → PACKAGE_DIR diverges from settings.json path | 🟡 | R5: on collision, resolve settings.json entry to absolute path |
| 5 | setup-machine.sh can't know which path to add | 🟡 | Parameterized: `[path]` argument, CWD default |
| 6 | "Versions match" health check requirement is confused | 🟡 | Clarified: parse wrapper SOURCE_DIR, compare its package.json to CWD's |
| 7 | Cross-repo parity-check.sh change has no coordination story | 🟠 | Moved to agent-config follow-up, not part of this spec |

### Round 2 (LoudTiger → PureStorm, 3 refinements)

| # | Concern | Severity | Resolution |
|---|---------|----------|------------|
| 8 | R5 npm: entries can't resolve from settings entry alone | 🔴 | Three-way resolution: npm prefix -g / absolute / relative |
| 9 | Health check failure in post-receive: what happens? | 🟡 | stderr + marker file, no mesh messaging (circular) |
| 10 | Fit check: Shape A does satisfy R3 | 🟠 | Corrected. Shape B selected for standalone health check (real differentiator) |
