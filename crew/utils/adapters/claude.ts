/**
 * Crew - Claude Code Runtime Adapter
 *
 * Wraps Claude Code CLI (--print --output-format stream-json --verbose)
 * and parses its JSONL streaming output into normalized ProgressEvents.
 *
 * Claude Code stream-json event types:
 * - type: "system", subtype: "init" — session start with model/tools
 * - type: "assistant" — model output. message.content[] has "thinking"/"tool_use"/"text" blocks
 * - type: "user" — tool result feedback
 * - type: "result" — final result with cost/turns
 *
 * Key differences from pi:
 * - No extension loading (MCP is configured externally)
 * - No tool restriction flags
 * - Thinking not supported via CLI flags
 * - System prompt via --system-prompt (inline only, no file path)
 */

import type {
  RuntimeAdapter,
  RuntimeFeature,
  SpawnTask,
  AdapterConfig,
  ProgressEvent,
} from "./types.js";

export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = "claude";

  getCommand(): string {
    return "claude";
  }

  buildArgs(task: SpawnTask, config: AdapterConfig): string[] {
    const args = ["--print", "--output-format", "stream-json", "--verbose"];

    if (config.model) {
      // Strip provider prefix (e.g., "anthropic/claude-sonnet-4-20250514" → "claude-sonnet-4-20250514")
      const model = config.model.includes("/")
        ? config.model.substring(config.model.indexOf("/") + 1)
        : config.model;
      args.push("--model", model);
    }

    // Thinking: not supported via Claude Code CLI flags
    // Tool restriction: not supported
    // Extension loading: not supported (MCP is configured externally)

    // System prompt: inline via --system-prompt
    if (task.systemPrompt) {
      args.push("--system-prompt", task.systemPrompt);
    }
    // Note: systemPromptPath not supported — caller reads file content
    // and passes as task.systemPrompt for Claude Code

    args.push("-p", task.prompt);
    return args;
  }

  buildEnv(base: Record<string, string>): Record<string, string> {
    return { ...base };
  }

  parseProgressEvent(line: string): ProgressEvent | null {
    if (!line.trim()) return null;

    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }

    return claudeEventToProgressEvent(event);
  }

  supportsFeature(feature: RuntimeFeature): boolean {
    switch (feature) {
      case "streaming":
        return true;
      case "system-prompt-inline":
        return true;
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
// Claude Code stream-json types (subset we care about)
// =============================================================================

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: {
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string | null;
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

function claudeEventToProgressEvent(event: ClaudeStreamEvent): ProgressEvent | null {
  // Skip system events (hooks, init) — they don't affect progress tracking
  if (event.type === "system") return null;

  // Map user events to tool_result — needed for accurate tool lifecycle
  // counters and durations (tool_call and tool_result are separate events)
  if (event.type === "user") {
    return { type: "tool_result" };
  }

  if (event.type === "assistant" && event.message) {
    const msg = event.message;
    const content = msg.content ?? [];

    // Check for tool_use blocks
    const toolUse = content.find((c) => c.type === "tool_use");
    if (toolUse) {
      return {
        type: "tool_call",
        toolName: toolUse.name,
        args: toolUse.input,
      };
    }

    // Check for text content
    const textParts = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("");

    return {
      type: "message",
      tokens: msg.usage
        ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens }
        : undefined,
      model: msg.model,
      content: textParts || undefined,
    };
  }

  if (event.type === "result") {
    if (event.is_error) {
      return {
        type: "error",
        errorMessage: event.result ?? "Unknown error",
      };
    }
    // Final result — could extract final cost but not needed for progress
    return null;
  }

  return null;
}
