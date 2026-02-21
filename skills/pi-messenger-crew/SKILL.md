---
name: pi-messenger-crew
description: Use pi-messenger for multi-agent coordination and Crew task orchestration. Covers joining the mesh, planning from PRDs, working on tasks, file reservations, and agent messaging. Load this skill when using pi_messenger or building with Crew.
---

# Pi-Messenger Crew Skill

Use pi-messenger for multi-agent coordination and Crew task orchestration.

## Quick Reference

### Join the Mesh (Required First)
```typescript
pi_messenger({ action: "join" })
```

### Check Status
```typescript
pi_messenger({ action: "status" })
pi_messenger({ action: "list" })  // See other agents
pi_messenger({ action: "feed" })  // Activity feed
```

## Crew Workflow

### 1. Check Crew Agents
```typescript
pi_messenger({ action: "crew.agents" })  // Verify 5 agents
pi_messenger({ action: "crew.install" }) // Informational: shows discovered sources
```

### 2. Plan from PRD
```typescript
// Auto-discover PRD.md in current directory
pi_messenger({ action: "plan" })

// Or specify path
pi_messenger({ action: "plan", prd: "path/to/PRD.md" })

// Or pass an inline prompt (no PRD file needed)
pi_messenger({ action: "plan", prompt: "Scan the codebase for bugs focusing on error handling" })

// Re-plan with a steering prompt (wipes existing tasks, preserves progress notes)
pi_messenger({ action: "plan", prompt: "Split the auth module into login and registration" })

// Steer first-time planning (prompt injected into progress notes before planner runs)
pi_messenger({ action: "plan", prd: "docs/PRD.md", prompt: "focus on backend first" })

// Plan + auto-start autonomous work when planning completes
pi_messenger({ action: "plan" })  // auto-starts workers (default)

// Cancel active or stale planning
pi_messenger({ action: "plan.cancel" })
```

Re-planning rejects if any tasks are `in_progress` — stop or complete them first. The steering prompt is injected into `planning-progress.md`'s Notes section where the planner reads it on every pass.

### 3. Work on Tasks
```typescript
// Single wave (runs ready tasks once)
pi_messenger({ action: "work" })

// Autonomous (keeps running until done/blocked)
pi_messenger({ action: "work", autonomous: true })

// Override concurrency or model for this wave
pi_messenger({ action: "work", autonomous: true, concurrency: 4 })
pi_messenger({ action: "work", model: "claude-sonnet-4-20250514" })
```

### 4. Task Management
```typescript
pi_messenger({ action: "task.list" })
pi_messenger({ action: "task.ready" })  // Tasks with no pending deps
pi_messenger({ action: "task.show", id: "task-1" })
pi_messenger({ action: "task.start", id: "task-1" })
pi_messenger({ action: "task.progress", id: "task-1", message: "Implemented auth middleware" })
pi_messenger({ action: "task.done", id: "task-1", summary: "What was done" })
pi_messenger({ action: "task.block", id: "task-1", reason: "Why blocked" })
pi_messenger({ action: "task.unblock", id: "task-1" })
pi_messenger({ action: "task.reset", id: "task-1" })
pi_messenger({ action: "task.reset", id: "task-1", cascade: true })  // Reset dependents too

// Create tasks manually
pi_messenger({ action: "task.create", title: "Implement auth", content: "Detailed spec...", dependsOn: ["task-1"] })

// Split a task into subtasks (two-phase: inspect then execute)
pi_messenger({ action: "task.split", id: "task-3" })  // Inspect: shows spec, deps, dependents
pi_messenger({ action: "task.split", id: "task-3", subtasks: [
  { title: "Subtask A", content: "..." },
  { title: "Subtask B", content: "..." }
] })  // Execute: creates subtasks, parent becomes milestone
```

### 5. Task Revision
```typescript
// Revise a single task's spec (planner rewrites based on your prompt)
pi_messenger({ action: "task.revise", id: "task-3", prompt: "add error handling for network failures" })

// Revise a task and all its transitive dependents (subtree revision)
// Planner sees the full subtree and can add/remove/modify tasks
pi_messenger({ action: "task.revise-tree", id: "task-3", prompt: "split this into separate API and CLI tasks" })
```

