<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-07 -->
<!-- Status: REVISED -->
<!-- Prior revisions: store.register() → registerSpawnedWorker(), single path → both spawn paths, stale references cleaned -->
<!-- Fresh review (2026-03-07): Fixed stale --pattern reference in external agent wiring flow -->
---
shaping: true
title: "Multi-Runtime Agent Support"
date: 2026-03-07
bead: pi-messenger-2
participants: IronQuartz (pi/claude-sonnet-4), CalmEagle (pi/claude-opus-4-6)
---

# Multi-Runtime Agent Support — Shaping

## Problem

pi-messenger's messaging mesh and Crew orchestration are architecturally agent-agnostic — file-based registry, JSON inbox/outbox, JSONL feed — but the implementation is coupled to pi in three places:

1. **Extension entry point** — Tool registration and lifecycle hooks use `@mariozechner/pi-coding-agent` APIs. No other agent can register as a mesh participant without going through pi's extension system.
2. **Worker spawning** — `crew/agents.ts` and `crew/lobby.ts` hardcode `spawn("pi", [...])` with pi-specific CLI flags.
3. **Progress parsing** — `crew/utils/progress.ts` parses pi's `--mode json` JSONL event stream. Each runtime has a different output format.

Users of Claude Code, Codex, or Gemini CLI are locked out of the mesh and Crew orchestration entirely.

## Outcome

Any supported AI coding CLI can join the messaging mesh and be spawned as a Crew worker, with progress visible in the Crew monitor.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | External agents can join the mesh via a non-extension entry point | Core goal |
| R1 | Crew can spawn workers using at least pi + one non-pi runtime (Claude Code for v1) | Core goal |
| R2 | **Worker progress and lifecycle** | Must-have |
| R2.1 | Basic lifecycle status (running/done/failed/stuck) works across all runtimes | Must-have |
| R2.2 | Rich progress (tool calls, tokens) for runtimes that support streaming | Nice-to-have |
| R3 | Existing pi-only setups work identically with zero config changes | Must-have |
| R4 | Adding a new runtime is isolated to one module + one config entry | Must-have |
| R5 | Runtimes that lack features (thinking, tool restriction, streaming) degrade gracefully — no crashes, logged warnings | Must-have |
| R6 | User declares runtimes in config; validated at spawn time (not startup) | Must-have |
| R7 | No persistent daemon — file-based architecture stays | Must-have |
| R8 | Workers receive task context and can report back regardless of runtime | Must-have |

### Key requirement decisions

