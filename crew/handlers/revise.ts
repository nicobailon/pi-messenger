import * as fs from "node:fs";
import * as path from "node:path";
import type { MessengerState } from "../../lib.js";
import type { CrewParams, Task } from "../types.js";
import { result } from "../utils/result.js";
import * as store from "../store.js";
import { logFeedEvent } from "../../feed.js";
import { spawnAgents } from "../agents.js";
import { getLiveWorkers } from "../live-progress.js";
import { isAutonomousForCwd, isPlanningForCwd } from "../state.js";
import { loadCrewConfig } from "../utils/config.js";

export interface ReviseResult {
  success: boolean;
  message: string;
}

// =============================================================================
// Single task revision
// =============================================================================

export async function executeRevise(
  cwd: string,
  taskId: string,
  prompt: string | undefined,
  agentName: string,
): Promise<ReviseResult> {
  const task = store.getTask(cwd, taskId);
  if (!task) return { success: false, message: `Task ${taskId} not found` };
  if (task.status === "in_progress") return { success: false, message: `Task ${taskId} is in_progress` };
  if (getLiveWorkers(cwd).has("__reviser__")) return { success: false, message: "A revision is already running" };
  if (isPlanningForCwd(cwd)) return { success: false, message: "Cannot revise during planning" };
  if (isAutonomousForCwd(cwd)) return { success: false, message: "Cannot revise during autonomous work" };

  if (prompt) {
    store.appendTaskProgress(cwd, taskId, agentName, `Revision requested: "${prompt}"`);
  }

  const spec = store.getTaskSpec(cwd, taskId) ?? "";
  const progress = store.getTaskProgress(cwd, taskId) ?? "";
  const blockContext = store.getBlockContext(cwd, taskId) ?? "";
  const prdContent = readPrd(cwd);

  const revisePrompt = buildRevisePrompt(task, spec, progress, blockContext, prdContent, prompt);
  const config = loadCrewConfig(store.getCrewDir(cwd));

  let output: string;
  try {
    const [agentResult] = await spawnAgents([{
      agent: "crew-planner",
      task: revisePrompt,
      taskId: "__reviser__",
      modelOverride: config.models?.planner,
    }], cwd);

    if (agentResult.exitCode !== 0) {
      const msg = `Revision failed: ${agentResult.error ?? "planner exited with error"}`;
      logFeedEvent(cwd, agentName, "task.revise", taskId, msg);
      return { success: false, message: msg };
    }
    output = agentResult.output;
  } catch (err) {
    const msg = `Revision failed: ${err instanceof Error ? err.message : "unknown error"}`;
    logFeedEvent(cwd, agentName, "task.revise", taskId, msg);
    return { success: false, message: msg };
  }

  const parsed = parseRevisedTask(output);
  if (!parsed) {
    const msg = "Revision failed: could not parse revised-task block from planner output";
    logFeedEvent(cwd, agentName, "task.revise", taskId, msg);
    return { success: false, message: msg };
  }

  if (parsed.title) store.updateTask(cwd, taskId, { title: parsed.title });
  store.setTaskSpec(cwd, taskId, parsed.spec);

  const preview = prompt ? prompt.slice(0, 60) : "revised";
  logFeedEvent(cwd, agentName, "task.revise", taskId, preview);
  return { success: true, message: `Revised ${taskId}${parsed.title ? `: ${parsed.title}` : ""}` };
}

export async function taskRevise(cwd: string, params: CrewParams, state: MessengerState) {
  const { id, prompt } = params;
  if (!id) return result("Error: id required for task.revise", { mode: "task.revise", error: "missing_id" });

  const r = await executeRevise(cwd, id, prompt ?? undefined, state.agentName || "unknown");
  if (!r.success) {
    return result(`Error: ${r.message}`, { mode: "task.revise", error: "revision_failed", id });
  }
  return result(r.message, { mode: "task.revise", id });
}

// =============================================================================
// Subtree revision
// =============================================================================

