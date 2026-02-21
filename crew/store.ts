/**
 * Crew - Store Operations
 * 
 * Simplified PRD-based storage: plan.json + tasks/*.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Plan, Task, TaskEvidence } from "./types.js";
import { allocateTaskId } from "./id-allocator.js";

// =============================================================================
// Directory Helpers
// =============================================================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getCrewDir(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "crew");
}

function getTasksDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "tasks");
}

function getBlocksDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "blocks");
}

export function cleanupBlockFiles(cwd: string, taskId: string): void {
  try { fs.unlinkSync(path.join(getBlocksDir(cwd), `${taskId}.md`)); } catch {}
}

// =============================================================================
// JSON Helpers
// =============================================================================

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, filePath);
}

function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, filePath);
}

// =============================================================================
// Plan Operations
// =============================================================================

export function getPlan(cwd: string): Plan | null {
  return readJson<Plan>(path.join(getCrewDir(cwd), "plan.json"));
}

export function createPlan(cwd: string, prdPath: string, prompt?: string): Plan {
  const now = new Date().toISOString();
  
  const plan: Plan = {
    prd: prdPath,
    ...(prompt ? { prompt } : {}),
    created_at: now,
    updated_at: now,
    task_count: 0,
    completed_count: 0,
  };

  writeJson(path.join(getCrewDir(cwd), "plan.json"), plan);
  return plan;
}

export function getPlanLabel(plan: Plan, maxLen = 60): string {
  if (!plan.prompt) return plan.prd;
  return plan.prompt.length > maxLen
    ? plan.prompt.slice(0, maxLen - 3) + "..."
    : plan.prompt;
}

export function updatePlan(cwd: string, updates: Partial<Plan>): Plan | null {
  const plan = getPlan(cwd);
  if (!plan) return null;

  const updated: Plan = {
    ...plan,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  writeJson(path.join(getCrewDir(cwd), "plan.json"), updated);
  return updated;
}

export function deletePlan(cwd: string): boolean {
  const planPath = path.join(getCrewDir(cwd), "plan.json");
  const planMdPath = path.join(getCrewDir(cwd), "plan.md");
  const tasksDir = getTasksDir(cwd);
  
  let deleted = false;
  
  // Delete plan.json
  if (fs.existsSync(planPath)) {
    fs.unlinkSync(planPath);
    deleted = true;
  }
  
  // Delete plan.md
  if (fs.existsSync(planMdPath)) {
    fs.unlinkSync(planMdPath);
  }
  
  // Delete all task files
  if (fs.existsSync(tasksDir)) {
    for (const file of fs.readdirSync(tasksDir)) {
      fs.unlinkSync(path.join(tasksDir, file));
    }
  }

  // Delete all block files
  const blocksDir = getBlocksDir(cwd);
  if (fs.existsSync(blocksDir)) {
    for (const file of fs.readdirSync(blocksDir)) {
      fs.unlinkSync(path.join(blocksDir, file));
    }
  }
  
  return deleted;
}

// =============================================================================
// Plan Spec Operations
// =============================================================================

export function getPlanSpec(cwd: string): string | null {
  return readText(path.join(getCrewDir(cwd), "plan.md"));
}

export function setPlanSpec(cwd: string, content: string): void {
  writeText(path.join(getCrewDir(cwd), "plan.md"), content);
  updatePlan(cwd, {}); // Touch updated_at
}

// =============================================================================
// Task Operations
// =============================================================================

export function createTask(
  cwd: string,
  title: string,
  description?: string,
  dependsOn?: string[]
): Task {
  const id = allocateTaskId(cwd);
  const now = new Date().toISOString();

  const task: Task = {
    id,
    title,
    status: "todo",
    depends_on: dependsOn ?? [],
    created_at: now,
    updated_at: now,
    attempt_count: 0,
  };

  writeJson(path.join(getTasksDir(cwd), `${id}.json`), task);

  // Create task spec file
  const specContent = description
    ? `# ${title}\n\n${description}\n`
    : `# ${title}\n\n*Spec pending*\n`;
  writeText(path.join(getTasksDir(cwd), `${id}.md`), specContent);

  // Update plan task count
  const plan = getPlan(cwd);
  if (plan) {
    updatePlan(cwd, { task_count: plan.task_count + 1 });
  }

  return task;
}

function normalizeTask(raw: Task): Task {
  return {
    ...raw,
    depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : [],
    attempt_count: typeof raw.attempt_count === "number" ? raw.attempt_count : 0,
  };
}

export function getTask(cwd: string, taskId: string): Task | null {
  const raw = readJson<Task>(path.join(getTasksDir(cwd), `${taskId}.json`));
  return raw ? normalizeTask(raw) : null;
}

export function updateTask(cwd: string, taskId: string, updates: Partial<Task>): Task | null {
  const task = getTask(cwd, taskId);
  if (!task) return null;

  const updated: Task = {
    ...task,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  writeJson(path.join(getTasksDir(cwd), `${taskId}.json`), updated);
  return updated;
}

export function getTasks(cwd: string): Task[] {
  const dir = getTasksDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const tasks: Task[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = readJson<Task>(path.join(dir, file));
    if (raw) tasks.push(normalizeTask(raw));
  }

  // Sort by ID number (task-1, task-2, ...)
  return tasks.sort((a, b) => {
    const aNum = parseInt(a.id.replace("task-", ""));
    const bNum = parseInt(b.id.replace("task-", ""));
    return aNum - bNum;
  });
}

export function getTaskSpec(cwd: string, taskId: string): string | null {
  return readText(path.join(getTasksDir(cwd), `${taskId}.md`));
}

export function appendTaskProgress(cwd: string, taskId: string, agent: string, message: string): void {
  const progressPath = path.join(getTasksDir(cwd), `${taskId}.progress.md`);
  ensureDir(path.dirname(progressPath));
  const timestamp = new Date().toISOString();
  fs.appendFileSync(progressPath, `[${timestamp}] (${agent}) ${message}\n`);
}

export function getTaskProgress(cwd: string, taskId: string): string | null {
  const content = readText(path.join(getTasksDir(cwd), `${taskId}.progress.md`));
  return content && content.trim().length > 0 ? content : null;
}

export function getBlockContext(cwd: string, taskId: string): string | null {
  return readText(path.join(getBlocksDir(cwd), `${taskId}.md`));
}

export function setTaskSpec(cwd: string, taskId: string, content: string): void {
  writeText(path.join(getTasksDir(cwd), `${taskId}.md`), content);
  updateTask(cwd, taskId, {}); // Touch updated_at
}

export function deleteTask(cwd: string, taskId: string): boolean {
  const task = getTask(cwd, taskId);
  if (!task) return false;

  const tasksDir = getTasksDir(cwd);
  for (const ext of [".json", ".md", ".progress.md"]) {
    try { fs.unlinkSync(path.join(tasksDir, `${taskId}${ext}`)); } catch {}
  }

  try { fs.unlinkSync(path.join(getBlocksDir(cwd), `${taskId}.md`)); } catch {}

  const allTasks = getTasks(cwd);
  for (const t of allTasks) {
    if (t.depends_on.includes(taskId)) {
      updateTask(cwd, t.id, {
        depends_on: t.depends_on.filter(d => d !== taskId),
      });
    }
  }

  const plan = getPlan(cwd);
  if (plan) {
    const updates: Partial<Plan> = { task_count: plan.task_count - 1 };
    if (task.status === "done") {
      updates.completed_count = plan.completed_count - 1;
    }
    updatePlan(cwd, updates);
  }

  return true;
}

// =============================================================================
// Task Lifecycle Operations
// =============================================================================

export function getBaseCommit(cwd: string): string | undefined {
  try {
    return execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
}

export function startTask(cwd: string, taskId: string, agentName: string): Task | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "todo") return null;

  return updateTask(cwd, taskId, {
    status: "in_progress",
    started_at: new Date().toISOString(),
    base_commit: getBaseCommit(cwd),
    assigned_to: agentName,
    attempt_count: task.attempt_count + 1,
  });
}

export function completeTask(
  cwd: string,
  taskId: string,
  summary: string,
  evidence?: TaskEvidence
): Task | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "in_progress") return null;

  const updated = updateTask(cwd, taskId, {
    status: "done",
    completed_at: new Date().toISOString(),
    summary,
    evidence,
    assigned_to: undefined,
  });

  // Update plan completed count
  if (updated) {
    const plan = getPlan(cwd);
    if (plan) {
      updatePlan(cwd, { completed_count: plan.completed_count + 1 });
    }
  }

  autoCompleteMilestones(cwd);

  return updated;
}

export function blockTask(cwd: string, taskId: string, reason: string): Task | null {
  const task = getTask(cwd, taskId);
  if (!task) return null;

  // Write block context to blocks directory
  const blockPath = path.join(getBlocksDir(cwd), `${taskId}.md`);
  writeText(blockPath, `# Blocked: ${task.title}\n\n**Reason:** ${reason}\n\n**Blocked at:** ${new Date().toISOString()}\n`);

  return updateTask(cwd, taskId, {
    status: "blocked",
    blocked_reason: reason,
    assigned_to: undefined,
  });
}

export function unblockTask(cwd: string, taskId: string): Task | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "blocked") return null;

  cleanupBlockFiles(cwd, taskId);

  return updateTask(cwd, taskId, {
    status: "todo",
    blocked_reason: undefined,
  });
}

export function resetTask(cwd: string, taskId: string, cascade: boolean = false): Task[] {
  const task = getTask(cwd, taskId);
  if (!task) return [];

  const resetTasks: Task[] = [];
  const wasDone = task.status === "done";

  // Reset this task
  const updated = updateTask(cwd, taskId, {
    status: "todo",
    started_at: undefined,
    completed_at: undefined,
    base_commit: undefined,
    assigned_to: undefined,
    summary: undefined,
    evidence: undefined,
    blocked_reason: undefined,
    // Keep attempt_count for tracking
  });
  if (updated) resetTasks.push(updated);

  cleanupBlockFiles(cwd, taskId);

  // If cascade, reset all tasks that depend on this one
  if (cascade) {
    const allTasks = getTasks(cwd);
    for (const t of allTasks) {
      if (t.depends_on.includes(taskId) && t.status !== "todo") {
        const cascaded = resetTask(cwd, t.id, true);
        resetTasks.push(...cascaded);
      }
    }
  }

  // Update plan completed count if needed
  if (wasDone && resetTasks.length > 0) {
    const plan = getPlan(cwd);
    if (plan) {
      const doneTasks = getTasks(cwd).filter(t => t.status === "done");
      updatePlan(cwd, { completed_count: doneTasks.length });
    }
  }

  return resetTasks;
}

// =============================================================================
// Ready Tasks (Dependency Resolution)
// =============================================================================

export function getReadyTasks(cwd: string, options?: { advisory?: boolean }): Task[] {
  const tasks = getTasks(cwd);
  if (options?.advisory) {
    return tasks.filter(t => t.status === "todo" && !t.milestone);
  }
  const doneIds = new Set(tasks.filter(t => t.status === "done").map(t => t.id));

  return tasks.filter(task => {
    // Must be in "todo" status
    if (task.status !== "todo") return false;
    if (task.milestone) return false;

    // All dependencies must be done
    return task.depends_on.every(depId => doneIds.has(depId));
  });
}

export function autoCompleteMilestones(cwd: string): void {
  let changed = true;
  while (changed) {
    changed = false;
    const tasks = getTasks(cwd);
    for (const task of tasks) {
      if (!task.milestone || task.status !== "todo") continue;
      const allDepsDone = task.depends_on.every(depId => {
        const dep = getTask(cwd, depId);
        return dep?.status === "done";
      });
      if (allDepsDone) {
        updateTask(cwd, task.id, {
          status: "done",
          completed_at: new Date().toISOString(),
          summary: "All subtasks completed",
        });
        const doneCount = getTasks(cwd).filter(t => t.status === "done").length;
        const plan = getPlan(cwd);
        if (plan) updatePlan(cwd, { completed_count: doneCount });
        changed = true;
      }
    }
  }
}

// =============================================================================
// Validation
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePlan(cwd: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const plan = getPlan(cwd);
  if (!plan) {
    return { valid: false, errors: ["No plan found"], warnings: [] };
  }

  const tasks = getTasks(cwd);

  // Check for orphan dependencies
  const taskIds = new Set(tasks.map(t => t.id));
  for (const task of tasks) {
    for (const depId of task.depends_on) {
      if (!taskIds.has(depId)) {
        errors.push(`Task ${task.id} depends on non-existent task ${depId}`);
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(taskId: string): boolean {
    if (recursionStack.has(taskId)) return true;
    if (visited.has(taskId)) return false;

    visited.add(taskId);
    recursionStack.add(taskId);

    const task = tasks.find(t => t.id === taskId);
    if (task) {
      for (const depId of task.depends_on) {
        if (hasCycle(depId)) return true;
      }
    }

    recursionStack.delete(taskId);
    return false;
  }

  for (const task of tasks) {
    visited.clear();
    recursionStack.clear();
    if (hasCycle(task.id)) {
      errors.push(`Circular dependency detected involving task ${task.id}`);
    }
  }

  // Check for tasks without specs
  for (const task of tasks) {
    const spec = getTaskSpec(cwd, task.id);
    if (!spec || spec.includes("*Spec pending*")) {
      warnings.push(`Task ${task.id} has no detailed spec`);
    }
  }

  // Check plan spec
  const planSpec = getPlanSpec(cwd);
  if (!planSpec || planSpec.includes("*Spec pending*")) {
    warnings.push("Plan has no detailed spec");
  }

  // Check task counts
  if (plan.task_count !== tasks.length) {
    warnings.push(`Plan task_count (${plan.task_count}) doesn't match actual tasks (${tasks.length})`);
  }

  const actualDone = tasks.filter(t => t.status === "done").length;
  if (plan.completed_count !== actualDone) {
    warnings.push(`Plan completed_count (${plan.completed_count}) doesn't match actual (${actualDone})`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// =============================================================================
// Dependency Graph
// =============================================================================

export function getTransitiveDependents(cwd: string, targetId: string): Task[] {
  const tasks = getTasks(cwd);
  const collected = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const task of tasks) {
      if (collected.has(task.id) || task.id === targetId) continue;
      if (task.depends_on.includes(current)) {
        collected.add(task.id);
        queue.push(task.id);
      }
    }
  }

  return tasks.filter(t => collected.has(t.id));
}

// =============================================================================
// Plan Existence Check
// =============================================================================

export function hasPlan(cwd: string): boolean {
  return getPlan(cwd) !== null;
}
