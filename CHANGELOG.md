# Changelog

## [0.12.0] - 2026-02-21

### Added
- **Thinking level support** - Agents support `thinking: <level>` in frontmatter (off, minimal, low, medium, high, xhigh). Config `thinking.<role>` overrides per-agent frontmatter. Applied via `--thinking` flag to spawned processes.
- **Advisory dependencies** - Dependencies are now informational context, not scheduling blockers. All `todo` tasks are eligible for assignment regardless of dependency status. Workers see dependency completion state (done/in-progress/not started) in their prompt and coordinate via reservations and DMs. Configurable via `dependencies` config (`"advisory"` default, `"strict"` for blocking mode). Transitive dependencies pruned from plans automatically.
- **Auto-work on plan completion** - Planning automatically starts autonomous work when tasks are created (default behavior). Pass `autoWork: false` to review the plan first. A steer message triggers the LLM to call `work { autonomous: true }` on its next turn.
- **Continuous worker refill** - Overlay automatically spawns replacement workers when tasks complete, maintaining concurrency up to the configured limit throughout execution.
- **Prompt-based planning** - `plan` action accepts an inline `prompt` parameter as the spec when no PRD file is available. The planner breaks down arbitrary requests into parallel tasks the same way it handles PRD files.
- **Live feed with flash notifications** - Feed tracks last-seen timestamp and highlights new events. Significant events (task completions, messages, plan changes) trigger flash notifications in the status bar.
- **Task revision** - `[p]` revises a single task's spec via the planner. `[P]` revises an entire subtree (target + transitive dependents), preserving done tasks and resetting revisable ones to `todo`. Re-plan with steering prompt injects user guidance into the planning-progress.md Notes section.
- **Chat UX redesign** - Global `[m]` key activates chat input from any overlay state (vim-style command mode). Plain text broadcasts to all peers; `@name message` sends DMs. Tab autocompletes agent names after `@` (Shift+Tab cycles backwards). Feed gets 60/40 space allocation when workers active. `[f]` toggles feed-focus mode (tasks compress to 2-line summary). Visual improvements: system events dimmed, colored agent names, separator dots between groups.
- **Auto-dismiss on completion** - Overlay auto-closes with snapshot handover 3 seconds after all tasks complete. Only triggers when the overlay witnessed tasks in progress. Any keypress cancels.
- **Worker coordination & chatter** - Workers receive environmental context (concurrent tasks, dependency summaries, recent feed, ready tasks) and coordination instructions. Four configurable levels (`none`|`minimal`|`moderate`|`chatty`, default: `chatty`) control verbosity. At `chatty`, workers DM peers and broadcast announcements, creating a chat-room effect in the overlay. New `coordination` config field.
- **Lobby workers** - `+` spawns workers: assigns ready tasks directly when available, otherwise pre-spawns idle lobby workers that join the mesh and chat. Lobby workers receive task assignments via steer message when tasks become available. Token budgets per coordination level cap spending while idle.
- **Auto-spawn on plan completion** - Workers auto-spawn when planning finishes and ready tasks exist. Lobby workers assigned first, then fresh workers up to concurrency limit.
- **TUI coordination level control** - `[v]` cycles coordination level at runtime (`chatty` → `none` → `minimal` → `moderate`).
- **Configurable `concurrency.max`** - Crew config field (default: 10) lets the user lower the worker ceiling. `+`/`-` keys respect the configured max.
- **Stuck task UX** - `[q]` Stop works on any `in_progress` task, not just those with live workers. `[s]` Start rejects when the agent is already busy. Detail view shows "Worker not running" warning for orphaned tasks.
- **Chatter mitigation** - Per-worker outgoing message rate limiting via `messageBudgets` config. Coordination level and per-worker token count displayed in overlay header.
- **Broadcast filtering** - Worker broadcasts now go to the feed only (no inbox delivery, no LLM turn interrupts). Eliminates O(N^2) token cascades between workers. DMs, user broadcasts, and planner broadcasts still deliver to inboxes in real-time. Detection via `PI_CREW_WORKER` env var set at spawn time. Worker name consistency also fixed in `agents.ts` via `PI_AGENT_NAME`.
- **Worker exit feed notifications** - Lobby workers that exit without a task assignment now appear as `leave` events in the feed.
- **2026-02-12 Overlay redesign** - Replaced tabbed `/messenger` UI with a unified crew dashboard layout (status, workers, tasks, feed, agents row, legend), added `Ctrl+T` snapshot transfer, `Ctrl+B` background/reattach support, empty-state system diagnostics, and inline `@all` / `@name` messaging in the overlay input flow.
- **Task progress system** - Added per-task append-only progress logs (`tasks/task-N.progress.md`) with `task.progress`, system auto-entries (assignment, review verdicts, shutdown resets, crash/failure outcomes), and retry-context injection in worker prompts.
- **Interactive Crew task manager** - Crew overlay now supports list/detail modes, task actions (reset/cascade-reset/unblock/start/block/delete), in-overlay confirmations, block-reason input, live worker messaging, context-aware key hints, and transient success/failure notifications.
- **Live worker concurrency adjustment** - In the Crew overlay, `+`/`-` now adjusts worker concurrency live during execution (clamped to 1-10).
- **Auto-open overlay on autonomous work** - The Crew overlay now opens automatically when autonomous mode starts, showing live worker progress without requiring `/messenger`. Configurable via `autoOverlay` (default: `true`). Escape dismisses; won't reopen until a new autonomous session.
- **Auto-open overlay on planning work** - The Crew overlay now opens automatically when planning starts and when an in-progress planning run is restored on session start/switch/fork/tree. Configurable via `autoOverlayPlanning` (default: `true`). Uses per-run planning IDs to avoid reopen loops within the same run after dismissal.
- **Task splitting** - New `task.split` action supports an inspect phase (returns spec/progress/deps/dependents) and an execute phase that creates subtasks, rewires downstream dependencies, converts the parent to a milestone, and auto-completes milestones when all subtasks are done. Milestones can't be started manually and are never dispatched to workers.
- **Planning observability state** - Added first-class planning run state with pass/phase tracking and persistence at `.pi/messenger/crew/planning-state.json`. Status, Crew UI, and feed now expose planning progress (`plan.start`, `plan.pass.*`, `plan.review.*`, `plan.done`, `plan.failed`) so long planning runs are visible by default. Planning runs with no updates for 5 minutes are flagged as stalled in status and Crew UI, with periodic refresh so stalls surface without requiring user interaction.
- **Planning cwd normalization** - Planning state now canonicalizes project paths (realpath) and compares by canonical path, fixing false negatives when sessions use `/tmp/...` while persisted state resolves to `/private/tmp/...`.
- **Structured planning outline** - Planner prompts now require ordered sections (PRD understanding, reviewed resources, sequential steps, parallel task graph). Latest structured output is persisted to `.pi/messenger/crew/planning-outline.md` for audit/review.