export async function executeReviseTree(
  cwd: string,
  taskId: string,
  prompt: string | undefined,
  agentName: string,
): Promise<ReviseResult> {
  const target = store.getTask(cwd, taskId);
  if (!target) return { success: false, message: `Task ${taskId} not found` };
  if (getLiveWorkers(cwd).has("__reviser__")) return { success: false, message: "A revision is already running" };
  if (isPlanningForCwd(cwd)) return { success: false, message: "Cannot revise during planning" };
  if (isAutonomousForCwd(cwd)) return { success: false, message: "Cannot revise during autonomous work" };

  const dependents = store.getTransitiveDependents(cwd, taskId);
  const subtreeAll = [target, ...dependents];
  const subtreeIds = new Set(subtreeAll.map(t => t.id));

  const liveWorkers = getLiveWorkers(cwd);
  const liveTasks = subtreeAll.filter(t => liveWorkers.has(t.id));
  if (liveTasks.length > 0) {
    return { success: false, message: `Cannot revise: ${liveTasks.map(t => t.id).join(", ")} have live workers` };
  }

  const doneTasks = subtreeAll.filter(t => t.status === "done");
  const revisable = subtreeAll.filter(t => t.status !== "done");

  if (prompt) {
    store.appendTaskProgress(cwd, taskId, agentName, `Tree revision requested: "${prompt}"`);
  }

  const prdContent = readPrd(cwd);
  const revisePrompt = buildReviseTreePrompt(subtreeAll, doneTasks, prdContent, prompt, cwd);
  const config = loadCrewConfig(store.getCrewDir(cwd));

  let output: string;
  try {
    const [agentResult] = await spawnAgents([{
      agent: "crew-planner",
      task: revisePrompt,
      taskId: "__reviser__",
      modelOverride: config.models?.planner,
    }], cwd);

    if (agentResult.exitCode !== 0) {
      const msg = `Tree revision failed: ${agentResult.error ?? "planner exited with error"}`;
      logFeedEvent(cwd, agentName, "task.revise-tree", taskId, msg);
      return { success: false, message: msg };
    }
    output = agentResult.output;
  } catch (err) {
    const msg = `Tree revision failed: ${err instanceof Error ? err.message : "unknown error"}`;
    logFeedEvent(cwd, agentName, "task.revise-tree", taskId, msg);
    return { success: false, message: msg };
  }

  const parsed = parseRevisionTaskBlock(output);
  if (!parsed || parsed.length === 0) {
    const msg = "Tree revision failed: could not parse tasks-json block from planner output";
    logFeedEvent(cwd, agentName, "task.revise-tree", taskId, msg);
    return { success: false, message: msg };
  }

  const existingEntries = parsed.filter(e => e.id);
  const newEntries = parsed.filter(e => !e.id && e.title);

  for (const entry of existingEntries) {
    if (!subtreeIds.has(entry.id!)) {
      const msg = `Tree revision failed: returned ID ${entry.id} is outside the subtree`;
      logFeedEvent(cwd, agentName, "task.revise-tree", taskId, msg);
      return { success: false, message: msg };
    }
  }

  const maxNew = Math.max(5, subtreeAll.length * 2);
  if (newEntries.length > maxNew) {
    const msg = `Tree revision failed: too many new tasks (${newEntries.length}, max ${maxNew})`;
    logFeedEvent(cwd, agentName, "task.revise-tree", taskId, msg);
    return { success: false, message: msg };
  }

  for (const entry of existingEntries) {
    if (entry.title) store.updateTask(cwd, entry.id!, { title: entry.title });
    store.setTaskSpec(cwd, entry.id!, entry.spec);
  }

  const titleToId = new Map<string, string>();
  for (const t of store.getTasks(cwd)) {
    titleToId.set(t.title.toLowerCase(), t.id);
  }

  for (const entry of newEntries) {
    const created = store.createTask(cwd, entry.title!, entry.spec, []);
    titleToId.set(entry.title!.toLowerCase(), created.id);
  }

  for (const entry of [...existingEntries, ...newEntries]) {
    if (!entry.dependsOn || entry.dependsOn.length === 0) continue;
    const entryId = entry.id ?? titleToId.get(entry.title!.toLowerCase());
    if (!entryId) continue;

    const resolvedDeps: string[] = [];
    for (const dep of entry.dependsOn) {
      const resolved = titleToId.get(dep.toLowerCase()) ?? (dep.startsWith("task-") ? dep : undefined);
      if (resolved && resolved !== entryId) resolvedDeps.push(resolved);
    }
    if (resolvedDeps.length > 0) {
      store.updateTask(cwd, entryId, { depends_on: resolvedDeps });
    }
  }

  for (const task of revisable) {
    store.updateTask(cwd, task.id, {
      status: "todo",
      started_at: undefined,
      completed_at: undefined,
      base_commit: undefined,
      assigned_to: undefined,
      summary: undefined,
      evidence: undefined,
      blocked_reason: undefined,
    });
    store.cleanupBlockFiles(cwd, task.id);
  }

  const preview = prompt ? prompt.slice(0, 60) : "revised tree";
  logFeedEvent(cwd, agentName, "task.revise-tree", taskId, `${taskId} + ${dependents.length} dependents — ${preview}`);
  return { success: true, message: `Revised ${taskId} + ${dependents.length} dependents` };
}

