# Pi-Messenger Extension Deep Scan Findings

**Scan Date:** 2026-03-07  
**Extension Path:** `/Users/chikochingaya/Desktop/Familiar/pi-messenger`  
**Scout:** Arline (reconnaissance specialist)

---

## Meta Analysis

### Architecture

Pi-messenger is a file-based multi-agent coordination extension for the Pi coding agent. It enables:

1. **Agent Mesh**: File-based agent discovery and messaging (no daemon)
2. **Crew System**: PRD → task breakdown → parallel execution with worker spawning
3. **Overlay TUI**: Real-time task/worker monitoring with keyboard controls

**Core Components:**
- `index.ts` - Extension entry point, lifecycle hooks, tool registration
- `handlers.ts` - Action handlers for coordination (join, send, reserve, etc.)
- `crew/` - Task orchestration system (planning, workers, state management)
- `overlay.ts` - TUI component for crew monitoring
- `store.ts` - File-based registry for agent state and messages
- `feed.ts` - Activity feed (JSONL event log)

### Patterns

**File-Based Coordination:**
- Registry: `~/.pi/agent/messenger/registry/<agent-name>.json`
- Inbox: `~/.pi/agent/messenger/inbox/<recipient>/<msg-id>.json`
- Crew state: `.pi/messenger/crew/` in project directory
- Feed: `.pi/messenger/feed.jsonl` in project directory

**Event-Driven:**
- Pi SDK lifecycle hooks: `session_start`, `session_switch`, `tool_call`, `tool_result`, `agent_end`
- File watchers for inbox delivery
- JSONL streaming for live progress updates

**Subprocess Management:**
- Workers spawned via `spawn("pi", args, { cwd, stdio })`
- JSON mode communication (`--mode json`)
- Progress tracking via stdout JSONL parsing

### Dependencies

**External:**
- `@mariozechner/pi-coding-agent` - Pi SDK (ExtensionAPI, TUI)
- `@mariozechner/pi-tui` - Terminal UI components
- `@sinclair/typebox` - Runtime type validation

**Internal:**
- Node.js `child_process.spawn` for worker processes
- `fs` module with file watchers (`fs.watch`)
- JSONL for structured logging and progress

### Gotchas

1. **File Watcher Recovery**: Watcher can fail silently. Extension has retry logic with exponential backoff (3 attempts).
   - `store.ts:372-421` - Watcher initialization with error handling
   - `index.ts:293-295` - `recoverWatcherIfNeeded()` called on session events

2. **Reservation Enforcement**: `tool_call` hook blocks `edit`/`write` operations on reserved files.
   - `index.ts:771-789` - Blocking logic runs BEFORE tool execution
   - Returns `{ block: true, reason: "..." }` to prevent tool from running

3. **Session State Persistence**: Autonomous state persisted via `appendEntry("crew-state", ...)` and restored on `session_start`.
   - `index.ts:531-534` - Restore logic
   - `crew/state-autonomous.ts:78-88` - `restoreAutonomousState()`

4. **Worker Budget Enforcement**: Lobby workers killed when exceeding token budget for coordination level.
   - `crew/lobby.ts:149-155` - Budget check on each JSONL event
   - Token budgets: none=10k, minimal=20k, moderate=50k, chatty=100k

5. **Task Attempt Limits**: Tasks auto-blocked after `maxAttemptsPerTask` (default 3).
   - `crew/handlers/work.ts:56-65` - Auto-block on ready task check
   - `crew/lobby.ts:186-192` - Auto-block on worker exit

### Task Recommendations

**For Planner:**
- Extension is feature-complete for current use case
- No obvious missing functionality
- Well-structured for maintenance

**Modification Guidelines:**
- **Adding Actions**: Create handler in `crew/handlers/`, import in `crew/index.ts`, add to router
- **Changing State**: Modify types in `crew/types.ts`, update store in `crew/store.ts`
- **Worker Configuration**: Edit `crew/agents/*.md` frontmatter + prompt sections
- **Config Options**: Add to `config.ts` DEFAULT_CONFIG, update type, handle in `loadConfig()`

**Files NOT Safe for Parallel Modification:**
- `index.ts` - Central extension registration, race conditions on state
- `crew/state.ts` - Shared autonomous/planning state
- `crew/registry.ts` - Worker registry, concurrent access issues

---

## File Map

### Root Level
- `index.ts` - Extension entry point (800+ lines)
- `handlers.ts` - Action handlers for coordination (500+ lines)
- `lib.ts` - Shared utilities (types, formatting, validation)
- `store.ts` - File-based registry and messaging
- `feed.ts` - Activity feed (JSONL logging)
- `config.ts` - Configuration resolution (project → user → defaults)
- `overlay.ts` - TUI component (800+ lines)
- `overlay-render.ts` - Rendering helpers for overlay sections
- `overlay-actions.ts` - Keyboard action handlers and state management

### Crew Directory (`crew/`)
- `index.ts` - Action router (plan, work, task.*)
- `agents.ts` - Worker spawning core logic
- `spawn.ts` - High-level spawn helpers for ready tasks
- `lobby.ts` - Idle lobby workers (chat while waiting for tasks)
- `prompt.ts` - Worker prompt construction
- `state.ts` - State barrel (autonomous + planning)
- `state-autonomous.ts` - Autonomous work state (waves, concurrency)
- `state-planning.ts` - Planning state (planner process tracking)
- `store.ts` - Task/plan file operations
- `registry.ts` - Worker process registry (in-memory)
- `task-actions.ts` - Task lifecycle actions (start, block, reset, etc.)
- `types.ts` - Type definitions (Plan, Task, CrewParams, etc.)

### Crew Handlers (`crew/handlers/`)
- `plan.ts` - Planning handler (spawn planner, watch for completion)
- `work.ts` - Work handler (spawn workers for ready tasks)
- `task.ts` - Task operations (show, list, start, done, block, etc.)
- `review.ts` - Review handler (spawn reviewer for task)
- `revise.ts` - Task revision (single task or tree)
- `sync.ts` - Plan sync (update dependent task specs after completion)
- `status.ts` - Status display (plan progress, active workers)

### Crew Utils (`crew/utils/`)
- `config.ts` - Crew config loading (.pi/messenger/crew/crew.json)
- `discover.ts` - Agent and skill discovery
- `install.ts` - Agent installation to crew directory
- `progress.ts` - Progress parsing from JSONL stdout
- `result.ts` - Result formatting helper
- `truncate.ts` - Output truncation
- `verdict.ts` - Review verdict parsing
- `artifacts.ts` - Session artifact paths

### Crew Agents (`crew/agents/`)
- `crew-planner.md` - Planner agent definition (codebase → task breakdown)
- `crew-worker.md` - Worker agent definition (implements single task)
- `crew-reviewer.md` - Reviewer agent definition (reviews task impl)
- `crew-plan-sync.md` - Plan sync agent (updates downstream specs)

---

## File Contents

### 1. Crew Agent Definitions

All agent definitions follow this frontmatter structure:

```yaml
---
name: crew-planner
description: Analyzes codebase and PRD to create a comprehensive task breakdown
tools: read, bash, web_search, pi_messenger
model: anthropic/claude-opus-4-6
crewRole: planner
maxOutput: { bytes: 204800, lines: 5000 }
parallel: false
retryable: true
---
```

**Fields:**
- `name` - Agent identifier (must match filename)
- `description` - One-line purpose
- `tools` - Comma-separated tool list (or array in YAML)
- `model` - Default model (overridable via crew config)
- `crewRole` - Role category (planner, worker, reviewer, analyst)
- `maxOutput` - Output limits for tool results
- `parallel` - Can multiple instances run concurrently?
- `retryable` - Can task be retried on failure?

#### crew-planner.md (Lines 1-200)

**Purpose:** Single-session planner that replaces 5 scouts + gap analyst. Analyzes codebase and PRD to produce comprehensive task breakdown.