- **Lobby worker keep-alive** - Lobby workers now survive the full planning phase via a file-based keep-alive signal. The orchestrator creates a `.alive` file per lobby worker; the worker's `turn_end` hook checks the file and injects a minimal steer message to prevent the session from exiting. File is deleted on task assignment, planning completion, or shutdown. ~25 tokens per keep-alive cycle.
- **`prompt` tool parameter** - The `prompt` parameter (used by `plan` and `task.revise`/`task.revise-tree`) is now declared in the tool schema so LLMs can discover it without the skill loaded.
- **Dynamic overlay width** - Overlay adapts to terminal width (clamped 40-100) instead of a fixed size. Fits half-width and quarter-width windows on smaller screens.
- **Live coordination level display** - Status bar hints now show the actual coordination level (`v:chatty`, `v:none`, etc.) instead of the opaque `v:Coord` label.

### Changed
- **Default `planning.maxPasses` reduced to 1** - Single-pass planning is now the default. Multi-pass planning with reviewer feedback is still available by setting `planning.maxPasses` in user or project config.
- **Structural cleanup** - Extracted `crew/prompt.ts` (worker prompt builder), `crew/spawn.ts` (shared spawn logic), `crew/registry.ts` (unified worker registry replacing separate maps in agents.ts and lobby.ts). Split `crew/state.ts` into `state-autonomous.ts` and `state-planning.ts` with a barrel re-export.
- **Crew agent locality** - Crew agents are now discovered from extension-local `crew/agents/` plus project overrides in `.pi/messenger/crew/agents/`. Removed auto-install/update copy machinery and converted `crew.install` / `--crew-install` to informational commands.

### Removed
- **Legacy key-based routing** - Removed the `join`, `claim`, `unclaim`, `complete`, `swarm`, `list`, `rename`, `reserve`, `release`, and `broadcast` tool parameters and the legacy routing block in `index.ts` that duplicated `crew/index.ts` action-based routing. All callers should use `action`-based syntax (e.g., `{ action: "join" }` instead of `{ join: true }`).
- **Interview handler** - Removed `crew/handlers/interview.ts`, `crew-interview-generator.md` agent, and the `interview` action. The feature spawned an LLM to generate questions for the user but never worked (got stuck). Agent moved to deprecated list for cleanup on existing installs.