Single revision rewrites one task's spec. Tree revision rewrites an entire subtree — the planner can modify existing tasks, add new ones (capped at 2x subtree size), remove pending ones, and rewire dependencies. Done tasks in the subtree are preserved; revisable tasks reset to `todo`.

Both revisions are mutually exclusive (only one revision at a time).

### 6. Review
```typescript
// Review a task implementation
pi_messenger({ action: "review", target: "task-1" })

// Review the overall plan
pi_messenger({ action: "review", target: "plan", type: "plan" })
```

## Overlay Keybindings

The Crew overlay (accessible via `/messenger` then tab to Crew) supports these keybindings:

**Global:** `[+/-]` Adjust worker concurrency (1-10), `[c]` Cancel active planning, `[Esc]` Close/back

**Task list view:** `[↑/↓]` Navigate, `[Enter]` Detail view

**Task actions (list and detail):**
- `[s]` Start task (todo only)
- `[r]` Reset task, `[R]` Cascade reset (reset + all dependents)
- `[u]` Unblock task (blocked only)
- `[b]` Block with reason (in_progress only)
- `[q]` Stop worker (in_progress with live worker)
- `[m]` Message worker (in_progress with live worker)
- `[S]` Split task (shows hint with command)
- `[p]` Revise task spec, `[P]` Revise subtree (not in_progress, not milestone)
- `[x]` Delete task (not while worker is active)
- `[←/→]` Navigate between tasks in detail view

## File Coordination

```typescript
// Reserve files before editing
pi_messenger({ action: "reserve", paths: ["src/index.ts", "src/types.ts"], reason: "Working on core" })

// Release when done
pi_messenger({ action: "release" })
```

## Agent Communication

```typescript
// Rename yourself
pi_messenger({ action: "rename", name: "MyAgentName" })

// Send message to specific agent
pi_messenger({ action: "send", to: "OtherAgent", message: "Hello!" })

// Broadcast to all
pi_messenger({ action: "broadcast", message: "Announcement" })
```

Messages are logged to the feed and visible in the overlay. DMs interrupt only the target agent (delivered as steering); broadcasts interrupt all agents.

## Typical Crew Session

```typescript
// 1. Join
pi_messenger({ action: "join" })

// 2. Plan (spawns planner agent)
pi_messenger({ action: "plan" })

// 3. Check tasks
pi_messenger({ action: "task.list" })

// 4. Work
pi_messenger({ action: "work", autonomous: true })

// 5. Status
pi_messenger({ action: "status" })
```

## Data Storage

Crew stores data in `.pi/messenger/crew/`:
```
.pi/messenger/crew/
├── config.json              # Project config (concurrency, models, coordination, etc.)
├── plan.json                # Plan metadata
├── planning-progress.md     # Planner output log (Notes section for steering)
├── planning-outline.md      # Latest plan outline
├── planning-state.json      # Current planning phase/pass
├── agents/                  # Optional: project-level crew agent overrides
│   └── crew-worker.md
├── tasks/
│   ├── task-1.json          # Task metadata (status, deps, summary)
│   ├── task-1.md            # Task spec (planner-generated)
│   ├── task-1.progress.md   # Worker progress log
│   └── ...
├── blocks/
│   └── task-N.md            # Block context
└── artifacts/               # Debug artifacts (agent input/output)
```

The activity feed lives at `.pi/messenger/feed.jsonl` (project-scoped, shared across all agents in the project).

Each crew agent ships with a default model:

| Agent | Role | Default Model |
|-------|------|---------------|
| `crew-planner` | planner | `anthropic/claude-opus-4-6` |
| `crew-worker` | worker | `anthropic/claude-haiku-4-5` |
| `crew-reviewer` | reviewer | `anthropic/claude-opus-4-6` |
| `crew-plan-sync` | analyst | `anthropic/claude-haiku-4-5` |

Override via `crew.models.<role>` in config. To customize an agent for a project, copy it from `~/.pi/agent/extensions/pi-messenger/crew/agents/` to `.pi/messenger/crew/agents/` and edit the frontmatter — project-level agents override extension defaults by name. Agents support `thinking: <level>` in frontmatter (off, minimal, low, medium, high, xhigh). Config `thinking.<role>` overrides the frontmatter value.

## Configuration

User-level config goes in `~/.pi/agent/pi-messenger.json` under a `crew` key. Project-level config goes in `.pi/messenger/crew/config.json`. Project overrides user, both override defaults.