**Key Workflow:**
1. Join mesh: `pi_messenger({ action: "join" })`
2. Explore codebase: `find`, `tree`, `grep`, read key files
3. Read documentation: ADRs, design docs, API docs
4. External research: `web_search` for best practices (conditional)
5. Gap analysis: missing requirements, edge cases, security, testing
6. Task breakdown: 4-8 tasks, dependency graph, acceptance criteria

**Output Format:**
- Markdown: Human-readable with `## Gap Analysis` and `### Task N` sections
- JSON: Fenced code block with `tasks-json` for reliable parsing

```json
[
  {
    "title": "Task title matching markdown section",
    "description": "Full description with acceptance criteria",
    "dependsOn": ["Task 1 title"],
    "skills": ["react-best-practices", "testing"]
  }
]
```

**Parallelism Guidelines:**
- Tasks form a DAG (directed acyclic graph), not a sequence
- Minimize critical path (longest dependency chain)
- Dependencies only when real data flow exists (imports, file reads)
- Avoid bottlenecks: no standalone "types" tasks all others depend on

**Anti-Patterns:**
- No integration funnels (tasks depending on everything)
- No redundant transitive deps (if B→A, C→B, don't list A in C)
- Tests belong in implementation task, not separate end task

#### crew-worker.md (Lines 1-100)

**Purpose:** Implements single task with mesh coordination.

**Key Workflow:**
1. Join mesh: `pi_messenger({ action: "join" })`
2. Re-anchor: `pi_messenger({ action: "task.show", id: "<TASK_ID>" })` + read spec file
3. Load skills: Read relevant skills from "Available Skills" section
4. Start & reserve: `pi_messenger({ action: "task.start", id: "..." })` + reserve files
5. Implement: Read existing code, implement, write tests, run tests
6. Commit: `git add -A && git commit -m "..."`
7. Release & complete: Release reservations + `task.done` with evidence

**Progress Logging:**
```typescript
pi_messenger({ action: "task.progress", id: "<TASK_ID>", message: "Added JWT validation to src/auth/middleware.ts" })
```

**Shutdown Handling:**
- If "SHUTDOWN REQUESTED" message received:
  - Stop immediately
  - Release reservations
  - Do NOT mark done or commit
  - Exit

#### crew-reviewer.md (Lines 1-50)

**Purpose:** Reviews task implementations for quality and correctness.

**Input:** Task spec + git diff

**Output Format:**
```
## Verdict: [SHIP|NEEDS_WORK|MAJOR_RETHINK]

Summary paragraph explaining assessment.

## Issues
- Issue 1: Description with file:line
- Issue 2: ...

## Suggestions
- Suggestion 1: Optional improvement
- Suggestion 2: ...
```

**Verdicts:**
- **SHIP**: Ready to merge
- **NEEDS_WORK**: Minor issues, must fix
- **MAJOR_RETHINK**: Fundamental problems, significant changes needed

#### crew-plan-sync.md (Lines 1-40)

**Purpose:** Updates downstream specs after task completion.

**Workflow:**
1. Read completed task details
2. Find dependent tasks
3. Update specs with new information (types, interfaces, exports)
4. Update epic spec if implementation affects overall plan

**Output:**
```
## Sync Summary

### Updated: task-id
Changes made:
- Updated section X to reflect...
- Added information about...

### No Updates Needed
[Explanation if nothing to sync]
```

---

### 2. Extension Entry Point (index.ts)

**Exported Function:** `piMessengerExtension(pi: ExtensionAPI)`

**Key Sections:**

#### State Initialization (Lines 60-113)
```typescript
const state: MessengerState = {
  agentName: process.env.PI_AGENT_NAME || "",
  registered: false,
  watcher: null,
  reservations: [],
  chatHistory: new Map(),
  unreadCounts: new Map(),
  broadcastHistory: [],
  seenSenders: new Map(),
  model: "",
  gitBranch: undefined,
  spec: undefined,
  scopeToFolder: config.scopeToFolder,
  isHuman: false,
  session: { toolCalls: 0, tokens: 0, filesModified: [] },
  activity: { lastActivityAt: new Date().toISOString() },
  statusMessage: undefined,
  customStatus: false,
  sessionStartedAt: new Date().toISOString(),
};
```

#### Tool Registration (Lines 311-506)
```typescript
pi.registerTool({
  name: "pi_messenger",
  label: "Pi Messenger",
  description: `Multi-agent coordination and task orchestration...`,
  parameters: Type.Object({
    action: Type.Optional(Type.String()),
    // ... ~40 parameters (prd, id, taskId, target, etc.)
  }),
  async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
    const params = rawParams as CrewParams;
    const action = params.action;
    
    if (!action) {
      return handlers.executeStatus(state, dirs, ctx.cwd ?? process.cwd());
    }
    
    const result = await executeCrewAction(
      action, params, state, dirs, ctx,
      deliverMessage, updateStatus,
      (type, data) => pi.appendEntry(type, data),
      { stuckThreshold, crewEventsInFeed, nameTheme, feedRetention },
      signal
    );
    
    if (action === "join" && state.registered && config.registrationContext) {
      sendRegistrationContext(ctx);
    }
    
    return result;
  }
});
```

**Parameter Groups:**
- **Crew**: prd, prompt, id, taskId, title, dependsOn, target, summary, evidence, content, count, subtasks, type, autoWork, autonomous, concurrency, model, cascade
- **Messaging**: spec, notes, to, message, replyTo, reason
- **Coordination**: paths, name, limit, autoRegisterPath

#### Command Registration (Lines 508-580)
```typescript
pi.registerCommand("messenger", {
  description: "Open messenger overlay, or 'config' to manage settings",
  handler: async (args, ctx) => {
    if (args[0] === "config") {
      // Open config overlay
      await ctx.ui.custom(/* MessengerConfigOverlay */);
      return;
    }
    
    // Auto-join if not registered
    if (!state.registered) {
      store.register(state, dirs, ctx, nameTheme);
      store.startWatcher(state, dirs, deliverMessage);
      updateStatus(ctx);
    }
    
    // Open chat/crew overlay
    const snapshot = await ctx.ui.custom(/* MessengerOverlay */);
    
    if (snapshot) {
      pi.sendMessage({
        customType: "crew_snapshot",
        content: snapshot,
        display: true,
      }, { triggerTurn: true });
    }
  }
});
```

#### Activity Tracking (Lines 628-715)

**Tool Call Tracking:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (!state.registered) return;
  
  updateLastActivity();
  incrementToolCount();
  scheduleRegistryFlush(ctx);
  
  const toolName = event.toolName;
  const input = event.input as Record<string, unknown>;
  
  if (toolName === "write" || toolName === "edit") {
    setCurrentActivity(`editing ${shortenPath(input.path)}`);
    debouncedLogEdit(input.path);
    trackRecentEdit();
  } else if (toolName === "read") {
    setCurrentActivity(`reading ${shortenPath(input.path)}`);
  } else if (toolName === "bash") {
    if (isGitCommit(command)) {
      setCurrentActivity("committing");
    } else if (isTestRun(command)) {
      setCurrentActivity("running tests");
    }
  }
  
  updateAutoStatus();
});
```

**Tool Result Tracking:**
```typescript
pi.on("tool_result", async (event, ctx) => {
  if (!state.registered) return;
  
  if (toolName === "write" || toolName === "edit") {
    setLastToolCall(`${toolName}: ${shortenPath(path)}`);
    addModifiedFile(path);
  }
  
  if (toolName === "bash") {
    if (isGitCommit(command)) {
      logFeedEvent(cwd, state.agentName, "commit", undefined, msg);
      trackRecentCommit();
    }
    if (isTestRun(command)) {
      logFeedEvent(cwd, state.agentName, "test", undefined, passed ? "passed" : "failed");
      trackRecentTest();
    }
  }
  
  clearCurrentActivity();
  updateAutoStatus();
  scheduleRegistryFlush(ctx);
});
```

#### Lifecycle Hooks (Lines 717-769)

**session_start:**
- Start status heartbeat (15s interval)
- Restore autonomous state from session entries
- Restore planning state (clear if planner exited)
- Auto-register if configured or folder matches `autoRegisterPaths`
- Log join event
- Auto-open crew overlay if configured

**session_switch / session_fork / session_tree:**
- Restore planning state
- Recover file watcher if needed
- Update status
- Auto-open crew overlay

**turn_end:**
- Process pending messages
- Lobby keepalive for lobby workers
- Update session token count
- Auto-open crew overlay

**agent_end:**
- Check for pending auto-work (after plan completion)
- Check autonomous continuation (if active)
- Spawn next wave if ready tasks available
- Stop autonomous if done/blocked/max waves reached

**session_shutdown:**
- Shutdown all workers and lobby workers
- Clear planning state if this process was planner
- Log leave event
- Clear timers (registry flush, edits, commits, tests)
- Stop file watcher
- Unregister agent

#### Reservation Enforcement (Lines 771-789)

```typescript
pi.on("tool_call", async (event, _ctx) => {
  if (!["edit", "write"].includes(event.toolName)) return;
  
  const filePath = input.path;
  if (!filePath) return;
  
  const conflicts = store.getConflictsWithOtherAgents(filePath, state, dirs);
  if (conflicts.length === 0) return;
  
  const c = conflicts[0];
  const lines = [
    filePath,
    `Reserved by: ${c.agent}${locationPart}`,
    c.reason ? `Reason: "${c.reason}"` : "",
    "",
    `Coordinate via pi_messenger({ action: "send", to: "${c.agent}", message: "..." })`
  ];
  
  return { block: true, reason: lines.join("\n") };
});
```

**Key Behavior:**
- Runs BEFORE tool execution
- Blocks only if file matches another agent's reservation
- Provides coordination hint in error message

---

### 3. Worker Spawning (crew/spawn.ts, crew/lobby.ts)

#### crew/spawn.ts - High-Level Spawn API

**spawnWorkersForReadyTasks(cwd, maxWorkers):**
```typescript
// 1. Try to assign to lobby workers first (already running)
const lobby = getAvailableLobbyWorkers(cwd);
for (const lw of lobby) {
  if (assigned >= maxWorkers) break;
  const task = readyTasks[0];
  const prompt = buildWorkerPrompt(task, ...);
  store.updateTask(cwd, task.id, { status: "in_progress", ... });
  assignTaskToLobbyWorker(lw, task.id, prompt, inboxDir);
  assigned++;
}

