/**
 * Crew - Codex CLI Runtime Adapter
 *
 * Wraps OpenAI Codex CLI (exec --json) and parses its JSONL streaming
 * output into normalized ProgressEvents.
 *
 * Codex exec --json event types:
 * - type: "thread.started" — session start with thread_id
 * - type: "turn.started" / "turn.completed" — turn lifecycle with usage
 * - type: "item.started", item.type: "command_execution" — tool call start
 * - type: "item.completed", item.type: "command_execution" — tool call result
 * - type: "item.completed", item.type: "agent_message" — model text output
 * - type: "item.completed", item.type: "error" — error/warning message
 * - type: "error" — fatal error
 * - type: "turn.failed" — turn failure with error
 *
 * Key differences from Claude Code:
 * - Non-interactive via `codex exec` subcommand (not --print)
 * - JSON output via --json flag (not --output-format stream-json)
 * - Model via -m flag (same shorthand)
 * - No system prompt flag — injected as prompt prefix
 * - No thinking flag
 * - No tool restriction flags
 * - No extension loading
 */

import type {
  RuntimeAdapter,
  RuntimeFeature,
  SpawnTask,
  AdapterConfig,
  ProgressEvent,
} from "./types.js";

export class CodexAdapter implements RuntimeAdapter {
  readonly name = "codex";

  getCommand(): string {
    return "codex";
  }

  buildArgs(task: SpawnTask, config: AdapterConfig): string[] {
    const args = ["exec", "--json"];

    if (config.model) {
      // Strip provider prefix (e.g., "openai/o4-mini" → "o4-mini")
      const model = config.model.includes("/")
        ? config.model.substring(config.model.indexOf("/") + 1)
        : config.model;
      args.push("-m", model);
    }

    // Codex has no --system-prompt flag, so prepend it to the prompt
    let prompt = task.prompt;
    if (task.systemPrompt) {
      prompt = `<system>\n${task.systemPrompt}\n</system>\n\n${prompt}`;
    }

    args.push(prompt);
    return args;
  }

  buildEnv(base: Record<string, string>): Record<string, string> {
    return { ...base };
  }

  parseProgressEvent(line: string): ProgressEvent | null {
    if (!line.trim()) return null;

    let event: CodexStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }

    return codexEventToProgressEvent(event);
  }

  supportsFeature(feature: RuntimeFeature): boolean {
    switch (feature) {
      case "streaming":
        return true;
      case "system-prompt-inline":
        return false; // No dedicated flag — we prepend to prompt
      case "thinking":
        return false;
      case "tool-restriction":
        return false;
      case "extension-loading":
        return false;
      case "system-prompt-file":
        return false;
      default:
        return false;
    }
  }
}

// =============================================================================
// Codex exec --json event types (subset we care about)
// =============================================================================

interface CodexStreamEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    message?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  message?: string;
  error?: { message?: string };
}

function codexEventToProgressEvent(event: CodexStreamEvent): ProgressEvent | null {
  // Tool call: command_execution started
  if (event.type === "item.started" && event.item?.type === "command_execution") {
    return {
      type: "tool_call",
      toolName: "shell",
      args: event.item.command ? { command: event.item.command } : undefined,
    };
  }

  // Tool result: command_execution completed
  if (event.type === "item.completed" && event.item?.type === "command_execution") {
    return { type: "tool_result" };
  }

  // Agent message
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return {
      type: "message",
      content: event.item.text,
    };
  }

  // Error item (warnings/errors from Codex)
  if (event.type === "item.completed" && event.item?.type === "error") {
    return {
      type: "error",
      errorMessage: event.item.message ?? "Unknown Codex error",
    };
  }

  // Fatal error
  if (event.type === "error") {
    return {
      type: "error",
      errorMessage: event.message ?? event.error?.message ?? "Unknown error",
    };
  }

  // Turn completed — extract usage tokens
  if (event.type === "turn.completed" && event.usage) {
    return {
      type: "message",
      tokens: {
        input: event.usage.input_tokens,
        output: event.usage.output_tokens,
      },
    };
  }

  // Lifecycle markers with no actionable task state — intentionally skipped:
  // - thread.started: session ID only, no task progress to surface
  // - turn.started: signals turn beginning, no content yet
  // - turn.failed: couldn't trigger in testing; null is safe — worker exit resets task to todo
  return null;
}
