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
| 2026-03-25 | Real Claude Code interaction | CLI session key uses `sha256(cwd+model)` but `--self-model` on `join` and auto-detection on `send` produce different model strings → different keys → identity rotates. Also: no `receive` command exists at all — agents can send but can never read replies. | Session lookup must fall back to CWD scan when exact key misses. `receive` command is a day-one requirement for any messaging system. Test the headline use case (send→receive round-trip) before shipping. |

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
- **Side-effect-free reads** — Any operation whose purpose is to observe (list, status, query, detect) must NEVER write shared state (registry, session files, identity). Three bugs traced to reads that silently mutated: CLI `list` clobbered spawn PID (spec 1tz), `send` auto-created sessions (spec 010), model detection changed identity (spec 010). Design rule: read paths and write paths must be completely separate code branches.

## Patterns That Don't Work
- **Session key including model string** — `sha256(cwd+model)` as session key means any change in how the model is detected (flag vs env var vs config) produces a different key. CWD-only fallback with ambiguity guard is the fix (spec 010).
- **Shipping a messaging CLI without a receive command** — The pi extension has push delivery via fs.watch(). The CLI has nothing. "Can I send and get a reply?" must be tested before any messaging feature ships.
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
- **Install path**: Dev repo registered as local path package in `~/.pi/agent/settings.json`. Pi loads extension directly from the dev repo — **no copy step needed**. Code changes are live on next pi session start.
- **CLI wrapper**: `/opt/homebrew/bin/pi-messenger-cli` → shell wrapper that uses jiti to run `cli/index.ts` from the dev repo. Created once by `node install.mjs`, persists across commits.
- **After code changes**: `git push` is the only deploy step. Dual-push syncs to mini-ts, post-receive hook handles setup. **No need to re-run install.mjs** after code changes.
- **First-time setup only**: Run `node install.mjs` once on a new machine to create the CLI wrapper. After that, changes are live via the local path package.
- **Mini-ts**: Running fork from `~/dev/pi-messenger-fork`, synced via dual-push. CLI wrapper installed and pointing to dev repo. Settings.json uses relative path `../../dev/pi-messenger-fork`.
- Mac mini SSH: `ssh mini-ts` (user chipcarman@chips-mac-mini)
- **Branch**: `feat/002-multi-runtime-support` is active dev branch on fork. PR #9 open against upstream but NOT for merging yet.

## Additional Domain Notes
- **pi-messenger-cli spawn/dismiss**: Added in spec 007. Uses FIFO stdin to keep collaborator alive between CLI invocations. State files in ~/.pi/agent/messenger/collaborators/. This is what makes the CLI actually useful — without spawn, non-pi agents can't participate in the collaboration protocol.
