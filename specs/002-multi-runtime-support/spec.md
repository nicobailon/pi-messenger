---
title: "Multi-Runtime Agent Support: Claude Code, Codex, Gemini CLI"
date: 2026-03-07
bead: pi-messenger-2
---

> **Note:** Shaping decisions captured in `shaping.md`. This document retains the original coupling analysis; see `shaping.md` for selected shape (D') and locked requirements.

# Multi-Runtime Agent Support

## Problem

pi-messenger's messaging mesh and Crew orchestration are architecturally agent-agnostic — file-based registry, JSON inbox/outbox, JSONL feed — but the implementation is coupled to pi in three critical places:

1. **Extension entry point** — Tool registration, lifecycle hooks, and TUI overlay use `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` APIs exclusively. No other agent can register as a mesh participant without going through pi's extension system.

2. **Worker spawning** — `crew/agents.ts` and `crew/lobby.ts` hardcode `spawn("pi", [...])` with pi-specific CLI flags (`--mode json`, `--no-session`, `--extension`, `--append-system-prompt`, `--thinking`, `--tools`, `--provider`). Crew cannot delegate work to Claude Code, Codex, or Gemini CLI.

3. **Progress parsing** — `crew/utils/progress.ts` parses pi's `--mode json` JSONL event stream (`PiEvent` type: tool calls, token usage, model info). Each runtime has its own streaming output format.

This means multi-agent workflows (Crew planning, parallel workers, reviews) only work when every participant is a pi instance. Users who prefer or need Claude Code, Codex, or Gemini CLI are locked out of the mesh and orchestration layer entirely.

## Outcome

Any supported AI coding CLI — pi, Claude Code, Codex, Gemini CLI — can:

1. **Join the mesh** as a first-class participant (register, send/receive messages, reserve files, appear in feed).
2. **Be spawned as a Crew worker** by the orchestrator to execute tasks.
3. **Report progress** in a normalized format the Crew monitor can display.

## Scope

### In Scope

- **Runtime adapter abstraction** — Interface for spawn args, environment setup, progress parsing, and graceful shutdown per CLI runtime.
- **Concrete adapters** for: `pi`, `claude` (Claude Code), `codex` (OpenAI Codex), `gemini` (Gemini CLI).
- **MCP server surface** — Expose pi_messenger actions as MCP tools so non-pi agents can call `join`, `send`, `reserve`, `task.start`, `task.done`, etc. without being a pi extension.
- **Crew config: `runtime` field** — Per-role or per-worker runtime selection (e.g., `models.worker: "anthropic/claude-sonnet-4"` + `runtime.worker: "claude"`).
- **Normalized progress events** — Common `AgentProgress` type populated by runtime-specific parsers.
- **Documentation** — How to configure mixed-runtime crews, supported CLI flags per runtime.

### Out of Scope

- **TUI overlay for non-pi agents** — The overlay is pi-specific UI. Non-pi agents participate headlessly. No effort to port it.
- **MCP tool installation automation** — Users configure MCP themselves (Claude Code `mcp.json`, etc.). We provide the server, not the wiring.
- **Feature parity across runtimes** — Some runtimes lack features (e.g., Codex has no `--thinking` flag). Adapters degrade gracefully; they don't shim missing capabilities.
- **Runtime auto-detection** — We don't sniff which CLI is available. The user declares runtimes in config.

## Analysis: Coupling Points

### 1. ExtensionContext Surface (23 imports across 12 files)

The `ExtensionContext` type is used for 5 properties:

| Property | Usage | Abstraction Path |
|---|---|---|
| `ctx.cwd` | Working directory (14 uses) | `process.cwd()` fallback — already handled |
| `ctx.hasUI` | Gates TUI features (8 uses) | Default `false` for non-pi runtimes |
| `ctx.model` | Agent model ID for registration (3 uses) | Pass explicitly from config or env var |
| `ctx.sessionManager` | Session ID + state restore (5 uses) | Generate UUID for non-pi; state restore is pi-only |
| `ctx.ui` | Notifications + status bar (12 uses) | No-op for non-pi; all in `store.ts` and `index.ts` |

**Key insight:** The crew handlers (`crew/handlers/*.ts`) only use `ctx.cwd` and pass it through. Defining a minimal `RuntimeContext` interface that these files accept instead of `ExtensionContext` is straightforward.

### 2. Spawn Layer (2 files, ~50 lines of pi-specific arg construction)

Both `crew/agents.ts` and `crew/lobby.ts` build args the same way:

```
["--mode", "json", "--no-session", "-p"]
+ model flags (--provider, --model)
+ thinking flag (--thinking)
+ tool restrictions (--tools)
+ extension loading (--extension)
+ system prompt (--append-system-prompt)
+ the task prompt string
```

Equivalent flags for other runtimes:

| Capability | pi | Claude Code | Codex | Gemini CLI |
|---|---|---|---|---|
| JSON output | `--mode json` | `--output-format stream-json` | `--output json` | TBD (may need wrapper) |
| Non-interactive | `--no-session -p` | `--print` | `--quiet` | `-` (stdin prompt) |
| Model selection | `--provider X --model Y` | `--model Y` | `--model Y` | `--model Y` |
| System prompt | `--append-system-prompt FILE` | `--system-prompt "..."` | `--instructions FILE` | `--system-instruction "..."` |
| Tool restriction | `--tools read,bash,...` | `--allowedTools read,bash,...` | N/A | N/A |
| Extended thinking | `--thinking budget` | N/A (model-level) | N/A | `--thinking-budget N` |

### 3. Progress Parsing

Pi emits JSONL with `{ type, toolName, args, message: { role, usage, model, content } }`. Other runtimes:

- **Claude Code** (`--output-format stream-json`): Emits `{ type: "tool_use" | "text" | ... }` — similar structure, different field names.
- **Codex**: `--output json` gives a single JSON blob at completion, not streaming. May need `--stream` or post-completion parsing.
- **Gemini CLI**: Structured output support varies. May require wrapper script.

### 4. MCP Server for Non-Pi Agents

Non-pi agents join the mesh by calling MCP tools. The MCP server wraps the same `handlers.ts` functions:

- `messenger_join` → `executeJoin()`
- `messenger_send` → `executeSend()`
- `messenger_status` → `executeStatus()`
- `messenger_reserve` → `executeReserve()`
- `messenger_task_start` → crew task handlers
- etc.

The handlers are already pure functions over file state + a thin context. The MCP server is a straightforward wrapper.

## Acceptance Criteria

1. **AC1: Runtime adapter interface exists** — A `RuntimeAdapter` interface defines `buildArgs(task, config) → string[]`, `buildEnv(task, config) → Record<string,string>`, `parseProgressEvent(line: string) → AgentProgress | null`, `getCommand() → string`, and `supportsFeature(feature) → boolean`.

2. **AC2: Four adapters implemented** — `PiAdapter`, `ClaudeAdapter`, `CodexAdapter`, `GeminiAdapter` — each tested with representative arg construction and progress parsing.

3. **AC3: Crew spawns via adapter** — `crew/agents.ts` and `crew/lobby.ts` call `adapter.buildArgs()` / `adapter.getCommand()` instead of hardcoding `spawn("pi", ...)`. Runtime is selected from crew config.

4. **AC4: MCP server exposes messenger actions** — A standalone MCP server (stdio transport) exposes messenger actions as tools. A Claude Code agent can `mcp.json`-configure it and call `messenger_join`, `messenger_send`, etc.

5. **AC5: Non-pi agent joins mesh end-to-end** — A Claude Code instance (or Codex/Gemini) can join the mesh via MCP, appear in `messenger_list`, send and receive messages, and reserve files.

6. **AC6: Mixed-runtime Crew wave** — A Crew plan can spawn workers across runtimes (e.g., pi planner + Claude Code worker + Codex reviewer). Progress displays for all.

7. **AC7: Graceful degradation** — When a runtime doesn't support a feature (e.g., tool restriction, thinking budget), the adapter omits the flag and logs a warning. No crashes.

8. **AC8: Config schema** — `crew/config.json` accepts `runtime` field at top level and per-role (`runtime.worker: "claude"`). Defaults to `"pi"` for backward compatibility.

## Constraints

- **Zero breaking changes** — Existing pi-only setups must work identically. All new config is optional with `"pi"` defaults.
- **No daemon** — The file-based architecture stays. MCP server is launched per-agent-session, not as a persistent service.
- **Adapter isolation** — Each adapter is a single file. Adding a new runtime means adding one file + one config entry. No shotgun changes.
- **Test coverage** — Each adapter gets unit tests for arg construction and progress parsing. Integration test for MCP server tool calls against file store.

## Risks

| Risk | Mitigation |
|---|---|
| CLI output formats change across versions | Pin to known-working versions in adapter; version detection if needed |
| Gemini CLI lacks structured JSON output | Wrapper script that captures output and converts to JSONL |
| MCP server startup latency adds to spawn time | Lazy init; MCP server stays alive for session duration |
| Claude Code MCP tool naming conflicts | Namespace: `pi_messenger_join` not `join` |

## Open Questions

1. Should the MCP server be a separate npm package or bundled in pi-messenger?
2. Do we need a "headless pi-messenger CLI" (no pi dependency) for agents that don't support MCP?
3. Should runtime adapters handle model name normalization (e.g., `anthropic/claude-sonnet-4` → `claude-sonnet-4` for Claude Code)?