- **R0/R1 split:** "Joining the mesh" (R0) is agent-initiated — an external agent voluntarily connects and needs an entry point. "Being spawned as a Crew worker" (R1) is orchestrator-initiated — the worker is created by the system and doesn't need to "join" anything. These are architecturally different paths and were originally conflated in the first draft.
- **R2 chunked:** "Progress displays" originally hid a 10x effort range. Pi has rich streaming JSONL; Codex emits a single JSON blob at completion. Basic lifecycle (R2.1) is the must-have; rich streaming (R2.2) is nice-to-have for capable runtimes.
- **R2.1 "stuck" caveat:** Stuck detection fidelity varies per runtime (JSONL silence for pi, stdout silence for Claude Code, wall-clock timeout for non-streaming). This is a degradation covered by R5, not a shape-level failure. **Spike needed** for default thresholds and per-runtime configurability.
- **R6 spawn-time validation:** Originally proposed as startup validation, changed because teams share config across machines — not all machines have all runtimes installed. Validate when we actually try to spawn, not at load.
- **R8 "has a mechanism":** Means there exists a way for workers to report back, not that reporting is guaranteed. Reliability varies by path (typed tool calls for pi, prompt-dependent CLI for non-pi). The spawner safety net (D'6) covers the critical path.
- **v1 scope:** The adapter interface supports N runtimes, but v1 concrete implementations are pi + Claude Code only. Codex and Gemini are fast-follows.

---

## Rejected Shapes

### A: Adapter + MCP

| Part | Mechanism |
|------|-----------|
| A1 | RuntimeAdapter interface: buildArgs(), buildEnv(), getCommand(), parseProgress(), supportsFeature() |
| A2 | MCP server (stdio) exposes all messenger actions. Spawner launches as sidecar per non-pi worker |
| A3 | Non-pi worker's MCP config auto-generated at spawn time |
| A4 | Pi workers unchanged — keep extension path |
| A5 | External agents (R0) use same MCP server, configured manually |
| A6 | Lifecycle: spawner watches process exit + MCP heartbeat |

**Rejected because:** A3 is a nightmare. Auto-generating MCP config means writing to each runtime's config location (Claude Code's `mcp.json`, Codex's config, etc.) — invasive, version-fragile, and would be a month of edge cases across runtimes and versions.

### B: Adapter + File Protocol

| Part | Mechanism |
|------|-----------|
| B1 | RuntimeAdapter interface (same as A1) |
| B2 | Workers interact with file store via bash commands injected into system prompt |
| B3 | Thin CLI wrapper for file store operations |
| B4 | Pi workers unchanged |
| B5 | External agents (R0) use same CLI |
| B6 | Lifecycle: spawner watches process exit + file store polling |

**Rejected because:** Subsumed by Shape D. The CLI approach (D'2) is strictly better than raw file protocol — it gives the LLM a named command to call rather than raw JSON file writes.

### C: Adapter + Hybrid

| Part | Mechanism |
|------|-----------|
| C1 | RuntimeAdapter interface (same as A1) |
| C2 | Pi workers: keep extension path |
| C3 | Non-pi workers: MCP server for communication |
| C4 | Two code paths in Crew monitor: extension events for pi, MCP for others |
| C5 | External agents (R0) use MCP |
| C6 | Lifecycle: pi uses JSONL, non-pi uses process exit + MCP |

**Rejected because:** MCP for non-pi workers is overkill — it adds process overhead, startup latency, and MCP config management. A CLI achieves the same access with less machinery. C4 (dual monitor paths) is the same maintenance burden as D' but without the simplicity gains.

### D: Adapter + CLI (original, with D3)

| Part | Mechanism |
|------|-----------|
| D1 | RuntimeAdapter interface |
| D2 | `pi-messenger-cli` — standalone Node CLI wrapping handlers.ts |
| **D3** | **ALL workers (including pi) use CLI when spawned by Crew** |
| D4 | Worker system prompt includes CLI usage instructions |
| D5 | External agents (R0) use same CLI |
| D6 | Lifecycle: spawner watches process exit + file store polling |
| D7 | CLI imports handlers.ts/store.ts/lib.ts directly. Zero logic duplication. |

**D3 rejected because:** It replaces pi's typed tool calls with prompt-dependent bash — a reliability regression. Pi Crew workers currently get `pi_messenger` as a first-class tool call via the extension (typed parameters, parsed and validated by the framework). D3 would replace this with system prompt instructions telling the LLM to run bash commands, subject to quoting issues, path resolution failures, and the LLM simply choosing not to call it. The architectural symmetry of "one path for all" is not worth degrading the path that already works.

---

## Selected Shape: D' — Adapter + CLI, Pi Extension Preserved

| Part | Mechanism |
|------|-----------|
| **D'1** | **RuntimeAdapter interface:** `buildArgs(task, config) → string[]`, `buildEnv(task, config) → Record<string,string>`, `getCommand() → string`, `parseProgress(line) → AgentProgress \| null`, `supportsFeature(feature) → boolean`. One adapter file per runtime. |
| **D'2** | **`pi-messenger-cli`** — standalone Node CLI wrapping handlers.ts. Exposes all handler actions (messaging, reservations, crew task lifecycle, feed, etc.). Imports handlers.ts/store.ts/lib.ts directly — zero logic duplication. |
| **D'3** | **Pi workers: extension path preserved.** Unchanged from today. Pi Crew workers get the pi-messenger extension loaded via `--extension`, giving them `pi_messenger` as a typed tool call. |
| **D'4** | **Non-pi workers: CLI instructions in system prompt.** `prompt.ts` injects exact CLI command syntax, arguments, and examples for non-pi runtimes. Includes commands for task.start, task.done, reserve, release, send. |
| **D'5** | **External agents (R0): same CLI.** Any agent that can run bash can join the mesh via `pi-messenger-cli join`, send messages, reserve files, etc. |
| **D'6** | **Lifecycle safety net (load-bearing).** Spawner watches child process exit. If `task.done` not called by the worker, spawner infers outcome from exit code (0 = success, non-zero = failure) + checks for file changes via git diff. Stuck detection: monitors output silence (JSONL for pi, stdout for Claude Code, wall-clock timeout for non-streaming). Post-completion: spawner does git diff to attribute file changes even if worker never called `reserve`. |
| **D'7** | **Shared implementation.** CLI and extension both import the same handlers.ts, store.ts, lib.ts. All messenger logic lives in one place. Adding the CLI adds a thin entry point, not duplicate business logic. |

### Why D'

The key insight is that **every coding agent has a bash tool.** MCP is a means to giving agents access to messenger actions, but a CLI achieves the same thing with zero config injection, zero sidecar processes, and zero MCP version dependency. The CLI is universally accessible.

D' preserves pi's typed tool call path (high reliability) while giving non-pi agents a CLI path (lower reliability but acceptable because D'6 catches the critical lifecycle). Two communication surfaces, one shared implementation.

### Design decisions embedded in D'

1. **D3 rejected → D'3:** Don't degrade pi's extension path for architectural symmetry. Typed tool calls > prompt-dependent bash.
2. **D'6 is load-bearing, not an afterthought:** The spawner safety net is what makes prompt-dependent CLI communication acceptable for non-pi workers. Without D'6, the CLI path would be too fragile for production use.
3. **CLI over MCP:** CLI avoids the config injection problem (A3), the sidecar overhead (A2/C3), and works with any agent that has bash — which is all of them.

---

## Fit Check: R × D'

| Req | Requirement | Status | D' |
|-----|-------------|--------|----|
| R0 | External agents can join the mesh via a non-extension entry point | Core goal | ✅ |
| R1 | Crew can spawn workers using at least pi + one non-pi runtime | Core goal | ✅ |
| R2.1 | Basic lifecycle status (running/done/failed/stuck) works across all runtimes | Must-have | ✅ |
| R2.2 | Rich progress (tool calls, tokens) for runtimes that support streaming | Nice-to-have | ✅ |
| R3 | Existing pi-only setups work identically with zero config changes | Must-have | ✅ |
| R4 | Adding a new runtime is isolated to one module + one config entry | Must-have | ✅ |
| R5 | Runtimes that lack features degrade gracefully — no crashes, logged warnings | Must-have | ✅ |
| R6 | User declares runtimes in config; validated at spawn time | Must-have | ✅ |
| R7 | No persistent daemon — file-based architecture stays | Must-have | ✅ |
| R8 | Workers receive task context and can report back regardless of runtime | Must-have | ✅ |


**Notes:**
- **R0 ✅:** D'5 — CLI is the non-extension entry point. `pi-messenger-cli join`, `pi-messenger-cli send`, etc. Any agent with bash can participate.
- **R1 ✅:** D'1 adapters handle spawn. Pi adapter wraps current behavior. Claude Code adapter is the v1 non-pi target. Adapter interface supports N runtimes.
- **R2.1 ✅:** D'6 — spawner watches process exit for basic lifecycle. Stuck detection mechanism varies per runtime (JSONL silence for pi, stdout silence for Claude Code, wall-clock timeout for non-streaming). Fidelity variation is covered by R5.
- **R2.2 ✅:** D'1 `parseProgress()` per adapter. Pi adapter parses JSONL. Claude Code adapter parses `--output-format stream-json`. Runtimes without streaming get R2.1 only.
- **R3 ✅:** D'3 — pi workers are completely untouched. Default runtime is `"pi"`. No config changes needed for current behavior.
- **R4 ✅:** D'1 — new runtime = one adapter file implementing the interface + one config entry in crew config schema. D'7 ensures no duplication of messenger logic.
- **R5 ✅:** D'1 `supportsFeature()` — adapter declares capabilities. Spawner skips unsupported flags (e.g., `--thinking` for runtimes that don't support it). Warning logged.
- **R6 ✅:** D'1 `getCommand()` returns the binary name. Spawner runs `which <command>` at spawn time. Fails with clear error if missing. No startup-time validation.
- **R7 ✅:** D'2/D'7 — CLI is invoked per-call, not a daemon. File store is the communication channel. No persistent processes added.
- **R8 ✅:** D'4 (non-pi: CLI instructions in system prompt via prompt.ts) + D'3 (pi: extension tool). Both paths lead to the same handlers.ts. "Report back" means the mechanism exists; reliability varies by path, with D'6 as safety net.

---

## Open Items

### Spikes needed

1. **Stuck detection thresholds** — What's the right default timeout for non-streaming runtimes? Should it be configurable per-runtime in crew config? What does "stdout silence" look like for Claude Code specifically?
2. **prompt.ts CLI injection format** — Test with Claude Code specifically. What exact instructions, syntax, and examples produce reliable CLI usage? This is the most likely source of bugs in the non-pi path.

### Open questions

3. **Model name normalization in adapters (D'1)** — Should adapters normalize model names across conventions? (e.g., `anthropic/claude-sonnet-4` in crew config → `claude-sonnet-4` for Claude Code's `--model` flag). Belongs in adapter implementation, not shape.

### Implementation risks to track

4. **Concurrent file store writes** — Multiple CLI processes hitting the file store simultaneously. Pre-existing risk (current pi workers have the same races), not D'-specific. store.ts uses atomic writes for some operations but plain writeFileSync for registrations and messages. Worth addressing but doesn't affect shape selection.
5. **D'4 prompt fragility** — Non-pi workers depend on following system prompt instructions to call CLI commands. Mitigated by D'6 (spawner safety net for critical lifecycle) but richer coordination (reservations, messages) is best-effort.

---

## Breadboard

Breadboarded by IronQuartz + CalmEagle. Maps D' parts into concrete affordances with wiring.

### Key design decision: PID liveness for CLI

**Problem:** The registration system assumes long-lived processes (same PID for entire session). Each CLI invocation is a separate Node process — PID dies between calls, agent appears offline, name could be reclaimed.

**Resolution (Option 5 — spawner pre-registers with child PID):** Both lobby.ts and agents.ts call `store.registerSpawnedWorker()` with `proc.pid` (the child process PID) immediately after spawn for non-pi runtimes. The CLI never registers — it reconstructs state from the file store. The child PID stays alive for the entire task, so liveness checks pass naturally.

- Crew workers (D'4): Spawner pre-registers. CLI is stateless action executor. Clean.
- External agents (D'5): Self-register via `pi-messenger-cli join`. Accept intermittent offline between CLI calls. Good enough for v1.

### Non-UI Affordances

#### Adapter Layer (D'1)

| Affordance | Place | Wires To |
|------------|-------|----------|
| `RuntimeAdapter` interface | `crew/utils/adapters/types.ts` (new) | Used by lobby.ts spawner |
| `PiAdapter` | `crew/utils/adapters/pi.ts` (new) | Extracts current arg construction from lobby.ts lines 76-110 |
| `ClaudeAdapter` | `crew/utils/adapters/claude.ts` (new) | `--print --output-format stream-json` |
| `getAdapter(runtime)` factory | `crew/utils/adapters/index.ts` (new) | Called by lobby.ts |
| `runtime` field in CrewConfig | `crew/utils/config.ts` | Read by lobby.ts to select adapter |

#### CLI (D'2)

| Affordance | Place | Wires To |
|------------|-------|----------|
| `pi-messenger-cli` entry point | `cli/index.ts` (new) | Node bin via package.json "bin" |
| Command router | `cli/index.ts` | Maps subcommands to handler calls |
| Agent name from env | `cli/index.ts` | Reads `PI_AGENT_NAME` |
| State reconstruction from file store | `cli/index.ts` | Reads registry file → constructs MessengerState with `registered=true` |
| Pure action execution | `cli/index.ts` | Each command calls handler directly |
| `join` command (external agents only) | `cli/index.ts` | Self-registers for non-spawned agents (D'5) |
| Human-readable output | `cli/index.ts` | Formats `result()` objects as `✓ success` / `✗ error` text |

#### Prompt Injection (D'4)

| Affordance | Place | Wires To |
|------------|-------|----------|
| `buildCliInstructions()` | `crew/prompt.ts` (new function) | Returns CLI command reference string |
| `runtime` parameter on `buildWorkerPrompt()` | `crew/prompt.ts` (signature change) | Caller passes runtime from config |
| Conditional injection | `crew/prompt.ts` | If `runtime !== "pi"`: append CLI instructions |
| CLI command reference + examples | Embedded in prompt string | Exact syntax for task.start, task.done, reserve, release, send |
| Expected output format | Embedded in prompt string | Tells LLM what `✓`/`✗` responses look like |

#### Spawn Refactor (D'1 + D'3)

| Affordance | Place | Wires To |
|------------|-------|----------|
| `spawnWithAdapter()` | `crew/lobby.ts` (refactor) | Replaces hardcoded `spawn("pi", ...)` at line 112 |
| Adapter-based arg construction | `crew/lobby.ts` (refactor) | Replaces lines 76-110 with `adapter.buildArgs()` |
| Adapter-based stdout parsing | `crew/lobby.ts` (refactor) | Replaces lines 141-168 with `adapter.parseProgressEvent()` |
| Extension injection (pi only) | `PiAdapter.buildArgs()` | `--extension EXTENSION_DIR` only when runtime=pi |
| Pre-register worker | `crew/lobby.ts` + `crew/agents.ts` (post-spawn) | Calls `store.registerSpawnedWorker(registryDir, cwd, name, pid, model, sessionId)` for non-pi runtimes |
| `registerSpawnedWorker()` | `store.ts` (new function) | Dedicated API matching full AgentRegistration schema; atomic write |
| `PI_AGENT_NAME` propagation | `lobby.ts` env → `cli/index.ts` env read | Spawner sets → runtime inherits → CLI reads |

#### Lifecycle Safety Net (D'6) — Enhancement of existing lobby.ts close handler

| Affordance | Place | Wires To |
|------------|-------|----------|
| Exit code inference | `crew/lobby.ts` close handler (enhance lines 170-200) | Exit 0 + no task.done → infer success; non-0 → mark failed |
| Stuck detection timer | `crew/lobby.ts` (new) | Watches last stdout timestamp, fires after configurable timeout |
| Post-completion git diff | `crew/lobby.ts` close handler (new) | `git diff --name-only` to attribute file changes |
| Existing: orphan task reset | `crew/lobby.ts` lines 170-200 (already exists) | Foundation — resets task to todo / blocks after max attempts |

#### Config Schema

| Affordance | Place | Wires To |
|------------|-------|----------|
| `runtime` top-level default | `crew/utils/config.ts` CrewConfig | Default: `"pi"` |
| `runtime` per-role override | `crew/utils/config.ts` CrewConfig | e.g., `{ worker: "claude", planner: "pi" }` |
| `stuckTimeout` per-runtime | `crew/utils/config.ts` CrewConfig | Default varies by adapter |
| Runtime validation at spawn | `crew/lobby.ts` | `which <command>` before spawn |

### UI Affordances (minimal)

| Affordance | Place | Wires To |
|------------|-------|----------|
| `runtime` in config.json | Project config file | Read by lobby.ts |
| `pi-messenger-cli --help` | CLI stdout | User/agent reference |
| Runtime name in Crew monitor | `crew/live-progress.ts` | Shows which adapter each worker uses |
| Degradation warnings | Feed log | "Claude adapter: --thinking not supported, skipping" |

### Wiring: Non-Pi Worker Flow (D'4)

```
config.json: runtime.worker = "claude"
  → lobby.ts: getAdapter("claude") → ClaudeAdapter
  → ClaudeAdapter.buildArgs(task, config) → ["--print", "--output-format", "stream-json", "--model", "...", prompt]
  → buildWorkerPrompt(task, ..., runtime="claude") → injects CLI instructions via buildCliInstructions()
  → lobby.ts: spawn("claude", args, { env: { PI_AGENT_NAME: "CoralFox", PI_CREW_WORKER: "1", ... } })
  → lobby.ts: registerSpawnedWorker(registryDir, cwd, "CoralFox", proc.pid, "claude-sonnet-4", "crew-abc123")
  → Claude Code starts, reads prompt with CLI instructions
  → Worker: bash("pi-messenger-cli task.start --id task-3")
      → CLI reads PI_AGENT_NAME, reconstructs state from registry, calls handler → ✓
  → Worker implements feature
  → Worker: bash("pi-messenger-cli task.done --id task-3 --summary '...'") → ✓
  → Process exits 0
  → lobby.ts close handler: task already marked done, unregisters worker
```

### Wiring: D'6 Safety Net Flow

```
  → Worker implements feature but never calls pi-messenger-cli task.done
  → Process exits 0
  → lobby.ts close handler: task still in_progress
  → Exit code 0 → infer success
  → git diff --name-only → attribute files changed
  → Mark task done with auto-inferred summary
  → Log warning: "task-3 completed (inferred from exit code, worker didn't call task.done)"
  → Unregister worker
```

### Wiring: Pi Worker Flow (unchanged)

```
  → lobby.ts: getAdapter("pi") → PiAdapter
  → PiAdapter.buildArgs() → ["--mode", "json", "--no-session", "-p", "--extension", EXTENSION_DIR, ...]
  → spawn("pi", args, { env: { PI_AGENT_NAME: "JadeWolf", ... } })
  → Pi worker self-registers via extension session_start hook (existing behavior)
  → Worker uses pi_messenger({ action: "task.done", ... }) typed tool call
  → Everything works exactly as today
```

### Wiring: External Agent Flow (D'5)

```
  → Agent (any runtime with bash) calls: pi-messenger-cli join --name MyAgent
  → CLI self-registers with own PID (short-lived — intermittent offline between calls, acceptable for v1)
  → Agent calls: pi-messenger-cli send --to JadeWolf --message "..."
  → Agent calls: pi-messenger-cli reserve --paths src/auth.ts src/login.ts
  → Between calls: agent may appear offline momentarily (PID dead). Re-registers on next call.
```

---

## Slices

Vertical implementation increments. Each ends in demo-able output.

### Dependency Graph

```
V1 (Adapter + PiAdapter)
 ├─→ V2 (CLI) ─→ V3 (ClaudeAdapter + Prompt + Pre-Registration)
 └─────────────→ V3
V4 (D'6 enhancements) — independent, parallel-safe with V2/V3
```

Note: V1 and V4 both touch lobby.ts (different sections — spawn logic vs close handler). Parallel-safe but note merge surface.

### V1: Adapter Interface + PiAdapter (pure refactor)

**Scope:**
- Extract arg construction (lobby.ts lines 76-112) into `PiAdapter.buildArgs()`
- Extract stdout parsing (lobby.ts lines 141-168) into `PiAdapter.parseProgressEvent()`
- Define `RuntimeAdapter` interface in `crew/utils/adapters/types.ts`
- `getAdapter(runtime)` factory in `crew/utils/adapters/index.ts`
- Add `runtime` field to CrewConfig (default: `"pi"`)
- lobby.ts calls adapter methods instead of inline logic

**Does NOT include:** registerSpawnedWorker() (that's V3).

**Demo:** Existing tests pass. `pi_messenger({ action: "work" })` spawns pi workers exactly as before. The refactor is invisible to users.

### V2: pi-messenger-cli

**Scope:**
- `cli/index.ts` entry point with command router
- State reconstruction from file store (two modes):
  - Crew-spawned worker (`PI_CREW_WORKER=1`): reads registry, expects runtime PID alive
  - External agent: auto-re-registers with current PID on every command
- Human-readable output formatting (`✓ success` / `✗ error`)
- `join` command for external agents (D'5)
- Action commands: send, status, list, reserve, release, task.start, task.done, feed
- package.json "bin" entry

**Demo:** `pi-messenger-cli join --name TestAgent && pi-messenger-cli send --to <agent> --message "hello from CLI"` — message appears in mesh.

### V3: ClaudeAdapter + Prompt Injection + Spawner Pre-Registration

**Scope:**
- `ClaudeAdapter` implementing RuntimeAdapter (`buildArgs()` + `parseProgressEvent()`)
- `store.registerSpawnedWorker()`: dedicated API for spawner pre-registration (matches AgentRegistration schema)
- Spawner pre-registration in both lobby.ts + agents.ts for non-pi workers
- `buildCliInstructions()` function in `crew/prompt.ts`
- `runtime` parameter added to `buildWorkerPrompt()` signature
- Conditional injection: if `runtime !== "pi"`, append CLI instructions
- `PI_AGENT_NAME` propagation verified end-to-end

**Demo:** Set `runtime: { worker: "claude" }` in crew config → `pi_messenger({ action: "work" })` → Claude Code worker spawns, picks up task, calls pi-messenger-cli to report progress, completes task → shows as done in Crew monitor.

**Risk note:** V3 is the first end-to-end non-pi runtime. It will likely surface issues unpredictable from the breadboard — Claude Code CLI flag behavior, prompt injection effectiveness, timing of spawner pre-registration vs worker's first CLI command. The open spike on prompt.ts CLI injection format should run during or before V3.

### V4: D'6 Lifecycle Enhancements (parallel-safe)

**Scope:**
- Exit code inference in lobby.ts close handler: exit 0 + no task.done → infer success; non-0 → mark failed
- Stuck detection timer: watches last stdout timestamp, fires after configurable timeout
- Post-completion git diff: `git diff --name-only` to attribute file changes when no reserve was called
- `stuckTimeout` config field (per-runtime defaults)

**Does NOT replace:** Existing orphan task reset (lobby.ts lines 170-200) — enhances it.

**Demo:** Spawn a worker that completes work but doesn't call task.done → spawner auto-infers completion from exit code → feed shows "task completed (inferred from exit code)".
