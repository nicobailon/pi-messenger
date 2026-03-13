<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-07 -->
<!-- Status: REVISED -->
<!-- Prior review: 24 findings resolved (R1:10 + R2:8 + R3:6) -->
<!-- Fresh review (2026-03-07): 9 findings across 4 rounds -->
<!-- FR1: [1] spawnAgents pre-claim timing, [2] concurrent git diff scoping, [3] nonce auth wiring, [4] CLI --pattern→--paths, [5] Claude tool_result mapping -->
<!-- FR2: [1] reservedPaths callsite wiring, [2] shaping.md stale --pattern, [3] nonceHash AgentRegistration schema -->
<!-- FR3: [1] getActiveAgents dead-PID filter → direct regfile read -->
<!-- FR4: APPROVED -->
<!-- R3: [1] Registry path via getMessengerRegistryDir(), [2] warnings destructured at both callsites, [3] spawn.ts non-pi fallback to spawnAgents, [4] prepack hook, [5] untracked files in getChangedFiles, [6] Worker nonce auth -->
---
title: "Multi-Runtime Agent Support — Implementation Plan"
date: 2026-03-07
bead: pi-messenger-2
shape: "D' (Adapter + CLI, Pi Extension Preserved)"
---

# Implementation Plan

Based on Shape D' from shaping.md. Four vertical slices (V1→V2→V3→V4), each demo-able.

## Architecture

### RuntimeAdapter Interface

```typescript
// crew/utils/adapters/types.ts

export type RuntimeFeature =
  | "streaming"
  | "thinking"
  | "tool-restriction"
  | "extension-loading"
  | "system-prompt-file"
  | "system-prompt-inline";

export interface SpawnTask {
  prompt: string;
  systemPrompt?: string;
  systemPromptPath?: string;
}

export interface AdapterConfig {
  model?: string;
  thinking?: string;
  tools?: string[];
  extensionDir: string;
}

export interface RuntimeAdapter {
  readonly name: string;
  getCommand(): string;
  buildArgs(task: SpawnTask, config: AdapterConfig): string[];
  buildEnv(base: Record<string, string>): Record<string, string>;
  parseProgressEvent(line: string): ProgressEvent | null;
  supportsFeature(feature: RuntimeFeature): boolean;
}

export interface ProgressEvent {
  type: "tool_call" | "tool_result" | "message" | "error" | "unknown";
  toolName?: string;
  args?: Record<string, unknown>;
  tokens?: { input?: number; output?: number };
  model?: string;
  content?: string;
  errorMessage?: string;
}
```

### File Layout

```
crew/utils/adapters/
├── types.ts        # RuntimeAdapter interface + ProgressEvent
├── index.ts        # getAdapter() factory + resolveRuntime() helper
├── pi.ts           # PiAdapter — wraps current arg construction + JSONL parsing
└── claude.ts       # ClaudeAdapter — Claude Code CLI flags + stream-json parsing

crew/runtime-spawn.ts  # Unified spawn engine (shared by agents.ts + lobby.ts)

cli/
└── index.ts        # pi-messenger-cli entry point + command router
```

### Two Spawn Paths — One Engine

