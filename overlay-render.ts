import * as fs from "node:fs";
import * as path from "node:path";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  formatDuration,
  formatRelativeTime,
  buildSelfRegistration,
  coloredAgentName,
  computeStatus,
  STATUS_INDICATORS,
  agentHasTask,
  estimateCost,
  formatCost,
  renderProgressBar,
  getSpinnerFrame,
  getToolIcon,
  renderSparkline,
  renderFileTree,
  renderAgentPipeline,
  renderDiffStatsBar,
  type Dirs,
  type MessengerState,
} from "./lib.js";
import * as store from "./store.js";
import * as crewStore from "./crew/store.js";
import {
  autonomousState,
  getPlanningUpdateAgeMs,
  isAutonomousForCwd,
  isPlanningForCwd,
  isPlanningStalled,
  planningState,
  PLANNING_STALE_TIMEOUT_MS,
} from "./crew/state.js";
import type { Task } from "./crew/types.js";
import { getLiveWorkers, type LiveWorkerInfo } from "./crew/live-progress.js";
import type { ToolEntry } from "./crew/utils/progress.js";
import { formatFeedLine as sharedFormatFeedLine, type FeedEvent } from "./feed.js";
import { discoverCrewAgents } from "./crew/utils/discover.js";
import { loadConfig } from "./config.js";
import { loadCrewConfig } from "./crew/utils/config.js";
import { listCheckpoints, getCheckpointDiff } from "./crew/utils/checkpoint.js";
import { getLobbyWorkerCount } from "./crew/lobby.js";
import type { CrewViewState } from "./overlay-actions.js";
import type { MonitorRegistry } from "./src/monitor/registry.js";
import { renderGroupedSessions } from "./src/monitor/ui/render.js";
import { renderSessionDetailView } from "./src/monitor/ui/session-detail.js";
import { deriveAttentionItems } from "./src/monitor/attention/derivation.js";
import type { AttentionItem } from "./src/monitor/types/attention.js";
import type { HealthStatus } from "./src/monitor/health/types.js";


const STATUS_ICONS: Record<string, string> = { done: "✓", in_progress: "●", todo: "○", blocked: "✗" };

function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

function renderActivityLog(
  tools: ToolEntry[],
  currentTool: string | undefined,
  currentToolArgs: string | undefined,
  startedAt: number,
  width: number,
  thinkingStartMs?: number,
): string[] {
  const lines: string[] = [];
  for (const entry of tools) {
    const elapsed = formatElapsed(entry.startMs - startedAt);
    const icon = getToolIcon(entry.tool);
    const args = entry.args ? ` ${entry.args}` : "";
    lines.push(truncateToWidth(`  [${elapsed}] ${icon} ${entry.tool}${args}`, width));
  }
  if (currentTool) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    const icon = getToolIcon(currentTool);
    const args = currentToolArgs ? ` ${currentToolArgs}` : "";
    lines.push(truncateToWidth(`  → [${elapsed}] ${icon} ${currentTool}${args}`, width));
  } else {
    const spinner = getSpinnerFrame();
    const thinkingDuration = thinkingStartMs
      ? ` (${formatElapsed(Date.now() - thinkingStartMs)})`
      : "";
    lines.push(`  ${spinner} thinking${thinkingDuration}...`);
  }
  return lines;
}

function hasLiveWorker(cwd: string, taskId: string): boolean {
  return getLiveWorkers(cwd).has(taskId);
}

