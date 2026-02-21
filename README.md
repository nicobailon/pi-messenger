<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-messenger/main/banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger

**What if multiple agents in different terminals sharing a folder could talk to each other like they're in a chat room?** Join, see who's online and what they're doing. Claim tasks, reserve files, send messages. An extension for [Pi coding agent](https://pi.dev/) — install it and go. No daemon, no server, just files.

[![npm version](https://img.shields.io/npm/v/pi-messenger?style=for-the-badge)](https://www.npmjs.com/package/pi-messenger)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

## Installation

```bash
pi install npm:pi-messenger
```

Crew agents ship with the extension (`crew/agents/*.md`) and are discovered automatically. The `pi-messenger-crew` skill is auto-loaded from the extension.

To show available crew agents:

```bash
npx pi-messenger --crew-install
```

To customize an agent for one project, copy it to `.pi/messenger/crew/agents/` and edit it.

To remove the extension:

```bash
npx pi-messenger --remove
```

To remove stale crew agent copies from the shared legacy directory (`~/.pi/agent/agents/`):

```bash
npx pi-messenger --crew-uninstall
```

## Quick Start

Once joined (manually or via `autoRegister` config), agents can coordinate:

```typescript
pi_messenger({ action: "join" })
pi_messenger({ action: "reserve", paths: ["src/auth/"], reason: "Refactoring" })
pi_messenger({ action: "send", to: "GoldFalcon", message: "auth is done" })
pi_messenger({ action: "release" })
```

For multi-agent task orchestration from a PRD:

```typescript
pi_messenger({ action: "plan" })                       // Planner analyzes codebase, creates tasks
pi_messenger({ action: "work", autonomous: true })      // Workers execute tasks in waves until done
pi_messenger({ action: "review", target: "task-1" })    // Reviewer checks implementation
```

## Features

**Living Presence** - Status indicators (active, idle, away, stuck), tool call counts, token usage, and auto-generated status messages like "on fire" or "debugging...". Your agent name appears in the status bar: `msg: SwiftRaven (2 peers) ●3`

**Activity Feed** - Unified timeline of edits, commits, test runs, messages, and task events. Query with `{ action: "feed" }`.

**Discovery** - Agents register with memorable themed names (SwiftRaven, LunarDust, OakTree). See who's active, what they're working on, which model and git branch they're on.

**Messaging** - Send messages between agents. Recipients wake up immediately and see the message as a steering prompt.

**File Reservations** - Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases on exit.

**Stuck Detection** - Agents idle too long with an open task or reservation are flagged as stuck. Peers get a notification.

**Human as Participant** - Your interactive pi session appears in the agent list with `(you)`. Same activity tracking, same status messages. Chat from the overlay.

## Chat Overlay

`/messenger` opens an interactive overlay with agent presence, activity feed, and chat:

<img width="722" height="351" alt="pi-messenger chat overlay" src="https://github.com/user-attachments/assets/4d0f1db7-90dd-4ffb-9463-560426edebd9" />

Chat input supports `@Name msg` for DMs and `@all msg` for broadcasts. Text without `@` broadcasts from the Agents tab or DMs the selected agent tab.

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch tabs (Agents, Crew, agent DMs, All) |
| `↑` `↓` | Scroll history / navigate crew tasks |
| `Enter` | Send message |
| `Esc` | Close |

## Crew: Task Orchestration

Crew turns a PRD into a dependency graph of tasks, then executes them in parallel waves.

### Workflow

1. **Plan** — Planner explores the codebase and PRD, drafts tasks with dependencies. A reviewer checks the plan; the planner refines until SHIP or `maxPasses` is reached. History is stored in `planning-progress.md`.
2. **Work** — Workers implement ready tasks (all dependencies met) in parallel waves. A single `work` call runs one wave. `autonomous: true` runs waves back-to-back until everything is done or blocked.
3. **Review** — Reviewer checks each implementation: SHIP, NEEDS_WORK, or MAJOR_RETHINK.

No special PRD format required — the planner auto-discovers `PRD.md`, `SPEC.md`, `DESIGN.md`, etc. in your project root and `docs/`. Or skip the file entirely:

```typescript
pi_messenger({ action: "plan", prompt: "Scan the codebase for bugs" })

// Plan + auto-start autonomous work when planning completes
pi_messenger({ action: "plan" })  // auto-starts workers (default)
```

### Wave Execution

Tasks form a dependency graph. Independent tasks run concurrently:

```
Wave 1:  task-1 (no deps)  ─┐
         task-3 (no deps)  ─┤── run in parallel
                             │
Wave 2:  task-2 (→ task-1) ─┤── task-1 done, task-2 unblocked
         task-4 (→ task-3) ─┘── task-3 done, task-4 unblocked

Wave 3:  task-5 (→ task-2, task-4) ── both deps done
```

The planner structures tasks to maximize parallelism. Foundation work has no dependencies and starts immediately. Features that don't touch each other get separate chains. Autonomous mode stops when all tasks are done or blocked.

### Crew Configuration

Crew spawns multiple LLM sessions in parallel — it can burn tokens fast. Start with a cheap worker model and scale up once you've seen the workflow. Add this to `~/.pi/agent/pi-messenger.json`:

```json
{ "crew": { "models": { "worker": "claude-haiku-4-5" } } }
```

The planner and reviewer keep their frontmatter defaults; only workers (the bulk of the spend) get the cheap model. Override per-role as needed:

```json
{
  "crew": {
    "models": {
      "worker": "claude-haiku-4-5",
      "planner": "claude-sonnet-4-6",
      "reviewer": "claude-sonnet-4-6"
    }
  }
}
```

Model strings accept `provider/model` format for explicit provider selection and `:level` suffix for inline thinking control. These work anywhere a model is specified — config, frontmatter, or per-task override:

```json
{
  "crew": {
    "models": {
      "worker": "anthropic/claude-haiku-4-5",
      "planner": "openrouter/anthropic/claude-sonnet-4:high"
    }
  }
}
```

The `:level` suffix and the `thinking.<role>` config are independent — if both are set, the suffix takes precedence and the `--thinking` flag is skipped to avoid double-application.

Full config reference (all fields optional — only set what you want to change):

```json
{
  "crew": {
    "concurrency": { "workers": 2, "max": 10 },
    "coordination": "chatty",
    "models": { "worker": "claude-haiku-4-5" },
    "review": { "enabled": true, "maxIterations": 3 },
    "planning": { "maxPasses": 1 },
    "work": {
      "maxAttemptsPerTask": 5,
      "maxWaves": 50
    }
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `concurrency.workers` | Default parallel workers per wave | `2` |
| `concurrency.max` | Maximum workers allowed (hard ceiling is 10) | `10` |
| `dependencies` | Dependency scheduling mode: `advisory` or `strict` | `"advisory"` |
| `coordination` | Worker coordination level: `none`, `minimal`, `moderate`, `chatty` | `"chatty"` |
| `messageBudgets` | Max outgoing messages per worker per level (sends rejected after limit) | `{ none: 0, minimal: 2, moderate: 5, chatty: 10 }` |
| `models.planner` | Model for planner agent | `anthropic/claude-opus-4-6` |
| `models.worker` | Model for workers (overridden by per-task or per-wave `model` param) | `anthropic/claude-haiku-4-5` |
| `models.reviewer` | Model for reviewer agent | `anthropic/claude-opus-4-6` |
| `models.analyst` | Model for analyst (plan-sync) agent | `anthropic/claude-haiku-4-5` |
| `thinking.planner` | Thinking level for planner agent | (from frontmatter) |
| `thinking.worker` | Thinking level for worker agents | (from frontmatter) |
| `thinking.reviewer` | Thinking level for reviewer agents | (from frontmatter) |
| `thinking.analyst` | Thinking level for analyst agents | (from frontmatter) |
| `review.enabled` | Auto-review after task completion | `true` |
| `review.maxIterations` | Max review/fix cycles per task | `3` |
| `planning.maxPasses` | Max planner/reviewer refinement passes | `1` |
| `work.maxAttemptsPerTask` | Auto-block after N failures | `5` |
| `work.maxWaves` | Max autonomous waves | `50` |
| `work.shutdownGracePeriodMs` | Grace period before SIGTERM on abort | `30000` |
| `work.env` | Environment variables passed to spawned workers | `{}` |

### Default Agent Models

Each crew agent ships with a default model in its frontmatter. Override any of these via `crew.models.<role>` in config:

| Agent | Role | Default Model |
|-------|------|---------------|
| `crew-planner` | planner | `anthropic/claude-opus-4-6` |
| `crew-worker` | worker | `anthropic/claude-haiku-4-5` |
| `crew-reviewer` | reviewer | `anthropic/claude-opus-4-6` |
| `crew-plan-sync` | analyst | `anthropic/claude-haiku-4-5` |

Agent definitions live in `crew/agents/` within the extension. To customize one for a project, copy it to `.pi/messenger/crew/agents/` and edit the frontmatter — project-level agents override extension defaults by name. Agents support `thinking: <level>` in frontmatter (off, minimal, low, medium, high, xhigh). Config `thinking.<role>` overrides the frontmatter value.

## API Reference

### Coordination

| Action | Description |
|--------|-------------|
| `join` | Join the agent mesh |
| `list` | List agents with presence info |
| `status` | Show your status or crew progress |
| `whois` | Detailed info about an agent (`name` required) |
| `feed` | Show activity feed (`limit` optional, default: 20) |
| `set_status` | Set custom status message (`message` optional — omit to clear) |
| `send` | Send DM (`to` + `message` required) |
| `broadcast` | Broadcast to all (`message` required) |
| `reserve` | Reserve files (`paths` required, `reason` optional) |
| `release` | Release reservations (`paths` optional — omit to release all) |
| `rename` | Change your name (`name` required) |

### Crew

| Action | Description |
|--------|-------------|
| `plan` | Create plan from PRD or inline prompt (`prd`, `prompt` optional — auto-discovers PRD if omitted, auto-starts workers unless `autoWork: false`) |
| `work` | Run ready tasks (`autonomous`, `concurrency` optional) |
| `review` | Review implementation (`target` task ID required) |
| `task.list` | List all tasks |
| `task.show` | Show task details (`id` required) |
| `task.start` | Start a task (`id` required) |
| `task.done` | Complete a task (`id` required, `summary` optional) |
| `task.block` | Block a task (`id` + `reason` required) |
| `task.unblock` | Unblock a task (`id` required) |
| `task.ready` | List tasks ready to work |
| `task.reset` | Reset a task (`id` required, `cascade` optional) |
| `crew.status` | Overall crew status |
| `crew.validate` | Validate plan dependencies |
| `crew.agents` | List available crew agents |
| `crew.install` | Show discovered crew agents and their sources |
| `crew.uninstall` | Remove stale shared-directory crew agent copies |

### Swarm (Spec-Based)

| Action | Description |
|--------|-------------|
| `swarm` | Show swarm task status |
| `claim` | Claim a task (`taskId` required) |
| `unclaim` | Release a claim (`taskId` required) |
| `complete` | Complete a task (`taskId` required) |

## Configuration

Create `~/.pi/agent/pi-messenger.json`:

```json
{
  "autoRegister": false,
  "autoRegisterPaths": ["~/projects/team-collab"],
  "scopeToFolder": false,
  "nameTheme": "default",
  "stuckThreshold": 900,
  "stuckNotify": true,
  "autoOverlayPlanning": true
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup | `false` |
| `autoRegisterPaths` | Folders where auto-join is enabled (supports `*` globs) | `[]` |
| `scopeToFolder` | Only see agents in same directory | `false` |
| `nameTheme` | Name theme: `default`, `nature`, `space`, `minimal`, `custom` | `"default"` |
| `nameWords` | Custom theme words: `{ adjectives: [...], nouns: [...] }` | — |
| `feedRetention` | Max events kept in activity feed | `50` |
| `stuckThreshold` | Seconds of inactivity before stuck detection | `900` |
| `stuckNotify` | Show notification when a peer appears stuck | `true` |
| `autoStatus` | Auto-generate status messages from activity | `true` |
| `autoOverlay` | Auto-open overlay when autonomous crew work starts | `true` |
| `autoOverlayPlanning` | Auto-open Crew overlay when planning starts or is restored in-progress | `true` |
| `crewEventsInFeed` | Include crew task events in activity feed | `true` |
| `contextMode` | Context injection level: `full`, `minimal`, `none` | `"full"` |

Config priority: project `.pi/pi-messenger.json` > user `~/.pi/agent/pi-messenger.json` > `~/.pi/agent/settings.json` `"messenger"` key > defaults.

## How It Works

Pi-messenger is a [pi extension](https://github.com/badlogic/pi-mono) that hooks into the agent lifecycle. It uses `pi.on("tool_call")` and `pi.on("tool_result")` to track activity — every edit, commit, and test run gets logged. `pi.on("session_start")` handles auto-registration, `pi.on("session_shutdown")` cleans up, and `pi.on("agent_end")` drives autonomous crew mode by checking for ready tasks after each agent turn.

Incoming messages wake the receiving agent via `pi.sendMessage()` with `triggerTurn: true` and `deliverAs: "steer"`, which injects the message as a steering prompt that resumes the agent. File reservations are enforced by returning `{ block: true }` from a `tool_call` hook on write/edit operations. The `/messenger` overlay uses `ctx.ui.custom()` for the chat TUI, and `ctx.ui.setStatus()` keeps the status bar updated with peer count and unread messages.

Crew workers are spawned as `pi --mode json` subprocesses with the agent's system prompt, model, and tool restrictions from their `.md` definitions. Progress is tracked via JSONL streaming — the overlay subscribes to a live progress store that shows each worker's current tool, call count, and token usage in real time. Aborting a work run triggers graceful shutdown: each worker receives an inbox message asking it to stop, followed by a grace period before SIGTERM. The planner and reviewer work the same way — just pi instances with different agent configs.

All coordination is file-based, no daemon required. Shared state (registry, inboxes, swarm claims/completions) lives in `~/.pi/agent/messenger/`. Activity feed and crew data are project-scoped under `.pi/messenger/` inside your project. Dead agents are detected via PID checks and cleaned up automatically.

## Credits

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** by [@doodlestein](https://x.com/doodlestein) — Inspiration for agent-to-agent messaging
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