### Fixed
- **Overlay rendering corruption from multi-line bash args** - `extractArgsPreview` returned raw bash `command` strings containing newlines (comments, `&&` chains, heredocs). These embedded newlines broke overlay rows, cascading layout corruption through the workers section, task list, and feed. Newlines are now collapsed to spaces at the extraction point.
- **Fire-and-forget dynamic import in `task-actions.ts`** - `killWorkerByTask` was imported via `import("./registry.js").then(...)` which swallowed errors silently. Replaced with a static import since no circular dependency exists.
- **Stale legacy syntax in user-facing strings** - Five handler/index strings still referenced removed `{ join: true }` / `{ list: true }` / `{ to: "..." }` syntax. Updated to action-based equivalents.
- **SIGKILL escalation never fired** - After `proc.kill("SIGTERM")`, Node.js immediately sets `proc.killed = true`. Both `killWorkerByTask` and `runAgent` graceful shutdown checked `!proc.killed` before escalating to SIGKILL, which was always false. Workers ignoring SIGTERM could hang indefinitely. Now checks only `exitCode === null`.
- **Lobby worker assignment zombie state** - State was mutated before the disk write, so a failed write left the worker permanently marked as assigned but invisible to future assignment. Reordered to write first, mutate on success.
- **Lobby assignment race in work handler** - If a lobby worker exited between availability check and assignment, the task got stuck as `in_progress` with no worker. Added return value check with rollback.
- **Autonomous state checks not cwd-scoped** - Auto-dismiss, snapshot generation, and revision guards used a global flag instead of per-project checks, blocking operations for unrelated projects.
- **Task flicker from lobby worker spawn** - Orchestrator and worker generated independent random names so `assigned_to` never matched. Task was also pre-set to `in_progress` but the worker expected `todo`. Fixed name propagation via env var, made `task.start` idempotent for the assigned agent, and added ownership guards in close handlers.
- **`[q]` Stop couldn't kill lobby-spawned workers** - Stop only checked one worker registry. Lobby workers are tracked separately and now have their own kill path.
- **Double-formatted message previews** - Overlay stored pre-formatted previews that the display layer formatted again. Now stores raw text; preview limit raised from 60 to 200 chars.
- **Stale workersHeight in trim loop** - Worker-line overflow trimming used a pre-computed height, causing over-trim to 0 workers on small terminals.
- **Artifact I/O crash** - Uncaught exceptions in child process event handlers crashed pi. Wrapped all artifact writes with try/catch.
- **Input field scrolling** - Text was clipped at the field edge instead of scrolling to keep the cursor visible.
- **Session shutdown orphans** - Workers now killed at the top of session shutdown, preventing orphan processes.
- **Task list blank line padding** - Task list no longer pads with empty lines. Surplus space goes to the feed.
- **`getLobbyWorkerCount` counted dead workers** - Registry function didn't filter exited processes, inflating the "N in lobby" status bar count.
- **`models.analyst` config was dead** - Config type and docs existed but `interview.ts` and `sync.ts` never read it. Now wired to both analyst handler call sites.

## [0.11.0] - 2026-02-08

### Added
- **Test suite** — 53 tests across 7 Vitest suites covering store CRUD, state machine, config merging, agent discovery, model resolution, graceful shutdown, and live progress (including cwd isolation). Includes test helpers for temp directories and mock contexts.
- **Per-agent runtime config** — Model override with 4-level priority: per-task > per-wave `model` param > config `crew.models.worker` > agent `.md` frontmatter. Environment variable override via `crew.work.env` config (not exposed as tool param to prevent API keys in logs).
- **Graceful shutdown** — `AbortSignal` threaded from tool execute through to spawned workers. On abort: discovers worker name via PID-based registry scan, writes shutdown message to worker inbox, waits 30s grace period, SIGTERM, waits 5s, SIGKILL. Tasks reset to `todo` for retry. Workers instructed to release reservations and exit without committing.
- **Live crew progress** — In-memory pub/sub store fed by worker JSONL events. Overlay Crew tab shows Active Workers section with tool name, call count, tokens, and elapsed time updating every second. Status bar shows active worker count during autonomous mode (`🔨N`).
- **`shutdownGracePeriodMs` config** — Configurable grace period before SIGTERM (default: 30000).

### Changed
- **Dynamic overlay height** — Content area scales with terminal size (8-25 lines) instead of hardcoded 10. On a standard 24-row terminal, visible content goes from 10 to 15 lines.
- **Handler signatures simplified** — Removed unused `state` and `dirs` parameters from plan and review handlers.

### Fixed
- **`deepMerge` crash** — Merging config with `models` key crashed when the target didn't have the key. Hardened for undefined target keys.
- **Result/task association** — Worker results now matched by `taskId` field instead of array index, since `spawnAgents` returns in completion order not submission order.

### Removed
- `attemptsPerTask` field from `AutonomousState` — declared but never populated by any code.
- `ARCHITECTURE.md` from repo (moved to external docs).

## [0.10.0] - 2026-02-05

### Fixed
- **Crew spawner applies agent definitions** — Spawned crew workers now receive the agent's system prompt (`--append-system-prompt`), tool restrictions (`--tools`), and model override from their `.md` definitions. Previously a phantom `--agent` flag was passed that pi-core silently ignored, the agent name leaked into the prompt as noise, and the system prompts (worker's 6-phase protocol, reviewer's rubric, planner's exploration workflow) were never delivered. Tool restrictions also take effect: reviewers and interview generators are now limited to `read,bash` instead of getting all default builtins including `write` and `edit`.
- **Crew spawner session cleanup** — Spawned workers now pass `--no-session` to avoid writing ephemeral session files to disk.

### Added
- **`--crew-install` / `--crew-uninstall` CLI flags** — `npx pi-messenger --crew-install` copies crew agent `.md` files and the `pi-messenger-crew` skill to user directories. `--crew-uninstall` removes them. Reads from the npm package (not the installed extension) to avoid version skew.

### Changed
- **README rewrite** — Installation section now shows real CLI commands instead of tool-call syntax. "How It Works" section explains pi extension API hooks (`pi.on()`, `pi.sendMessage()`, `{ block: true }`, `ctx.ui.custom()`) instead of listing directory trees.

## [0.9.0] - 2026-02-05

