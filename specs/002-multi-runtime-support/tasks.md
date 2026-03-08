<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-07 -->
<!-- Status: RECONCILED (aligned with Codex-approved plan.md, 24 findings incorporated) -->
<!-- Revisions: V1 expanded (runtime-spawn engine + agents.ts wiring), V2 packaging revised, V3 rewritten (registerSpawnedWorker, all callsites, nonce auth, lobby guard), V4 centralized inference + both paths -->
---
title: "Multi-Runtime Agent Support — Tasks"
date: 2026-03-07
bead: pi-messenger-2
---

# Tasks

Ordered by slice. Dependencies noted. Check off as completed.

```
V1 (Adapter + Unified Spawn Engine) ──→ V3 (ClaudeAdapter + Prompt + Pre-Registration)
V2 (CLI) ──────────────────────────────→ V3
V4 (Lifecycle) — independent, parallel-safe
```

V1 and V2 are fully parallel. V3 depends on both. V4 is independent.

## V1: Adapter Interface + PiAdapter + Unified Spawn Engine (pure refactor)

Prerequisites: none

- [x] **V1.1** Create `crew/utils/adapters/types.ts` — RuntimeAdapter interface, ProgressEvent type, RuntimeFeature type, SpawnTask type, AdapterConfig type
- [x] **V1.2** Create `crew/utils/adapters/pi.ts` — PiAdapter implementing RuntimeAdapter
  - `buildArgs()`: Extract from BOTH agents.ts:runAgent() lines 200-257 AND lobby.ts lines 76-112 (imports pushModelArgs, resolveThinking, modelHasThinkingSuffix from agents.ts — already pure)
  - `buildEnv()`: Pass-through
  - `parseProgressEvent()`: Wrap parseJsonlLine() from utils/progress.ts, map PiEvent → ProgressEvent
  - `supportsFeature()`: Returns true for all features
  - `getCommand()`: Returns "pi"
- [x] **V1.3** Create `crew/utils/adapters/index.ts` — `getAdapter(runtime)` factory, `resolveRuntime(config, role)` helper
- [x] **V1.4** Create `crew/runtime-spawn.ts` — Unified spawn engine shared by agents.ts + lobby.ts
  - `import { execFileSync } from "node:child_process"` (ESM, not require)
  - `RUNTIME_ALLOWLIST` constant for runtime name validation
  - `buildRuntimeSpawn(runtime, task, config, baseEnv)` → `RuntimeSpawnArgs { command, args, env, adapter, warnings }`
  - `validateCommandAvailable(command)` using `execFileSync("which", [command])` (no shell interpolation)
  - `validateCliAvailable(runtime)` — checks `pi-messenger-cli` availability for non-pi runtimes, fails fast with install instructions
  - R5 compliance: builds explicit warnings[] for unsupported features (thinking, tools, extensions)
- [x] **V1.5** Add `runtime` field to CrewConfig in `crew/utils/config.ts` — `runtime?: { planner?: string; worker?: string; reviewer?: string }`, default all "pi"
- [x] **V1.6** Refactor `crew/agents.ts` runAgent() — replace lines 200-260 (pi-specific arg construction + spawn) with `buildRuntimeSpawn()` call. Replace JSONL parsing with `adapter.parseProgressEvent()`. Destructure and log `warnings` to feed via `logFeedEvent()`.
- [x] **V1.7** Refactor `crew/lobby.ts` spawn logic — replace inline arg construction (lines 76-112) with `buildRuntimeSpawn()` call. Replace stdout parsing (lines 141-168) with `adapter.parseProgressEvent()`. Destructure and log `warnings` to feed.
- [x] **V1.8** Add `updateProgressFromEvent()` to `crew/utils/progress.ts` — maps ProgressEvent fields to AgentProgress updates. Existing updateProgress() can delegate internally.
- [x] **V1.9** Write unit tests — PiAdapter.buildArgs(), PiAdapter.parseProgressEvent(), buildRuntimeSpawn() returns correct command/args/env/warnings for pi
- [x] **V1.10** Verify all existing tests pass — the refactor must be invisible

## V2: pi-messenger-cli