// 2. Spawn fresh workers for remaining tasks
while (assigned < maxWorkers) {
  const task = readyTasks[0];
  const prompt = buildWorkerPrompt(task, ...);
  const worker = spawnWorkerForTask(cwd, task.id, prompt);
  if (!worker) break;
  assigned++;
}

return { assigned, firstWorkerName };
```

**spawnSingleWorker(cwd, taskId):**
- Gets task from store
- Builds worker prompt
- Calls `spawnWorkerForTask()` from lobby.ts
- Returns `{ name }` or `null`

#### crew/lobby.ts - Subprocess Management

**Lobby Worker Concept:**
Idle workers that join mesh, explore project, and chat while waiting for task assignments. When task available, receives assignment via steer message and transitions to work mode.

**spawnLobbyWorker(cwd, promptOverride):** (Lines 52-160)

1. **Discover worker config:**
   ```typescript
   const agents = discoverCrewAgents(cwd);
   const workerConfig = agents.find(a => a.name === "crew-worker");
   ```

2. **Generate name:**
   ```typescript
   const id = randomUUID().slice(0, 6);
   let name = generateMemorableName();
   // Retry up to 5 times if collision with existing lobby worker
   ```

3. **Build prompt:**
   ```typescript
   const prompt = promptOverride ?? buildLobbyPrompt(cwd, config);
   ```

4. **Build args array:**
   ```typescript
   const args = ["--mode", "json", "--no-session", "-p"];
   
   // Model
   const model = config.models?.worker ?? workerConfig.model;
   if (model) pushModelArgs(args, model);
   
   // Thinking
   const thinking = resolveThinking(config.thinking?.worker, workerConfig.thinking);
   if (thinking && !modelHasThinkingSuffix(model)) {
     args.push("--thinking", thinking);
   }
   
   // Tools
   if (workerConfig.tools?.length) {
     const builtinTools = [];
     const extensionPaths = [];
     for (const tool of workerConfig.tools) {
       if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
         extensionPaths.push(tool);
       } else if (BUILTIN_TOOLS.has(tool)) {
         builtinTools.push(tool);
       }
     }
     if (builtinTools.length > 0) args.push("--tools", builtinTools.join(","));
     for (const ext of extensionPaths) args.push("--extension", ext);
   }
   
   args.push("--extension", EXTENSION_DIR);
   
   // System prompt (if defined in frontmatter)
   if (workerConfig.systemPrompt) {
     promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-lobby-"));
     const promptPath = path.join(promptTmpDir, "crew-worker.md");
     fs.writeFileSync(promptPath, workerConfig.systemPrompt, { mode: 0o600 });
     args.push("--append-system-prompt", promptPath);
   }
   
   args.push(prompt);
   ```

5. **Set env vars:**
   ```typescript
   const env = {
     ...process.env,
     ...config.work.env,
     PI_AGENT_NAME: name,
     PI_CREW_WORKER: "1",
     PI_LOBBY_ID: id
   };
   ```

6. **Spawn subprocess:**
   ```typescript
   const proc = spawn("pi", args, {
     cwd,
     stdio: ["ignore", "pipe", "pipe"],
     env
   });
   ```

7. **Create alive file:**
   ```typescript
   const aliveFile = path.join(crewDir, `lobby-${id}.alive`);
   fs.writeFileSync(aliveFile, "", { mode: 0o600 });
   ```

8. **Register worker:**
   ```typescript
   const worker: LobbyWorkerEntry = {
     type: "lobby",
     lobbyId: id,
     name,
     cwd,
     proc,
     taskId: lobbyTaskId(id),
     startedAt: Date.now(),
     assignedTaskId: null,
     coordination: config.coordination ?? "chatty",
     promptTmpDir,
     aliveFile,
   };
   registerWorker(worker);
   ```

9. **Parse JSONL stdout for progress:**
   ```typescript
   let jsonlBuffer = "";
   proc.stdout?.on("data", (data) => {
     jsonlBuffer += data.toString();
     const lines = jsonlBuffer.split("\n");
     jsonlBuffer = lines.pop() ?? "";
     for (const line of lines) {
       const event = parseJsonlLine(line);
       if (event) {
         updateProgress(progress, event, worker.startedAt);
         updateLiveWorker(cwd, displayId, { ...progress });
         
         // Budget enforcement
         const budget = LOBBY_TOKEN_BUDGETS[currentConfig.coordination ?? "chatty"];
         if (progress.tokens > budget) {
           proc.kill("SIGTERM");
         }
       }
     }
   });
   ```

10. **Handle process exit:**
    ```typescript
    proc.on("close", (exitCode) => {
      removeLiveWorker(cwd, displayId);
      unregisterWorker(cwd, taskId);
      
      // Cleanup temp files
      if (worker.promptTmpDir) fs.rmSync(worker.promptTmpDir, { recursive: true });
      if (worker.aliveFile) fs.unlinkSync(worker.aliveFile);
      
      // Handle task state if assigned
      if (worker.assignedTaskId) {
        const task = store.getTask(cwd, worker.assignedTaskId);
        if (task && task.status === "in_progress") {
          if (task.attempt_count >= config.work.maxAttemptsPerTask) {
            store.updateTask(cwd, worker.assignedTaskId, {
              status: "blocked",
              blocked_reason: `Max attempts (${maxAttemptsPerTask}) reached`,
              assigned_to: undefined
            });
          } else {
            store.updateTask(cwd, worker.assignedTaskId, { status: "todo" });
          }
        }
      }
    });
    ```

**assignTaskToLobbyWorker(worker, taskId, prompt, inboxDir):** (Lines 209-230)

```typescript
const msgId = randomUUID();
const msgPath = path.join(inboxDir, worker.name, `${msgId}.json`);
const message: AgentMailMessage = {
  id: msgId,
  from: "crew",
  to: worker.name,
  text: prompt,
  timestamp: new Date().toISOString(),
};