### Added
- **npm publishing** - Package now published to npm. Install with `pi install npm:pi-messenger`.
- **`install.mjs`** - `npx pi-messenger` copies the npm package contents to the extensions directory. No git dependency. Version-pinned to the npm release. `npx pi-messenger --remove` to uninstall.
- `repository`, `homepage`, `bugs` fields in package.json for npm/GitHub integration.
- `bin`, `files` fields in package.json for npm distribution.

### Changed
- **Banner image** - README references `banner.png` via absolute GitHub URL (`raw.githubusercontent.com`) instead of relative path, so it renders on both GitHub and npmjs.com without shipping the 1.1MB image in the npm package.
- **Install section** - README now documents `pi install npm:pi-messenger` as the primary install method.

## [0.8.2] - 2026-02-01

### Fixed
- Adapt execute signature to pi v0.51.0: reorder signal, onUpdate, ctx parameters

## [0.8.1] - 2026-01-30

### Changed
- **Parallelism-aware planning** - Planner prompt now includes a dedicated Parallel Execution section teaching DAG thinking, independent work streams, critical path minimization, and real data flow dependencies. Plans should produce wider dependency graphs with more concurrent waves instead of linear chains.
- **Parallelism-aware review** - Both the automated planning loop reviewer and the manual plan review (`action: "review"`) now evaluate plans for unnecessary sequential dependencies and critical path length.
- PRD truncation applied consistently to both explicit `prd` parameter and auto-discovered PRD files (100KB limit).

### Fixed
- Stale README agent list referenced removed "analysts" instead of the actual 5 agents.

## [0.8.0] - 2026-01-30

### Added
- **Planning progress file** - `.pi/messenger/crew/planning-progress.md` accumulates planner findings and reviewer feedback across passes and runs. Persists through plan deletions. User-editable: add steering notes that the planner reads on every run.
- `planning.maxPasses` config option (default: 3). Set to 1 for single-pass behavior.
- JSON task block parsing (`tasks-json` fenced block) as the primary task extraction path, with the existing markdown regex as fallback.
- Shared verdict parser (`crew/utils/verdict.ts`) used by both review and planning handlers.

### Changed
- **Planning redesign: single planner agent** - Replaced the 5-scout + gap-analyst pipeline (6 LLM sessions) with a single `crew-planner` agent that explores the codebase iteratively in one session. Cheaper, faster, no information loss from truncation handoffs. Crew agent count: 10 to 5.
- **Iterative planning with review** - Planner runs in a multi-pass loop with reviewer feedback until SHIP verdict or `maxPasses` reached. Falls back gracefully on reviewer/planner failures.
- Deprecated scout and gap-analyst agent files auto-cleaned from `~/.pi/agent/agents/` on first use.

### Removed
- 5 scout agents (`crew-repo-scout`, `crew-practice-scout`, `crew-docs-scout`, `crew-web-scout`, `crew-github-scout`) and `crew-gap-analyst`.
- `concurrency.scouts` and `truncation.scouts` config options (replaced by `truncation.planners`).

## [0.7.4] - 2026-01-29

### Added
- **Living Presence** - Agents now have rich status indicators (active, idle, away, stuck) based on activity recency, open tasks, and reservations. Status is computed from `lastActivityAt` with configurable stuck threshold.
- **Activity Feed** - Append-only JSONL feed (`feed.jsonl`) tracks edits, commits, test runs, messages, joins/leaves, and crew task events. Pruned on startup to `feedRetention` limit. New `feed` action to query events.
- **Tool & Token Tracking** - Each agent's session tracks tool call count and cumulative token usage, visible in `list`, `whois`, and the overlay.
- **Auto Status** - Agents generate contextual status messages from recent activity: "on fire" after rapid edits, "debugging..." after repeated test runs, "just shipped" after a commit, "exploring the codebase" while reading files.
- **Stuck Detection** - Agents idle beyond `stuckThreshold` with an open task or reservation are flagged as stuck. Peers with a UI receive a notification. A `stuck` event is logged to the feed.
- **Name Themes** - Five name generation themes: `default` (SwiftRaven), `nature` (OakTree), `space` (LunarDust), `minimal` (Alpha), and `custom` with user-supplied word lists.
- **`whois` action** - Detailed agent info: status, model, branch, session age, tool calls, tokens, reservations, recent files, swarm claims.
- **`set_status` action** - Set or clear a custom status message. Overrides auto-status until cleared.
- **`feed` action** - Query the activity feed with configurable `limit`.
- **Overlay: agent cards** - The Agents tab now renders full presence cards with status indicator, current activity, tool/token counts, reservations, and status messages.
- **Overlay: activity feed section** - Below agent cards, recent feed events are displayed in a compact time-prefixed format.
- **Overlay: chat input** - Type `@Name msg` for DMs, `@all msg` for broadcasts. Plain text broadcasts from the Agents tab or DMs from an agent's tab.
- **Crew events in feed** - Task starts, completions, and blocks appear in the activity feed with a `[Crew]` prefix. Controlled by `crewEventsInFeed` config.
- **New config options** - `nameTheme`, `nameWords`, `feedRetention`, `stuckThreshold`, `stuckNotify`, `autoStatus`, `crewEventsInFeed`.

