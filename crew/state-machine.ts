import type { TaskStatus } from "./types.js";

const LEGAL_TRANSITIONS: Record<string, string[]> = {
  "todo":        ["assigned", "blocked"],
  "assigned":    ["starting", "todo", "blocked"],
  "starting":    ["in_progress", "todo", "blocked"],
  "in_progress": ["done", "blocked", "todo"],
  "done":        ["todo"],
  "blocked":     ["todo"],
};

export function validateTransition(from: string, to: string): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function enforceTransition(taskId: string, from: string, to: string): void {
  if (!validateTransition(from, to)) {
    throw new Error(
      `Illegal state transition: ${taskId} cannot go from "${from}" to "${to}". ` +
      `Legal transitions from "${from}": [${(LEGAL_TRANSITIONS[from] || []).join(", ")}]`
    );
  }
}

export function getLegalTransitions(status: string): string[] {
  return LEGAL_TRANSITIONS[status] ?? [];
}
