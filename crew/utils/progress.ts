/**
 * Crew - Progress Tracking
 * 
 * Real-time visibility into agent execution via --mode json event parsing.
 */

export interface ToolEntry {
  tool: string;
  args: string;
  startMs: number;
  endMs: number;
}

export interface AgentProgress {
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartMs?: number;
  recentTools: ToolEntry[];
  toolCallCount: number;
  tokens: number;
  durationMs: number;
  error?: string;
}

// Event types from pi's --mode json output
export interface PiEvent {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  message?: {
    role: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    errorMessage?: string;
  };
}

export function createProgress(agent: string): AgentProgress {
  return {
    agent,
    status: "pending",
    recentTools: [],
    toolCallCount: 0,
    tokens: 0,
    durationMs: 0,
  };
}

export function parseJsonlLine(line: string): PiEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function updateProgress(progress: AgentProgress, event: PiEvent, startTime: number): void {
  progress.durationMs = Date.now() - startTime;

  switch (event.type) {
    case "tool_execution_start":
      progress.status = "running";
      progress.currentTool = event.toolName;
      progress.currentToolArgs = extractArgsPreview(event.args);
      progress.currentToolStartMs = Date.now();
      break;

    case "tool_execution_end":
      progress.toolCallCount++;
      if (progress.currentTool) {
        progress.recentTools.push({
          tool: progress.currentTool,
          args: progress.currentToolArgs ?? "",
          startMs: progress.currentToolStartMs ?? Date.now(),
          endMs: Date.now(),
        });
      }
      progress.currentTool = undefined;
      progress.currentToolArgs = undefined;
      progress.currentToolStartMs = undefined;
      break;

    case "message_end":
      if (event.message?.usage) {
        progress.tokens += (event.message.usage.input ?? 0) + (event.message.usage.output ?? 0);
      }
      if (event.message?.errorMessage) {
        progress.error = event.message.errorMessage;
      }
      break;
  }
}

function extractArgsPreview(args?: Record<string, unknown>): string {
  if (!args) return "";
  const previewKeys = ["command", "path", "file_path", "pattern", "query"];
  for (const key of previewKeys) {
    if (args[key] && typeof args[key] === "string") {
      const value = (args[key] as string).replaceAll("\n", " ").replaceAll("\r", "");
      return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    }
  }
  return "";
}

export function getFinalOutput(messages: PiEvent[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "message_end" && msg.message?.role === "assistant") {
      for (const part of msg.message.content ?? []) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}