function readPlanningTail(cwd: string, maxLines: number): string[] {
  const progressPath = path.join(crewStore.getCrewDir(cwd), "planning-progress.md");
  if (!fs.existsSync(progressPath)) return [];
  try {
    const lines = fs.readFileSync(progressPath, "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function appendUniversalHints(text: string): string {
  return `${text}  [^T] [^B]`;
}

function idleLabel(timestamp: string | undefined): string {
  if (!timestamp) return "idle";
  const ageMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
  if (!Number.isFinite(ageMs) || ageMs < 30_000) return "active";
  return `idle ${formatDuration(ageMs)}`;
}

export function renderStatusBar(theme: Theme, cwd: string, width: number): string {
  const plan = crewStore.getPlan(cwd);
  const autonomousActive = isAutonomousForCwd(cwd);
  const crewDir = crewStore.getCrewDir(cwd);
  const crewConfig = loadCrewConfig(crewDir);

  if (isPlanningForCwd(cwd)) {
    const updated = planningState.updatedAt ? formatRelativeTime(planningState.updatedAt) : "unknown";
    const stalled = isPlanningStalled(cwd);
    const label = stalled ? "Planning stalled" : "Planning";
    const lobbyCount = getLobbyWorkerCount(cwd);
    const workerNote = lobbyCount > 0 ? ` │ ${lobbyCount} in lobby` : "";
    const coordLevel = crewConfig.coordination;
    return truncateToWidth(`${label} ${planningState.pass}/${planningState.maxPasses} │ ${planningState.phase} │ ${updated}${workerNote} │ ${crewConfig.dependencies} │ ${coordLevel}`, width);
  }

  if (!plan) {
    const liveCount = getLiveWorkers(cwd).size;
    return truncateToWidth(`No active plan │ ⚙ ${liveCount}/${autonomousState.concurrency} workers`, width);
  }

  const ready = crewStore.getReadyTasks(cwd, { advisory: crewConfig.dependencies === "advisory" });
  const progressBar = renderProgressBar(plan.completed_count, plan.task_count, 12);
  const planLabel = crewStore.getPlanLabel(plan, 30);
  let base = `📋 ${planLabel}: ${progressBar}`;
  if (ready.length > 0) {
    const readyLabel = crewConfig.dependencies === "advisory" ? "available" : "ready";
    base += ` │ ${ready.length} ${readyLabel}`;
  }
  const liveCount = getLiveWorkers(cwd).size;
  base += ` │ ⚙ ${liveCount}/${autonomousState.concurrency} workers`;
  const coordLevel = crewConfig.coordination;
  base += ` │ ${crewConfig.dependencies} │ ${coordLevel}`;

  if (!autonomousActive) {
    return truncateToWidth(base, width);
  }

  const parts = ["● AUTO", `W${autonomousState.waveNumber}`];
  if (autonomousState.startedAt) {
    const elapsedMs = Date.now() - new Date(autonomousState.startedAt).getTime();
    const mm = Math.floor(elapsedMs / 60000).toString();
    const ss = Math.floor((elapsedMs % 60000) / 1000).toString().padStart(2, "0");
    parts.push(`⏱ ${mm}:${ss}`);
  }
  return truncateToWidth(`${base} │ ${theme.fg("accent", parts.join(" "))}`, width);
}

export function renderWorkersSection(theme: Theme, cwd: string, width: number, maxLines: number): string[] {
  if (maxLines <= 0) return [];

  const workers = Array.from(getLiveWorkers(cwd).values()).slice(0, maxLines);
  if (workers.length === 0) return [];

  const lines: string[] = [];
  for (const info of workers) {
    const toolIcon = info.progress.currentTool ? getToolIcon(info.progress.currentTool) : getSpinnerFrame();
    const activity = info.progress.currentTool
      ? `${toolIcon} ${info.progress.currentTool}${info.progress.currentToolArgs ? `(${info.progress.currentToolArgs})` : ""}`
      : `${toolIcon} thinking`;
    const elapsed = formatDuration(Date.now() - info.startedAt);
    const tokens = info.progress.tokens > 1000
      ? `${(info.progress.tokens / 1000).toFixed(0)}k`
      : `${info.progress.tokens}`;
    
    // Cost estimation
    const cost = estimateCost(info.progress.tokens, info.progress.model);
    const costStr = formatCost(cost);
    const costDisplay = costStr ? ` ${costStr}` : "";
    
    // Model badge
    const modelBadge = info.progress.model
      ? theme.fg("dim", `[${info.progress.model.replace(/^.*\//, "").slice(0, 16)}]`)
      : "";
    
    // Sparkline for activity density
    const sparkline = info.progress.toolCallBuckets.length > 2
      ? " " + theme.fg("dim", renderSparkline(info.progress.toolCallBuckets, 8))
      : "";

    // Agent pipeline mini-visualization
    const pipelinePhase = info.progress.currentTool
      ? (info.progress.toolCallCount > 0 ? "tools" : "first-tool")
      : (info.progress.tokens > 0 ? "thinking" : "starting");
    const pipelineSteps = [
      { label: "Think", status: (pipelinePhase === "thinking" ? "active" : pipelinePhase === "starting" ? "active" : "done") as "done" | "active" | "pending" },
      { label: "Tools", status: (pipelinePhase === "tools" || pipelinePhase === "first-tool" ? "active" : pipelinePhase === "thinking" && info.progress.toolCallCount > 0 ? "done" : "pending") as "done" | "active" | "pending" },
    ];
    const pipeline = renderAgentPipeline(pipelineSteps);

    const line = `⚡ ${info.name} ${formatTaskLabel(info.taskId)}  ${pipeline}  ${activity}  ${theme.fg("dim", `${elapsed}  ${tokens} tok${costDisplay}`)}${sparkline} ${modelBadge}`;
    lines.push(truncateToWidth(line, width));
  }
  return lines;
}

export function renderTaskList(theme: Theme, cwd: string, width: number, height: number, viewState: CrewViewState): string[] {
  const tasks = crewStore.getTasks(cwd);
  const lines: string[] = [];

  if (tasks.length === 0) {
    lines.push(theme.fg("dim", "(no tasks yet)"));
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  viewState.selectedTaskIndex = Math.max(0, Math.min(viewState.selectedTaskIndex, tasks.length - 1));

  for (let i = 0; i < tasks.length; i++) {
    lines.push(renderTaskLine(theme, tasks[i], i === viewState.selectedTaskIndex, width, getLiveWorkers(cwd).get(tasks[i].id)));
  }

  if (lines.length <= height) {
    viewState.scrollOffset = 0;
    return lines;
  }

  const selectedLine = Math.min(viewState.selectedTaskIndex, lines.length - 1);
  if (selectedLine < viewState.scrollOffset) {
    viewState.scrollOffset = selectedLine;
  } else if (selectedLine >= viewState.scrollOffset + height) {
    viewState.scrollOffset = selectedLine - height + 1;
  }

  viewState.scrollOffset = Math.max(0, Math.min(viewState.scrollOffset, lines.length - height));
  return lines.slice(viewState.scrollOffset, viewState.scrollOffset + height);
}

export function renderTaskSummary(theme: Theme, cwd: string, width: number, height: number): string[] {
  const tasks = crewStore.getTasks(cwd);
  const counts: Record<string, number> = { done: 0, in_progress: 0, blocked: 0, todo: 0 };
  const activeNames: string[] = [];
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
    if (t.status === "in_progress" && t.assigned_to) activeNames.push(t.assigned_to);
  }
  const parts: string[] = [];
  if (counts.done > 0) parts.push(theme.fg("accent", `${counts.done} done`));
  if (counts.in_progress > 0) parts.push(theme.fg("warning", `${counts.in_progress} active`));
  if (counts.blocked > 0) parts.push(theme.fg("error", `${counts.blocked} blocked`));
  if (counts.todo > 0) parts.push(theme.fg("dim", `${counts.todo} todo`));
  const line1 = truncateToWidth(`Tasks: ${parts.join("  ")}  (${tasks.length} total)`, width);
  const line2 = activeNames.length > 0
    ? truncateToWidth(theme.fg("dim", `  Active: ${activeNames.join(", ")}`), width)
    : "";
  const lines = [line1];
  if (line2) lines.push(line2);
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

const DIM_EVENTS = new Set(["join", "leave", "reserve", "release", "plan.pass.start", "plan.pass.done", "plan.review.start", "plan.review.done"]);

export function renderFeedSection(theme: Theme, events: FeedEvent[], width: number, lastSeenTs: string | null): string[] {
  if (events.length === 0) return [];
  const lines: string[] = [];
  let lastWasMessage = false;

  for (const event of events) {
    const isNew = lastSeenTs === null || event.ts > lastSeenTs;
    const isMessage = event.type === "message";

    if (lines.length > 0 && isMessage !== lastWasMessage) {
      lines.push(theme.fg("dim", "  ·"));
    }

    if (isMessage) {
      lines.push(...renderMessageLines(theme, event, width));
    } else {
      // Add event-type icons for richer feed rendering
      const eventIcon = getEventIcon(event.type);
      const formatted = `${eventIcon} ${sharedFormatFeedLine(event)}`;
      const dimmed = DIM_EVENTS.has(event.type) || !isNew;
      lines.push(truncateToWidth(dimmed ? theme.fg("dim", formatted) : formatted, width));
    }
    lastWasMessage = isMessage;
  }
  return lines;
}

function getEventIcon(type: string): string {
  switch (type) {
    case "task.done": return "✅";
    case "task.start": return "▶️";
    case "task.block": return "🚫";
    case "task.unblock": return "🔓";
    case "task.reset": return "🔄";
    case "task.delete": return "🗑️";
    case "task.split": return "✂️";
    case "task.revise": case "task.revise-tree": return "📝";
    case "plan.start": return "📋";
    case "plan.done": return "🎉";
    case "plan.failed": return "💥";
    case "plan.cancel": return "⛔";
    case "plan.pass.start": case "plan.pass.done": return "🔄";
    case "plan.review.start": case "plan.review.done": return "🔍";
    case "join": return "👋";
    case "leave": return "👋";
    case "commit": return "📦";
    case "test": return "🧪";
    case "stuck": return "⚠️";
    default: return "•";
  }
}

function formatTaskLabel(taskId: string): string {
  if (taskId === "__planner__") return "(planner)";
  if (taskId === "__reviser__") return "(reviser)";
  if (taskId.startsWith("__lobby-") && taskId.endsWith("__")) return "(lobby)";
  return taskId;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf(" ", maxWidth);
    if (breakAt <= 0) breakAt = maxWidth;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines;
}

function renderMessageLines(theme: Theme, event: FeedEvent, width: number): string[] {
  const time = new Date(event.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const agentStyled = coloredAgentName(event.agent);
  const rawPreview = event.preview?.trim() ?? "";

  const direction = event.target ? `\u2192 ${event.target}` : "\u2726";
  const singleLen = time.length + 1 + event.agent.length + 1 + (event.target ? 2 + event.target.length : 1) + (rawPreview ? 1 + rawPreview.length : 0);

  if (singleLen <= width && rawPreview) {
    return [truncateToWidth(`${time} ${agentStyled} ${theme.fg("accent", direction)} ${rawPreview}`, width)];
  }

  const header = `${time} ${agentStyled} ${theme.fg("accent", direction)}`;
  if (!rawPreview) return [truncateToWidth(header, width)];

  const indent = "      ";
  const maxBody = width - indent.length;
  const wrapped = wrapText(rawPreview, maxBody);
  const result = [truncateToWidth(header, width)];
  for (const bodyLine of wrapped) {
    result.push(truncateToWidth(`${indent}${bodyLine}`, width));
  }
  return result;
}

export function renderAgentsRow(
  cwd: string,
  width: number,
  state: MessengerState,
  dirs: Dirs,
  stuckThresholdMs: number,
): string {
  const allClaims = store.getClaims(dirs);
  const rowParts: string[] = [];
  const seen = new Set<string>();

  const self = buildSelfRegistration(state);
  rowParts.push(`🟢 You (${idleLabel(self.activity?.lastActivityAt ?? self.startedAt)})`);
  seen.add(self.name);

  for (const agent of store.getActiveAgents(state, dirs)) {
    if (seen.has(agent.name)) continue;
    const computed = computeStatus(
      agent.activity?.lastActivityAt ?? agent.startedAt,
      agentHasTask(agent.name, allClaims, crewStore.getTasks(agent.cwd)),
      (agent.reservations?.length ?? 0) > 0,
      stuckThresholdMs,
    );
    const indicator = STATUS_INDICATORS[computed.status];
    const idle = computed.idleFor ? ` ${computed.idleFor}` : "";
    rowParts.push(`${indicator} ${coloredAgentName(agent.name)}${idle}`);
    seen.add(agent.name);
  }

  for (const worker of getLiveWorkers(cwd).values()) {
    if (seen.has(worker.taskId)) continue;
    rowParts.push(`🔵 ${worker.name} ${formatTaskLabel(worker.taskId)}`);
    seen.add(worker.taskId);
  }

  return truncateToWidth(rowParts.join("  "), width);
}

export function renderEmptyState(theme: Theme, cwd: string, width: number, height: number): string[] {
  const lines: string[] = [];
  const agents = discoverCrewAgents(cwd);
  const config = loadConfig(cwd);
  const crewConfig = loadCrewConfig(crewStore.getCrewDir(cwd));

  lines.push("Crew agents:");
  if (agents.length === 0) {
    lines.push(theme.fg("dim", "  (none discovered)"));
  } else {
    for (const agent of agents) {
      const model = agent.model ? ` (model: ${agent.model})` : "";
      lines.push(`  ${agent.name}${model}`);
    }
  }

  lines.push("");
  lines.push("Config:");
  lines.push(`  Workers: ${crewConfig.concurrency.workers}  │  Stuck threshold: ${config.stuckThreshold}s`);
  lines.push(`  Auto-overlay: ${config.autoOverlay ? "on" : "off"}  │  Feed retention: ${config.feedRetention}`);
  lines.push("");
  lines.push("Create a plan:");
  lines.push("  pi_messenger({ action: \"plan\", prd: \"docs/PRD.md\" })");

  if (lines.length > height) {
    return lines.slice(0, height).map(line => truncateToWidth(line, width));
  }
  while (lines.length < height) lines.push("");
  return lines.map(line => truncateToWidth(line, width));
}

export function renderPlanningState(theme: Theme, cwd: string, width: number, height: number): string[] {
  const lines: string[] = [];
  const updated = planningState.updatedAt ? formatRelativeTime(planningState.updatedAt) : "unknown";
  const stalled = isPlanningStalled(cwd);
  const ageMs = getPlanningUpdateAgeMs(cwd);

  const plannerWorker = getLiveWorkers(cwd).get("__planner__");
  const reviewerWorker = getLiveWorkers(cwd).get("__reviewer__");
  const activeWorker = plannerWorker ?? reviewerWorker;

  lines.push(stalled ? theme.fg("warning", "Planning stalled") : "Planning in progress");
  lines.push(`  Pass: ${planningState.pass}/${planningState.maxPasses}  │  Phase: ${planningState.phase}  │  ${updated}`);

  if (stalled) {
    const staleFor = ageMs === null ? "unknown" : formatDuration(ageMs);
    lines.push(theme.fg("warning", `  Health: stalled (${staleFor}, timeout ${formatDuration(PLANNING_STALE_TIMEOUT_MS)})`));
  }

  lines.push("");

  if (activeWorker) {
    const p = activeWorker.progress;
    const tokens = p.tokens > 1000 ? `${(p.tokens / 1000).toFixed(0)}k` : `${p.tokens}`;
    const elapsed = formatElapsed(Date.now() - activeWorker.startedAt);
    const cost = estimateCost(p.tokens, p.model);
    const costStr = formatCost(cost);
    const costDisplay = costStr ? `  ${costStr}` : "";
    lines.push(`  ${activeWorker.agent}  │  ${p.toolCallCount} calls  ${tokens} tokens  ${elapsed}${costDisplay}`);
    lines.push("");
    const activityLines = renderActivityLog(p.recentTools, p.currentTool, p.currentToolArgs, activeWorker.startedAt, width, p.thinkingStartMs);
    lines.push(...activityLines);
  } else {
    const tail = readPlanningTail(cwd, 5);
    if (tail.length > 0) {
      lines.push(theme.fg("dim", "  recent:"));
      for (const item of tail) {
        lines.push(theme.fg("dim", `    ${item}`));
      }
    }
    lines.push("");
    lines.push(theme.fg("dim", "  progress: .pi/messenger/crew/planning-progress.md"));
    lines.push(theme.fg("dim", "  outline: .pi/messenger/crew/planning-outline.md"));
  }

  if (lines.length > height) {
    return lines.slice(-height).map(line => truncateToWidth(line, width));
  }
  while (lines.length < height) lines.push("");
  return lines.map(line => truncateToWidth(line, width));
}

export function renderLegend(
  theme: Theme,
  cwd: string,
  width: number,
  viewState: CrewViewState,
  task: Task | null,
  scrollLocked?: boolean,
  registry?: MonitorRegistry,
): string {
  // Scroll lock indicator prefix
  const scrollPrefix = scrollLocked ? theme.fg("warning", "📌 PINNED ") : "";
  if (viewState.confirmAction) {
    const text = renderConfirmBar(viewState.confirmAction.taskId, viewState.confirmAction.label, viewState.confirmAction.type);
    return truncateToWidth(theme.fg("warning", appendUniversalHints(text)), width);
  }

  if (viewState.inputMode === "block-reason") {
    const text = renderBlockReasonBar(viewState.blockReasonInput);
    return truncateToWidth(theme.fg("warning", appendUniversalHints(text)), width);
  }

  if (viewState.inputMode === "message") {
    const text = renderMessageBar(viewState.messageInput);
    return truncateToWidth(theme.fg("accent", text + "  [^T] [^B]"), width);
  }

  if (viewState.inputMode === "revise-prompt") {
    const label = viewState.reviseScope === "tree" ? "Revise tree" : "Revise";
    const text = `${label}: ${viewState.revisePromptInput}█  [Enter] Send  [Esc] Cancel`;
    return truncateToWidth(theme.fg("accent", appendUniversalHints(text)), width);
  }

  if (viewState.notification) {
    if (Date.now() < viewState.notification.expiresAt) {
      return truncateToWidth(appendUniversalHints(viewState.notification.message), width);
    }
    viewState.notification = null;
  }

  if (viewState.mode === "monitor-detail") {
    if (viewState.confirmAction?.type === "end-session") {
      const text = renderConfirmBar(viewState.confirmAction.taskId, viewState.confirmAction.label, "end-session");
      return truncateToWidth(theme.fg("warning", appendUniversalHints(text)), width);
    }
    const hints: string[] = [];
    const sessions = registry?.store.list() ?? [];
    const session = sessions[viewState.monitorSelectedIndex];
    if (session) {
      if (session.status === "active") hints.push("p:Pause");
      else if (session.status === "paused") hints.push("p:Resume");
      if (session.status !== "ended" && session.status !== "error") hints.push("e:End");
    }
    hints.push("i:Inspect", "↑↓:Scroll", "Esc:Back");
    return truncateToWidth(scrollPrefix + theme.fg("dim", appendUniversalHints(hints.join("  "))), width);
  }

  if (viewState.mode === "detail" && task) {
    return truncateToWidth(scrollPrefix + theme.fg("dim", appendUniversalHints(renderDetailStatusBar(cwd, task))), width);
  }

  if (task) {
    return truncateToWidth(scrollPrefix + theme.fg("dim", appendUniversalHints(renderListStatusBar(cwd, task))), width);
  }

  if (isPlanningForCwd(cwd)) {
    return truncateToWidth(
      scrollPrefix + theme.fg("dim", appendUniversalHints(`c:Cancel  v:${coordHint(cwd)}  +/-:Wkrs  Esc:Close`)),
      width,
    );
  }

  return truncateToWidth(scrollPrefix + theme.fg("dim", appendUniversalHints(`m:Monitor  @:Chat  v:${coordHint(cwd)}  +/-:Wkrs  Esc:Close`)), width);
}

export function renderDetailView(cwd: string, task: Task, width: number, height: number, viewState: CrewViewState): string[] {
  const live = getLiveWorkers(cwd).get(task.id);

  const lines: string[] = [];
  const tokens = live ? (live.progress.tokens > 1000 ? `${(live.progress.tokens / 1000).toFixed(0)}k` : `${live.progress.tokens}`) : "";
  const elapsed = live ? formatElapsed(Date.now() - live.startedAt) : "";

  lines.push(`${task.id}: ${task.title}`);
  if (live) {
    const cost = estimateCost(live.progress.tokens, live.progress.model);
    const costStr = formatCost(cost);
    const costDisplay = costStr ? `  ${costStr}` : "";
    const modelBadge = live.progress.model
      ? `  [${live.progress.model.replace(/^.*\//, "").slice(0, 20)}]`
      : "";
    lines.push(`Status: ${task.status}  │  ${live.name}  │  ${live.progress.toolCallCount} calls  ${tokens} tokens  ${elapsed}${costDisplay}${modelBadge}`);
  } else {
    const typeText = task.milestone ? "  │  Type: milestone" : "";
    const assignedText = task.assigned_to ? `  │  Assigned: ${task.assigned_to}` : "";
    lines.push(`Status: ${task.status}  │  Attempts: ${task.attempt_count}  │  Created: ${formatRelativeTime(task.created_at)}${typeText}${assignedText}`);
  }
  lines.push("");

  if (task.status === "in_progress" && !live) {
    const startedText = task.started_at ? ` (started ${formatRelativeTime(task.started_at)})` : "";
    lines.push(`⚠ Worker not running${startedText} — press [q] to stop and unassign`);
    lines.push("");
  }

  if (live) {
    // Sparkline activity graph
    if (live.progress.toolCallBuckets.length > 2) {
      lines.push(`Activity: ${renderSparkline(live.progress.toolCallBuckets, 20)}`);
    }
    
    // File tree visualization (Cursor-like source control view)
    if (live.progress.filesModified.length > 0) {
      const fileCount = live.progress.filesModified.length;
      lines.push(`Files modified (${fileCount}):`);
      if (fileCount <= 12) {
        // Tree view for manageable count
        const fileEntries = live.progress.filesModified.map(f => ({ path: f, action: "modified" }));
        const treeLines = renderFileTree(fileEntries, width - 2);
        for (const tl of treeLines) {
          lines.push(`  ${tl}`);
        }
      } else {
        // Compact list for large count
        const preview = live.progress.filesModified.slice(0, 5)
          .map(f => f.replace(/^.*\//, ""))
          .join(", ");
        lines.push(`  ${preview} +${fileCount - 5} more`);
      }
    }
    
    lines.push("");
    const activityLines = renderActivityLog(
      live.progress.recentTools,
      live.progress.currentTool,
      live.progress.currentToolArgs,
      live.startedAt,
      width,
      live.progress.thinkingStartMs,
    );
    lines.push(...activityLines);
    
    // Inline diff viewer: show recent edit diffs with stats
    const recentDiffs = live.progress.recentTools
      .filter(t => t.tool === "edit" && t.diffPreview && t.success !== false)
      .slice(-3); // Show last 3 diffs
    if (recentDiffs.length > 0) {
      lines.push("");
      lines.push("── Recent Changes ──────────────────────");
      for (const entry of recentDiffs) {
        const filePath = entry.args || "file";
        // Diff stats bar
        const statsBar = entry.diffPreview ? renderDiffStatsBar(entry.diffPreview) : "";
        lines.push(`  ${getToolIcon("edit")} ${filePath}  ${statsBar}`);
        // Render diff lines with color indicators
        const diffLines = (entry.diffPreview ?? "").split("\n");
        const previewLines = diffLines.slice(0, 10);
        for (const dl of previewLines) {
          const m = dl.match(/^([+-\s])(\s*\d*)\s(.*)$/);
          if (!m) continue;
          const [, prefix, num, content] = m;
          const lineNum = num.trim().padStart(4);
          if (prefix === "+") {
            lines.push(`    + ${lineNum} ${content}`);
          } else if (prefix === "-") {
            lines.push(`    - ${lineNum} ${content}`);
          } else {
            lines.push(`      ${lineNum} ${content}`);
          }
        }
        if (diffLines.length > 10) {
          lines.push(`    ... (${diffLines.length - 10} more lines)`);
        }
        lines.push("");
      }
    }
  } else {
    if (task.depends_on.length > 0) {
      lines.push("Dependencies:");
      for (const depId of task.depends_on) {
        const dep = crewStore.getTask(cwd, depId);
        if (!dep) lines.push(`  ○ ${depId}: (missing)`);
        else lines.push(`  ${dep.status === "done" ? "✓" : "○"} ${dep.id}: ${dep.title} (${dep.status})`);
      }
      lines.push("");
    }

    const progress = crewStore.getTaskProgress(cwd, task.id);
    if (progress) {
      lines.push("Progress:");
      for (const line of progress.trimEnd().split("\n")) lines.push(`  ${line}`);
      lines.push("");
    }

    if (task.status === "blocked") {
      lines.push(`Block Reason: ${task.blocked_reason ?? "Unknown"}`);
      const blockContext = crewStore.getBlockContext(cwd, task.id);
      if (blockContext) {
        lines.push("", "Block Context:");
        for (const line of blockContext.trimEnd().split("\n")) lines.push(`  ${line}`);
      }
      lines.push("");
    }

    if (task.last_review) {
      const icon = task.last_review.verdict === "SHIP" ? "✓" : task.last_review.verdict === "NEEDS_WORK" ? "✗" : "⚠";
      lines.push(`Last Review: ${icon} ${task.last_review.verdict} (${formatRelativeTime(task.last_review.reviewed_at)})`);
      if (task.last_review.issues.length > 0) {
        lines.push("  Issues:");
        for (const issue of task.last_review.issues) lines.push(`    - ${issue}`);
      }
      if (task.last_review.suggestions.length > 0) {
        lines.push("  Suggestions:");
        for (const suggestion of task.last_review.suggestions) lines.push(`    - ${suggestion}`);
      }
      lines.push("");
    }

    if (task.status === "done") {
      lines.push(`Completion Summary: ${task.summary ?? "(none)"}`);
      const evidence = task.evidence;
      if (evidence && (evidence.commits?.length || evidence.tests?.length || evidence.prs?.length)) {
        lines.push("Evidence:");
        if (evidence.commits?.length) lines.push(`  Commits: ${evidence.commits.join(", ")}`);
        if (evidence.tests?.length) lines.push(`  Tests: ${evidence.tests.join(", ")}`);
        if (evidence.prs?.length) lines.push(`  PRs: ${evidence.prs.join(", ")}`);
      }
      
      // Git checkpoint info (rollback capability)
      try {
        const checkpoints = listCheckpoints(cwd, task.id);
        if (checkpoints.length > 0) {
          lines.push("");
          lines.push("📸 Checkpoints (press R to restore):");
          for (const cp of checkpoints) {
            const when = formatRelativeTime(new Date(cp.timestamp).toISOString());
            lines.push(`  ${cp.label === "pre" ? "⏪" : "⏩"} ${cp.label}: ${cp.commitHash.slice(0, 8)} (${when})`);
          }
          // Show diff summary between pre/post
          const diffStat = getCheckpointDiff(cwd, task.id);
          if (diffStat) {
            lines.push("  Changes:");
            for (const line of diffStat.split("\n").slice(0, 10)) {
              lines.push(`    ${line}`);
            }
          }
        }
      } catch {
        // Checkpoint display is best-effort
      }
      
      lines.push("");
    }

    lines.push("Spec:");
    const spec = crewStore.getTaskSpec(cwd, task.id);
    if (!spec || spec.trimEnd().length === 0) lines.push("  *No spec available*");
    else for (const line of spec.trimEnd().split("\n")) lines.push(`  ${line}`);
  }

  const maxScroll = Math.max(0, lines.length - height);
  if (live && viewState.detailAutoScroll) {
    viewState.detailScroll = maxScroll;
  }
  viewState.detailScroll = Math.max(0, Math.min(viewState.detailScroll, maxScroll));
  const visible = lines.slice(viewState.detailScroll, viewState.detailScroll + height).map(line => truncateToWidth(line, width));
  while (visible.length < height) visible.push("");
  return visible;
}

function coordHint(cwd: string): string {
  return loadCrewConfig(crewStore.getCrewDir(cwd)).coordination ?? "chatty";
}

function renderDetailStatusBar(cwd: string, task: Task): string {
  const hints: string[] = [];
  if (task.status === "in_progress") hints.push("q:Stop");
  if (["done", "blocked", "in_progress"].includes(task.status)) hints.push("r:Reset");
  if (task.status === "blocked") hints.push("u:Unblock");
  if (task.status !== "done" && !task.milestone) hints.push("S:Split");
  if (task.status === "todo" && !task.milestone) hints.push("s:Start");
  if (task.status === "in_progress") hints.push("b:Block");
  if (task.status !== "in_progress" && !task.milestone) hints.push("p:Revise");
  if (task.status !== "in_progress" && !task.milestone) hints.push("P:Tree");
  if (!(task.status === "in_progress" && hasLiveWorker(cwd, task.id))) hints.push("x:Del");
  // Checkpoint restore for completed tasks
  if (task.status === "done") {
    try {
      const checkpoints = listCheckpoints(cwd, task.id);
      if (checkpoints.some(cp => cp.label === "pre")) hints.push("C:Restore");
    } catch { /* ignore */ }
  }
  if (!isPlanningForCwd(cwd)) hints.push("m:Monitor");
  hints.push(`v:${coordHint(cwd)}`, "f:Feed", "+/-:Wkrs", "←→:Nav");
  return hints.join("  ");
}

function renderListStatusBar(cwd: string, task: Task): string {
  const hints: string[] = ["Enter:Detail"];
  if (task.status === "in_progress") hints.push("q:Stop");
  if (["done", "blocked", "in_progress"].includes(task.status)) hints.push("r:Reset");
  if (task.status === "blocked") hints.push("u:Unblock");
  if (task.status !== "done" && !task.milestone) hints.push("S:Split");
  if (task.status === "todo" && !task.milestone) hints.push("s:Start");
  if (task.status === "in_progress") hints.push("b:Block");
  if (task.status !== "in_progress" && !task.milestone) hints.push("p:Revise");
  if (!(task.status === "in_progress" && hasLiveWorker(cwd, task.id))) hints.push("x:Del");
  if (!isPlanningForCwd(cwd)) hints.push("m:Monitor");
  hints.push(`v:${coordHint(cwd)}`, "f:Feed", "+/-:Wkrs");
  return hints.join("  ");
}

function renderConfirmBar(taskId: string, label: string, type: "reset" | "cascade-reset" | "delete" | "cancel-planning" | "end-session"): string {
  if (type === "cancel-planning") return "⚠ Cancel planning? [y] Confirm  [n] Cancel";
  if (type === "end-session") return `⚠ End session "${label}"? [y] Confirm  [n] Cancel`;
  if (type === "reset") return `⚠ Reset ${taskId} \"${label}\"? [y] Confirm  [n] Cancel`;
  if (type === "cascade-reset") return `⚠ Cascade reset ${taskId} and dependents? [y] Confirm  [n] Cancel`;
  return `⚠ Delete ${taskId} \"${label}\"? [y] Confirm  [n] Cancel`;
}

function renderBlockReasonBar(input: string): string {
  return `Block reason: ${input}█  [Enter] Confirm  [Esc] Cancel`;
}

function renderMessageBar(input: string): string {
  const isAt = input.startsWith("@");
  const hint = isAt ? "DM" : "broadcast";
  const tabHint = isAt && !input.includes(" ") ? "  [Tab] Complete" : "";
  return `${hint}: ${input}█  [Enter] Send${tabHint}  [Esc] Cancel`;
}

function renderTaskLine(theme: Theme, task: Task, isSelected: boolean, width: number, liveWorker?: LiveWorkerInfo): string {
  const select = isSelected ? theme.fg("accent", "▸ ") : "  ";
  const icon = STATUS_ICONS[task.status] ?? "?";
  const coloredIcon = task.status === "done"
    ? theme.fg("accent", icon)
    : task.status === "in_progress"
      ? theme.fg("warning", icon)
      : task.status === "blocked"
        ? theme.fg("error", icon)
        : theme.fg("dim", icon);

  let suffix = "";
  if (task.status === "in_progress" && liveWorker) {
    suffix = ` (${liveWorker.name})`;
  } else if (task.status === "in_progress" && task.assigned_to) {
    suffix = ` (${task.assigned_to})`;
  } else if (task.status === "todo" && task.depends_on.length > 0) {
    suffix = ` → ${task.depends_on.join(", ")}`;
  } else if (task.status === "blocked" && task.blocked_reason) {
    const reason = task.blocked_reason.slice(0, 28);
    suffix = ` [${reason}${task.blocked_reason.length > 28 ? "…" : ""}]`;
  }

  if (task.milestone) suffix += `${suffix ? " " : ""}· milestone`;
  return truncateToWidth(`${select}${coloredIcon} ${task.id}  ${task.title}${theme.fg("dim", suffix)}`, width);
}


// ─── Attention queue helpers ──────────────────────────────────────────────────

const ANSI_YELLOW = "\x1b[33m";
const ANSI_BOLD_ATTN = "\x1b[1m";
const ANSI_DIM_ATTN = "\x1b[2m";
const ANSI_RESET_ATTN = "\x1b[0m";

/**
 * Build a health status map from sessions using lightweight heuristics.
 * Pure function — no side effects, no external calls.
 */
function buildHealthMapFromSessions(
  sessions: Array<{
    status: string;
    metadata: { id: string; startedAt: string };
    events: Array<{ timestamp: string }>;
    metrics: { eventCount: number; errorCount: number };
  }>,
  now: number,
): Map<string, HealthStatus> {
  const map = new Map<string, HealthStatus>();
  for (const s of sessions) {
    if (s.status !== "active") {
      map.set(s.metadata.id, "healthy");
      continue;
    }
    let lastTs = Date.parse(s.metadata.startedAt);
    for (const e of s.events) {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t) && t > lastTs) lastTs = t;
    }
    const ageMs = Math.max(0, now - lastTs);
    const errorRate =
      s.metrics.eventCount > 0 ? s.metrics.errorCount / s.metrics.eventCount : 0;
    if (ageMs >= 120_000) {
      map.set(s.metadata.id, "critical");
    } else if (ageMs >= 30_000 || errorRate >= 0.5) {
      map.set(s.metadata.id, "degraded");
    } else {
      map.set(s.metadata.id, "healthy");
    }
  }
  return map;
}

function attentionReasonLabel(reason: AttentionItem["reason"]): string {
  switch (reason) {
    case "waiting_on_human": return "waiting";
    case "stuck": return "stuck";
    case "degraded": return "degraded";
    case "high_error_rate": return "high errors";
    case "repeated_retries": return "repeated retries";
    case "failed_recoverable": return "failed";
    case "stale_running": return "stale";
    default: return String(reason);
  }
}

/**
 * Render the attention queue section as an array of lines.
 * Shown above the session list when sessions need operator attention.
 */
export function renderAttentionQueue(items: AttentionItem[], width: number): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${ANSI_BOLD_ATTN}${ANSI_YELLOW}⚠ Attention Queue (${items.length})${ANSI_RESET_ATTN}`);
  for (const item of items) {
    const sessionId = item.sessionId.slice(0, 12);
    const label = attentionReasonLabel(item.reason);
    const maxMsg = Math.max(10, width - sessionId.length - label.length - 6);
    const msg =
      item.message.length > maxMsg
        ? item.message.slice(0, maxMsg - 1) + "…"
        : item.message;
    lines.push(
      `  ${sessionId}  ${ANSI_YELLOW}${label}${ANSI_RESET_ATTN}: ${msg}`,
    );
    const maxAction = Math.max(10, width - 6);
    const action =
      item.recommendedAction.length > maxAction
        ? item.recommendedAction.slice(0, maxAction - 1) + "…"
        : item.recommendedAction;
    lines.push(`  ${ANSI_DIM_ATTN}→ ${action}${ANSI_RESET_ATTN}`);
  }
  lines.push("");
  return lines;
}

export function renderMonitorView(
  registry: MonitorRegistry | undefined,
  width: number,
  height: number,
  viewState: CrewViewState,
): string[] {
  if (!registry) {
    const lines: string[] = ["  No monitor registry available."];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const sessions = registry.store.list();
  if (sessions.length === 0) {
    const lines: string[] = ["  No active sessions."];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const clampedIndex = Math.max(0, Math.min(viewState.monitorSelectedIndex, sessions.length - 1));
  viewState.monitorSelectedIndex = clampedIndex;

  const now = Date.now();
  const healthMap = buildHealthMapFromSessions(sessions, now);
  const attentionItems = deriveAttentionItems(sessions, healthMap, new Map());
  const attentionLines = renderAttentionQueue(attentionItems, width);

  const sessionLines = renderGroupedSessions(sessions, clampedIndex, width);
  const allLines = [...attentionLines, ...sessionLines];

  const visible = allLines.slice(0, height);
  while (visible.length < height) visible.push("");
  return visible;
}


export function renderMonitorDetailView(
  registry: MonitorRegistry | undefined,
  width: number,
  height: number,
  viewState: CrewViewState,
): string[] {
  if (!registry) {
    const lines: string[] = ["  No monitor registry available."];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const sessions = registry.store.list();
  const session = sessions[viewState.monitorSelectedIndex];
  if (!session) {
    const lines: string[] = ["  Session not found."];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const snapshot = registry.healthMonitor.getSessionHealth(session.metadata.id);
  const health = snapshot.state === "stuck"
    ? "critical"
    : snapshot.state === "degraded"
      ? "degraded"
      : "healthy";
  const alert = registry.healthMonitor.getAlert(session.metadata.id);

  return renderSessionDetailView(session, health, width, height, Date.now(), alert);
}

export function navigateTask(viewState: CrewViewState, direction: 1 | -1, taskCount: number): void {
  if (taskCount === 0) return;
  viewState.selectedTaskIndex = Math.max(0, Math.min(taskCount - 1, viewState.selectedTaskIndex + direction));
}