### Fixed
- **Self-whois missing Model and Branch lines** - `buildSelfRegistration` returned `model: ""` and omitted `gitBranch`/`spec`, so self-whois skipped the Model and Branch lines that peers could see. Added `model` to `MessengerState`, populated during registration and updates, and included all three fields in self-representation.
- **Rename desync: stale session time and activity** - `renameAgent` wrote fresh `startedAt` and `lastActivityAt` to disk but didn't update the in-memory state. The next registry flush would overwrite the disk's fresh values with stale ones, making the agent appear idle for the entire pre-rename session duration. Self-whois also showed a different session age than peer-whois.
- **Orphaned comma in crew status "In Progress" formatting** - When a task had no `assigned_to` but `attempt_count > 1`, the output produced a leading comma. Rewrote to build suffix parts as an array and join conditionally.
- **Blocked reason unconditional "..." truncation** - Crew status always appended "..." to `blocked_reason` regardless of length, so "API timeout" displayed as "API timeout...". Now only truncates when the reason exceeds 40 characters.
- **`agentHasTask` duplicated 4 times** - Identical logic checking swarm claims + crew tasks existed in `handlers.ts` (2 places), `index.ts`, and `overlay.ts`. Extracted to a shared pure function in `lib.ts`. Eliminates divergence risk (the crew tasks check was already missing from some copies).
- **Dead code in `executeRelease`** - Removed redundant `before` variable and `releasedCount` computation, replaced with direct `releasedPatterns.length`.

## [0.7.3] - 2026-01-27

### Fixed
- Google API compatibility: Use `StringEnum` for string literal unions (`type`, `autoRegisterPath`) and `Type.Any()` for mixed-type unions (`to`, `release`) to avoid unsupported `anyOf`/`const` JSON Schema patterns

## 0.7.2 - 2026-01-26

### Changed
- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## 0.7.1 - 2026-01-24

### Added

- **Skill installation** - `crew.install` now installs `pi-messenger-crew` skill alongside agents
- **Skills directory** - Extension ships skills in `skills/` (moved from `crew/skills/`)
- **README documentation** - Added "Crew Install" section explaining what gets installed

### Fixed

- **Worker pi_messenger access** - Spawned workers now receive `--extension` flag, giving them access to `pi_messenger` tool for mesh coordination, file reservations, and sibling messaging

### Changed

- `crew.install` output now lists both agents and skills
- `crew.uninstall` removes both agents and skills

## 0.7.0 - 2026-01-23

### Breaking Changes

**Epic System Removed** - Crew has been simplified to a PRD-based workflow:

| Before | After |
|--------|-------|
| PRD → epic.create → plan epic → work on epic | PRD → plan → work → done |
| Task IDs: `c-1-abc.1`, `c-1-abc.2` | Task IDs: `task-1`, `task-2` |
| `target: "c-1-abc"` (epic ID) required | No target needed - works on current plan |

### Removed

- **Epic actions** - `epic.create`, `epic.show`, `epic.list`, `epic.close`, `epic.set_spec`
- **Checkpoint actions** - `checkpoint.save`, `checkpoint.restore`, `checkpoint.delete`, `checkpoint.list`
- **Epic validation** - `crew.validate` now validates the plan, not an epic
- **Epic-scoped task operations** - `task.ready` and `task.list` no longer require `epic` parameter
- **Files deleted:**
  - `crew/handlers/epic.ts` (~285 lines)
  - `crew/handlers/checkpoint.ts` (~190 lines)
  - Epic CRUD functions from `crew/store.ts` (~100 lines)

### Changed

- **`plan` action** - Now takes `prd` parameter instead of `target`:
  ```typescript
  // Before
  pi_messenger({ action: "plan", target: "c-1-abc" })
  
  // After
  pi_messenger({ action: "plan" })                    // Auto-discover PRD
  pi_messenger({ action: "plan", prd: "docs/PRD.md" }) // Explicit path
  ```

- **`work` action** - No longer requires target:
  ```typescript
  // Before
  pi_messenger({ action: "work", target: "c-1-abc" })
  
  // After
  pi_messenger({ action: "work" })                    // Work on current plan
  pi_messenger({ action: "work", autonomous: true })  // Autonomous mode
  ```

- **`status` action** - Now shows plan progress instead of epic list

- **Task IDs** - Simplified from `c-N-xxx.M` to `task-N`:
  ```typescript
  // Before
  pi_messenger({ action: "task.show", id: "c-1-abc.1" })
  
  // After
  pi_messenger({ action: "task.show", id: "task-1" })
  ```

- **Crew overlay** - Now shows flat task list under PRD name (no epic grouping)

### Storage

New simplified storage structure:
```
.pi/messenger/crew/
├── plan.json              # Plan metadata (PRD path, progress)
├── plan.md                # Gap analyst output
├── tasks/
│   ├── task-1.json        # Task metadata
│   ├── task-1.md          # Task spec
│   └── ...
├── artifacts/             # Unchanged
└── config.json            # Unchanged
```

### Benefits

1. **Simpler mental model** - PRD → Tasks → Done
2. **Less API surface** - 9 fewer actions to learn
3. **Cleaner IDs** - `task-1` instead of `c-1-abc.1`
4. **PRD is the spec** - No redundant epic spec
5. **Faster onboarding** - Fewer concepts to explain
6. **~475 lines removed** - Smaller, more maintainable codebase