try {
  fs.mkdirSync(path.dirname(msgPath), { recursive: true });
  fs.writeFileSync(msgPath, JSON.stringify(message), { mode: 0o600 });
  
  // Update worker state
  worker.assignedTaskId = taskId;
  worker.taskId = taskId;
  
  return true;
} catch {
  return false;
}
```

**spawnWorkerForTask(cwd, taskId, prompt):** (Lines 232-320)

Similar to `spawnLobbyWorker()` but:
- Passes prompt directly via args: `args.push(prompt)`
- Sets `PI_CREW_TASK_ID` env var
- No lobby ID or alive file
- Immediately assigns `assignedTaskId = taskId`

**Command Shape Summary:**
```bash
pi --mode json --no-session -p \
  --model "anthropic/claude-haiku-4-5" \
  --thinking "enabled" \
  --tools "read,write,edit,bash" \
  --extension "/path/to/extension" \
  --append-system-prompt "/tmp/crew-worker.md" \
  "Your task prompt here..."
```

**Environment Variables:**
- `PI_AGENT_NAME` - Worker's memorable name
- `PI_CREW_WORKER` - "1" flag indicating crew worker
- `PI_LOBBY_ID` - Unique ID for lobby workers
- `PI_CREW_TASK_ID` - Task ID for task workers
- `PI_MESSENGER_DIR` - Override default `~/.pi/agent/messenger`

---

### 4. Task State Transitions (crew/state.ts, crew/task-actions.ts, crew/store.ts)

#### Task Status Enum
```typescript
type TaskStatus = "todo" | "in_progress" | "done" | "blocked";
```

#### State Transition Diagram

```
┌──────┐
│ todo │◄─────────────────────┐
└──┬───┘                      │
   │                          │
   │ task.start               │ task.reset
   │                          │ worker exit (attempts < max)
   │                          │
   v                          │
┌──────────────┐              │
│ in_progress  │──────────────┤
└──┬─────┬─────┘              │
   │     │                    │
   │     │ task.block         │
   │     │ max attempts       │
   │     │                    │
   │     v                    │
   │   ┌─────────┐            │
   │   │ blocked │────────────┘
   │   └────┬────┘
   │        │
   │        │ task.unblock
   │        │
   │        └────────────────►
   │
   │ task.done
   │
   v
┌──────┐
│ done │ (terminal)
└──────┘
```

#### Task Actions (crew/task-actions.ts)

**executeTaskAction(cwd, action, taskId, agentName, reason, options):**

```typescript
export type TaskAction = "start" | "block" | "unblock" | "reset" | "cascade-reset" | "delete" | "stop";
```

**Action: start**
- Validates: status === "todo"
- Blocks milestones (not manually startable)
- Checks dependencies (unless `dependencies: "advisory"`)
- Calls `store.startTask(cwd, taskId, agentName)`
- Logs feed event

```typescript
if (task.milestone) {
  return { success: false, error: "milestone_not_startable" };
}
if (task.status !== "todo") {
  return { success: false, error: "invalid_status" };
}
if (config.dependencies !== "advisory") {
  const unmet = task.depends_on.filter(depId => store.getTask(cwd, depId)?.status !== "done");
  if (unmet.length > 0) {
    return { success: false, error: "unmet_dependencies", unmetDependencies: unmet };
  }
}
const started = store.startTask(cwd, taskId, agentName);
```

**Action: block**
- Validates: status === "in_progress"
- Requires `reason` parameter
- Calls `store.blockTask(cwd, taskId, reason)`

**Action: unblock**
- Validates: status === "blocked"
- Calls `store.unblockTask(cwd, taskId)`
- Transitions to "todo"

**Action: reset**
- Calls `store.resetTask(cwd, taskId, cascade: false)`
- Resets single task to "todo"
- Clears evidence, summary, assigned_to

**Action: cascade-reset**
- Calls `store.resetTask(cwd, taskId, cascade: true)`
- Resets task + all dependents (recursive)

**Action: delete**
- Validates: worker not active for task
- Calls `store.deleteTask(cwd, taskId)`

**Action: stop**
- Validates: status === "in_progress"
- Kills worker if active: `killWorkerByTask(cwd, taskId)`
- Updates task: `{ status: "todo", assigned_to: undefined }`

#### Store Operations (crew/store.ts)

**startTask(cwd, taskId, agentName):**
```typescript
const task = getTask(cwd, taskId);
if (!task || task.status !== "todo") return null;

const updated = {
  ...task,
  status: "in_progress" as const,
  started_at: new Date().toISOString(),
  base_commit: getBaseCommit(cwd),
  assigned_to: agentName,
  attempt_count: task.attempt_count + 1,
};

updateTask(cwd, taskId, updated);
appendTaskProgress(cwd, taskId, "system", `Started by ${agentName} (attempt ${updated.attempt_count})`);
return updated;
```

**blockTask(cwd, taskId, reason):**
```typescript
const task = getTask(cwd, taskId);
if (!task || task.status !== "in_progress") return null;

const updated = {
  ...task,
  status: "blocked" as const,
  blocked_reason: reason,
  assigned_to: undefined,
};

updateTask(cwd, taskId, updated);
appendTaskProgress(cwd, taskId, "system", `Blocked: ${reason}`);
return updated;
```

**completeTask(cwd, taskId, agentName, summary, evidence):**
```typescript
const task = getTask(cwd, taskId);
if (!task || task.status !== "in_progress" || task.assigned_to !== agentName) {
  return { error: "invalid_state" };
}

const updated = {
  ...task,
  status: "done" as const,
  completed_at: new Date().toISOString(),
  summary,
  evidence,
  assigned_to: undefined,
};

updateTask(cwd, taskId, updated);
appendTaskProgress(cwd, taskId, "system", `Completed: ${summary}`);
plan.completed_count++;
savePlan(cwd, plan);

return { success: true, task: updated };
```

**resetTask(cwd, taskId, cascade):**
```typescript
function collectDependents(taskId: string, collected: Set<string>) {
  const tasks = getTasks(cwd);
  for (const t of tasks) {
    if (t.depends_on.includes(taskId) && !collected.has(t.id)) {
      collected.add(t.id);
      collectDependents(t.id, collected);
    }
  }
}

const toReset = new Set([taskId]);
if (cascade) collectDependents(taskId, toReset);

const resetTasks: Task[] = [];
for (const id of toReset) {
  const task = getTask(cwd, id);
  if (!task) continue;
  
  const reset = {
    ...task,
    status: "todo" as const,
    started_at: undefined,
    completed_at: undefined,
    base_commit: undefined,
    assigned_to: undefined,
    summary: undefined,
    evidence: undefined,
    blocked_reason: undefined,
    last_review: undefined,
  };
  
  updateTask(cwd, id, reset);
  resetTasks.push(reset);
}

return resetTasks;
```

#### Autonomous State (crew/state-autonomous.ts)

```typescript
export interface AutonomousState {
  active: boolean;
  cwd: string | null;
  waveNumber: number;
  waveHistory: WaveResult[];
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: "completed" | "blocked" | "manual" | null;
  concurrency: number;
  autoOverlayPending: boolean;
}

export const autonomousState: AutonomousState = {
  active: false,
  cwd: null,
  waveNumber: 0,
  waveHistory: [],
  startedAt: null,
  stoppedAt: null,
  stopReason: null,
  concurrency: 2,
  autoOverlayPending: false,
};
```

**Wave Management:**
```typescript
function startAutonomous(cwd: string, concurrency: number): void {
  autonomousState.active = true;
  autonomousState.cwd = normalizeCwd(cwd);
  autonomousState.waveNumber = 1;
  autonomousState.waveHistory = [];
  autonomousState.startedAt = new Date().toISOString();
  autonomousState.stoppedAt = null;
  autonomousState.stopReason = null;
  autonomousState.concurrency = clampConcurrency(concurrency);
  autonomousState.autoOverlayPending = true;
}

