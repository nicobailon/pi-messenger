import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

const DEFAULT_SCRIPT_PATH = `${process.env.HOME ?? ""}/.pi/agent/scripts/sync-crew-task.sh`;
const DEFAULT_TIMEOUT_MS = 700;

export type CrewTaskSyncEvent =
  | "task.created"
  | "task.started"
  | "task.done"
  | "task.blocked"
  | "task.reset"
  | "task.reviewed"
  | "task.discovered";

export interface CrewTaskSyncPayload {
  event: CrewTaskSyncEvent;
  [key: string]: unknown;
}

const SCRIPT_PATH_ENV = "PI_MESSENGER_SYNC_CREW_TASK_SCRIPT";

function getSyncScriptPath(): string {
  const override = process.env[SCRIPT_PATH_ENV];
  return override ?? DEFAULT_SCRIPT_PATH;
}

export function syncCrewTask(payload: CrewTaskSyncPayload): void {
  const scriptPath = getSyncScriptPath();
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return;
  }

  try {
    spawnSync(scriptPath, {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: DEFAULT_TIMEOUT_MS,
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    return;
  }
}

export function buildCrewTaskSyncPayload(
  task: {
    id: string;
    title: string;
    status: string;
    depends_on?: string[];
    assigned_to?: string;
    summary?: string;
    evidence?: unknown;
    blocked_reason?: string;
    updated_at?: string;
    started_at?: string;
    completed_at?: string;
    discovered_from?: string;
  },
  event: CrewTaskSyncEvent,
  extra: Record<string, unknown> = {},
): CrewTaskSyncPayload {
  return {
    event,
    id: task.id,
    title: task.title,
    status: task.status,
    depends_on: task.depends_on ?? [],
    assigned_to: task.assigned_to,
    summary: task.summary,
    evidence: task.evidence,
    blocked_reason: task.blocked_reason,
    updated_at: task.updated_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
    discovered_from: task.discovered_from,
    ...extra,
  };
}