---

## 0.6.3 - 2026-01-23

### Changed

- **Crew agent model assignments** - Optimized for cost and capability:
  - Scouts (deep): `claude-opus-4-5` - repo-scout, github-scout, practice-scout
  - Scouts (fast): `claude-haiku-4-5` - docs-scout, web-scout
  - Analysts: `claude-opus-4-5` - gap-analyst, interview-generator, plan-sync
  - Worker: `claude-opus-4-5` - quality code generation
  - Reviewer: `openai/gpt-5.2-high` - diverse perspective for review

- **Streamlined scout roster** - Reduced from 7 to 5 focused scouts:
  - Removed: `crew-memory-scout` (memory system not implemented)
  - Removed: `crew-epic-scout` (only useful for multi-epic projects)
  - Removed: `crew-docs-gap-scout` (merged into gap-analyst)
  - Renamed: `crew-github-scout` → `crew-web-scout` (web search focus)
  - New: `crew-github-scout` (gh CLI integration, sparse checkouts)

### Added

- **PRD auto-discovery** - Plan handler now finds and includes PRD/spec files:
  - Searches: `PRD.md`, `SPEC.md`, `REQUIREMENTS.md`, `DESIGN.md`, `PLAN.md`
  - Also checks `docs/` subdirectory
  - Content included in all scout prompts (up to 50KB)

- **Review feedback loop** - Workers see previous review feedback on retry:
  - `last_review` field added to Task type
  - Review handler stores feedback after each review
  - Worker prompt includes issues to fix on retry attempts

- **Scout skip logic** - web-scout and github-scout assess relevance first:
  - Can skip with explanation if not relevant to the feature
  - Saves time and API costs for internal/simple features

- **ARCHITECTURE.md** - New documentation with orchestration flow diagram, model summary, and agent inventory

### Fixed

- Template literal bug in worker prompt (epicId not interpolating)
- Retry detection off-by-one (now correctly shows attempt number)
- Case-insensitive filesystem duplicate PRD reads (uses realpath)
- Wave number tracking in autonomous mode (was off-by-one after addWaveResult)
- CREW_AGENTS list in install.ts (removed deleted agents, added crew-web-scout)
- Corrupted crew-plan-sync.md (had TypeScript code appended)

## 0.6.2 - 2026-01-23

### Changed

- Initial crew agent model assignments (superseded by 0.6.3)

## 0.6.1 - 2026-01-23

### Added

- **Planning Workflow Documentation** - README now explains how the `plan` action works:
  - Diagram showing scouts (parallel) → gap-analyst → tasks with dependencies
  - Clarifies that no special format is required for PRDs/specs
  - Example of starting from a PRD with `idea: true`

## 0.6.0 - 2026-01-23

### Added

**Crew: Task Orchestration** - A complete multi-agent task orchestration system for complex epics.

- **Epics & Tasks** - Hierarchical work items with dependency tracking
  - `epic.create`, `epic.show`, `epic.list`, `epic.close`, `epic.set_spec`
  - `task.create`, `task.show`, `task.list`, `task.start`, `task.done`, `task.block`, `task.unblock`, `task.ready`, `task.reset`

- **Planning** - Automated task breakdown with parallel scouts
  - `plan` action runs 7 scout agents in parallel to analyze codebase
  - Gap analyst synthesizes findings into task graph with dependencies
  - Supports planning from idea (`idea: true`) or existing epic

- **Work Execution** - Parallel worker spawning with concurrency control
  - `work` action executes ready tasks (dependencies satisfied)
  - `autonomous: true` flag for continuous wave execution until done/blocked
  - Configurable concurrency for scouts (default: 4) and workers (default: 2)
  - Auto-blocks tasks after `maxAttemptsPerTask` failures

- **Code Review** - Automated review with verdicts
  - `review` action for implementation (git diff) or plan review
  - SHIP / NEEDS_WORK / MAJOR_RETHINK verdicts with detailed feedback

- **Interview** - Clarification question generation
  - `interview` action generates 20-40 deep questions
  - Outputs JSON file for pi's interview tool

- **Sync** - Downstream spec updates
  - `sync` action updates dependent task specs after completion

- **Checkpoints** - State save/restore for recovery
  - `checkpoint.save`, `checkpoint.restore`, `checkpoint.delete`, `checkpoint.list`

- **Status & Maintenance**
  - `crew.status` - Overall crew status with progress metrics
  - `crew.validate` - Validate epic structure and dependencies
  - `crew.agents` - List available crew agents by role
  - `crew.install` / `crew.uninstall` - Agent management

- **Crew Overlay Tab** - Visual epic/task tree in `/messenger` overlay
  - Tab bar shows "Crew (N)" with active epic count
  - Expand/collapse epics with Enter key
  - Status icons: ✓ done, ● in_progress, ○ todo, ✗ blocked
  - Shows assigned agent, dependencies, and block reasons
  - Autonomous mode status bar: wave number, progress, ready count, timer

- **12 Crew Agents** - Auto-installed on first use of `plan`, `work`, or `review`
  - 7 scouts: repo, practice, docs, github, epic, docs-gap, memory
  - Plus: worker, reviewer, gap-analyst, interview-generator, plan-sync