export async function taskReviseTree(cwd: string, params: CrewParams, state: MessengerState) {
  const { id, prompt } = params;
  if (!id) return result("Error: id required for task.revise-tree", { mode: "task.revise-tree", error: "missing_id" });

  const r = await executeReviseTree(cwd, id, prompt ?? undefined, state.agentName || "unknown");
  if (!r.success) {
    return result(`Error: ${r.message}`, { mode: "task.revise-tree", error: "revision_failed", id });
  }
  return result(r.message, { mode: "task.revise-tree", id });
}

// =============================================================================
// Helpers
// =============================================================================

function readPrd(cwd: string): string {
  const plan = store.getPlan(cwd);
  if (!plan) return "";
  if (plan.prompt) return plan.prompt;
  const prdPath = path.isAbsolute(plan.prd) ? plan.prd : path.join(cwd, plan.prd);
  try { return fs.readFileSync(prdPath, "utf-8"); } catch { return ""; }
}

function buildRevisePrompt(
  task: Task,
  spec: string,
  progress: string,
  blockContext: string,
  prdContent: string,
  prompt: string | undefined,
): string {
  const parts: string[] = [
    `Revise the spec for task ${task.id}: "${task.title}"`,
    "",
    "## Current Spec",
    spec || "(no spec)",
  ];

  if (progress) parts.push("", "## Progress", progress);
  if (blockContext) parts.push("", "## Block Context", blockContext);
  if (prdContent) {
    const truncated = prdContent.length > 20000 ? prdContent.slice(0, 20000) + "\n[truncated]" : prdContent;
    parts.push("", "## PRD", truncated);
  }
  if (prompt) parts.push("", "## Revision Instructions", prompt);

  parts.push("", "## Output Format", `Return a single \`revised-task\` fenced block:

\`\`\`revised-task
{
  "title": "Updated title (or omit to keep current)",
  "spec": "Full revised spec content..."
}
\`\`\`

The spec should be complete (not a diff). Include all sections the task needs.`);

  return parts.join("\n");
}

function buildReviseTreePrompt(
  subtree: Task[],
  doneTasks: Task[],
  prdContent: string,
  prompt: string | undefined,
  cwd: string,
): string {
  const parts: string[] = [
    `Revise the following task subtree. Done tasks are context (preserve them), non-done tasks are revisable.`,
    "",
  ];

  for (const task of subtree) {
    const isDone = doneTasks.some(d => d.id === task.id);
    const spec = store.getTaskSpec(cwd, task.id) ?? "(no spec)";
    const deps = task.depends_on.length > 0 ? `\nDependencies: ${task.depends_on.join(", ")}` : "";
    parts.push(`### ${task.id}: ${task.title} [${isDone ? "DONE - context only" : "REVISABLE"}]${deps}\n${spec}\n`);
  }

  if (prdContent) {
    const truncated = prdContent.length > 20000 ? prdContent.slice(0, 20000) + "\n[truncated]" : prdContent;
    parts.push("## PRD", truncated, "");
  }
  if (prompt) parts.push("## Revision Instructions", prompt, "");

  parts.push(`## Output Format

Return a single \`tasks-json\` fenced block. Each task object must have:
- \`id\`: the existing task ID (e.g. "task-3") for existing tasks, or OMIT for new tasks
- \`title\`: task title
- \`spec\`: full revised spec content
- \`dependsOn\`: array of task IDs or titles this depends on

Existing tasks that you don't include will be left unchanged.
Do NOT include done tasks unless you need to reference them in dependencies.

\`\`\`tasks-json
[
  { "id": "task-3", "title": "...", "spec": "...", "dependsOn": [] },
  { "title": "New task", "spec": "...", "dependsOn": ["task-3"] }
]
\`\`\``);

  return parts.join("\n");
}

function parseRevisedTask(output: string): { title?: string; spec: string } | null {
  const match = output.match(/```revised-task\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.spec !== "string" || !parsed.spec.trim()) return null;
    return {
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined,
      spec: parsed.spec,
    };
  } catch {
    return null;
  }
}

interface RevisionEntry {
  id?: string;
  title?: string;
  spec: string;
  dependsOn?: string[];
}

function parseRevisionTaskBlock(output: string): RevisionEntry[] | null {
  const match = output.match(/```tasks-json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return null;
    const entries: RevisionEntry[] = [];
    for (const raw of parsed) {
      if (typeof raw.spec !== "string" || !raw.spec.trim()) continue;
      entries.push({
        id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined,
        title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined,
        spec: raw.spec,
        dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d: unknown) => typeof d === "string") : [],
      });
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}