**Critical insight (Codex R1 finding #1):** There are TWO separate spawn paths:
1. **`crew/lobby.ts`** — lobby workers (pre-warmed, assigned tasks via steer messages)
2. **`crew/agents.ts` `spawnAgents()` → `runAgent()`** — crew workers spawned per-task from `work.ts:161`

Both currently hardcode `spawn("pi", [...])` with pi-specific args. The adapter pattern must wire into BOTH paths.

**Solution: `crew/runtime-spawn.ts`** — a shared spawn engine that:
- Takes a `RuntimeAdapter`, `SpawnTask`, and `AdapterConfig`
- Returns `{ command: string, args: string[], env: Record<string, string> }`
- Both `agents.ts:runAgent()` and `lobby.ts:spawnWorkerForTask()` call this engine
- No duplicated arg construction logic

```typescript
// crew/runtime-spawn.ts
import { execFileSync } from "node:child_process";
import type { RuntimeAdapter, SpawnTask, AdapterConfig } from "./utils/adapters/types.js";
import { getAdapter, resolveRuntime } from "./utils/adapters/index.js";
import type { CrewConfig } from "./utils/config.js";

const RUNTIME_ALLOWLIST = new Set(["pi", "claude"]);

export interface RuntimeSpawnArgs {
  command: string;
  args: string[];
  env: Record<string, string>;
  adapter: RuntimeAdapter;
  warnings: string[];  // R5 compliance: callers MUST log these to feed
}

export function buildRuntimeSpawn(
  runtime: string,
  task: SpawnTask,
  config: AdapterConfig,
  baseEnv: Record<string, string>,
): RuntimeSpawnArgs {
  if (!RUNTIME_ALLOWLIST.has(runtime)) {
    throw new Error(`Unknown runtime "${runtime}". Allowed: ${[...RUNTIME_ALLOWLIST].join(", ")}`);
  }
  const adapter = getAdapter(runtime);
  const command = adapter.getCommand();
  validateCommandAvailable(command);
  validateCliAvailable(runtime);  // Fail fast if non-pi runtime can't report back

  // R5 compliance: log warnings for unsupported features
  const warnings: string[] = [];
  if (config.thinking && !adapter.supportsFeature("thinking")) {
    warnings.push(`${runtime}: thinking flag not supported, skipping`);
  }
  if (config.tools?.length && !adapter.supportsFeature("tool-restriction")) {
    warnings.push(`${runtime}: tool restriction not supported, skipping`);
  }
  if (config.extensionDir && !adapter.supportsFeature("extension-loading")) {
    warnings.push(`${runtime}: extension loading not supported, custom tools unavailable`);
  }
  // Warnings are returned for caller to log to feed (not silently skipped — R5)

  const args = adapter.buildArgs(task, config);
  const env = adapter.buildEnv(baseEnv);
  return { command, args, env, adapter, warnings };
}

// Also validate pi-messenger-cli is available for non-pi runtimes (R2 finding #8)
function validateCliAvailable(runtime: string): void {
  if (runtime === "pi") return; // pi uses typed tool calls, no CLI needed
  try {
    execFileSync("which", ["pi-messenger-cli"], { stdio: "ignore" });
  } catch {
    throw new Error(
      `pi-messenger-cli not found in PATH (required for ${runtime} workers to report task status). ` +
      `Install: npm install -g pi-messenger`
    );
  }
}

function validateCommandAvailable(command: string): void {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
  } catch {
    throw new Error(`Runtime command "${command}" not found in PATH`);
  }
}
```

### Wiring: agents.ts (main worker path)

**`crew/agents.ts` `runAgent()` (lines ~200-260) — BEFORE:**
```typescript
const args = ["--mode", "json", "--no-session", "-p"];
pushModelArgs(args, model);
// ... 40 lines of pi-specific arg construction ...
const proc = spawn("pi", args, { cwd, stdio, env });
```

**AFTER:**
```typescript
const runtime = resolveRuntime(config, role);
const spawnTask: SpawnTask = { prompt: task.task, systemPrompt: agentConfig?.systemPrompt, systemPromptPath };
const adapterCfg: AdapterConfig = { model, thinking, tools: agentConfig?.tools, extensionDir: EXTENSION_DIR };
const { command, args, env: spawnEnv, adapter, warnings } = buildRuntimeSpawn(runtime, spawnTask, adapterCfg, baseEnv);
// R5: log feature degradation warnings to feed
for (const w of warnings) {
  logFeedEvent(cwd, workerName, "message", task.taskId ?? "", w);
}
const proc = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: spawnEnv });

// Progress parsing uses adapter
proc.stdout?.on("data", (data) => {
  // ... existing buffer logic ...
  for (const line of lines) {
    const event = adapter.parseProgressEvent(line);
    if (event) {
      updateProgressFromEvent(progress, event, startTime);
      // ... existing live worker + artifact logic ...
    }
  }
});
```

### Wiring: lobby.ts (lobby worker path)

Same pattern — replace the pi-specific arg construction block with `buildRuntimeSpawn()` call. Both paths now share one engine.

### Wiring: spawn.ts (overlay helper)

`crew/spawn.ts` calls `spawnWorkerForTask()` from lobby and `buildWorkerPrompt()` directly. Update `buildWorkerPrompt()` calls to pass runtime (see V3 prompt changes).

### Wiring: work.ts (prompt builder calls)

`work.ts:123` and `work.ts:150` both call `buildWorkerPrompt()`. Update to pass runtime parameter:
```typescript
const runtime = resolveRuntime(config, "worker");
const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, runtime);
```

---

## V1: Adapter Interface + PiAdapter (pure refactor)

### Goal
Extract the spawn logic into adapter pattern. Zero behavior change. Wires into BOTH spawn paths.

### Changes

**New file: `crew/utils/adapters/types.ts`**
- RuntimeAdapter interface (as above)
- ProgressEvent type
- RuntimeFeature type

**New file: `crew/utils/adapters/pi.ts`**
- `PiAdapter` class implementing RuntimeAdapter
- `buildArgs()`: Extracts current `agents.ts:runAgent()` lines 200-257 AND `lobby.ts` lines 76-112.
  - Constructs `["--mode", "json", "--no-session", "-p"]`
  - Adds model flags via `pushModelArgs()` (imported from agents.ts — already pure)
  - Adds `--thinking` if supported
  - Adds `--tools` for builtin tools
  - Adds `--extension` for custom tool paths AND `EXTENSION_DIR`
  - Adds `--append-system-prompt` if systemPrompt or systemPromptPath provided
  - Appends task prompt
- `buildEnv()`: Passes through base env (PI_AGENT_NAME, PI_CREW_WORKER, PI_LOBBY_ID already set by caller)
- `parseProgressEvent()`: Wraps `parseJsonlLine()` from `utils/progress.ts`. Maps PiEvent → ProgressEvent.
- `supportsFeature()`: Returns true for all features (pi supports everything)
- `getCommand()`: Returns `"pi"`

**New file: `crew/utils/adapters/index.ts`**
- `getAdapter(runtime: string): RuntimeAdapter` — factory. Returns `PiAdapter` for `"pi"`, throws for unknown.
- `resolveRuntime(config: CrewConfig, role: string): string` — reads `config.runtime?.[role] ?? "pi"`

**New file: `crew/runtime-spawn.ts`**
- `buildRuntimeSpawn()` — unified engine (as shown in architecture section above)
- `validateCommandAvailable()` — safe `execFileSync("which", [command])`, no shell interpolation
- Imports from adapters, exports for agents.ts + lobby.ts

**Modified: `crew/utils/config.ts`**
- Add to `CrewConfig` interface:
  ```typescript
  runtime?: {
    planner?: string;
    worker?: string;
    reviewer?: string;
  };
  ```
- Add to `DEFAULT_CONFIG`: `runtime: { planner: "pi", worker: "pi", reviewer: "pi" }`

**Modified: `crew/agents.ts` `runAgent()`**
- Import `buildRuntimeSpawn` from `./runtime-spawn.js`
- Import `resolveRuntime` from `./utils/adapters/index.js`
- Replace lines 200-260 (pi-specific arg construction + spawn) with adapter-based code (see architecture section)
- Replace JSONL parsing (lines 275-300) with `adapter.parseProgressEvent(line)`
- The `pushModelArgs`, `resolveThinking`, `modelHasThinkingSuffix` helpers remain in agents.ts — PiAdapter imports them

**Modified: `crew/lobby.ts`**
- Import `buildRuntimeSpawn` from `./runtime-spawn.js`
- Import `resolveRuntime` from `./utils/adapters/index.js`
- Replace lines 70-112 (arg construction) with `buildRuntimeSpawn()` call
- Replace stdout parsing with `adapter.parseProgressEvent()`

**Modified: `crew/utils/progress.ts`**
- Add `updateProgressFromEvent(progress, event: ProgressEvent, startedAt)` — maps ProgressEvent fields to AgentProgress updates
- Existing `updateProgress(progress, piEvent, startedAt)` can delegate internally after PiEvent → ProgressEvent conversion

### Tests
- Unit test PiAdapter.buildArgs() with various config combinations
- Unit test PiAdapter.parseProgressEvent() with sample JSONL lines
- Unit test buildRuntimeSpawn() returns correct command/args/env for pi
- Existing integration tests pass unchanged (refactor is invisible)

### Demo
`pi_messenger({ action: "work" })` spawns pi workers exactly as before. All existing tests pass.

---

## V2: pi-messenger-cli

### Goal
Standalone CLI wrapping handlers.ts. Testable independently of any runtime.

### Changes

**New file: `cli/index.ts`** (source — compiled to JS before publish)
- Parses argv: `pi-messenger-cli <command> [--flag value ...]`
- Commands mapped to handlers:
  - `join [--name NAME]` → External agent self-registration (D'5 path)
  - `send --to NAME --message MSG` → `handlers.executeSend()`
  - `status` → `handlers.executeStatus()`
  - `list` → `handlers.executeList()`
  - `reserve --paths PATH [PATH...] [--reason REASON]` → `handlers.executeReserve()`
  - `release --paths PATH [PATH...]` → `handlers.executeRelease()`
  - `task.start --id ID` → crew task handlers
  - `task.done --id ID --summary SUMMARY` → crew task handlers
  - `feed [--limit N]` → `handlers.executeFeed()`
- State bootstrap (two modes):
  - **Crew-spawned** (`PI_CREW_WORKER=1` in env): Read registry for `PI_AGENT_NAME`, verify PID alive, construct `MessengerState` with `registered: true`. Retry lookup 3x with 100ms delay (mitigates spawn-registration race from V3.4).
  - **External agent** (`join` command): Self-register with own PID. On subsequent commands, auto-re-register if registry entry stale/missing.
- Dirs construction: Same as index.ts — `PI_MESSENGER_DIR || ~/.pi/agent/messenger`
- Output formatting: Map `result()` objects to human-readable text:
  - Success: `✓ <message>`
  - Error: `✗ <error>`
  - Data: Print relevant fields as text

**Modified: `package.json`**
- Add to `"bin"`: `"pi-messenger-cli": "./dist/cli/index.js"` (compiled output)
- Add to `"files"`: `"dist/cli/**"` (compiled CLI files)
- Add build script: `"build:cli": "tsc -p tsconfig.cli.json"`
- Add `"prepack": "npm run build:cli"` — ensures `dist/cli/index.js` is always fresh at publish time
- Note: The shebang `#!/usr/bin/env node` goes in the compiled JS file, NOT tsx. This avoids runtime dependency on tsx for consumers.

**New file: `tsconfig.cli.json`**
- Extends base tsconfig
- Input: `cli/index.ts`
- Output: `dist/cli/`
- Target: Node 18+

### Key design: no ExtensionContext dependency

Most handlers already accept `(state, dirs, cwd, ...)` — no ctx needed. The four functions that need ctx (`executeJoin` in handlers, `register`/`updateRegistration`/`flushActivityToRegistry` in store.ts) are only called on the `join` path.

For the Crew-spawned path, the CLI never registers — it only calls action handlers with pre-constructed state.

For the `join` path (external agents), the CLI constructs a minimal ctx-like object:
```typescript
const minimalCtx = {
  cwd: process.cwd(),
  hasUI: false,
  model: { id: process.env.PI_MODEL ?? "unknown" },
  sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
  ui: { notify: () => {}, setStatus: () => {}, theme: {}, custom: async () => {} },
};
```

### Prerequisites
- None — V2 is parallel with V1. CLI calls handlers directly, doesn't use resolveRuntime or adapters.

### Tests
- Unit tests for CLI arg parsing → correct handler calls
- Integration test: spawn CLI as child process, verify it writes to file store
- Test both modes: Crew-spawned (PI_CREW_WORKER=1, PI_AGENT_NAME set, registry pre-populated) and external agent (join command)
- Test retry logic for spawn-registration race

### Demo
```bash
pi-messenger-cli join --name TestAgent
pi-messenger-cli send --to BrightHawk --message "hello from CLI"
pi-messenger-cli status
```
Message appears in mesh feed.

---

## V3: ClaudeAdapter + Prompt Injection + Spawner Pre-Registration

### Goal
First non-pi runtime. End-to-end: configure, spawn Claude Code worker, task completes via CLI.

### V3.0: Spike — Capture Claude Code Stream Format
Before building the parser, run actual `claude --print --output-format stream-json` to capture real output format. Prevents building against assumed formats.

```bash
echo "Say hello" | claude --print --output-format stream-json 2>&1 | head -50
```

Save captured format to `specs/002-multi-runtime-support/claude-stream-format.jsonl` for reference.

### Changes

**New file: `crew/utils/adapters/claude.ts`**
- `ClaudeAdapter` implementing RuntimeAdapter
- `getCommand()`: Returns `"claude"`
- `buildArgs()`:
  ```typescript
  const args = ["--print", "--output-format", "stream-json"];
  if (config.model) {
    const model = config.model.includes("/")
      ? config.model.split("/")[1]  // "anthropic/claude-sonnet-4" → "claude-sonnet-4"
      : config.model;
    args.push("--model", model);
  }
  if (task.systemPrompt) {
    args.push("--system-prompt", task.systemPrompt);
  }
  // Claude Code doesn't support --tools or --extension
  // R5: warnings emitted by buildRuntimeSpawn(), not silently skipped
  args.push(task.prompt);
  return args;
  ```
- `buildEnv()`: Pass through (Claude Code reads standard env vars)
- `parseProgressEvent()`: Parse Claude Code's `--output-format stream-json` events, based on spike results. Map to ProgressEvent.
    - `type: "assistant"` with `tool_use` content → `ProgressEvent { type: "tool_call" }`
    - `type: "user"` (tool result feedback) → `ProgressEvent { type: "tool_result" }` (Codex R2 finding #5: required for accurate tool lifecycle counters and durations)
    - `type: "assistant"` with `text` content → `ProgressEvent { type: "message" }` with token counts
    - `type: "result"` with `is_error` → `ProgressEvent { type: "error" }`
    - `type: "system"` → skip (init/hooks metadata)
- `supportsFeature()`:
  - `streaming`: true
  - `thinking`: false (model-level, not flag-level)
  - `tool-restriction`: false (defer --allowedTools to v2)
  - `extension-loading`: false
  - `system-prompt-file`: false (Claude Code takes inline --system-prompt, not file path)
  - `system-prompt-inline`: true

**Modified: `crew/utils/adapters/index.ts`**
- Import ClaudeAdapter
- `getAdapter("claude")` → returns ClaudeAdapter instance

**New function: `store.ts` `registerSpawnedWorker()`**
- Dedicated API for spawner pre-registration matching the REAL `AgentRegistration` schema from `lib.ts`:
  ```typescript
  export function registerSpawnedWorker(
    registryDir: string,  // explicit path, not Dirs — lobby.ts doesn't have Dirs
    workerCwd: string,
    name: string,
    pid: number,
    model: string,
    sessionId: string,
  ): boolean {
    ensureDirSync(registryDir);
    const now = new Date().toISOString();
    // Must match AgentRegistration from lib.ts exactly:
    // name, pid, sessionId, cwd, model, startedAt, isHuman, session, activity
    const reg: AgentRegistration = {
      name,
      pid,
      sessionId,
      cwd: workerCwd,
      model,
      startedAt: now,
      isHuman: false,
      session: {
        toolCalls: 0,
        tokens: 0,
      },
      activity: {
        lastActivityAt: now,
      },
    };
    const filePath = join(registryDir, `${name}.json`);
    // Atomic write to prevent partial reads under concurrent access
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(reg, null, 2));
    fs.renameSync(tmpPath, filePath);
    invalidateAgentsCache();
    return true;
  }
  ```
- Import path: `store.ts` (root) — the messenger store, not `crew/store.ts` (task store)
- Callers pass explicit registryDir matching the REAL path from index.ts:
  ```
  PI_MESSENGER_DIR || join(homedir(), ".pi/agent/messenger")  →  join(baseDir, "registry")
  ```
  This is `~/.pi/agent/messenger/registry` by default — NOT `cwd/.pi/messenger/agents`.

**New shared helper: `store.ts` `getMessengerRegistryDir()`**
```typescript
import { homedir } from "node:os";
import { join } from "node:path";

export function getMessengerRegistryDir(): string {
  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi/agent/messenger");
  return join(baseDir, "registry");
}
```
This mirrors the exact derivation from `index.ts:113-116`. Both paths (extension + CLI + spawner) use the same directory.

**Caller examples:**
```typescript
// In crew/lobby.ts
import { registerSpawnedWorker, getMessengerRegistryDir } from "../store.js";
const registryDir = getMessengerRegistryDir();
registerSpawnedWorker(registryDir, cwd, name, proc.pid!, model ?? "unknown", `crew-${id}`);

// In crew/agents.ts — prefers messengerDirs if provided (already correct path from work.ts)
import { registerSpawnedWorker, getMessengerRegistryDir } from "../store.js";
const registryDir = options.messengerDirs?.registry ?? getMessengerRegistryDir();
registerSpawnedWorker(registryDir, cwd, workerName, proc.pid!, model ?? "unknown", `crew-${runId}`);
```

**Modified: `crew/lobby.ts` (spawner pre-registration)**
- After `spawn(command, args, ...)` returns proc:
  ```typescript
  import { registerSpawnedWorker, getMessengerRegistryDir } from "../store.js";
  // Use shared helper — same derivation as index.ts:113-116
  const registryDir = getMessengerRegistryDir();
  if (runtime !== "pi") {
    registerSpawnedWorker(registryDir, cwd, name, proc.pid!, model ?? "unknown", `crew-${id}`);
  }
  ```
- Pi workers continue to self-register via extension session_start hook.

**Modified: `crew/agents.ts` (spawner pre-registration)**
- Same pattern — after spawn, if runtime !== "pi":
  ```typescript
  import { registerSpawnedWorker, getMessengerRegistryDir } from "../store.js";
  const registryDir = options.messengerDirs?.registry ?? getMessengerRegistryDir();
  if (runtime !== "pi") {
    registerSpawnedWorker(registryDir, cwd, workerName, proc.pid!, model ?? "unknown", `crew-${runId}`);
  }
  ```

**Modified: `crew/prompt.ts`**
- Add `runtime?: string` parameter to `buildWorkerPrompt()`:
  ```typescript
  export type AssignmentMode = "pre-claimed" | "unclaimed";

  export function buildWorkerPrompt(
    task: Task,
    prdPath: string,
    cwd: string,
    config: CrewConfig,
    concurrentTasks: Task[],
    skills?: CrewSkillInfo[],
    runtime?: string,                // ← new, optional, backward compatible
    assignmentMode?: AssignmentMode, // ← new, optional (default: "unclaimed")
  ): string {
  ```
- After `buildCoordinationInstructions()` (line ~112), before `buildSkillsSection()` (line ~114):
  ```typescript
  if (runtime && runtime !== "pi") {
    prompt += buildCliInstructions(assignmentMode ?? "unclaimed");
  }
  ```
- New parameter `assignmentMode?: "pre-claimed" | "unclaimed"` to handle the task.start instruction conflict (Codex finding #5):
  ```typescript
  function buildCliInstructions(mode: "pre-claimed" | "unclaimed" = "unclaimed"): string {
    const startSection = mode === "pre-claimed"
      ? `### Task already started
  Your task is already claimed and started — do NOT call \`task.start\`. Jump straight to implementation.`
      : `### Required: Start the task
  \`\`\`bash
  pi-messenger-cli task.start --id <task-id>
  \`\`\``;

    return `## Reporting via CLI

  You have access to \`pi-messenger-cli\` for task coordination. Use bash to run these commands:

  ${startSection}

  ### Required: Report completion
  \`\`\`bash
  pi-messenger-cli task.done --id <task-id> --summary "Brief description of what you did"
  \`\`\`

  ### Optional: File reservations (prevents conflicts with other workers)
  \`\`\`bash
  pi-messenger-cli reserve --paths src/auth.ts src/login.ts --reason "Implementing feature X"
  pi-messenger-cli release --paths src/auth.ts src/login.ts
  \`\`\`

  ### Optional: Send messages to other agents
  \`\`\`bash
  pi-messenger-cli send --to <agent-name> --message "your message"
  \`\`\`

  Output format: ✓ for success, ✗ for errors.
  `;
  }
  ```

**Modified: ALL `buildWorkerPrompt()` callsites** (exact argument lists)
- `crew/handlers/work.ts:123` (lobby assignment — task pre-claimed by assignTaskToLobbyWorker):
  ```typescript
  const runtime = resolveRuntime(config, "worker");
  const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, runtime, "pre-claimed");
  ```
- `crew/handlers/work.ts:150` (spawnAgents path — **must set in_progress before spawn**):
  ```typescript
  const runtime = resolveRuntime(config, "worker");
  // CRITICAL (Codex R2 finding #1): The remainingTasks loop must set in_progress
  // BEFORE building the prompt. Without this, task.done fails (requires in_progress).
  // The lobby path (line 127) already does this; the spawnAgents path must match.
  store.updateTask(cwd, task.id, {
    status: "in_progress",
    started_at: new Date().toISOString(),
    base_commit: store.getBaseCommit(cwd),
    assigned_to: "crew-worker",
    attempt_count: task.attempt_count + 1,
  });
  const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, runtime, "pre-claimed");
  ```
  Note: The original code at work.ts:146-165 does NOT set in_progress for spawnAgents tasks (only the lobby path at line 127 does). This fix ensures both paths are consistent.
- `crew/spawn.ts:49` (lobby worker assignment — pre-claimed via store.updateTask at spawn.ts:51):
  ```typescript
  const runtime = resolveRuntime(config, "worker");
  const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, runtime, "pre-claimed");
  ```
- `crew/spawn.ts:109` (spawnWorkerForTask — pre-claimed inside spawnWorkerForTask at lobby.ts:337):
  ```typescript
  const runtime = resolveRuntime(config, "worker");
  const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, runtime, "pre-claimed");
  ```
  Note: spawnWorkerForTask() at lobby.ts:337 calls `store.updateTask(status: "in_progress")` before the worker sees the prompt, so ALL current paths are "pre-claimed". The "unclaimed" mode exists for future external-agent task pickup (D'5 path) where the agent self-selects tasks.

**Modified: `crew/lobby.ts` (lobby workers restricted to pi in v1)**
- `spawnLobbyWorker()` checks runtime before spawning idle lobby workers:
  ```typescript
  const runtime = resolveRuntime(config, "worker");
  if (runtime !== "pi") {
    // Lobby workers use pi_messenger typed tool calls for mesh join, chat, etc.
    // Non-pi runtimes would need a completely different lobby prompt using CLI.
    // Disabled for v1 — non-pi workers only spawn on-demand via work handler.
    return null;
  }
  ```
- This means `crew/handlers/work.ts` lobby-first assignment (`getAvailableLobbyWorkers`) won't find lobby workers for non-pi runtimes, and will fall through to the `spawnAgents()` path (which IS runtime-aware). This is the correct behavior.

**Modified: `crew/spawn.ts` (non-pi overlay fallback)**
- `spawnWorkerForTask()` returns null for non-pi runtimes (since `spawnLobbyWorker()` returns null).
  `crew/spawn.ts:77` and `spawn.ts:104` call it and stop on null.
  For non-pi runtimes, the overlay path needs a direct-spawn fallback using `spawnAgents()`:
  ```typescript
  // In spawnWorkersForReadyTasks() — after lobby assignment loop
  const runtime = resolveRuntime(config, "worker");
  while (assigned < maxWorkers) {
    const fresh = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
    if (fresh.length === 0) break;
    const task = fresh[0];
    if (runtime === "pi") {
      // Existing path — spawnWorkerForTask uses lobby infrastructure
      const worker = spawnWorkerForTask(cwd, task.id, prompt);
      if (!worker) break;
      // ...
    } else {
      // Non-pi: use spawnAgents() directly (runtime-aware, no lobby dependency)
      // This is the same path work.ts uses for non-lobby workers
      const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, runtime, "pre-claimed");
      store.updateTask(cwd, task.id, { status: "in_progress", ... });
      // Fire-and-forget via spawnAgents (async — overlay monitors progress)
      spawnAgents([{ agent: "crew-worker", task: prompt, taskId: task.id }], cwd, {});
    }
    assigned++;
  }
  ```
- Similarly for `spawnSingleWorker()` — if runtime !== "pi", delegate to `spawnAgents()`.
- This ensures the overlay `[w]` keybinding works for all runtimes, not just pi.

**Modified: `crew/lobby.ts` (feature warnings — R5 compliance)**
- When `buildRuntimeSpawn()` returns, destructure and log ALL warnings:
  ```typescript
  const { command, args, env, adapter, warnings } = buildRuntimeSpawn(runtime, task, cfg, baseEnv);
  // R5: log every feature degradation warning to feed
  for (const w of warnings) {
    logFeedEvent(cwd, name, "message", taskId, w);
  }
  ```
- No manual `supportsFeature()` checks at callsite — `buildRuntimeSpawn()` is the single source of truth for warning generation.
- When `system-prompt-file` not supported but `system-prompt-inline` is:
  - Read file content, pass as `task.systemPrompt` (inline string)
  - Log info to feed

### Tests
- Unit test ClaudeAdapter.buildArgs() with various configs
- Unit test ClaudeAdapter.parseProgressEvent() with captured stream-json samples
- Unit test registerSpawnedWorker() creates correct registry file
- Unit test buildCliInstructions() for both "pre-claimed" and "unclaimed" modes
- Integration test: mock spawn, verify Claude Code args constructed correctly
- Integration test: verify buildWorkerPrompt() adds CLI instructions only for non-pi
- End-to-end test (manual): configure `runtime: { worker: "claude" }`, run work, verify Claude Code spawns and completes a task

### Demo
Set `runtime: { worker: "claude" }` → `pi_messenger({ action: "work" })` → Claude Code worker spawns, calls pi-messenger-cli, completes task → shows done in monitor.

### Risk: Prompt injection effectiveness
The CLI instructions are the most fragile part. Testing with real Claude Code sessions is essential during V3.0 spike:
- Try different instruction formats (numbered steps vs code blocks vs examples)
- Test with simple and complex tasks
- Measure: what % of tasks call task.done vs relying on D'6 inference?

---

## V4: D'6 Lifecycle Enhancements

### Goal
Harden the spawner safety net. Exit code inference, stuck detection, file attribution. Applied to BOTH spawn paths (Codex finding #2).

### Centralized Completion Inference

**New file: `crew/completion-inference.ts`** (Codex recommendation — shared by both paths)
```typescript
import * as store from "./store.js";
import { logFeedEvent } from "../feed.js";
import { execFileSync } from "node:child_process";