- **Action-based API** - Consistent `action` parameter pattern
  - Example: `pi_messenger({ action: "epic.create", title: "OAuth Login" })`
  - 24 new crew actions, 38 total actions through one tool

### Storage

New directory `.pi/messenger/crew/` (per-project):
- `epics/*.json` - Epic metadata
- `specs/*.md` - Epic specifications  
- `tasks/*.json` - Task metadata
- `tasks/*.md` - Task specifications
- `blocks/*.md` - Block context for blocked tasks
- `checkpoints/` - Saved state snapshots
- `artifacts/` - Debug artifacts (input/output/jsonl per run)
- `config.json` - Project-level config overrides

### Configuration

New `crew` section in `~/.pi/agent/pi-messenger.json`:
```json
{
  "crew": {
    "concurrency": { "scouts": 4, "workers": 2 },
    "review": { "enabled": true, "maxIterations": 3 },
    "work": { "maxAttemptsPerTask": 5, "maxWaves": 50 },
    "artifacts": { "enabled": true, "cleanupDays": 7 }
  }
}
```

### Fixed

- 12 bugs fixed during implementation review:
  - **Critical:** `loadCrewConfig` called with wrong path in plan.ts and work.ts
  - Double-counting bug in work.ts (tasks in both `failed` and `blocked` arrays)
  - O(n²) complexity in plan.ts task creation loop
  - O(n²) complexity in agents.ts worker spawn loop
  - Invalid status icon map in epic.ts (missing `blocked`, `archived`)
  - Various unused imports and variables cleaned up

---

## 0.5.1 - 2026-01-22

### Added

- **Path-based auto-register** - New `autoRegisterPaths` config option allows specifying folders where agents should auto-join the mesh, instead of global auto-register. Supports `~` expansion and glob patterns (`~/work/*`).
- **Folder scoping** - New `scopeToFolder` config option limits agent visibility to the same working directory. When enabled, agents only see other agents in the same folder (broadcasts are scoped, but direct messaging by name still works).
- **Auto-register path management (tool)** - New `autoRegisterPath` parameter:
  - `pi_messenger({ autoRegisterPath: "add" })` - Add current folder to auto-register list
  - `pi_messenger({ autoRegisterPath: "remove" })` - Remove current folder
  - `pi_messenger({ autoRegisterPath: "list" })` - Show all configured paths
- **Config TUI command** - `/messenger config` opens an overlay to manage auto-register paths with keyboard navigation.

### Changed

- Auto-register logic now checks both `autoRegister` (global) and `autoRegisterPaths` (path-based). If either matches, the agent auto-joins.
- `getActiveAgents()` now filters by cwd when `scopeToFolder` is enabled.

## 0.5.0 - 2026-01-20

### Added

- **Swarm coordination** - Agents can now coordinate on shared spec files with atomic task claiming
- **Spec registration** - `pi_messenger({ spec: "path/to/spec.md" })` registers your working spec
- **Task claiming** - `pi_messenger({ claim: "TASK-01" })` atomically claims a task in your spec
- **Task completion** - `pi_messenger({ complete: "TASK-01", notes: "..." })` marks tasks done with notes
- **Task unclaiming** - `pi_messenger({ unclaim: "TASK-01" })` releases a claim without completing
- **Swarm status** - `pi_messenger({ swarm: true })` shows all agents' claims and completions
- **Spec-scoped swarm** - `pi_messenger({ swarm: true, spec: "path" })` shows status for one spec only
- **Join with spec** - `pi_messenger({ join: true, spec: "path" })` joins and registers spec atomically
- **Single-claim-per-agent rule** - Must complete or unclaim before claiming another task
- **Stale claim cleanup** - Claims from dead agents (PID gone + lock >10s old) are automatically cleaned

### Changed

- **Agents tab in overlay** - Now groups agents by spec with claims displayed
- **Status output** - Now includes current spec and active claim when set
- **List output** - Now shows spec and claim status for each agent

### Storage

New files in `~/.pi/agent/messenger/`:
- `claims.json` - Active task claims by spec
- `completions.json` - Completed tasks by spec
- `swarm.lock` - Atomic lock for claim/complete mutations

### Fixed

- **Safe completion write order** - Completions are now written before claims removal, so if the second write fails the task completion is still recorded
- **Overlay scroll reset on agent death** - When an agent dies and the overlay auto-switches to another tab, scroll position is now properly reset
- **Type-safe result handling** - Added proper type guards (`isClaimSuccess`, `isUnclaimNotYours`, etc.) for discriminated union result types, replacing fragile `as` casts
- **I/O error cleanup** - If registration write succeeds but read-back fails (extremely rare I/O error), the orphaned file is now cleaned up
- **Single agent lookup for reservations** - `ReservationConflict` now includes full agent registration, eliminating redundant disk reads when blocking reserved files

## 0.4.0 - 2026-01-21

### Changed

- **Opt-in registration** - Agents no longer auto-register on startup. Use `pi_messenger({ join: true })` to join the mesh, or open `/messenger` which auto-joins. This reduces context pollution for sessions that don't need multi-agent coordination.
- **New `autoRegister` config** - Set to `true` to restore the old auto-register-on-startup behavior.

