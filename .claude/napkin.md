# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-03-10 | NiceStorm bug report | Diagnosed challenger idle as "context overflow / silent error" without checking feed timestamps | Always check feed.jsonl timestamps first — spawn/dismiss intervals reveal patience issues before theorizing about code bugs |
| 2026-03-10 | NiceStorm challenger spawns | NiceStorm dismissed challengers after 77-131s; they needed 3-10 min | Spawn result now includes patience reminder. agent-collaboration.md updated with explicit wait protocol |

## User Preferences
- (accumulate as you learn them)

## Patterns That Work
- Full `/ground→/shape→/plan→/codex-review→/implement` lifecycle works end-to-end (confirmed 2026-03-09, spec 011)
- Codex review gate (3 rounds) caught 10 issues pre-implementation — always worth the gate
- Two-agent planning with adversarial challenger catches architectural issues early
- Dual-push auto-sync (laptop→mini) is reliable — changes land immediately after `git push`

## Patterns That Don't Work
- **Dismissing collaborators before they respond** — challengers need 3-10 min on large codebases. Check token count delta (increasing = still working) before assuming stuck.
- `((var++))` with `set -e` silently aborts when var=0 — use `var=$((var + 1))`
- `git rev-parse --short` produces different-length SHAs across machines — use `--short=7`
- `pi list` regex matching (npm:|../) misses absolute-path identifiers — match by indent level instead

## Domain Notes
- Pi extension project — NOT a Swift/Apple project. `gj` commands do not apply here.
- TypeScript codebase, vitest for testing, no build step (pi loads .ts directly)
- File-based coordination (JSON in ~/.pi/agent/messenger/ and .pi/messenger/)
- Crew agents are spawned as `pi --mode json` subprocesses
- Author: Nico Bailon (nicobailon on GitHub)
- **FORK MGMT**: We don't own pi-messenger. Upstream = nicobailon, fork = carmandale. Laptop runs local path install (v0.14.0), Mac mini has npm (v0.13.0 — stale). See `~/.agent-config/docs/pi-messenger-fork.md` for full details.
- **Never `pi install npm:pi-messenger` on laptop** — overwrites fork with older upstream
- Mac mini SSH: `ssh mini-ts` (user chipcarman@chips-mac-mini)