function addWaveResult(result: WaveResult): void {
  autonomousState.waveHistory.push(result);
  autonomousState.waveNumber++;
}

function stopAutonomous(reason: "completed" | "blocked" | "manual"): void {
  autonomousState.active = false;
  autonomousState.autoOverlayPending = false;
  autonomousState.stoppedAt = new Date().toISOString();
  autonomousState.stopReason = reason;
}
```

#### Planning State (crew/state-planning.ts)

```typescript
export interface PlanningState {
  cwd: string | null;
  pid: number | null;
  runId: string | null;
  startedAt: number | null;
  maxPasses: number;
  pass: number;
  phase: string;
}

export const planningState: PlanningState = {
  cwd: null,
  pid: null,
  runId: null,
  startedAt: null,
  maxPasses: 3,
  pass: 0,
  phase: "idle",
};
```

**Stale Detection:**
```typescript
function isPlanningStalled(cwd: string): boolean {
  if (!isPlanningForCwd(cwd) || !planningState.pid) return false;
  try {
    process.kill(planningState.pid, 0);
    return false;
  } catch {
    return true;
  }
}

function restorePlanningState(cwd: string): { staleCleared: boolean } {
  const crewDir = join(cwd, ".pi", "messenger", "crew");
  const statePath = join(crewDir, "planning-state.json");
  
  if (!existsSync(statePath)) return { staleCleared: false };
  
  const saved = JSON.parse(readFileSync(statePath, "utf-8"));
  
  // Check if planner process still alive
  if (saved.pid) {
    try {
      process.kill(saved.pid, 0);
      // Still alive, restore
      Object.assign(planningState, saved);
      return { staleCleared: false };
    } catch {
      // Dead, clear
      unlinkSync(statePath);
      return { staleCleared: true };
    }
  }
  
  return { staleCleared: false };
}
```

---

### 5. Reservation Enforcement

**File:** `index.ts:771-789`

**Hook:** `pi.on("tool_call", ...)`

**Trigger:** Before `edit` or `write` tool execution

**Logic:**
1. Extract `filePath` from tool input
2. Call `store.getConflictsWithOtherAgents(filePath, state, dirs)`
3. If conflicts found, return `{ block: true, reason: "..." }`
4. Otherwise, allow tool to proceed

**getConflictsWithOtherAgents() implementation (store.ts):**

```typescript
export function getConflictsWithOtherAgents(
  filePath: string,
  state: MessengerState,
  dirs: Dirs
): Array<{ agent: string; pattern: string; reason?: string; registration: AgentRegistration }> {
  const conflicts: Array<...> = [];
  const agents = getActiveAgents(state, dirs);
  
  for (const agent of agents) {
    if (agent.name === state.agentName) continue; // Skip self
    
    for (const r of agent.reservations ?? []) {
      if (matchesReservation(filePath, r.pattern)) {
        conflicts.push({
          agent: agent.name,
          pattern: r.pattern,
          reason: r.reason,
          registration: agent
        });
      }
    }
  }
  
  return conflicts;
}

function matchesReservation(filePath: string, pattern: string): boolean {
  // Normalize paths
  const normalizedFile = path.resolve(filePath);
  const normalizedPattern = path.resolve(pattern);
  
  // Exact match
  if (normalizedFile === normalizedPattern) return true;
  
  // Directory prefix match (pattern ends with /)
  if (normalizedPattern.endsWith("/")) {
    return normalizedFile.startsWith(normalizedPattern);
  }
  
  // Glob pattern (simple * support)
  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(
      "^" + normalizedPattern.replace(/\*/g, ".*") + "$"
    );
    return regex.test(normalizedFile);
  }
  
  return false;
}
```

**Blocking Behavior:**
- Tool call is aborted BEFORE execution
- Error message includes:
  - File path
  - Reservation owner (name + location)
  - Reason (if provided)
  - Coordination hint: `pi_messenger({ action: "send", to: "...", message: "..." })`

**Example Error:**
```
src/auth/middleware.ts
Reserved by: Alice (familiar on feat/jwt)
Reason: "Implementing JWT validation"