export interface InferenceContext {
  cwd: string;
  taskId: string;
  workerName: string;
  exitCode: number | null;
  baseCommit?: string;
  reservedPaths?: string[];  // Worker's reserved file paths (from store claims)
}

/**
 * Infer task completion when worker exits without calling task.done.
 * Used by both lobby.ts close handler and agents.ts/work.ts result processing.
 * Returns true if task was auto-completed, false if left for caller to handle.
 *
 * CONCURRENCY SAFETY (Codex R2 finding #2):
 * - When reservedPaths available: only counts files within reserved paths
 * - When no reservedPaths: uses repo-wide diff but logs a warning
 * - Requires at least one file change to infer success (exit 0 + no changes = NOT inferred)
 */
export function inferTaskCompletion(ctx: InferenceContext): boolean {
  const task = store.getTask(ctx.cwd, ctx.taskId);
  if (!task) return false;
  if (task.status === "done") return true; // already completed via CLI
  if (task.status !== "in_progress") return false;

  if (ctx.exitCode === 0) {
    const allChangedFiles = getChangedFiles(ctx.cwd, ctx.baseCommit);

    // Scope to reserved paths when available (concurrency-safe)
    let filesChanged: string[];
    if (ctx.reservedPaths && ctx.reservedPaths.length > 0) {
      filesChanged = allChangedFiles.filter(f =>
        ctx.reservedPaths!.some(rp => f.startsWith(rp) || f === rp)
      );
    } else {
      filesChanged = allChangedFiles;
      if (filesChanged.length > 0) {
        // Warn: repo-wide attribution may include other workers' changes
        logFeedEvent(ctx.cwd, ctx.workerName, "message", ctx.taskId,
          `Warning: D'6 inference using repo-wide diff (worker had no file reservations). ` +
          `${filesChanged.length} files may include other workers' changes.`);
      }
    }

    // Require at least one file change to infer success
    if (filesChanged.length === 0) return false;

    store.updateTask(ctx.cwd, ctx.taskId, {
      status: "done",
      assigned_to: undefined,
    });
    store.appendTaskProgress(ctx.cwd, ctx.taskId, "system",
      `Completed (inferred from exit code 0). Files: ${filesChanged.join(", ") || "none detected"}`);
    logFeedEvent(ctx.cwd, ctx.workerName, "task.done", ctx.taskId,
      "Completed (inferred — worker didn't call task.done)");
    return true;
  }
  return false; // non-zero exit — caller handles reset/block
}

