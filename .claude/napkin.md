# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-03-10 | NiceStorm bug report | Diagnosed challenger idle as "context overflow / silent error" without checking feed timestamps | Always check feed.jsonl timestamps first — spawn/dismiss intervals reveal patience issues before theorizing about code bugs |
| 2026-03-10 | NiceStorm challenger spawns | NiceStorm dismissed challengers after 77-131s; they needed 3-10 min | Spawn result now includes patience reminder. agent-collaboration.md updated with explicit wait protocol |
| 2026-03-12 | Dale correction | Assumed we'd merge PR to upstream and npm publish to release spec 004 | We don't own upstream. We install our fork locally via `node install.mjs`. Never propose upstream merge/npm publish without explicit user direction |
| 2026-03-12 | Dale correction | Messaged WildNova by wrong name (called them WildNova, they are HappyFalcon) | Agent name ≠ session name. WildNova is the session/mesh identity; HappyFalcon is the agent who was in the shaping session. Check context before assuming identity |
| 2026-03-18 | Dale correction | `~/.pi/agent/bin/` assumed to be in system PATH — survived shaping, planning, 6 Codex rounds, implementation, and code verification. User caught it in 5 seconds from Terminal. | Every agent runs inside pi where getShellEnv() adds the bin dir. That's an environmental bias, not reality. ALWAYS test PATH-dependent features with `env -i PATH=... which <cmd>` from a clean shell. The Homebrew bin (`/opt/homebrew/bin/`) is the real system-wide PATH on macOS. |
| 2026-03-18 | Codex agent logs | CLI read-only commands (list, status, feed) re-registered the caller's PID, clobbering the spawn process's registration. Collaborators then failed to deliver messages because `validateTargetAgent` saw the dead PID from the short-lived list process. | Read-only CLI commands must NEVER write to the registry. Only mutating commands (join, send, reserve, spawn, etc.) should register. Fixed in `READ_ONLY_COMMANDS` set + `bootstrap({ register: false })`. |

## User Preferences
- "Best in class, tested, repeatable, updatable, installed and ready to use" — no quick fixes, no bandaids without explicit approval
- macOS only — don't propose Linux-specific conventions (~/.local/bin, XDG)
- When spawn is broken, fix spawn — don't work around it by substituting collaborators
- **ALWAYS verify PATH-dependent features from a clean shell** (`env -i PATH="/opt/homebrew/bin:/usr/bin:/bin" which <cmd>`), NEVER from inside pi. Pi's getShellEnv() adds ~/.pi/agent/bin/ which masks the real PATH. This blind spot survived 8 shapes, 3 challengers, 6 Codex rounds, and a full implementation before the user caught it in 5 seconds from Terminal.

## Patterns That Work
- Full `/ground→/shape→/plan→/codex-review→/implement` lifecycle works end-to-end (confirmed 2026-03-09, spec 011)
- Codex review gate (3 rounds) caught 10 issues pre-implementation — always worth the gate
- Two-agent planning with adversarial challenger catches architectural issues early
- Dual-push auto-sync (laptop→mini) is reliable — changes land immediately after `git push`
- Mode 2 collaboration (user-directed existing agent) works well — LoudArrow diagnosed spawn stall root cause via mesh messaging
- Pi has `~/.pi/agent/bin/` managed bin dir with PATH injection via `getShellEnv()` — but this is pi-internal only. For system-wide CLI access, symlink into `/opt/homebrew/bin/` (Homebrew's bin, always in PATH on macOS)
- Lighter spawn prompts: only include what's needed for FIRST response. File reads can happen during conversation.

## Patterns That Don't Work
- **CLI read-only commands clobbering spawn registrations** — Every CLI invocation used to re-register, so `list` would overwrite the PID left by `spawn`. When `list` exits, collaborators see the caller as dead. Fixed: `READ_ONLY_COMMANDS` bypass registration.
- **Dismissing collaborators before they respond** — challengers need 3-10 min on large codebases. Check token count delta (increasing = still working) before assuming stuck.
- **D5 absolute timeout kills working spawns** — spec 006 D5 (300s absolute timeout) fires during spawn when collaborator is actively reading files. Root cause: pollForCollaboratorMessage has no context awareness. Fix: spec 008 adds `context: "spawn" | "send"` to PollOptions, gates D5 to send-only.
- `((var++))` with `set -e` silently aborts when var=0 — use `var=$((var + 1))`
- `git rev-parse --short` produces different-length SHAs across machines — use `--short=7`
- `pi list` regex matching (npm:|../) misses absolute-path identifiers — match by indent level instead

## Domain Notes
- Pi extension project — NOT a Swift/Apple project. `gj` commands do not apply here.
- TypeScript codebase, vitest for testing, no build step (pi loads .ts directly)
- File-based coordination (JSON in ~/.pi/agent/messenger/ and .pi/messenger/)
- Crew agents are spawned as `pi --mode json` subprocesses
- Author: Nico Bailon (nicobailon on GitHub)
- **FORK MGMT**: We don't own pi-messenger. Upstream = `nicobailon/pi-messenger`, fork = `carmandale/pi-messenger`. We are NOT ready to submit upstream — don't propose it.
- **Install path**: Dev repo at `~/Groove Jones Dropbox/Dale Carman/Projects/dev/pi-messenger` → run `node install.mjs` → copies files to `~/.pi/agent/extensions/pi-messenger/` → pi loads from there at session start. No npm publish needed.
- **Current versions**: Extensions dir = v0.14.0 (our fork, spec 004 blocking). Global npm = v0.13.0 (upstream, untouched). Pi loads from extensions dir, NOT from npm global.
- **Never `pi install npm:pi-messenger` on laptop** — overwrites fork with older upstream
- **After code changes**: Must re-run `node install.mjs` from dev repo to update the extensions dir. New pi sessions pick up changes automatically (no pi restart needed for extension file changes, but agents in-flight use old code).
- **Mini-ts**: Still on v0.13.0 (upstream npm). Not urgent — HappyFalcon handling separately. Would need `scp -r` or similar to push extension files there.
- Mac mini SSH: `ssh mini-ts` (user chipcarman@chips-mac-mini)
- **Branch**: `feat/002-multi-runtime-support` is active dev branch on fork. PR #9 open against upstream but NOT for merging yet.

## Additional Domain Notes
- **pi-messenger-cli spawn/dismiss**: Added in spec 007. Uses FIFO stdin to keep collaborator alive between CLI invocations. State files in ~/.pi/agent/messenger/collaborators/. This is what makes the CLI actually useful — without spawn, non-pi agents can't participate in the collaboration protocol.