Prerequisites: none (fully independent of V1 — CLI calls handlers directly, doesn't use adapters)

- [x] **V2.1** Create `cli/index.ts` — source file with argv parser, command router
- [x] **V2.2** Implement state bootstrap — two modes:
  - Crew-spawned (PI_CREW_WORKER=1): Read registry for PI_AGENT_NAME, verify PID alive, construct MessengerState. Include retry (3x, 100ms delay) for spawn-registration race.
  - External agent: Auto-re-register with current PID on every command
- [x] **V2.3** Implement `join` command — self-registration for external agents (D'5). Construct minimal ctx-like object for store.register()
- [x] **V2.4** Implement action commands — send, status, list, reserve, release, task.start, task.done, feed. Map to handler functions from handlers.ts and crew handlers
- [x] **V2.5** Implement output formatting — map result() objects to human-readable `✓`/`✗` text
- [x] **V2.6** Create `tsconfig.cli.json` — extends base tsconfig, input: cli/index.ts, output: dist/cli/, target Node 18+
- [x] **V2.7** Update `package.json`:
  - Add `"pi-messenger-cli": "./dist/cli/index.js"` to bin (compiled JS with `#!/usr/bin/env node` shebang)
  - Add `"dist/cli/**"` to files array
  - Add `"build:cli": "tsc -p tsconfig.cli.json"` script
  - Add `"prepack": "npm run build:cli"` to ensure fresh build at publish
- [x] **V2.8** Write unit tests for CLI arg parsing and command routing
- [x] **V2.9** Write integration test — spawn CLI as child process, verify file store writes (both crew-spawned and external agent modes). Test retry logic for spawn-registration race.

## V3: ClaudeAdapter + Prompt Injection + Spawner Pre-Registration

Prerequisites: V1 (adapter interface + runtime-spawn engine), V2 (CLI exists for workers to call)

- [x] **V3.0** Spike: Run `claude --print --output-format stream-json -p "read the current directory"` and capture actual output format. Save to `specs/002-multi-runtime-support/claude-stream-format.jsonl`. Verify event types, field names, token fields before building parser.
- [x] **V3.1** Create `crew/utils/adapters/claude.ts` — ClaudeAdapter implementing RuntimeAdapter
  - `buildArgs()`: --print, --output-format stream-json, --model (strip provider prefix), --system-prompt (inline)
  - `parseProgressEvent()`: Parse Claude Code stream-json events → ProgressEvent (based on spike results)
  - `supportsFeature()`: streaming=true, thinking=false, tool-restriction=false, extension-loading=false, system-prompt-file=false, system-prompt-inline=true
  - `getCommand()`: Returns "claude"
- [x] **V3.2** Register ClaudeAdapter in `crew/utils/adapters/index.ts` — getAdapter("claude") returns ClaudeAdapter. Add "claude" to RUNTIME_ALLOWLIST in runtime-spawn.ts.
- [x] **V3.3** Create `registerSpawnedWorker()` in `store.ts` — dedicated API (NOT overloading register()):
  - Signature: `registerSpawnedWorker(registryDir, workerCwd, name, pid, model, sessionId)`
  - Build full AgentRegistration matching lib.ts schema: name, pid, sessionId, cwd, model, startedAt, isHuman:false, session:{toolCalls:0, tokens:0}, activity:{lastActivityAt:now}
  - Atomic write (tmp + rename) to prevent partial reads
- [x] **V3.4** Create `getMessengerRegistryDir()` in `store.ts` — shared helper: `PI_MESSENGER_DIR || join(homedir(), ".pi/agent/messenger")` → `join(baseDir, "registry")`. Same derivation as index.ts:113-116.
- [x] **V3.5** Add spawner pre-registration to `crew/lobby.ts` — after spawn(), if runtime !== "pi":
  - `const registryDir = getMessengerRegistryDir()`
  - `registerSpawnedWorker(registryDir, cwd, name, proc.pid!, model, "crew-<id>")`
- [x] **V3.6** Add spawner pre-registration to `crew/agents.ts` — same pattern, use `options.messengerDirs?.registry ?? getMessengerRegistryDir()`
- [x] **V3.7** Add non-pi lobby guard to `crew/lobby.ts` — `spawnLobbyWorker()` returns null when runtime !== "pi" (lobby prompt uses pi_messenger typed tool calls). Non-pi workers only spawn on-demand via work handler's spawnAgents() path.
- [x] **V3.8** Add non-pi overlay fallback to `crew/spawn.ts` — when runtime !== "pi", spawnWorkersForReadyTasks() and spawnSingleWorker() delegate to spawnAgents() (runtime-aware) instead of spawnWorkerForTask() (lobby-dependent). Ensures overlay [w] keybinding works for all runtimes.
- [x] **V3.9** Handle extension/tool skipping for non-pi in `crew/lobby.ts` — check adapter.supportsFeature("extension-loading"). Log warnings from buildRuntimeSpawn(). Read system prompt file content for runtimes that support inline but not file-based system prompts.
- [x] **V3.10** Add `runtime` and `assignmentMode` parameters to `buildWorkerPrompt()` in `crew/prompt.ts`:
  - Signature: `(task, prdPath, cwd, config, concurrentTasks, skills?, runtime?, assignmentMode?)`
  - `type AssignmentMode = "pre-claimed" | "unclaimed"`
- [x] **V3.11** Create `buildCliInstructions(mode)` in `crew/prompt.ts` — CLI command reference with context-aware task.start handling:
  - "pre-claimed" mode: "Task already started — do NOT call task.start"
  - "unclaimed" mode: "Required: call task.start"
  - Both modes: task.done, reserve, release, send syntax and examples
  - Injected after buildCoordinationInstructions(), before buildSkillsSection()
- [x] **V3.12** Update ALL `buildWorkerPrompt()` callsites — pass runtime + assignmentMode:
  - `work.ts:123` (lobby assignment): runtime, "pre-claimed"
  - `work.ts:150` (spawnAgents path): runtime, "pre-claimed" (task set to in_progress before spawn)
  - `spawn.ts:49` (lobby worker assignment): runtime, "pre-claimed"
  - `spawn.ts:109` (spawnWorkerForTask): runtime, "pre-claimed"
- [ ] **V3.13** Add worker nonce auth — spawner generates PI_CREW_NONCE env var (random UUID), registerSpawnedWorker() stores nonce hash in registration. CLI validates nonce for mutating commands (task.start, task.done, send, reserve). Read-only commands skip validation.
- [x] **V3.14** Write unit tests — ClaudeAdapter.buildArgs(), ClaudeAdapter.parseProgressEvent(), registerSpawnedWorker() creates correct registry file, getMessengerRegistryDir() matches index.ts derivation, buildCliInstructions() for both modes, nonce validation
- [x] **V3.15** Write integration test — mock spawn, verify Claude Code args, verify pre-registration in correct registry dir, verify warnings logged
- [ ] **V3.16** End-to-end manual test — configure `runtime: { worker: "claude" }`, run work action, verify Claude Code spawns and completes task via CLI

## V4: D'6 Lifecycle Enhancements (parallel-safe)

Prerequisites: none (enhances existing close/result handlers independently)
Note: touches lobby.ts lines 170-200 (close handler) — different section from V1 (lines 76-168). Parallel-safe.

- [x] **V4.1** Create `crew/completion-inference.ts` — centralized completion inference shared by BOTH lobby.ts close handler AND work.ts result processing:
  - `inferTaskCompletion(ctx: InferenceContext): boolean`
  - Handles: already done (return true), exit 0 + in_progress → infer done, non-zero → return false
  - Uses getChangedFiles() for file attribution in inferred summaries
- [x] **V4.2** Create `getChangedFiles(cwd, baseCommit?)` in `crew/completion-inference.ts`:
  - Uses `execFileSync("git", [...])` (no shell interpolation)
  - Combines committed changes (`git diff --name-only baseCommit HEAD`) + working tree changes (`git diff --name-only baseCommit`) + new untracked files (`git ls-files --others --exclude-standard`)
  - Falls back to HEAD-only diff if no baseCommit
- [x] **V4.3** Wire `inferTaskCompletion()` into `crew/lobby.ts` close handler (lines 170-200) — replace existing exit-code handling for assigned tasks
- [x] **V4.4** Wire `inferTaskCompletion()` into `crew/handlers/work.ts` result processing (lines 180-220) — try inference before falling through to "reset to todo" for exit-0 + still in_progress
- [ ] **V4.5** Add stuck detection timer — track lastOutputTimestamp per worker, fire warning after configurable timeout. Log to feed with type "stuck" (matches FeedEventType). Don't auto-kill.
- [x] **V4.6** Add `stuckTimeout` to CrewConfig in `crew/utils/config.ts` — default 300000ms (5 min)
- [x] **V4.7** Write unit tests — inferTaskCompletion (exit 0 → done, exit 0 + already done → true, exit 1 → false), getChangedFiles() (with baseCommit, with untracked), stuck detection fires + logs "stuck"
- [x] **V4.8** Write integration test — mock worker exits without task.done → inferred in both lobby AND agents paths

## Post-Implementation

- [x] **P1** Update README or docs with multi-runtime configuration guide
- [x] **P2** Document CLI usage for external agents
- [ ] **P3** Close bead pi-messenger-2
