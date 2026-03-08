/**
 * Crew - Pi Runtime Adapter
 *
 * Wraps pi's CLI flags and --mode json JSONL progress parsing.
 * Extracts the arg construction logic previously duplicated in
 * agents.ts and lobby.ts into a single reusable adapter.
 */

import { pushModelArgs, resolveThinking, modelHasThinkingSuffix } from "../../agents.js";
import { parseJsonlLine, type PiEvent } from "../progress.js";
import type {
  RuntimeAdapter,
  RuntimeFeature,
  SpawnTask,
  AdapterConfig,
  ProgressEvent,
} from "./types.js";

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export class PiAdapter implements RuntimeAdapter {
  readonly name = "pi";

  getCommand(): string {
    return "pi";
  }

  buildArgs(task: SpawnTask, config: AdapterConfig): string[] {
    const args = ["--mode", "json", "--no-session", "-p"];

    if (config.model) {
      pushModelArgs(args, config.model);
    }

    if (config.thinking && !modelHasThinkingSuffix(config.model)) {
      const thinking = resolveThinking(config.thinking);
      if (thinking) {
        args.push("--thinking", thinking);
      }
    }

    if (config.tools?.length) {
      const builtinTools: string[] = [];
      const extensionPaths: string[] = [];
      for (const tool of config.tools) {
        if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
          extensionPaths.push(tool);
        } else if (BUILTIN_TOOLS.has(tool)) {
          builtinTools.push(tool);
        }
      }
      if (builtinTools.length > 0) {
        args.push("--tools", builtinTools.join(","));
      }
      for (const extensionPath of extensionPaths) {
        args.push("--extension", extensionPath);
      }
    }

    // Pass the pi-messenger extension so workers can use pi_messenger tool
    args.push("--extension", config.extensionDir);

    if (task.systemPromptPath) {
      args.push("--append-system-prompt", task.systemPromptPath);
    }

    args.push(task.prompt);
    return args;
  }

  buildEnv(base: Record<string, string>): Record<string, string> {
    // Pi workers use the base env as-is; PI_AGENT_NAME, PI_CREW_WORKER, etc.
    // are set by the caller (lobby.ts / agents.ts) before passing in.
    return { ...base };
  }

  parseProgressEvent(line: string): ProgressEvent | null {
    const piEvent = parseJsonlLine(line);
    if (!piEvent) return null;
    return piEventToProgressEvent(piEvent);
  }

  supportsFeature(_feature: RuntimeFeature): boolean {
    // Pi supports all features
    return true;
  }
}

function piEventToProgressEvent(event: PiEvent): ProgressEvent {
  const msg = event.message;

  if (event.type === "tool_call" || event.toolName) {
    return {
      type: "tool_call",
      toolName: event.toolName,
      args: event.args,
    };
  }

  if (event.type === "tool_result") {
    return { type: "tool_result" };
  }

  if (msg?.errorMessage) {
    return {
      type: "error",
      errorMessage: msg.errorMessage,
    };
  }

  if (msg) {
    const content = msg.content
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("");

    return {
      type: "message",
      tokens: msg.usage
        ? { input: msg.usage.input, output: msg.usage.output }
        : undefined,
      model: msg.model,
      content: content || undefined,
    };
  }

  return { type: "unknown" };
}