### Fixed

- **Read operations no longer blocked by reservations** - Previously, reading reserved files was blocked. Now only `edit` and `write` operations are blocked, allowing agents to read files for context even when another agent has reserved them.

## 0.3.0 - 2026-01-21

### Added

- **Agent differentiation** - Agents are now easier to distinguish when multiple work in the same folder
- **Git branch detection** - Automatically detects and displays git branch (or short SHA for detached HEAD)
- **Adaptive display modes** - List and overlay views adapt based on agent context:
  - Same folder + branch: Compact view, branch in header
  - Same folder, different branches: Shows branch per agent
  - Different folders: Shows folder per agent
- **Location awareness** - Status command now shows `Location: folder (branch)`
- **Enhanced context** - Registration and first-contact messages include location info
- **Improved reservation display** - Uses 🔒 prefix, truncates long paths from the left preserving filename

### Changed

- Reservation conflict messages now show the blocking agent's location: `Reserved by: X (in folder on branch)`
- First contact message format: `*X is in folder on branch (model)*`
- Tab bar adapts: name only (same context), name:branch (different branches), name/folder (different folders)
- Status details object now includes `folder` and `gitBranch` for programmatic access

### Fixed

- **Agent identity detection** - When an agent quits and a new pi instance registers with the same name, recipients now correctly see first-contact details. Previously, `seenSenders` tracked names only; now it tracks `name -> sessionId` to detect identity changes.
- **Registration race condition** - Added write-then-verify check to prevent two agents from claiming the same name simultaneously. If another agent wins the race, auto-generated names retry with a fresh lookup; explicit names fail with a clear error.
- **Rename race condition** - Added write-then-verify check to `renameAgent()` to prevent two agents from renaming to the same name simultaneously. If verification fails, returns "race_lost" error and the agent keeps its old name.

### Performance

- **Cached filtered agents** - `getActiveAgents()` now caches filtered results per agent name, avoiding repeated array allocations on every call.
- **Memoized agent colors** - `agentColorCode()` now caches computed color codes, avoiding hash recalculation on every render.
- **Overlay render cache** - Sorted agent list is now cached within each render cycle, avoiding redundant sort operations.
- **Reduced redundant calls** - `formatRelativeTime()` result is now reused in message box rendering instead of being called twice.

### Documentation

- **README overhaul** - New banner image showing connected pi symbols, punchy tagline, license/platform badges, comparison table, organized features section, keyboard shortcuts table, and streamlined layout following reference README patterns.

## 0.2.1 - 2026-01-20

### Fixed

- **Performance: Agent registry caching** - `getActiveAgents()` now caches results for 1 second, dramatically reducing disk I/O. Previously, every keypress in the overlay and every tool_call for read/edit/write caused full registry scans.
- **Performance: Watcher debouncing** - File watcher events are now debounced with 50ms delay, coalescing rapid filesystem events into a single message processing call.
- **Stability: Message processing guard** - Concurrent calls to `processAllPendingMessages()` are now serialized to prevent race conditions when watcher events and turn_end overlap.
- **Stability: MessengerState type** - Added `watcherDebounceTimer` field for proper debounce timer management.

## 0.2.0 - 2026-01-20

### Added

- **Chat overlay** - `/messenger` now opens an interactive overlay instead of a menu. Full chat interface with tabs for each agent, message history, and an input bar at the bottom.
- **Message history** - Messages persist in memory for the session (up to 50 per conversation). Scroll through history with arrow keys.
- **Unread badges** - Status bar shows total unread count. Tab bar shows per-agent unread counts that clear when you switch to that tab.
- **Broadcast tab** - "+ All" tab for sending messages to all agents at once. Shows your outgoing broadcast history.
- **Agent colors** - Each agent name gets a consistent color based on a hash of their name. Makes it easy to distinguish agents in conversations.
- **Agent details** - When viewing a conversation with no messages, shows the agent's working directory, model, and file reservations.
- **Context injection** - Agents now receive orientation on startup and helpful context with messages:
  - Registration message explaining multi-agent environment (once per session)
  - Reply hint showing how to respond to messages
  - Sender details (cwd, model) on first contact from each agent
- **Configuration file** - `~/.pi/agent/pi-messenger.json` for customizing context injection. Supports `contextMode: "full" | "minimal" | "none"`.

### Changed

- `/messenger` command now opens overlay (was: interactive menu with select prompts)
- Status bar now shows unread count badge when messages are waiting

### Fixed

- Message delivery order: files are now deleted after successful delivery, not before (prevents message loss if delivery fails)
- ANSI escape codes in message text are now stripped to prevent terminal injection
- Watcher recovery: if the inbox watcher dies after exhausting retries, it now automatically recovers on the next turn or session event
- Small terminal handling: overlay now handles very small terminal windows gracefully with minimum height safeguards

## 0.1.0 - 2026-01-20

Initial release.

- Agent discovery with auto-generated memorable names (SwiftRaven, GoldFalcon, etc.)
- Direct messaging between agents with immediate delivery
- Broadcast messaging to all active agents
- File reservations with conflict detection
- Message renderer for incoming agent messages
- Status bar integration showing agent name and peer count