/**
 * Get files changed since a base commit, including working tree AND untracked files.
 * Uses execFileSync (no shell interpolation).
 * Combines: committed changes + staged/unstaged diffs + new untracked files.
 */
function getChangedFiles(cwd: string, baseCommit?: string): string[] {
  try {
    const files = new Set<string>();

    if (baseCommit) {
      // Committed changes since base
      const committed = execFileSync("git", ["diff", "--name-only", baseCommit, "HEAD"], {
        cwd, encoding: "utf-8", timeout: 5000,
      });
      for (const f of committed.trim().split("\n").filter(Boolean)) files.add(f);

      // Working tree changes (staged + unstaged) against base
      const working = execFileSync("git", ["diff", "--name-only", baseCommit], {
        cwd, encoding: "utf-8", timeout: 5000,
      });
      for (const f of working.trim().split("\n").filter(Boolean)) files.add(f);
    } else {
      // Fallback: just uncommitted changes
      const result = execFileSync("git", ["diff", "--name-only", "HEAD"], {
        cwd, encoding: "utf-8", timeout: 5000,
      });
      for (const f of result.trim().split("\n").filter(Boolean)) files.add(f);
    }

    // NEW files (untracked) — catches created files that git diff misses
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, encoding: "utf-8", timeout: 5000,
    });
    for (const f of untracked.trim().split("\n").filter(Boolean)) files.add(f);

    return [...files];
  } catch {
    return [];
  }
}
```

### Changes

**Modified: `crew/lobby.ts` close handler (lines 170-200)**
- Import `inferTaskCompletion` from `./completion-inference.js`
- Replace current close logic with:
  ```typescript
  proc.on("close", (exitCode) => {
    // ... existing cleanup (removeLiveWorker, unregisterWorker, etc.) ...

    if (worker.assignedTaskId) {
      const task = store.getTask(cwd, worker.assignedTaskId);
      if (task && task.assigned_to === worker.name) {
        // Look up worker's reserved file paths for scoped attribution (Codex R2+R3 finding)
        // CRITICAL: Cannot use getActiveAgents() here — worker PID is dead, registration
        // would be filtered out. Read registration file directly, bypassing liveness check.
        const regPath = path.join(dirs.registry, `${worker.name}.json`);
        let reservedPaths: string[] = [];
        try {
          const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
          reservedPaths = (reg.reservations ?? []).map((r: any) => r.pattern);
        } catch { /* registration already cleaned up — fall back to repo-wide */ }
        if (!inferTaskCompletion({
          cwd,
          taskId: worker.assignedTaskId,
          workerName: worker.name,
          exitCode,
          baseCommit: task.base_commit,
          reservedPaths,
        })) {
          // Non-zero exit or still in_progress — existing reset/block logic
          // ... preserved ...
        }
      }
    }
  });
  ```

**Modified: `crew/handlers/work.ts` result processing (lines 180-220)**
- Import `inferTaskCompletion` from `../completion-inference.js`
- In the result processing loop, before the current exit-code branching:
  ```typescript
  if (r.exitCode === 0 && task?.status === "in_progress") {
    // Try inference before falling through to "reset to todo"
    // Look up worker's reserved file paths for scoped attribution (Codex R2+R3 finding)
    // Read registration file directly — worker may have exited, getActiveAgents filters dead PIDs
    const regPath = path.join(dirs.registry, `${r.progress.agent}.json`);
    let reservedPaths: string[] = [];
    try {
      const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
      reservedPaths = (reg.reservations ?? []).map((rv: any) => rv.pattern);
    } catch { /* fall back to repo-wide */ }
    if (inferTaskCompletion({
      cwd, taskId, workerName: r.progress.agent,
      exitCode: r.exitCode, baseCommit: task.base_commit,
      reservedPaths,
    })) {
      succeeded.push(taskId);
      continue;
    }
  }
  // ... existing logic for done/blocked/other states ...
  ```

**Stuck detection timer (both paths):**
- Track `lastOutputTimestamp` per worker (updated on each stdout data event)
- Add timer that fires when `Date.now() - lastOutputTimestamp > stuckTimeout`
- On stuck detection:
  ```typescript
  store.appendTaskProgress(cwd, taskId, "system",
    `Worker appears stuck (no output for ${stuckTimeout/1000}s)`);
  logFeedEvent(cwd, worker.name, "stuck", taskId, "No output detected");
  // Note: feed type is "stuck" (not "task.stuck" — Codex finding #6)
  ```

**Modified: `crew/utils/config.ts`**
- Add to CrewConfig:
  ```typescript
  stuckTimeout?: number;  // ms, default 300000 (5 min)
  ```
- Add to DEFAULT_CONFIG: `stuckTimeout: 300_000`

### Tests
- Unit test: inferTaskCompletion with exit 0 + in_progress → marks done
- Unit test: inferTaskCompletion with exit 0 + already done → returns true (no-op)
- Unit test: inferTaskCompletion with exit 1 → returns false
- Unit test: getChangedFiles() with baseCommit (uses execFileSync, not shell)
- Unit test: stuck detection fires after timeout, logs with type "stuck"
- Integration test: mock worker exits without task.done → inferred in both lobby and agents paths

### Demo
Spawn a worker that completes work but doesn't call task.done → spawner auto-infers → feed shows "Completed (inferred — worker didn't call task.done)".

---

## Cross-Cutting Concerns

### Concurrent File Store Writes
Pre-existing risk. store.ts uses atomic writes (temp + rename) for claims/completions but plain writeFileSync for registrations. With CLI processes writing simultaneously, registration writes could race. Mitigation: use atomic write pattern (write to temp, rename) for registration writes in store.ts. `registerSpawnedWorker()` should use this pattern from day one.

### Model Name Normalization
ClaudeAdapter handles this: `anthropic/claude-sonnet-4` → `claude-sonnet-4` (strip provider prefix). Each adapter normalizes model names for its runtime. No shared normalization layer needed.

### Worker Identity Verification (Codex R3 security finding)
The CLI crew-spawned mode trusts `PI_AGENT_NAME` + registry presence. Any local process could impersonate a worker. Mitigation:
- Spawner generates a per-worker nonce (random UUID) and sets it as `PI_CREW_NONCE` env var
- `registerSpawnedWorker()` stores a SHA-256 hash of the nonce in the registration file's `nonceHash` field
- CLI mutating commands (`task.start`, `task.done`, `send`, `reserve`) validate `PI_CREW_NONCE` against the stored hash before executing
- Read-only commands (`status`, `list`, `feed`) don't require nonce
- External agents (`join` path) generate and store their own nonce at join time
- This is defense-in-depth for a local-machine threat model (low severity, but prevents accidental cross-worker interference)

**Concrete wiring (Codex R2 finding #3):**

In `crew/lobby.ts` and `crew/agents.ts` (both spawn paths):
```typescript
import { createHash, randomUUID } from "node:crypto";
const nonce = randomUUID();
const nonceHash = createHash("sha256").update(nonce).digest("hex");
// Pass nonce to worker env, hash to registration
const env = { ...baseEnv, PI_CREW_NONCE: nonce };
registerSpawnedWorker(registryDir, cwd, name, proc.pid!, model, sessionId, nonceHash);
```

In `lib.ts` — add `nonceHash` to `AgentRegistration` schema (Codex R2 finding #3):
```typescript
export interface AgentRegistration {
  name: string;
  pid: number;
  sessionId: string;
  cwd: string;
  model: string;
  startedAt: string;
  reservations?: FileReservation[];
  gitBranch?: string;
  spec?: string;
  isHuman: boolean;
  session: AgentSession;
  activity: AgentActivity;
  statusMessage?: string;
  nonceHash?: string;  // SHA-256 hash of PI_CREW_NONCE — optional for backward compat
}
```

In `store.ts` `registerSpawnedWorker()`:
```typescript
export function registerSpawnedWorker(
  registryDir: string, workerCwd: string, name: string,
  pid: number, model: string, sessionId: string,
  nonceHash?: string,  // SHA-256 hash of PI_CREW_NONCE
): boolean {
  // ... existing registration fields ...
  const reg: AgentRegistration = { ...existingFields, nonceHash };
  // Atomic write (tmp + rename)
}
```

In `cli/index.ts` state bootstrap — read nonceHash from registration:
```typescript
// In crew-spawned mode, after reading registration:
const registration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
// nonceHash is now part of AgentRegistration — validated by validateNonce()
```

In `cli/index.ts` state bootstrap:
```typescript
function validateNonce(registration: AgentRegistration): void {
  if (!registration.nonceHash) return; // legacy or external agent
  const nonce = process.env.PI_CREW_NONCE;
  if (!nonce) throw new Error("PI_CREW_NONCE required for mutating commands on crew-spawned workers");
  const hash = createHash("sha256").update(nonce).digest("hex");
  if (hash !== registration.nonceHash) throw new Error("Nonce mismatch — wrong worker identity");
}
// Called before task.start, task.done, send, reserve, release
```

### Shell Safety (Codex finding #8)
All subprocess invocations use `execFileSync`/`spawnSync` with argv arrays. NO template literal interpolation in `execSync`. Runtime names validated against `RUNTIME_ALLOWLIST` constant.

### Backward Compatibility
- All new config fields are optional with "pi" defaults
- buildWorkerPrompt() runtime param is optional (last position)
- registerSpawnedWorker() is new function (no overloading of existing register())
- getAdapter("pi") is the default path
- Zero changes to existing pi worker behavior
