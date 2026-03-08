/**
 * Crew - Model & Thinking Utilities
 *
 * Pure helpers for model argument construction and thinking resolution.
 * Extracted from agents.ts to avoid circular imports when adapters
 * need these same utilities.
 */

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function pushModelArgs(args: string[], model: string): void {
  const slashIdx = model.indexOf("/");
  if (slashIdx !== -1) {
    args.push("--provider", model.substring(0, slashIdx), "--model", model.substring(slashIdx + 1));
  } else {
    args.push("--model", model);
  }
}

export function resolveThinking(
  configThinking?: string,
  agentThinking?: string,
): string | undefined {
  const resolved = configThinking ?? agentThinking;
  if (!resolved || resolved === "off") return undefined;
  return resolved;
}

export function modelHasThinkingSuffix(model: string | undefined): boolean {
  if (!model) return false;
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) return false;
  return THINKING_LEVELS.has(model.substring(colonIdx + 1));
}

export function resolveModel(
  taskModel?: string,
  paramModel?: string,
  configModel?: string,
  agentModel?: string,
): string | undefined {
  return taskModel ?? paramModel ?? configModel ?? agentModel;
}