Coordinate via pi_messenger({ action: "send", to: "Alice", message: "..." })
```

---

### 6. Overlay/TUI (overlay.ts, overlay-render.ts, overlay-actions.ts)

#### Architecture

**Main Component:** `MessengerOverlay` implements `Component` and `Focusable` interfaces from `@mariozechner/pi-tui`

**Rendering Pipeline:**
1. `render()` called by TUI system
2. Calls section renderers from `overlay-render.ts`
3. Returns `string[]` (one string per line)

**State Management:**
- `CrewViewState` holds view-specific state (scroll, selection, input mode)
- Created in `overlay-actions.ts:createCrewViewState()`
- Mutated by keyboard handlers

#### Key State (overlay-actions.ts:23-52)

```typescript
export interface CrewViewState {
  mode: "tasks" | "workers" | "feed" | "agents";
  taskScroll: number;
  taskSelectedIndex: number;
  workerScroll: number;
  feedScroll: number;
  feedFilterType: FeedEventType | "all";
  agentScroll: number;
  showCompleted: boolean;
  inputMode: null | "confirm" | "block-reason" | "message" | "revise-prompt";
  inputValue: string;
  inputContext?: InputContext;
  notificationMessage: string | null;
  notificationSuccess: boolean;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  detailView: "task" | "worker" | "feed" | null;
  detailId: string | null;
  detailScroll: number;
}
```

**Modes:**
- `tasks` - Task list view (default)
- `workers` - Active workers view
- `feed` - Activity feed view
- `agents` - Connected agents view

**Input Modes:**
- `confirm` - Y/N confirmation dialog
- `block-reason` - Text input for block reason
- `message` - Text input for sending message
- `revise-prompt` - Text input for task revision prompt

#### Keyboard Bindings (overlay.ts:800-900)

**Global:**
- `q`, `Esc` - Close overlay (exit or background)
- `?` - Show help/legend
- `r` - Refresh view
- `Tab` - Cycle modes (tasks → workers → feed → agents → tasks)
- `Ctrl+B` - Background overlay (keep process running)

**Task List Mode:**
- `↑`/`k`, `↓`/`j` - Navigate tasks
- `Enter` - Task detail view (or start if todo)
- `s` - Start selected task (spawn worker)
- `b` - Block task (prompts for reason)
- `u` - Unblock task
- `x` - Reset task
- `X` - Cascade reset (task + dependents)
- `Del` - Delete task
- `e` - Edit task in editor
- `t` - Toggle show completed
- `+`/`-` - Adjust concurrency (spawns/no-op)

**Worker View Mode:**
- `↑`/`k`, `↓`/`j` - Navigate workers
- `Enter` - Worker detail view
- `K` - Kill selected worker

**Feed Mode:**
- `↑`/`k`, `↓`/`j` - Scroll feed
- `f` - Cycle filter (all → join → leave → commit → test → ...)
- `Enter` - Feed event detail view

**Agents Mode:**
- `↑`/`k`, `↓`/`j` - Navigate agents
- `Enter` - Agent detail view (whois)
- `m` - Send message to selected agent

**Detail View:**
- `Esc`, `←` - Back to list
- `↑`/`k`, `↓`/`j` - Scroll detail

#### Refresh Timers (overlay.ts:170-230)

**Progress Timer:**
- Interval: 2000ms (2 seconds)
- Runs when live workers active
- Triggers `tui.requestRender()`

**Planning Timer:**
- Interval: 5000ms (5 seconds)
- Runs when planning active for current project
- Updates planning state, checks auto-spawn on completion

**Live Worker Change Listener:**
- Callback registered via `onLiveWorkersChanged()`
- Syncs refresh timers (start/stop based on active workers)
- Triggers immediate render

#### Rendering Sections (overlay-render.ts)

**renderStatusBar(width, plan, autonomousState, planningState, theme):**
- Shows plan label, completion progress, autonomous mode indicator
- Format: `[Plan: docs/PRD.md] 3/8 ⚡ wave 2 (4w)`

**renderTaskList(tasks, viewState, width, height, config, theme):**
- Scrollable task list with status indicators
- Format: `[●] task-1: Implement auth middleware (3 deps)`
- Highlights selected task

**renderTaskSummary(tasks, width, theme):**
- Compact summary: `Tasks: 3 todo, 2 in progress, 1 blocked, 2 done`

**renderWorkersSection(workers, viewState, width, height, theme):**
- Live worker progress: tokens, tool count, recent tools
- Format: `Alice → task-1 | 1.2k | 15 tools | read(auth.ts), edit(middleware.ts)`

**renderFeedSection(events, viewState, width, height, theme):**
- Activity feed with timestamp, agent, event type, details
- Format: `2m ago · Alice · commit · "feat: Add JWT validation"`
- Filtered by event type (join, leave, commit, test, etc.)

**renderAgentsRow(agents, claimsMap, tasksMap, viewState, theme):**
- Connected agents with status, reservations, task
- Format: `● Alice (active) | src/auth/ | task-1`

**renderDetailView(viewState, width, height, theme, cwd, stuckThresholdMs, state, dirs):**
- Task detail: Full description, dependencies, progress log, review feedback
- Worker detail: Full progress, stdout tail
- Feed event detail: Full event data
- Agent detail: Whois information

#### Auto-Spawn on Plan Complete (overlay.ts:235-255)

```typescript
private checkAutoSpawnOnPlanComplete(planning: boolean): void {
  const wasPlanningBefore = this.wasPlanning;
  this.wasPlanning = planning;
  
  // Planning just finished
  if (!wasPlanningBefore || planning) return;
  
  const readyTasks = crewStore.getReadyTasks(this.cwd, { advisory: ... });
  if (readyTasks.length > 0) {
    const target = Math.min(readyTasks.length, autonomousState.concurrency);
    const { assigned } = spawnWorkersForReadyTasks(this.cwd, target);
    if (assigned > 0) {
      setNotification(this.crewViewState, this.tui, true, 
        `Plan ready — ${assigned} worker${assigned > 1 ? "s" : ""} started`);
      this.tui.requestRender();
    }
  }
  
  cleanupUnassignedAliveFiles(this.cwd);
}
```

**Trigger:** Called in planning timer callback when `isPlanningForCwd()` transitions from `true` to `false`

**Behavior:**
- Checks for ready tasks
- Spawns workers up to `autonomousState.concurrency`
- Shows notification with worker count

---

### 7. Config Resolution Order (config.ts)

**Priority (highest to lowest):**
1. Project: `.pi/pi-messenger.json`
2. Extension-specific: `~/.pi/agent/pi-messenger.json`
3. Main settings: `~/.pi/agent/settings.json` → `"messenger"` key
4. Defaults

**loadConfig(cwd) implementation:**

```typescript
export function loadConfig(cwd: string): MessengerConfig {
  const projectPath = join(cwd, ".pi", "pi-messenger.json");
  const extensionGlobalPath = join(homedir(), ".pi", "agent", "pi-messenger.json");
  const mainSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
  
  // Load from main settings.json (lowest priority)
  let settingsConfig: Partial<MessengerConfig> = {};
  const mainSettings = readJsonFile(mainSettingsPath);
  if (mainSettings && typeof mainSettings.messenger === "object") {
    settingsConfig = mainSettings.messenger as Partial<MessengerConfig>;
  }
  
  // Load extension-specific global config
  const extensionConfig = readJsonFile(extensionGlobalPath);
  
  // Load project config (highest priority)
  const projectConfig = readJsonFile(projectPath);
  
  // Merge with priority
  const merged = {
    ...DEFAULT_CONFIG,
    ...settingsConfig,
    ...(extensionConfig ?? {}),
    ...(projectConfig ?? {})
  };
  
  // Normalize autoRegisterPaths
  if (Array.isArray(merged.autoRegisterPaths)) {
    merged.autoRegisterPaths = merged.autoRegisterPaths.map(expandHome);
  }
  
  return merged;
}
```

**Config Fields:**

```typescript
export interface MessengerConfig {
  autoRegister: boolean;                      // Auto-join on session start
  autoRegisterPaths: string[];                 // Paths that trigger auto-join
  scopeToFolder: boolean;                      // Scope registry to cwd (default: global)
  contextMode: "full" | "minimal" | "none";    // Message context verbosity
  registrationContext: boolean;                // Send context msg on join
  replyHint: boolean;                          // Include reply hint in messages
  senderDetailsOnFirstContact: boolean;        // Show sender details on first message
  nameTheme: string;                           // Name generator theme
  nameWords?: { adjectives: string[]; nouns: string[] }; // Custom name words
  feedRetention: number;                       // Max feed events to keep
  stuckThreshold: number;                      // Seconds before "stuck" status
  stuckNotify: boolean;                        // Notify on stuck detection
  autoStatus: boolean;                         // Auto-generate status messages
  autoOverlay: boolean;                        // Auto-open overlay on autonomous start
  autoOverlayPlanning: boolean;                // Auto-open overlay on planning start
  crewEventsInFeed: boolean;                   // Include crew events in feed
}
```

**Defaults:**

```typescript
const DEFAULT_CONFIG: MessengerConfig = {
  autoRegister: false,
  autoRegisterPaths: [],
  scopeToFolder: false,
  contextMode: "full",
  registrationContext: true,
  replyHint: true,
  senderDetailsOnFirstContact: true,
  nameTheme: "default",
  feedRetention: 50,
  stuckThreshold: 900,
  stuckNotify: true,
  autoStatus: true,
  autoOverlay: true,
  autoOverlayPlanning: true,
  crewEventsInFeed: true,
};
```

**Auto-Register Paths Matching:**

```typescript
export function matchesAutoRegisterPath(cwd: string, paths: string[]): boolean {
  const normalizedCwd = cwd.replace(/\/+$/, "");
  
  for (const pattern of paths) {
    const expanded = expandHome(pattern).replace(/\/+$/, "");
    
    // Trailing /* matches any subdirectory
    if (expanded.endsWith("/*")) {
      const base = expanded.slice(0, -2);
      if (normalizedCwd === base || normalizedCwd.startsWith(base + "/")) {
        return true;
      }
    }
    // Prefix match: /path/prefix* matches /path/prefix-anything
    else if (expanded.endsWith("*")) {
      const prefix = expanded.slice(0, -1);
      if (normalizedCwd.startsWith(prefix)) {
        return true;
      }
    }
    // Exact match
    else {
      if (normalizedCwd === expanded) {
        return true;
      }
    }
  }
  
  return false;
}
```

**Crew Config (separate file):**

Path: `.pi/messenger/crew/crew.json` (project-specific)

```typescript
export interface CrewConfig {
  concurrency: {
    workers: number;           // Default: 2
    max: number;               // Hard limit: 10
  };
  coordination: "none" | "minimal" | "moderate" | "chatty"; // Default: "chatty"
  messageBudgets?: Record<string, number>;
  dependencies: "strict" | "advisory"; // Default: "strict"
  models?: {
    planner?: string;
    worker?: string;
    reviewer?: string;
  };
  thinking?: {
    planner?: string;
    worker?: string;
    reviewer?: string;
  };
  work: {
    maxWaves: number;          // Default: 100
    maxAttemptsPerTask: number; // Default: 3
    env?: Record<string, string>;
  };
}
```

**Coordination Levels:**
- `none` - No inter-worker communication, 10k token budget
- `minimal` - Rare coordination, 20k token budget
- `moderate` - Task handoffs, 50k token budget
- `chatty` - Full collaboration, 100k token budget

---

### 8. pi_messenger Action Handlers

**Action Router:** `crew/index.ts:executeCrewAction()`

**Handler Locations:**
- Coordination: `handlers.ts`
- Crew: `crew/handlers/*.ts`

#### Coordination Actions (handlers.ts)

| Action | Handler | Parameters | Description |
|--------|---------|------------|-------------|
| `join` | `executeJoin()` | `spec?` | Join agent mesh, start file watcher |
| `status` | `executeStatus()` | - | Show registration status, peer count |
| `list` | `executeList()` | - | List all active agents with presence |
| `whois` | `executeWhois()` | `name` | Show agent details (status, activity, reservations) |
| `set_status` | `executeSetStatus()` | `message?` | Set custom status (clear if empty) |
| `feed` | `executeFeed()` | `limit?` | Activity feed (last N events) |
| `spec` | `executeSetSpec()` | `spec` | Set spec file path |
| `send` | `executeSend()` | `to, message, replyTo?` | Send message to agent(s) |
| `broadcast` | `executeSend()` | `message` | Broadcast to all agents |
| `reserve` | `executeReserve()` | `paths[], reason?` | Reserve files/directories |
| `release` | `executeRelease()` | `paths[]?` | Release reservations (all if no paths) |
| `rename` | `executeRename()` | `name` | Change agent name |
| `swarm` | `executeSwarm()` | `spec?` | Show swarm status (claims, completions) |
| `claim` | `executeClaim()` | `taskId, spec?, reason?` | Claim task (legacy, deprecated) |
| `unclaim` | `executeUnclaim()` | `taskId, spec?` | Release claim (legacy) |
| `complete` | `executeComplete()` | `taskId, notes?, spec?` | Complete task (legacy) |
| `autoRegisterPath` | `executeAutoRegisterPath()` | `add\|remove\|list` | Manage auto-register paths |

#### Crew Actions (crew/handlers/*.ts)

| Action | Handler | Parameters | Description |
|--------|---------|------------|-------------|
| `plan` | `plan.ts:execute()` | `prd?, prompt?` | Spawn planner, create task breakdown |
| `plan.cancel` | `crew/index.ts` | - | Cancel active planning run |
| `work` | `work.ts:execute()` | `autonomous?, concurrency?, model?` | Spawn workers for ready tasks |
| `task.show` | `task.ts:execute("show")` | `id` | Show task details + spec content |
| `task.list` | `task.ts:execute("list")` | - | List all tasks with status |
| `task.create` | `task.ts:execute("create")` | `title, content?, dependsOn?` | Create new task manually |
| `task.start` | `task.ts:execute("start")` | `id` | Start task (mark in_progress) |
| `task.done` | `task.ts:execute("done")` | `id, summary, evidence?` | Complete task |
| `task.block` | `task.ts:execute("block")` | `id, reason` | Block task |
| `task.unblock` | `task.ts:execute("unblock")` | `id` | Unblock task |
| `task.progress` | `task.ts:execute("progress")` | `id, message` | Log progress entry |
| `task.reset` | `task.ts:execute("reset")` | `id, cascade?` | Reset task (+ dependents if cascade) |
| `task.delete` | `task.ts:execute("delete")` | `id` | Delete task |
| `task.stop` | `task.ts:execute("stop")` | `id` | Stop worker, reset to todo |
| `task.split` | `task.ts:execute("split")` | `id, count?, subtasks?` | Split task into subtasks |
| `task.revise` | `revise.ts:executeRevise()` | `id, prompt` | Revise single task spec |
| `task.revise-tree` | `revise.ts:executeReviseTree()` | `id, prompt` | Revise task + dependents |
| `review` | `review.ts:execute()` | `target, type?` | Review task impl or plan |
| `sync` | `sync.ts:execute()` | `id` | Sync downstream specs after completion |
| `status` | `status.ts:execute()` | - | Crew status (plan, tasks, workers) |

#### Action Handler Details

**plan (crew/handlers/plan.ts:200-450)**

```typescript
export async function execute(
  params: CrewParams,
  ctx: ExtensionContext,
  agentName: string,
  triggerOverlayRender: () => void
) {
  const cwd = ctx.cwd ?? process.cwd();
  
  // Validate not already planning
  if (isPlanningForCwd(cwd)) {
    return result("Planning already in progress. Cancel with pi_messenger({ action: 'plan.cancel' })",
      { mode: "plan", error: "already_planning" });
  }
  
  // Resolve PRD or prompt
  const prdPath = params.prd ?? discoverPRD(cwd);
  const prompt = params.prompt;
  
  if (!prdPath && !prompt) {
    return result("No PRD found. Provide prd path or inline prompt.",
      { mode: "plan", error: "no_prd" });
  }
  
  // Install crew agents to local directory
  await installCrewAgents(cwd);
  
  // Build planner prompt
  const agents = discoverCrewAgents(cwd);
  const plannerAgent = agents.find(a => a.name === "crew-planner");
  const plannerPrompt = buildPlannerPrompt(prdPath, prompt, cwd);
  
  // Spawn planner subprocess
  const args = ["--mode", "json", "--no-session", "-p"];
  pushModelArgs(args, config.models?.planner ?? plannerAgent.model);
  if (plannerAgent.thinking) args.push("--thinking", plannerAgent.thinking);
  args.push("--extension", EXTENSION_DIR);
  if (plannerAgent.systemPrompt) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-planner-"));
    const promptPath = path.join(tmpDir, "crew-planner.md");
    fs.writeFileSync(promptPath, plannerAgent.systemPrompt);
    args.push("--append-system-prompt", promptPath);
  }
  args.push(plannerPrompt);
  
  const env = { ...process.env, PI_AGENT_NAME: "Planner" };
  const proc = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
  
  // Set planning state
  setPlanningState(cwd, process.pid, randomUUID().slice(0, 6), 3);
  
  // Watch for task files
  const watchInterval = setInterval(() => {
    const tasks = crewStore.getTasks(cwd);
    if (tasks.length > 0) {
      clearInterval(watchInterval);
      markPlanningPhase(cwd, "finalizing");
    }
  }, 2000);
  
  // Handle planner exit
  proc.on("close", (exitCode) => {
    clearInterval(watchInterval);
    
    if (exitCode === 0) {
      const tasks = crewStore.getTasks(cwd);
      const plan = crewStore.getPlan(cwd);
      
      if (tasks.length > 0 && plan) {
        // Success
        clearPlanningState(cwd);
        
        // Auto-work if configured
        if (params.autoWork !== false && config.autoWork) {
          setPendingAutoWork(cwd);
        }
      } else {
        // No tasks generated
        clearPlanningState(cwd);
      }
    } else {
      // Planner failed
      clearPlanningState(cwd);
    }
    
    triggerOverlayRender();
  });
  
  return result(`Planning started. Watch progress with /messenger overlay.`,
    { mode: "plan", prd: prdPath, prompt });
}
```

**work (crew/handlers/work.ts:22-180)**

See section 3 (Worker Spawning) for detailed implementation.

**Key points:**
- Validates plan exists
- Auto-blocks tasks exceeding max attempts
- Assigns to lobby workers first (already running)
- Spawns fresh workers for remaining tasks
- Throttles via `autonomousState.concurrency`
- Starts autonomous mode if `autonomous: true`
- Logs wave result on completion
- Continues on `agent_end` if autonomous and ready tasks available

**task.show (crew/handlers/task.ts:30-60)**

```typescript
case "show": {
  const task = store.getTask(cwd, params.id!);
  if (!task) {
    return result(`Task ${params.id} not found`, { mode: "task.show", error: "not_found" });
  }
  
  const specPath = path.join(crewDir, "tasks", `${task.id}.md`);
  const specContent = fs.existsSync(specPath)
    ? fs.readFileSync(specPath, "utf-8")
    : "(No spec file)";
  
  const lines = [
    `# ${task.id}: ${task.title}`,
    `Status: ${task.status}`,
    `Dependencies: ${task.depends_on.join(", ") || "none"}`,
    "",
    "## Spec",
    "",
    specContent
  ];
  
  if (task.blocked_reason) {
    lines.push("", `## Blocked`, task.blocked_reason);
  }
  
  if (task.last_review) {
    lines.push("", `## Last Review`, task.last_review.summary);
  }
  
  return result(lines.join("\n"), { mode: "task.show", task });
}
```

**task.done (crew/handlers/task.ts:120-180)**

```typescript
case "done": {
  const task = store.getTask(cwd, params.id!);
  if (!task || task.status !== "in_progress") {
    return result(`Task ${params.id} must be in_progress to complete`,
      { mode: "task.done", error: "invalid_status" });
  }
  
  if (!params.summary) {
    return result("Summary required for task.done",
      { mode: "task.done", error: "missing_summary" });
  }
  
  const completed = store.updateTask(cwd, params.id!, {
    status: "done",
    completed_at: new Date().toISOString(),
    summary: params.summary,
    evidence: params.evidence,
    assigned_to: undefined,
  });
  
  const plan = store.getPlan(cwd);
  if (plan) {
    plan.completed_count++;
    store.savePlan(cwd, plan);
  }
  
  store.appendTaskProgress(cwd, params.id!, state.agentName, `Completed: ${params.summary}`);
  logFeedEvent(cwd, state.agentName, "task.done", params.id!, params.summary);
  
  // Auto-complete milestones
  store.autoCompleteMilestones(cwd);
  
  return result(`Completed ${params.id}`, {
    mode: "task.done",
    task: completed,
    planProgress: plan ? `${plan.completed_count}/${plan.task_count}` : undefined
  });
}
```

**task.split (crew/handlers/task.ts:220-310)**

Two-phase operation:

1. **Inspect phase** (`subtasks` not provided):
   - Shows task spec
   - Suggests split count
   - Returns instructions for executing split

2. **Execute phase** (`subtasks` provided):
   - Validates parent task exists and is todo
   - Creates subtask files in `.pi/messenger/crew/tasks/`
   - Updates parent task dependencies to point to subtasks
   - Returns confirmation

```typescript
case "split": {
  const parent = store.getTask(cwd, params.id!);
  if (!parent) {
    return result(`Task ${params.id} not found`, { mode: "task.split", error: "not_found" });
  }
  
  // Inspect phase
  if (!params.subtasks) {
    const specPath = path.join(crewDir, "tasks", `${parent.id}.md`);
    const specContent = fs.readFileSync(specPath, "utf-8");
    const suggestedCount = params.count ?? 3;
    
    return result(
      `# Split ${parent.id}\n\n${specContent}\n\n` +
      `Suggested split: ${suggestedCount} subtasks.\n\n` +
      `To execute: pi_messenger({ action: "task.split", id: "${parent.id}", subtasks: [...] })`,
      { mode: "task.split", phase: "inspect", task: parent, suggestedCount }
    );
  }
  
  // Execute phase
  if (parent.status !== "todo") {
    return result(`Task ${parent.id} must be todo to split`,
      { mode: "task.split", error: "invalid_status" });
  }
  
  const subtaskIds: string[] = [];
  for (let i = 0; i < params.subtasks.length; i++) {
    const subtask = params.subtasks[i];
    const subtaskId = `${parent.id}.${i + 1}`;
    
    store.createTask(cwd, {
      id: subtaskId,
      title: subtask.title,
      status: "todo",
      depends_on: [],
      skills: parent.skills,
    });
    
    const subtaskSpecPath = path.join(crewDir, "tasks", `${subtaskId}.md`);
    fs.writeFileSync(subtaskSpecPath, subtask.content ?? subtask.title);
    
    subtaskIds.push(subtaskId);
  }
  
  // Update parent to depend on all subtasks
  store.updateTask(cwd, parent.id, {
    depends_on: subtaskIds,
    milestone: true,
  });
  
  return result(`Split ${parent.id} into ${subtaskIds.length} subtasks`,
    { mode: "task.split", phase: "execute", parent: parent.id, subtasks: subtaskIds });
}
```

**review (crew/handlers/review.ts:18-150)**

```typescript
export async function execute(params: CrewParams, ctx: ExtensionContext) {
  const cwd = ctx.cwd ?? process.cwd();
  const targetId = params.target;
  const type = params.type ?? (targetId?.startsWith("task-") ? "impl" : "plan");
  
  if (type === "impl") {
    // Review task implementation
    const task = store.getTask(cwd, targetId!);
    if (!task || task.status !== "done") {
      return result("Task must be done to review", { mode: "review", error: "invalid_status" });
    }
    
    // Get git diff
    const diffCmd = `git diff ${task.base_commit}..HEAD`;
    const diff = execSync(diffCmd, { cwd, encoding: "utf-8" });
    
    // Build review prompt
    const prompt = buildReviewPrompt(task, diff, cwd);
    
    // Spawn reviewer
    const args = ["--mode", "json", "--no-session", "-p"];
    pushModelArgs(args, config.models?.reviewer ?? reviewerAgent.model);
    args.push("--extension", EXTENSION_DIR);
    args.push(prompt);
    
    const proc = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "inherit"], env });
    
    // Parse output
    let output = "";
    proc.stdout?.on("data", (data) => { output += data.toString(); });
    
    await new Promise((resolve) => proc.on("close", resolve));
    
    // Parse verdict
    const verdict = parseVerdict(output);
    
    // Update task with review feedback
    if (verdict.verdict !== "SHIP") {
      store.updateTask(cwd, targetId!, {
        last_review: {
          verdict: verdict.verdict,
          summary: verdict.summary,
          issues: verdict.issues,
          suggestions: verdict.suggestions,
          reviewed_at: new Date().toISOString(),
        }
      });
    }
    
    return result(output, { mode: "review", type: "impl", target: targetId, verdict });
  }
  
  // type === "plan"
  // Review plan quality (not yet implemented)
  return result("Plan review not yet implemented", { mode: "review", error: "not_implemented" });
}
```

---

## Summary

### What Pi-Messenger Does

1. **File-Based Agent Mesh**: No daemon, agents discover each other via `~/.pi/agent/messenger/registry/`
2. **Task Orchestration**: PRD → planner → task breakdown → parallel worker execution
3. **Live Progress Monitoring**: TUI overlay with real-time worker status, task list, activity feed
4. **Reservation System**: File-level conflict prevention with `tool_call` hooks
5. **Autonomous Execution**: Wave-based continuous work until done/blocked

### Key Design Patterns

- **Event-Driven Lifecycle**: Pi SDK hooks (`session_start`, `tool_call`, `agent_end`) drive state transitions
- **JSONL Streaming**: Worker progress via stdout parsing
- **File-Based Coordination**: Registry, inbox, specs, feed all JSONL/JSON files
- **Process Supervision**: Lobby workers pre-spawned, assigned on-demand, budget-enforced
- **State Persistence**: Autonomous and planning state restored across sessions

### Critical Implementation Details

1. **Worker Spawning**: `spawn("pi", args, { cwd, stdio })` with JSON mode, env vars for identity
2. **Task State Machine**: `todo → in_progress → done/blocked`, reset clears to todo
3. **Reservation Enforcement**: `tool_call` hook blocks before execution, returns `{ block: true }`
4. **Config Priority**: Project > Extension > Main Settings > Defaults
5. **Auto-Spawn**: Planning completion triggers worker spawn if `autoWork` enabled

### Files to Modify for Common Tasks

- **Add action**: `crew/handlers/<action>.ts` + import in `crew/index.ts`
- **Change task fields**: `crew/types.ts` (Task interface) + `crew/store.ts` (update functions)
- **Add config option**: `config.ts` (DEFAULT_CONFIG) + update type
- **Modify worker behavior**: `crew/agents/crew-worker.md` (prompt + frontmatter)
- **Add overlay section**: `overlay-render.ts` (render function) + `overlay.ts` (call in render())

---

✅ **DONE:** Deep scan complete. All requested information documented with file paths and line numbers.