Crew spawns multiple LLM sessions in parallel — start with a cheap worker model and scale up. Add this to `~/.pi/agent/pi-messenger.json`:

```json
{ "crew": { "models": { "worker": "claude-haiku-4-5" } } }
```

Model strings accept `provider/model` format for explicit provider selection and `:level` suffix for inline thinking control:

```json
{ "crew": { "models": { "worker": "anthropic/claude-haiku-4-5", "planner": "openrouter/anthropic/claude-sonnet-4:high" } } }
```

The `:level` suffix and the `thinking.<role>` config are independent — if both are set, the suffix takes precedence.

Full example (`~/.pi/agent/pi-messenger.json`):
```json
{
  "crew": {
    "concurrency": { "workers": 3, "max": 6 },
    "models": { "worker": "claude-haiku-4-5", "planner": "claude-sonnet-4-6" },
    "coordination": "chatty",
    "work": { "maxAttemptsPerTask": 5 }
  }
}
```

Project-level (`.pi/messenger/crew/config.json`):
```json
{
  "concurrency": { "workers": 4 },
  "coordination": "moderate",
  "models": { "worker": "gpt-4.1" },
  "planning": { "maxPasses": 1 },
  "work": {
    "maxWaves": 50,
    "env": { "OPENAI_API_BASE": "https://custom.endpoint" }
  }
}
```

### Key Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `concurrency.workers` | Default parallel workers per wave | `2` |
| `concurrency.max` | Maximum workers allowed via `+` key (hard ceiling: 10) | `10` |
| `dependencies` | Dependency scheduling mode: `advisory` or `strict` | `"advisory"` |
| `coordination` | Worker communication level: `none`, `minimal`, `moderate`, `chatty` | `chatty` |
| `messageBudgets` | Max outgoing messages per worker per level (sends rejected after limit) | `{ none: 0, minimal: 2, moderate: 5, chatty: 10 }` |
| `models.worker` | Default model for workers | `anthropic/claude-haiku-4-5` |
| `models.planner` | Default model for planner | `anthropic/claude-opus-4-6` |
| `models.reviewer` | Default model for reviewer | `anthropic/claude-opus-4-6` |
| `models.analyst` | Default model for analyst (plan-sync) | `anthropic/claude-haiku-4-5` |
| `thinking.planner` | Thinking level for planner agent | (from frontmatter) |
| `thinking.worker` | Thinking level for worker agents | (from frontmatter) |
| `thinking.reviewer` | Thinking level for reviewer agents | (from frontmatter) |
| `thinking.analyst` | Thinking level for analyst agents | (from frontmatter) |
| `planning.maxPasses` | Max planner/reviewer refinement passes | `1` |
| `work.maxWaves` | Max autonomous waves | `50` |
| `work.maxAttemptsPerTask` | Max attempts before auto-blocking a task | `5` |
| `work.stopOnBlock` | Stop autonomous mode when any task blocks | `false` |
| `work.shutdownGracePeriodMs` | Grace period before SIGTERM on abort | `30000` |
| `work.env` | Environment variables passed to spawned workers | `{}` |

### Coordination Levels

Controls how much workers communicate during execution:

- **`none`**: No coordination instructions. Workers just execute their task.
- **`minimal`**: Check reservations before editing files. Message if conflicts.
- **`moderate`**: Announce start/completion via broadcast. Check reservations. Ask about unclear dependencies.
- **`chatty`** (default): All of moderate, plus: DM peers whose tasks overlap, share progress on interface changes, respond to incoming messages, claim next task after completion.

At `moderate` and `chatty`, workers also receive recent activity context and concurrent task info in their prompts.

### Model Override Priority

Worker model is resolved with 4-level priority (highest wins):
1. Per-task `model` field on the task object
2. Per-wave `model` param on the work call
3. Config-level `crew.models.worker`
4. Agent `.md` frontmatter `model` field

### Graceful Shutdown

When you cancel a work run (Ctrl+C), workers receive a shutdown sequence:
1. Inbox message asking the worker to stop, release reservations, and exit
2. Wait `shutdownGracePeriodMs` (default 30s) for clean exit
3. SIGTERM if still running, wait 5s
4. SIGKILL if still running

Tasks from gracefully shutdown workers reset to `todo` for retry on the next wave. Crashed workers (non-graceful exit) block the task in autonomous mode to prevent retry loops.
