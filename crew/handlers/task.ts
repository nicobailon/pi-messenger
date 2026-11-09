/**
 * Crew - Task Handlers
 * 
 * Operations: create, split, show, list, start, done, block, unblock, ready, reset, progress, approve, reject
 * Simplified: tasks belong to the plan, not an epic
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MessengerState } from "../../lib.ts";
import type { CrewParams, Plan, Task, TaskEvidence } from "../types.ts";
import { result } from "../utils/result.ts";
import { loadCrewConfig } from "../utils/config.ts";
import * as store from "../store.ts";
import * as teamStore from "../team/store.ts";
import { logFeedEvent } from "../../feed.ts";
import { executeTaskAction } from "../task-actions.ts";
import { taskRevise, taskReviseTree } from "./revise.ts";
import { approvalTaskSummaries, taskMetadataMarkers } from "../utils/task-format.ts";
export { executeRevise, executeReviseTree, type ReviseResult } from "./revise.ts";

function revisionHint(task: Task): string {
  return `pi_messenger({ action: "task.revise", id: "${task.id}", prompt: "Address approval feedback" })`;
}

function rejectedTasksText(tasks: Task[]): string {
  if (tasks.length === 0) return "";
  return `\n\nRejected tasks need revision:\n${tasks.map(t => `  - ${t.id}: ${t.title}${t.approval?.feedback ? ` — ${t.approval.feedback}` : ""}\n    Revise with: \`${revisionHint(t)}\`\n    Or revise dependents too: \`pi_messenger({ action: "task.revise-tree", id: "${t.id}", prompt: "Address approval feedback" })\``).join("\n")}`;
}

export async function execute(
  op: string,
  params: CrewParams,
  state: MessengerState,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd;

  switch (op) {
    case "create":
      return taskCreate(cwd, params);
    case "split":
      return taskSplit(cwd, params, state);
    case "show":
      return taskShow(cwd, params);
    case "list":
      return taskList(cwd);
    case "start":
      return taskStart(cwd, params, state);
    case "done":
      return taskDone(cwd, params, state);
    case "block":
      return taskBlock(cwd, params, state);
    case "unblock":
      return taskUnblock(cwd, params, state);
    case "ready":
      return taskReady(cwd);
    case "reset":
      return taskReset(cwd, params, state);
    case "progress":
      return taskProgress(cwd, params, state);
    case "approve":
      return taskApproval(cwd, params, state, "approved");
    case "reject":
      return taskApproval(cwd, params, state, "rejected");
    case "revise":
      return taskRevise(cwd, params, state);
    case "revise-tree":
      return taskReviseTree(cwd, params, state);
    default:
      return result(`Unknown task operation: ${op}`, { mode: "task", error: "unknown_operation", operation: op });
  }
}

// =============================================================================
// task.create
// =============================================================================

function taskActionHint(task: Task): string {
  if (teamStore.taskNeedsRevision(task)) return `Revise first: \`${revisionHint(task)}\``;
  return teamStore.taskNeedsApproval(task)
    ? `Approve first: \`pi_messenger({ action: "task.approve", id: "${task.id}" })\``
    : `Start with: \`pi_messenger({ action: "task.start", id: "${task.id}" })\``;
}

function taskCreate(cwd: string, params: CrewParams) {
  if (!params.title) {
    return result("Error: title required for task.create", { mode: "task.create", error: "missing_title" });
  }

  // Verify plan exists
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result("Error: No plan exists. Create one first with pi_messenger({ action: \"plan\" })", { 
      mode: "task.create", error: "no_plan" 
    });
  }

  // Validate dependencies exist
  if (params.dependsOn && params.dependsOn.length > 0) {
    for (const depId of params.dependsOn) {
      const dep = store.getTask(cwd, depId);
      if (!dep) {
        return result(`Error: Dependency ${depId} not found`, { mode: "task.create", error: "dependency_not_found", dependency: depId });
      }
    }
  }

  const role = teamStore.canonicalRoleForTask(cwd, params.role);
  if (params.role?.trim() && teamStore.getActiveTeam(cwd) && !role) {
    return result(`Error: unknown Team role: ${params.role.trim()}`, { mode: "task.create", error: "invalid_role", role: params.role.trim() });
  }

  const riskLabels = teamStore.normalizeRiskLabels(params.riskLabels);
  const approval = params.approval ?? teamStore.approvalForTask(cwd, role, riskLabels);
  const task = store.createTask(cwd, params.title, params.content, params.dependsOn, {
    ...(role ? { role } : {}),
    ...(riskLabels && riskLabels.length > 0 ? { risk_labels: riskLabels } : {}),
    ...(approval ? { approval } : {}),
  });

  const depsText = task.depends_on.length > 0 
    ? `\n**Depends on:** ${task.depends_on.join(", ")}`
    : "";
  const teamText = `${task.role ? `\n**Role:** ${task.role}` : ""}${task.risk_labels?.length ? `\n**Risk labels:** ${task.risk_labels.join(", ")}` : ""}${task.approval?.required ? `\n**Approval:** ${task.approval.status}` : ""}`;

  const text = `✅ Created task **${task.id}**

**Title:** ${task.title}
**Status:** ${task.status}${depsText}${teamText}

${taskActionHint(task)}`;

  return result(text, {
    mode: "task.create",
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      depends_on: task.depends_on,
      role: task.role,
      risk_labels: task.risk_labels,
      approval: task.approval,
    }
  });
}

function taskSplit(cwd: string, params: CrewParams, state: MessengerState) {
  const { id, count, subtasks } = params;
  if (!id) {
    return result("Error: id required for task.split", { mode: "task.split", error: "missing_id" });
  }

  const task = store.getTask(cwd, id);
  if (!task) {
    return result(`Error: Task ${id} not found`, { mode: "task.split", error: "not_found", id });
  }

  if (task.status === "done") {
    return result(`Error: Cannot split completed task ${id}`, { mode: "task.split", error: "already_done", id });
  }

  if (task.milestone) {
    return result(`Error: Cannot split milestone task ${id}`, { mode: "task.split", error: "already_milestone", id });
  }

  if (!subtasks) {
    const spec = store.getTaskSpec(cwd, id);
    const progress = store.getTaskProgress(cwd, id);
    const suggestedCount = count ?? 2;
    const allTasks = store.getTasks(cwd);
    const dependents = allTasks.filter(t => t.depends_on.includes(id));
    const depsText = task.depends_on.length > 0 ? task.depends_on.join(", ") : "(none)";
    const dependentsText = dependents.length > 0
      ? `${dependents.map(t => t.id).join(", ")} (will be rewired to depend on all subtasks)`
      : "(none)";
    const specText = spec && spec.trim().length > 0 ? spec : "(no spec content)";
    const progressText = progress && progress.trim().length > 0 ? progress : "(no progress entries)";

    const text = `# Split Task ${task.id}: ${task.title}

**Status:** ${task.status}
**Dependencies:** ${depsText}
**Dependents:** ${dependentsText}
**Suggested count:** ${suggestedCount}

## Current Spec
${specText}

## Progress
${progressText}

---

To execute the split, call task.split again with subtask definitions:

pi_messenger({
  action: "task.split",
  id: "${task.id}",
  subtasks: [
    { title: "...", content: "..." },
    { title: "...", content: "..." },
    { title: "...", content: "..." }
  ]
})

Each subtask inherits this task's dependencies (${depsText}).
The parent becomes a milestone that auto-completes when all subtasks are done.`;

    return result(text, {
      mode: "task.split",
      phase: "inspect",
      task: { id: task.id, title: task.title, status: task.status, depends_on: task.depends_on },
      spec,
      progress,
      suggestedCount,
      dependents: dependents.map(t => t.id),
    });
  }

  if (subtasks.length < 2) {
    return result("Error: task.split requires at least 2 subtasks", { mode: "task.split", error: "insufficient_subtasks", id });
  }

  for (const sub of subtasks) {
    if (!sub.title || !sub.title.trim()) {
      return result("Error: each subtask requires a non-empty title", { mode: "task.split", error: "invalid_subtask_title", id });
    }
  }

  const created: Task[] = [];
  for (const sub of subtasks) {
    const approval: Task["approval"] = task.approval?.required
      ? { required: true, status: task.approval.status === "approved" ? "approved" : "pending" }
      : teamStore.approvalForTask(cwd, task.role, task.risk_labels);
    const newTask = store.createTask(cwd, sub.title, sub.content, [...task.depends_on], {
      ...(task.role ? { role: task.role } : {}),
      ...(task.risk_labels?.length ? { risk_labels: task.risk_labels } : {}),
      ...(approval ? { approval } : {}),
    });
    created.push(newTask);
  }

  const allTasks = store.getTasks(cwd);
  const subtaskIds = created.map(t => t.id);
  for (const t of allTasks) {
    if (t.id !== id && t.depends_on.includes(id) && !subtaskIds.includes(t.id)) {
      store.updateTask(cwd, t.id, {
        depends_on: [...t.depends_on.filter(d => d !== id), ...subtaskIds],
      });
    }
  }

  if (task.status === "blocked") {
    store.cleanupBlockFiles(cwd, id);
  }

  store.updateTask(cwd, id, {
    depends_on: subtaskIds,
    milestone: true,
    status: "todo",
    started_at: undefined,
    completed_at: undefined,
    base_commit: undefined,
    assigned_to: undefined,
    summary: undefined,
    evidence: undefined,
    blocked_reason: undefined,
    role: undefined,
    risk_labels: undefined,
    approval: undefined,
  });

  store.setTaskSpec(cwd, id, `# ${task.title}\n\nMilestone: completes when ${subtaskIds.join(", ")} are done.\n`);

  logFeedEvent(cwd, state.agentName || "unknown", "task.split", id,
    `Split into ${created.length} subtasks: ${subtaskIds.join(", ")}`);

  return result(`Split ${id} into ${created.length} subtasks`, {
    mode: "task.split",
    phase: "execute",
    parent: id,
    subtasks: created.map(t => ({ id: t.id, title: t.title })),
  });
}

// =============================================================================
// task.show
// =============================================================================

function taskShow(cwd: string, params: CrewParams) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.show", { mode: "task.show", error: "missing_id" });
  }

  const task = store.getTask(cwd, id);
  if (!task) {
    return result(`Error: Task ${id} not found`, { mode: "task.show", error: "not_found", id });
  }

  const spec = store.getTaskSpec(cwd, id);

  // Build status details
  let statusDetails = "";
  switch (task.status) {
    case "in_progress":
      statusDetails = `\n**Assigned to:** ${task.assigned_to ?? "unknown"}\n**Started:** ${task.started_at}`;
      if (task.base_commit) statusDetails += `\n**Base commit:** ${task.base_commit.slice(0, 8)}`;
      break;
    case "done":
      statusDetails = `\n**Completed:** ${task.completed_at}`;
      if (task.summary) statusDetails += `\n**Summary:** ${task.summary}`;
      break;
    case "blocked":
      statusDetails = `\n**Blocked reason:** ${task.blocked_reason ?? "unknown"}`;
      break;
  }

  const depsText = task.depends_on.length > 0 
    ? `\n**Depends on:** ${task.depends_on.join(", ")}`
    : "";

  // Spec preview
  let specPreview = "";
  if (spec && !spec.includes("*Spec pending*")) {
    const truncated = spec.length > 800 ? spec.slice(0, 800) + "..." : spec;
    specPreview = `\n\n## Spec\n\`\`\`\n${truncated}\n\`\`\``;
  }
  const progress = store.getTaskProgress(cwd, id);
  let progressSection = "";
  if (progress) {
    const lines = progress.trimEnd().split("\n");
    const recent = lines.length > 20 ? lines.slice(-20) : lines;
    const omitted = lines.length > 20 ? `(${lines.length - 20} earlier entries omitted)\n` : "";
    const preview = omitted + recent.join("\n");
    progressSection = `\n\n## Progress\n\`\`\`\n${preview}\n\`\`\``;
  }

  const statusIcon = {
    todo: "⬜",
    in_progress: "🔄",
    done: "✅",
    blocked: "🚫",
  }[task.status];

  const text = `# Task ${task.id}: ${task.title}

${statusIcon} **Status:** ${task.status}${statusDetails}
**Attempts:** ${task.attempt_count}${taskMetadataMarkers(task)}${depsText}${progressSection}${specPreview}`;

  return result(text, {
    mode: "task.show",
    task,
    hasSpec: spec && !spec.includes("*Spec pending*"),
  });
}

function taskProgress(cwd: string, params: CrewParams, state: MessengerState) {
  const { id, message } = params;
  if (!id) return result("Error: id required for task.progress", { mode: "task.progress", error: "missing_id" });
  if (!message) return result("Error: message required for task.progress", { mode: "task.progress", error: "missing_message" });

  const task = store.getTask(cwd, id);
  if (!task) return result(`Error: Task ${id} not found`, { mode: "task.progress", error: "not_found", id });

  store.appendTaskProgress(cwd, id, state.agentName || "unknown", message);
  return result(`Progress logged for ${id}`, { mode: "task.progress", id });
}

// =============================================================================
// task.list
// =============================================================================

// Days after which a fully-completed wave is considered stale (no active work).
const STALE_WAVE_DAYS = 14;
const SPECS_REF_RE = /specs\/(\d{8}-\d{6})-([a-z0-9-]+)/;

function isoDay(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function daysSince(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000);
}

// specs/ reference embedded in the plan's prd path or prompt, e.g. specs/20261013-124607-nessus-upload-into-execution/
function planSpecRef(plan: Plan): string | null {
  const match = SPECS_REF_RE.exec(`${plan.prd} ${plan.prompt ?? ""}`);
  return match ? `${match[0]}/` : null;
}

function waveAgeLine(plan: Plan): string {
  return `Wave: created ${isoDay(plan.created_at)}, updated ${isoDay(plan.updated_at)} (${daysSince(plan.updated_at)}d old)`;
}

function staleWaveLine(plan: Plan): string {
  return `⚠ STALE WAVE — completed ${isoDay(plan.updated_at)} (${daysSince(plan.updated_at)}d ago). No active crew wave. Authority for current work: the spec's tasks.md (e.g. specs/<id>/<slug>/tasks.md) and GitLab issues — task.list does not track them.`;
}

function isStaleWave(plan: Plan): boolean {
  return plan.task_count > 0
    && plan.completed_count === plan.task_count
    && daysSince(plan.updated_at) > STALE_WAVE_DAYS;
}

function taskList(cwd: string) {
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result(
      `No plan found. Create one with: pi_messenger({ action: "plan" })\nAuthority for current work: spec tasks.md / GitLab issues — no crew wave exists.`,
      { mode: "task.list", tasks: [], hasPlan: false },
    );
  }

  const tasks = store.getTasks(cwd);
  if (tasks.length === 0) {
    return result(`No tasks in plan. Create with: \`pi_messenger({ action: "task.create", title: "..." })\``, {
      mode: "task.list",
      tasks: [],
      prd: plan.prd,
    });
  }

  const lines: string[] = [];
  if (isStaleWave(plan)) {
    lines.push(staleWaveLine(plan), "");
  }

  lines.push(`# Tasks for ${store.getPlanLabel(plan)}\n`);
  lines.push(waveAgeLine(plan));
  const specRef = planSpecRef(plan);
  if (specRef) lines.push(`Spec: ${specRef}`);
  lines.push("");
  
  for (const task of tasks) {
    const icon = { todo: "⬜", in_progress: "🔄", done: "✅", blocked: "🚫" }[task.status];
    const deps = task.depends_on.length > 0 ? ` → deps: ${task.depends_on.join(", ")}` : "";
    const assignee = task.assigned_to ? ` [${task.assigned_to}]` : "";
    lines.push(`${icon} **${task.id}**: ${task.title}${taskMetadataMarkers(task)}${assignee}${deps}`);
  }

  const done = tasks.filter(t => t.status === "done").length;
  lines.push(`\n**Progress:** ${done}/${tasks.length}`);

  return result(lines.join("\n"), {
    mode: "task.list",
    prd: plan.prd,
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      depends_on: t.depends_on,
      role: t.role,
      risk_labels: t.risk_labels,
      approval: t.approval,
    })),
  });
}

// =============================================================================
// task.start
// =============================================================================

function taskStart(cwd: string, params: CrewParams, state: MessengerState) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.start", { mode: "task.start", error: "missing_id" });
  }

  const task = store.getTask(cwd, id);
  if (task && teamStore.taskNeedsApproval(task)) {
    const message = teamStore.taskNeedsRevision(task)
      ? `Error: Task ${id} was rejected and needs revision before it can be started.`
      : `Error: Task ${id} needs lead approval before it can be started.`;
    return result(message, {
      mode: "task.start",
      error: teamStore.taskNeedsRevision(task) ? "needs_revision" : "needs_approval",
      id,
      approval: task.approval,
    });
  }

  const agentName = state.agentName || "unknown";
  const actionResult = executeTaskAction(cwd, "start", id, agentName);
  if (!actionResult.success || !actionResult.task) {
    return result(`Error: ${actionResult.message}`, {
      mode: "task.start",
      error: actionResult.error ?? "start_failed",
      id,
      unmetDependencies: actionResult.unmetDependencies,
    });
  }

  const started = actionResult.task;
  const spec = store.getTaskSpec(cwd, id);
  const specPreview = spec && !spec.includes("*Spec pending*")
    ? `\n\n**Spec:**\n\`\`\`\n${spec.length > 1000 ? spec.slice(0, 1000) + "..." : spec}\n\`\`\``
    : "";

  const text = `🔄 Started task **${id}**

**Title:** ${started.title}
**Assigned to:** ${agentName}
**Attempt:** ${started.attempt_count}
${started.base_commit ? `**Base commit:** ${started.base_commit.slice(0, 8)}` : ""}${specPreview}

When done: \`pi_messenger({ action: "task.done", id: "${id}", summary: "..." })\`
If blocked: \`pi_messenger({ action: "task.block", id: "${id}", reason: "..." })\``;

  return result(text, {
    mode: "task.start",
    task: {
      id: started.id,
      title: started.title,
      status: started.status,
      assigned_to: started.assigned_to,
      attempt_count: started.attempt_count,
      base_commit: started.base_commit,
    }
  });
}

// =============================================================================
// task.done
// =============================================================================

function taskDone(cwd: string, params: CrewParams, state: MessengerState) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.done", { mode: "task.done", error: "missing_id" });
  }

  const task = store.getTask(cwd, id);
  if (!task) {
    return result(`Error: Task ${id} not found`, { mode: "task.done", error: "not_found", id });
  }

  if (task.status !== "in_progress") {
    return result(`Error: Task ${id} is ${task.status}, not in_progress`, {
      mode: "task.done", error: "invalid_status", id, status: task.status
    });
  }

  const summary = params.summary ?? "Task completed";
  const evidence: TaskEvidence | undefined = params.evidence;

  const completed = store.completeTask(cwd, id, summary, evidence);
  if (!completed) {
    return result(`Error: Failed to complete task ${id}`, { mode: "task.done", error: "complete_failed", id });
  }

  logFeedEvent(cwd, state.agentName || "unknown", "task.done", id, summary);

  const plan = store.getPlan(cwd);
  const tasks = store.getTasks(cwd);
  const remaining = tasks.filter(t => t.status !== "done");

  let nextSteps = "";
  if (remaining.length === 0) {
    nextSteps = `\n\n🎉 **All tasks complete!** Plan is finished.`;
  } else {
    const config = loadCrewConfig(store.getCrewDir(cwd));
    const ready = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
    const actionable = ready.filter(t => !teamStore.taskNeedsApproval(t));
    const rejected = ready.filter(teamStore.taskNeedsRevision);
    const needsApproval = ready.filter(t => teamStore.taskPendingApproval(t));
    if (actionable.length > 0) {
      nextSteps = `\n\n**Ready tasks:** ${actionable.map(t => t.id).join(", ")}`;
    }
    if (needsApproval.length > 0) {
      nextSteps += `\n\n**Needs approval:** ${needsApproval.map(t => t.id).join(", ")}`;
    }
    nextSteps += rejectedTasksText(rejected);
  }

  const text = `✅ Completed task **${id}**

**Summary:** ${summary}
**Progress:** ${plan?.completed_count}/${plan?.task_count}${nextSteps}`;

  return result(text, {
    mode: "task.done",
    task: {
      id: completed.id,
      title: completed.title,
      status: completed.status,
      summary: completed.summary,
    },
    progress: {
      completed: plan?.completed_count ?? 0,
      total: plan?.task_count ?? 0,
    }
  });
}

// =============================================================================
// task.block
// =============================================================================

function taskBlock(cwd: string, params: CrewParams, state: MessengerState) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.block", { mode: "task.block", error: "missing_id" });
  }

  if (!params.reason) {
    return result("Error: reason required for task.block", { mode: "task.block", error: "missing_reason" });
  }

  const actionResult = executeTaskAction(cwd, "block", id, state.agentName || "unknown", params.reason);
  if (!actionResult.success || !actionResult.task) {
    return result(`Error: ${actionResult.message}`, {
      mode: "task.block",
      error: actionResult.error ?? "block_failed",
      id,
    });
  }

  const blocked = actionResult.task;
  const text = `🚫 Blocked task **${id}**

**Reason:** ${params.reason}

Unblock with: \`pi_messenger({ action: "task.unblock", id: "${id}" })\``;

  return result(text, {
    mode: "task.block",
    task: {
      id: blocked.id,
      title: blocked.title,
      status: blocked.status,
      blocked_reason: blocked.blocked_reason,
    }
  });
}

// =============================================================================
// task.unblock
// =============================================================================

function taskUnblock(cwd: string, params: CrewParams, state: MessengerState) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.unblock", { mode: "task.unblock", error: "missing_id" });
  }

  const actionResult = executeTaskAction(cwd, "unblock", id, state.agentName || "unknown");
  if (!actionResult.success || !actionResult.task) {
    return result(`Error: ${actionResult.message}`, {
      mode: "task.unblock",
      error: actionResult.error ?? "unblock_failed",
      id,
    });
  }

  const unblocked = actionResult.task;
  const text = `⬜ Unblocked task **${id}**\n\n${taskActionHint(unblocked)}`;

  return result(text, {
    mode: "task.unblock",
    task: {
      id: unblocked.id,
      title: unblocked.title,
      status: unblocked.status,
    }
  });
}

// =============================================================================
// task.ready
// =============================================================================

function taskReady(cwd: string) {
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result("No plan found. Create one with: pi_messenger({ action: \"plan\" })", { 
      mode: "task.ready", ready: [], hasPlan: false 
    });
  }

  const config = loadCrewConfig(store.getCrewDir(cwd));
  const allReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
  const ready: typeof allReady = [];
  const needsApproval: typeof allReady = [];
  const rejected: typeof allReady = [];
  for (const task of allReady) {
    if (teamStore.taskNeedsRevision(task)) rejected.push(task);
    else if (teamStore.taskPendingApproval(task)) needsApproval.push(task);
    else ready.push(task);
  }

  if (ready.length === 0) {
    const tasks = store.getTasks(cwd);
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const blocked = tasks.filter(t => t.status === "blocked");
    const done = tasks.filter(t => t.status === "done");

    let reason = "";
    if (done.length === tasks.length) {
      reason = "All tasks are done!";
    } else if (inProgress.length > 0) {
      reason = `${inProgress.length} task(s) in progress: ${inProgress.map(t => t.id).join(", ")}`;
    } else if (rejected.length > 0) {
      reason = "No startable tasks; rejected tasks need revision.";
    } else if (needsApproval.length > 0) {
      reason = "No startable tasks; ready tasks need lead approval.";
    } else if (blocked.length > 0) {
      reason = `${blocked.length} task(s) blocked: ${blocked.map(t => t.id).join(", ")}`;
    } else {
      reason = "All remaining tasks have unmet dependencies.";
    }

    const approvalText = needsApproval.length > 0
      ? `\n\nNeeds approval:\n${needsApproval.map(t => `  - ${t.id}: ${t.title}`).join("\n")}`
      : "";
    const revisionText = rejectedTasksText(rejected);
    return result(`No ready tasks.\n\n${reason}${approvalText}${revisionText}`, {
      mode: "task.ready",
      ready: [],
      needsApproval: approvalTaskSummaries(needsApproval),
      rejected: approvalTaskSummaries(rejected),
      reason,
    });
  }

  const lines: string[] = [`# Ready Tasks\n`];
  for (const task of ready) {
    lines.push(`⬜ **${task.id}**: ${task.title}`);
  }
  lines.push(`\nStart one: \`pi_messenger({ action: "task.start", id: "${ready[0].id}" })\``);
  lines.push(`Or run all: \`pi_messenger({ action: "work" })\``);

  if (needsApproval.length > 0) {
    lines.push(`\nNeeds approval:\n${needsApproval.map(t => `  - ${t.id}: ${t.title}`).join("\n")}`);
  }
  const revisionText = rejectedTasksText(rejected);
  if (revisionText) lines.push(revisionText);

  return result(lines.join("\n"), {
    mode: "task.ready",
    ready: ready.map(t => ({
      id: t.id,
      title: t.title,
    })),
    needsApproval: approvalTaskSummaries(needsApproval),
    rejected: approvalTaskSummaries(rejected),
  });
}

// =============================================================================
// task.approve / task.reject
// =============================================================================

function taskApproval(cwd: string, params: CrewParams, state: MessengerState, status: "approved" | "rejected") {
  const id = params.id;
  const action = status === "approved" ? "approve" : "reject";
  const mode = `task.${action}`;
  const actor = state.agentName || "unknown";

  if (!id) {
    return result(`Error: id required for ${mode}`, { mode, error: "missing_id" });
  }

  const task = store.getTask(cwd, id);
  if (!task) {
    return result(`Error: Task ${id} not found`, { mode, error: "not_found", id });
  }
  if (!task.approval?.required) {
    return result(`Task ${id} does not require approval.`, { mode, error: "approval_not_required", id });
  }
  if (task.status === "in_progress" || task.status === "done") {
    return result(`Error: Task ${id} is ${task.status}; approval can only change before work starts.`, {
      mode,
      error: "invalid_status",
      id,
      status: task.status,
    });
  }

  const approval = {
    ...task.approval,
    status,
    feedback: params.reason,
    decided_by: actor,
    decided_at: new Date().toISOString(),
  };
  const updated = store.updateTask(cwd, id, { approval });
  logFeedEvent(cwd, actor, status === "approved" ? "task.approve" : "task.reject", id, params.reason);

  const nextStep = status === "rejected"
    ? `\n\nNext: revise with \`${revisionHint(task)}\`, or use \`pi_messenger({ action: "task.revise-tree", id: "${id}", prompt: "Address approval feedback" })\` if dependents need updates too.`
    : "";

  return result(`${status === "approved" ? "Approved" : "Rejected"} task **${id}**.${nextStep}`, {
    mode,
    task: updated ? { id: updated.id, title: updated.title, approval: updated.approval } : undefined,
  });
}

// =============================================================================
// task.reset
// =============================================================================

function taskReset(cwd: string, params: CrewParams, state: MessengerState) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.reset", { mode: "task.reset", error: "missing_id" });
  }

  const cascade = params.cascade ?? false;
  const action = cascade ? "cascade-reset" : "reset";
  const actionResult = executeTaskAction(cwd, action, id, state.agentName || "unknown");
  if (!actionResult.success) {
    return result(`Error: ${actionResult.message}`, {
      mode: "task.reset",
      error: actionResult.error ?? "reset_failed",
      id,
    });
  }

  const resetTasks = actionResult.resetTasks ?? [];
  const text = cascade && resetTasks.length > 1
    ? `🔄 Reset ${resetTasks.length} tasks:\n${resetTasks.map(t => `  - ${t.id}`).join("\n")}`
    : `🔄 Reset task **${id}**`;

  const resetTask = store.getTask(cwd, id);
  const hint = resetTask ? taskActionHint(resetTask) : `Start with: \`pi_messenger({ action: "task.start", id: "${id}" })\``;

  return result(`${text}\n\n${hint}`, {
    mode: "task.reset",
    reset: resetTasks.map(t => t.id),
    cascade,
  });
}
