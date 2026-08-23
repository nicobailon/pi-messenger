/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination - no daemon required.
 */

import { homedir } from "node:os";
import * as fs from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";

function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TSchema {
  const unsafe = (Type as unknown as {
    Unsafe?: (schema: Record<string, unknown>) => TSchema;
  }).Unsafe;

  if (typeof unsafe === "function") {
    return unsafe({
      type: "string",
      enum: [...values],
      ...(options?.description && { description: options.description }),
      ...(options?.default && { default: options.default }),
    });
  }

  return Type.Union(
    values.map((value) => Type.Literal(value)),
    options,
  );
}
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  MAX_CHAT_HISTORY,
  formatRelativeTime,
  stripAnsiCodes,
  extractFolder,
  generateAutoStatus,
  computeStatus,
  agentHasTask,
} from "./lib.ts";
import * as store from "./store.ts";
import * as handlers from "./handlers.ts";
import { MessengerOverlay, type OverlayCallbacks } from "./overlay.ts";
import { MessengerConfigOverlay } from "./config-overlay.ts";
import { loadConfig, loadGlobalConfig, matchesAutoRegisterPath, type MessengerConfig } from "./config.ts";
import { executeCrewAction } from "./crew/index.ts";
import { logFeedEvent, pruneFeed } from "./feed.ts";
import type { CrewParams } from "./crew/types.ts";
import {
  autonomousState,
  clearPlanningState,
  consumePendingAutoWork,
  consumePlanningOverlayPending,
  dismissPlanningOverlayRun,
  getPlanningOverlayPending,
  isPlanningForCwd,
  isPlanningStalled,
  markPlanningOverlayPending,
  planningState,
  restoreAutonomousState,
  restorePlanningState,
  stopAutonomous,
  isAutonomousForCwd,
} from "./crew/state.ts";
import { loadCrewConfig } from "./crew/utils/config.ts";
import * as crewStore from "./crew/store.ts";
import * as teamStore from "./crew/team/store.ts";
import { runLegacyAgentCleanupMigration } from "./crew/utils/install.ts";
import { getLiveWorkers, onLiveWorkersChanged } from "./crew/live-progress.ts";
import { shutdownAllWorkers } from "./crew/agents.ts";
import { shutdownLobbyWorkers } from "./crew/lobby.ts";

let overlayTui: TUI | null = null;
let overlayHandle: OverlayHandle | null = null;
let overlayOpening = false;

export default function piMessengerExtension(pi: ExtensionAPI) {
  // One-time migration: remove stale crew agents from shared ~/.pi/agent/agents/
  // (crew agents now discovered from extension-local directory)
  runLegacyAgentCleanupMigration();

  // ===========================================================================
  // State & Configuration
  // ===========================================================================

  let config: MessengerConfig = loadGlobalConfig();

  const state: MessengerState = {
    agentName: process.env.PI_AGENT_NAME || "",
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "",
    cwd: "",
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: config.scopeToFolder,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  };

  const nameTheme = { theme: config.nameTheme, customWords: config.nameWords };

  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi/agent/messenger");
  const dirs: Dirs = {
    base: baseDir,
    registry: join(baseDir, "registry"),
    inbox: join(baseDir, "inbox")
  };

  // ===========================================================================
  // Message Delivery
  // ===========================================================================

  function deliverMessage(msg: AgentMailMessage): void {
    // Store in chat history (keyed by sender)
    let history = state.chatHistory.get(msg.from);
    if (!history) {
      history = [];
      state.chatHistory.set(msg.from, history);
    }
    history.push(msg);
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    // Increment unread count
    const current = state.unreadCounts.get(msg.from) ?? 0;
    state.unreadCounts.set(msg.from, current + 1);

    // Trigger overlay re-render if open
    overlayTui?.requestRender();

    // Build message content with optional context
    // Detect if this is a new agent identity (first contact OR same name but different session)
    const sender = store.getActiveAgents(state, dirs).find(a => a.name === msg.from);
    const senderSessionId = sender?.sessionId;
    const prevSessionId = state.seenSenders.get(msg.from);
    const isNewIdentity = !prevSessionId || (senderSessionId && prevSessionId !== senderSessionId);

    // Update seen senders with current sessionId (only if we could look it up)
    if (senderSessionId) {
      state.seenSenders.set(msg.from, senderSessionId);
    }

    let content = "";

    // Add sender details on new identity (first contact or agent restart with same name)
    if (isNewIdentity && config.senderDetailsOnFirstContact && sender) {
      const folder = extractFolder(sender.cwd);
      const locationPart = sender.gitBranch
        ? `${folder} on ${sender.gitBranch}`
        : folder;
      content += `*${msg.from} is in ${locationPart} (${sender.model})*\n\n`;
    }

    // Add reply hint
    const replyHint = config.replyHint
      ? ` — reply: pi_messenger({ action: "send", to: "${msg.from}", message: "..." })`
      : "";

    content += `**Message from ${msg.from}**${replyHint}\n\n${msg.text}`;

    if (msg.replyTo) {
      content = `*(reply to ${msg.replyTo.substring(0, 8)})*\n\n${content}`;
    }

    pi.sendMessage(
      { customType: "agent_message", content, display: true, details: msg },
      { triggerTurn: true, deliverAs: "steer" }
    );
  }

  // ===========================================================================
  // Stuck Detection
  // ===========================================================================

  const notifiedStuck = new Set<string>();

  function checkStuckAgents(ctx: ExtensionContext, peers: ReturnType<typeof store.getActiveAgents>): void {
    if (!config.stuckNotify || !ctx.hasUI || !state.registered) return;

    const thresholdMs = config.stuckThreshold * 1000;
    const allClaims = store.getClaims(dirs);
    const tasksByCwd = new Map<string, ReturnType<typeof crewStore.getTasks>>();
    const currentlyStuck = new Set<string>();

    for (const agent of peers) {
      let tasks = tasksByCwd.get(agent.cwd);
      if (!tasks) {
        tasks = crewStore.getTasks(agent.cwd);
        tasksByCwd.set(agent.cwd, tasks);
      }
      const hasTask = agentHasTask(agent.name, allClaims, tasks);
      const computed = computeStatus(
        agent.activity?.lastActivityAt ?? agent.startedAt,
        hasTask,
        (agent.reservations?.length ?? 0) > 0,
        thresholdMs
      );

      if (computed.status === "stuck") {
        currentlyStuck.add(agent.name);

        if (!notifiedStuck.has(agent.name)) {
          notifiedStuck.add(agent.name);
          logFeedEvent(ctx.cwd, agent.name, "stuck");

          const idleStr = computed.idleFor ?? "unknown";
          const taskInfo = hasTask ? " with task in progress" : " with reservation";
          ctx.ui.notify(`\u26A0\uFE0F ${agent.name} appears stuck (idle ${idleStr}${taskInfo})`, "warning");
        }
      }
    }

    for (const name of notifiedStuck) {
      if (!currentlyStuck.has(name)) {
        notifiedStuck.delete(name);
      }
    }
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  function updateStatus(ctx: ExtensionContext): void {
    try {
      if (!ctx.hasUI || !state.registered) return;

      const agents = store.getActiveAgents(state, dirs);
      checkStuckAgents(ctx, agents);
      const activeNames = new Set(agents.map(a => a.name));
      const count = agents.length;
      const theme = ctx.ui.theme;

      for (const name of state.unreadCounts.keys()) {
        if (!activeNames.has(name)) {
          state.unreadCounts.delete(name);
        }
      }
      for (const name of notifiedStuck) {
        if (!activeNames.has(name)) {
          notifiedStuck.delete(name);
        }
      }

      // Sum remaining unread counts
      let totalUnread = 0;
      for (const n of state.unreadCounts.values()) totalUnread += n;

      const nameStr = theme.fg("accent", state.agentName);
      const countStr = theme.fg("dim", ` (${count} peer${count === 1 ? "" : "s"})`);
      const unreadStr = totalUnread > 0 ? theme.fg("accent", ` ●${totalUnread}`) : "";

      const planningCwd = ctx.cwd;
      const planningStr =
        isPlanningForCwd(planningCwd)
          ? theme.fg(
              "warning",
              ` · plan ${planningState.pass}/${planningState.maxPasses} ${planningState.phase}${isPlanningStalled(planningCwd) ? " stalled" : ""}`,
            )
          : "";

      const activityStr = !planningStr && state.activity.currentActivity
        ? theme.fg("dim", ` · ${state.activity.currentActivity}`)
        : "";

      // Add crew status if autonomous mode is active
      let crewStr = "";
      if (autonomousState.active) {
        const cwd = ctx.cwd;
        const plan = crewStore.getPlan(cwd);
        if (plan) {
          const workerCount = getLiveWorkers(cwd).size;
          crewStr = theme.fg("accent", ` ⚡${plan.completed_count}/${plan.task_count}`);
          if (workerCount > 0) {
            crewStr += theme.fg("dim", ` 🔨${workerCount}`);
          }
        }
      }

      ctx.ui.setStatus("messenger", `msg: ${nameStr}${countStr}${unreadStr}${planningStr}${activityStr}${crewStr}`);

      maybeAutoOpenCrewOverlay(ctx);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("extension ctx is stale")) {
        throw error;
      }

      latestCtx = null;
      stopStatusHeartbeat();
    }
  }

  function clearAllUnreadCounts(): void {
    for (const key of state.unreadCounts.keys()) {
      state.unreadCounts.set(key, 0);
    }
  }

  const STATUS_HEARTBEAT_MS = 15_000;
  let latestCtx: ExtensionContext | null = null;
  let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const AUTONOMOUS_CONTINUE_REPEAT_LIMIT = 3;
  let autonomousContinueSignature: string | null = null;
  let autonomousContinueRepeats = 0;

  function resetAutonomousContinueGuard(): void {
    autonomousContinueSignature = null;
    autonomousContinueRepeats = 0;
  }

  function trackAutonomousContinue(signature: string): number {
    if (autonomousContinueSignature === signature) {
      autonomousContinueRepeats += 1;
    } else {
      autonomousContinueSignature = signature;
      autonomousContinueRepeats = 1;
    }
    return autonomousContinueRepeats;
  }

  function startStatusHeartbeat(): void {
    if (statusHeartbeatTimer) return;
    statusHeartbeatTimer = setInterval(() => {
      if (latestCtx) updateStatus(latestCtx);
    }, STATUS_HEARTBEAT_MS);
  }

  function stopStatusHeartbeat(): void {
    if (!statusHeartbeatTimer) return;
    clearInterval(statusHeartbeatTimer);
    statusHeartbeatTimer = null;
  }

  function captureStatusContext(ctx: ExtensionContext): void {
    latestCtx = ctx;
    startStatusHeartbeat();
  }

  onLiveWorkersChanged(() => {
    if (latestCtx) updateStatus(latestCtx);
  });

  // ===========================================================================
  // Registration Context
  // ===========================================================================

  function sendRegistrationContext(ctx: ExtensionContext): void {
    const folder = extractFolder(ctx.cwd ?? state.cwd);
    const locationPart = state.gitBranch
      ? `${folder} on ${state.gitBranch}`
      : folder;
    pi.sendMessage({
      customType: "messenger_context",
      content: `You are agent "${state.agentName}" in ${locationPart}. Use pi_messenger({ action: "status" }) to see crew status, pi_messenger({ action: "work" }) to run tasks.`,
      display: false
    }, { triggerTurn: false });
  }

  // ===========================================================================
  // Tool Registration
  // ===========================================================================

  pi.registerTool({
    name: "pi_messenger",
    label: "Pi Messenger",
    description: `Multi-agent coordination and task orchestration.

Usage (action-based API - preferred):
  // Coordination
  pi_messenger({ action: "join" })                              → Join mesh
  pi_messenger({ action: "leave" })                             → Leave mesh for this session
  pi_messenger({ action: "status" })                            → Get status
  pi_messenger({ action: "list" })                              → List agents with presence
  pi_messenger({ action: "feed", limit: 20 })                   → Activity feed
  pi_messenger({ action: "whois", name: "AgentName" })          → Agent details
  pi_messenger({ action: "set_status", message: "reviewing" })  → Set custom status
  pi_messenger({ action: "reserve", paths: ["src/"] })          → Reserve files
  pi_messenger({ action: "send", to: "Agent", message: "hi" })  → Send message
  
  // Crew: Plan from PRD
  pi_messenger({ action: "plan" })                              → Auto-discover PRD
  pi_messenger({ action: "plan", prd: "docs/PRD.md" })          → Explicit PRD path
  pi_messenger({ action: "plan", prompt: "Scan for bugs" })     → Inline prompt (no PRD)
  pi_messenger({ action: "plan.cancel" })                       → Cancel active planning
  
  // Crew: Work through tasks
  pi_messenger({ action: "work" })                              → Run ready tasks
  pi_messenger({ action: "work", autonomous: true })            → Run until done/blocked
  pi_messenger({ action: "work.stop" })                         → Stop autonomous work for this project
  
  // Crew: Tasks
  pi_messenger({ action: "task.show", id: "task-1" })           → Show task
  pi_messenger({ action: "task.list" })                         → List all tasks
  pi_messenger({ action: "task.split", id: "task-3" })          → Inspect task for splitting
  pi_messenger({ action: "task.split", id: "task-3", subtasks: [...] }) → Execute split
  pi_messenger({ action: "task.start", id: "task-1" })          → Start task
  pi_messenger({ action: "task.approve", id: "task-1" })        → Approve gated task
  pi_messenger({ action: "task.reject", id: "task-1", reason: "..." }) → Reject gated task and feed revision
  pi_messenger({ action: "task.done", id: "task-1", summary: "..." })
  pi_messenger({ action: "task.reset", id: "task-1" })          → Reset task
  
  // Crew: Review
  pi_messenger({ action: "review", target: "task-1" })          → Review impl

  // Team: Optional role-aware layer around Crew
  pi_messenger({ action: "team.setup", name: "migration-squad" }) → Activate profile, create starter charter, show next steps
  pi_messenger({ action: "team.profile.list" })                 → List built-in and saved team profiles
  pi_messenger({ action: "team.profile.use", name: "migration-squad" }) → Activate a team profile
  pi_messenger({ action: "team.charter.show" })                 → Show project team charter
  pi_messenger({ action: "team.memory.note", type: "decision", message: "..." })
  pi_messenger({ action: "team.roles" })                        → Resolve Team roles (packaged pi-subagents vocabulary + optional metadata)
  pi_messenger({ action: "team.status" })                       → Team summary`,
    promptSnippet:
      "Use for multi-agent coordination and Crew workflows: join/status/feed, create plans, run work waves, manage tasks, optional Team roles/profiles, reserve files, and message agents.",
    parameters: Type.Object({
      action: Type.Optional(Type.String({
        description: "Action to perform (e.g., 'join', 'plan', 'work', 'task.start')"
      })),

      // ═══════════════════════════════════════════════════════════════════════
      // CREW PARAMETERS
      // ═══════════════════════════════════════════════════════════════════════
      prd: Type.Optional(Type.String({ description: "PRD file path for plan action" })),
      prompt: Type.Optional(Type.String({ description: "Inline prompt for plan action, or revision instructions for task.revise/task.revise-tree" })),
      id: Type.Optional(Type.String({ description: "Task ID (task-N format)" })),
      taskId: Type.Optional(Type.String({ description: "Swarm task ID (e.g., TASK-01) - for action-based claim/unclaim/complete" })),
      title: Type.Optional(Type.String({ description: "Title for task.create" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on (for task.create)" })),
      role: Type.Optional(Type.String({ description: "Team role for task creation/planning (built-ins follow packaged pi-subagents vocabulary; profiles may define more)" })),
      riskLabels: Type.Optional(Type.Array(Type.String(), { description: "Team risk labels for approval policy" })),
      target: Type.Optional(Type.String({ description: "Task ID for review action" })),
      summary: Type.Optional(Type.String({ description: "Summary for task.done" })),
      evidence: Type.Optional(Type.Object({
        commits: Type.Optional(Type.Array(Type.String())),
        tests: Type.Optional(Type.Array(Type.String())),
        prs: Type.Optional(Type.Array(Type.String()))
      }, { description: "Evidence for task.done" })),
      content: Type.Optional(Type.String({ description: "Content for task spec" })),
      count: Type.Optional(Type.Number({ description: "Suggested number of subtasks for task.split" })),
      subtasks: Type.Optional(Type.Array(
        Type.Object({
          title: Type.String(),
          content: Type.Optional(Type.String()),
        }),
        { description: "Subtask definitions for task.split (execute phase)" }
      )),
      type: Type.Optional(StringEnum(["plan", "impl", "decision", "interface", "risk", "handoff"], { description: "Review type, or Team memory type for team.memory.*" })),
      autoWork: Type.Optional(Type.Boolean({ description: "Auto-start autonomous work after plan completes (default: true, pass false to review plan first)" })),
      autonomous: Type.Optional(Type.Boolean({ description: "Run work continuously until done/blocked" })),
      concurrency: Type.Optional(Type.Number({ description: "Override worker concurrency" })),
      model: Type.Optional(Type.String({ description: "Override worker model for this work wave" })),
      cascade: Type.Optional(Type.Boolean({ description: "For task.reset - also reset dependent tasks" })),
      limit: Type.Optional(Type.Number({ description: "Number of events to return (for feed action, default 20)" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Paths for reserve/release actions" })),
      name: Type.Optional(Type.String({ description: "Name for rename action or Team setup/profile/charter commands" })),

      // ═══════════════════════════════════════════════════════════════════════
      // MESSAGING & COORDINATION PARAMETERS
      // ═══════════════════════════════════════════════════════════════════════
      spec: Type.Optional(Type.String({ description: "Path to spec/plan file" })),
      notes: Type.Optional(Type.String({ description: "Completion notes" })),
      to: Type.Optional(Type.Any({ description: "Target agent name (string) or multiple names (array)" })),
      message: Type.Optional(Type.String({ description: "Message to send, Team setup/charter text, or Team memory note" })),
      replyTo: Type.Optional(Type.String({ description: "Message ID if this is a reply" })),
      reason: Type.Optional(Type.String({ description: "Reason for reservation, claim, task block, or approval rejection feedback" })),
      autoRegisterPath: Type.Optional(StringEnum(["add", "remove", "list"], { description: "Manage auto-register paths: add/remove current folder, or list all" }))
    }),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as CrewParams;
      captureStatusContext(ctx);

      const action = params.action;
      if (!action) {
        return handlers.executeStatus(state, dirs, ctx.cwd);
      }

      const result = await executeCrewAction(
        action,
        params,
        state,
        dirs,
        ctx,
        deliverMessage,
        updateStatus,
        (type, data) => pi.appendEntry(type, data),
        { stuckThreshold: config.stuckThreshold, crewEventsInFeed: config.crewEventsInFeed, nameTheme, feedRetention: config.feedRetention },
        signal
      );

      if (action === "join" && state.registered && config.registrationContext) {
        sendRegistrationContext(ctx);
      }

      if (action === "leave" && !state.registered) {
        overlayHandle?.hide();
        overlayHandle = null;
        overlayTui = null;
        overlayOpening = false;
      }

      return result;
    }
  });

  // ===========================================================================
  // Commands
  // ===========================================================================

  pi.registerCommand("messenger", {
    description: "Open messenger overlay, or 'config' to manage settings",
    handler: async (args, ctx) => {
      captureStatusContext(ctx);
      if (!ctx.hasUI) return;

      // /messenger config - open config overlay
      if (args[0] === "config") {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => {
            return new MessengerConfigOverlay(tui, theme, done, ctx.cwd);
          },
          { overlay: true }
        );
        return;
      }

      // /messenger - open chat overlay (auto-joins if not registered)
      if (!state.registered) {
        if (!store.register(state, dirs, ctx, nameTheme)) {
          ctx.ui.notify("Failed to join agent mesh", "error");
          return;
        }
        store.startWatcher(state, dirs, deliverMessage);
        updateStatus(ctx);
      }

      if (overlayHandle && overlayHandle.isHidden()) {
        overlayHandle.setHidden(false);
        clearAllUnreadCounts();
        updateStatus(ctx);
        return;
      }

      const callbacks: OverlayCallbacks = {
        onBackground: (snapshotText) => {
          overlayHandle?.setHidden(true);
          pi.sendMessage({
            customType: "crew_snapshot",
            content: snapshotText,
            display: true,
          }, { triggerTurn: true });
        },
      };

      const snapshot = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(tui, theme, state, dirs, done, callbacks, ctx.cwd);
        },
        {
          overlay: true,
          onHandle: (handle) => {
            overlayHandle = handle;
          },
        }
      );

      if (snapshot) {
        pi.sendMessage({
          customType: "crew_snapshot",
          content: snapshot,
          display: true,
        }, { triggerTurn: true });
      }

      // Overlay closed
      clearAllUnreadCounts();
      overlayHandle = null;
      overlayTui = null;
      updateStatus(ctx);
    }
  });

  // ===========================================================================
  // Message Renderer
  // ===========================================================================

  pi.registerMessageRenderer<AgentMailMessage>("agent_message", (message, _options, theme) => {
    const details = message.details as AgentMailMessage & { message?: unknown; ts?: unknown };
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const text = typeof details.text === "string"
          ? details.text
          : typeof details.message === "string"
            ? details.message
            : "";
        const timestamp = typeof details.timestamp === "string"
          ? details.timestamp
          : typeof details.ts === "string"
            ? details.ts
            : "";
        const safeFrom = stripAnsiCodes(typeof details.from === "string" ? details.from : "");
        const safeText = stripAnsiCodes(text);
        
        const header = theme.fg("accent", `From ${safeFrom}`);
        const time = theme.fg("dim", ` (${formatRelativeTime(timestamp)})`);

        const result: string[] = [];
        result.push(truncateToWidth(header + time, width));
        result.push("");

        for (const line of safeText.split("\n")) {
          result.push(truncateToWidth(line, width));
        }

        return result;
      },
      invalidate() {}
    };
  });

  // ===========================================================================
  // Activity Tracking
  // ===========================================================================

  const EDIT_DEBOUNCE_MS = 5000;
  const REGISTRY_FLUSH_MS = 10000;
  const RECENT_WINDOW_MS = 60_000;
  const pendingEdits = new Map<string, ReturnType<typeof setTimeout>>();
  let recentCommit = false;
  let recentCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let recentTestRuns = 0;
  let recentTestTimer: ReturnType<typeof setTimeout> | null = null;
  let recentEdits = 0;
  let recentEditTimer: ReturnType<typeof setTimeout> | null = null;

  function updateLastActivity(): void {
    state.activity.lastActivityAt = new Date().toISOString();
  }

  function incrementToolCount(): void {
    state.session.toolCalls++;
  }

  function setCurrentActivity(activity: string): void {
    state.activity.currentActivity = activity;
  }

  function clearCurrentActivity(): void {
    state.activity.currentActivity = undefined;
  }

  function setLastToolCall(toolCall: string): void {
    state.activity.lastToolCall = toolCall;
  }

  function addModifiedFile(filePath: string): void {
    const files = state.session.filesModified;
    const idx = files.indexOf(filePath);
    if (idx !== -1) files.splice(idx, 1);
    files.push(filePath);
    if (files.length > 20) files.shift();
  }

  function debouncedLogEdit(filePath: string, cwd: string): void {
    const existing = pendingEdits.get(filePath);
    if (existing) clearTimeout(existing);
    pendingEdits.set(filePath, setTimeout(() => {
      logFeedEvent(cwd, state.agentName, "edit", filePath);
      pendingEdits.delete(filePath);
    }, EDIT_DEBOUNCE_MS));
  }

  function scheduleRegistryFlush(ctx: ExtensionContext): void {
    if (state.registryFlushTimer) return;
    state.registryFlushTimer = setTimeout(() => {
      state.registryFlushTimer = null;
      store.flushActivityToRegistry(state, dirs, ctx);
    }, REGISTRY_FLUSH_MS);
  }

  function isGitCommit(command: string): boolean {
    return /\bgit\s+commit\b/.test(command);
  }

  function isTestRun(command: string): boolean {
    return /\b(npm\s+test|npx\s+(jest|vitest|mocha)|pytest|go\s+test|cargo\s+test|bun\s+test)\b/.test(command);
  }

  function extractCommitMessage(command: string): string {
    const match = command.match(/-m\s+["']([^"']+)["']/);
    return match ? match[1] : "";
  }

  function updateAutoStatus(): void {
    if (!state.registered || !config.autoStatus || state.customStatus) return;

    const autoMsg = generateAutoStatus({
      currentActivity: state.activity.currentActivity,
      recentCommit,
      recentTestRuns,
      recentEdits,
      sessionStartedAt: state.sessionStartedAt,
    });

    state.statusMessage = autoMsg;
  }

  function trackRecentCommit(): void {
    recentCommit = true;
    if (recentCommitTimer) clearTimeout(recentCommitTimer);
    recentCommitTimer = setTimeout(() => { recentCommit = false; }, RECENT_WINDOW_MS);
  }

  function trackRecentTest(): void {
    recentTestRuns++;
    if (recentTestTimer) clearTimeout(recentTestTimer);
    recentTestTimer = setTimeout(() => { recentTestRuns = 0; }, RECENT_WINDOW_MS);
  }

  function trackRecentEdit(): void {
    recentEdits++;
    if (recentEditTimer) clearTimeout(recentEditTimer);
    recentEditTimer = setTimeout(() => { recentEdits = 0; }, RECENT_WINDOW_MS);
  }

  function shortenPath(filePath: string): string {
    const parts = filePath.split("/");
    return parts.length > 2 ? parts.slice(-2).join("/") : filePath;
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!state.registered) return;

    updateLastActivity();
    incrementToolCount();
    scheduleRegistryFlush(ctx);

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === "write" || toolName === "edit") {
      const path = input.path as string;
      if (path) {
        setCurrentActivity(`editing ${shortenPath(path)}`);
        debouncedLogEdit(path, ctx.cwd);
        trackRecentEdit();
      }
    } else if (toolName === "read") {
      const path = input.path as string;
      if (path) {
        setCurrentActivity(`reading ${shortenPath(path)}`);
      }
    } else if (toolName === "bash") {
      const command = input.command as string;
      if (command) {
        if (isGitCommit(command)) {
          setCurrentActivity("committing");
        } else if (isTestRun(command)) {
          setCurrentActivity("running tests");
        }
      }
    }

    updateAutoStatus();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!state.registered) return;

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === "write" || toolName === "edit") {
      const path = input.path as string;
      if (path) {
        setLastToolCall(`${toolName}: ${shortenPath(path)}`);
        addModifiedFile(path);
      }
    }

    if (toolName === "bash") {
      const command = input.command as string;
      if (command) {
        const cwd = ctx.cwd;
        if (isGitCommit(command)) {
          const msg = extractCommitMessage(command);
          logFeedEvent(cwd, state.agentName, "commit", undefined, msg);
          setLastToolCall(`commit: ${msg}`);
          trackRecentCommit();
        }
        if (isTestRun(command)) {
          const passed = !event.isError;
          logFeedEvent(cwd, state.agentName, "test", undefined, passed ? "passed" : "failed");
          setLastToolCall(`test: ${passed ? "passed" : "failed"}`);
          trackRecentTest();
        }
      }
    }

    clearCurrentActivity();
    updateAutoStatus();
    scheduleRegistryFlush(ctx);
  });

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    captureStatusContext(ctx);
    state.cwd = ctx.cwd;
    config = loadConfig(state.cwd);
    state.scopeToFolder = config.scopeToFolder;
    nameTheme.theme = config.nameTheme;
    nameTheme.customWords = config.nameWords;
    resetAutonomousContinueGuard();
    startStatusHeartbeat();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "crew-state") {
        restoreAutonomousState(entry.data as Parameters<typeof restoreAutonomousState>[0]);
      }
    }
    const { staleCleared } = restorePlanningState(state.cwd);
    if (staleCleared && ctx.hasUI) {
      ctx.ui.notify("Stale planning state cleared (planner process exited)", "warning");
    }

    state.isHuman = ctx.hasUI;
    try { fs.rmSync(join(homedir(), ".pi/agent/messenger/feed.jsonl"), { force: true }); } catch {}

    const shouldAutoRegister = config.autoRegister || 
      matchesAutoRegisterPath(state.cwd, config.autoRegisterPaths);

    if (!shouldAutoRegister) {
      maybeAutoOpenCrewOverlay(ctx);
      return;
    }

    if (store.register(state, dirs, ctx, nameTheme)) {
      const cwd = state.cwd;
      store.startWatcher(state, dirs, deliverMessage);
      updateStatus(ctx);
      pruneFeed(cwd, config.feedRetention);
      logFeedEvent(cwd, state.agentName, "join");

      if (config.registrationContext) {
        sendRegistrationContext(ctx);
      }
    }

    maybeAutoOpenCrewOverlay(ctx);
  });

  function recoverWatcherIfNeeded(): void {
    if (state.registered && !state.watcher && !state.watcherRetryTimer) {
      state.watcherRetries = 0;
      store.startWatcher(state, dirs, deliverMessage);
    }
  }

  function maybeAutoOpenCrewOverlay(ctx: ExtensionContext): void {
    const cwd = ctx.cwd;
    if (config.autoOverlayPlanning) {
      markPlanningOverlayPending(cwd);
    }

    const autonomousPending =
      config.autoOverlay &&
      autonomousState.active &&
      autonomousState.autoOverlayPending;

    const planningPending =
      config.autoOverlayPlanning ? getPlanningOverlayPending(cwd) : null;

    if ((!autonomousPending && !planningPending) || !ctx.hasUI || overlayTui || overlayOpening) {
      return;
    }

    if (autonomousPending) {
      autonomousState.autoOverlayPending = false;
    }

    const planningRunId = planningPending
      ? consumePlanningOverlayPending(cwd)?.runId ?? null
      : null;

    overlayOpening = true;
    const callbacks: OverlayCallbacks = {
      onBackground: (snapshotText) => {
        overlayHandle?.setHidden(true);
        pi.sendMessage({
          customType: "crew_snapshot",
          content: snapshotText,
          display: true,
        }, { triggerTurn: true });
      },
    };

    ctx.ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        overlayTui = tui;
        return new MessengerOverlay(tui, theme, state, dirs, done, callbacks, ctx.cwd);
      },
      {
        overlay: true,
        onHandle: (handle) => {
          overlayHandle = handle;
        },
      }
    ).then((snapshot) => {
      if (planningRunId) {
        dismissPlanningOverlayRun(planningRunId);
      }
      if (snapshot) {
        pi.sendMessage({
          customType: "crew_snapshot",
          content: snapshot,
          display: true,
        }, { triggerTurn: true });
      }
      clearAllUnreadCounts();
      overlayOpening = false;
      overlayHandle = null;
      overlayTui = null;
      updateStatus(ctx);
    }).catch(() => {
      overlayOpening = false;
      overlayHandle = null;
      overlayTui = null;
      if (config.autoOverlayPlanning) {
        markPlanningOverlayPending(cwd);
      }
    });
  }

  pi.on("session_tree", async (_event, ctx) => {
    captureStatusContext(ctx);
    const { staleCleared } = restorePlanningState(ctx.cwd);
    if (staleCleared && ctx.hasUI) {
      ctx.ui.notify("Stale planning state cleared (planner process exited)", "warning");
    }
    updateStatus(ctx);
    maybeAutoOpenCrewOverlay(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    captureStatusContext(ctx);
    store.processAllPendingMessages(state, dirs, deliverMessage);
    const lobbyId = process.env.PI_LOBBY_ID;
    if (lobbyId) {
      const cwd = ctx.cwd;
      const aliveFile = join(cwd, ".pi", "messenger", "crew", `lobby-${lobbyId}.alive`);
      if (fs.existsSync(aliveFile)) {
        pi.sendMessage({
          customType: "lobby_keepalive",
          content: "[Keep-alive] Planning in progress. No task assigned yet. Acknowledge with a single period.",
          display: false,
        }, { triggerTurn: true, deliverAs: "steer" });
      }
    }
    recoverWatcherIfNeeded();
    updateStatus(ctx);

    if (state.registered) {
      const msg = event.message as unknown as Record<string, unknown> | undefined;
      if (msg && msg.role === "assistant" && msg.usage) {
        const usage = msg.usage as { totalTokens?: number; input?: number; output?: number };
        const total = usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0));
        if (total > 0) {
          state.session.tokens += total;
          scheduleRegistryFlush(ctx);
        }
      }
    }

    maybeAutoOpenCrewOverlay(ctx);
  });

  // ===========================================================================
  // Crew Autonomous Mode Continuation
  // ===========================================================================

  pi.on("agent_end", async (_event, ctx) => {
    if (process.env.PI_CREW_WORKER === "1" || process.env.PI_LOBBY_ID) {
      return;
    }

    if (!state.registered) {
      if (autonomousState.active) {
        stopAutonomous("manual");
        pi.appendEntry("crew-state", autonomousState);
        resetAutonomousContinueGuard();
        if (ctx.hasUI) {
          ctx.ui.notify("Autonomous stopped: this session is not registered in pi-messenger.", "warning");
        }
      }
      return;
    }

    // --- Auto-work after plan completion ---
    const autoWork = consumePendingAutoWork();
    if (autoWork && !overlayTui) {
      const cwd = autoWork.cwd;
      const crewConfig = loadCrewConfig(crewStore.getCrewDir(cwd));
      const readyTasks = crewStore.getReadyTasks(cwd, { advisory: crewConfig.dependencies === "advisory" });
      const startableTasks = readyTasks.filter(t => !teamStore.taskNeedsApproval(t));
      if (startableTasks.length > 0) {
        const plan = crewStore.getPlan(cwd);
        const label = plan ? crewStore.getPlanLabel(plan) : "plan";
        pi.sendMessage({
          customType: "crew_auto_work",
          content: `Plan complete — ${startableTasks.length} task(s) ready for ${label}. Starting autonomous work.\n\nCall: pi_messenger({ action: "work", autonomous: true })`,
          display: true,
        }, { triggerTurn: true, deliverAs: "steer" });
        return;
      }
      if (readyTasks.length > 0) {
        const rejected = readyTasks.filter(teamStore.taskNeedsRevision);
        const pending = readyTasks.filter(teamStore.taskPendingApproval);
        pi.sendMessage({
          customType: rejected.length > 0 ? "crew_auto_work_needs_revision" : "crew_auto_work_needs_approval",
          content: rejected.length > 0
            ? `Plan complete — ${rejected.length} ready task(s) need revision before autonomous work can start.`
            : `Plan complete — ${pending.length} ready task(s) need lead approval before autonomous work can start.`,
          display: true,
        });
        return;
      }
    }

    // --- Existing autonomous continuation ---
    if (!autonomousState.active) {
      resetAutonomousContinueGuard();
      return;
    }

    const currentCwd = ctx.cwd;
    if (!isAutonomousForCwd(currentCwd)) {
      resetAutonomousContinueGuard();
      return;
    }

    const cwd = autonomousState.cwd ?? currentCwd;
    const crewDir = join(cwd, ".pi", "messenger", "crew");
    const crewConfig = loadCrewConfig(crewDir);

    // Check max waves limit
    if (autonomousState.waveNumber >= crewConfig.work.maxWaves) {
      stopAutonomous("manual");
      pi.appendEntry("crew-state", autonomousState);
      resetAutonomousContinueGuard();
      if (ctx.hasUI) {
        ctx.ui.notify(`Autonomous stopped: max waves (${crewConfig.work.maxWaves}) reached`, "warning");
      }
      return;
    }

    // Check for ready tasks
    const readyTasks = crewStore.getReadyTasks(cwd, { advisory: crewConfig.dependencies === "advisory" });
    const startableTasks = readyTasks.filter(t => !teamStore.taskNeedsApproval(t));

    if (startableTasks.length === 0) {
      // No ready tasks - check if all done or blocked
      const allTasks = crewStore.getTasks(cwd);
      const allDone = allTasks.every(t => t.status === "done");
      const needsApproval = readyTasks.filter(teamStore.taskPendingApproval);
      const rejected = readyTasks.filter(teamStore.taskNeedsRevision);

      stopAutonomous(allDone ? "completed" : "blocked");
      pi.appendEntry("crew-state", autonomousState);
      resetAutonomousContinueGuard();

      const plan = crewStore.getPlan(cwd);
      if (ctx.hasUI) {
        if (allDone) {
          ctx.ui.notify(`✅ All tasks complete for ${plan?.prd ?? "plan"}!`, "info");
        } else if (rejected.length > 0) {
          ctx.ui.notify(`Autonomous stopped: ${rejected.length} task(s) need revision`, "warning");
        } else if (needsApproval.length > 0) {
          ctx.ui.notify(`Autonomous stopped: ${needsApproval.length} task(s) need lead approval`, "warning");
        } else {
          const blocked = allTasks.filter(t => t.status === "blocked");
          ctx.ui.notify(`Autonomous stopped: ${blocked.length} task(s) blocked`, "warning");
        }
      }
      return;
    }

    const continueSignature = `${cwd}:${autonomousState.waveNumber}:${startableTasks.map(task => task.id).sort().join(",")}`;
    const continueRepeatCount = trackAutonomousContinue(continueSignature);
    if (continueRepeatCount >= AUTONOMOUS_CONTINUE_REPEAT_LIMIT) {
      stopAutonomous("manual");
      pi.appendEntry("crew-state", autonomousState);
      resetAutonomousContinueGuard();

      const plan = crewStore.getPlan(cwd);
      const message = `Autonomous work on ${plan?.prd ?? "plan"} stopped after ${continueRepeatCount} repeated continuation retries without wave progress. Resolve the abort condition, then run pi_messenger({ action: "work", autonomous: true }).`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
      pi.sendMessage({
        customType: "crew_continue_stopped",
        content: message,
        display: true,
      });
      return;
    }

    // Continue to next wave
    // Note: waveNumber was already incremented by addWaveResult() in work.ts
    const plan = crewStore.getPlan(cwd);
    pi.sendMessage({
      customType: "crew_continue",
      content: `Continuing autonomous work on ${plan?.prd ?? "plan"}. Wave ${autonomousState.waveNumber} with ${startableTasks.length} ready task(s).`,
      display: true
    }, { triggerTurn: true, deliverAs: "steer" });

    // The steer message will trigger the LLM to call work again
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    latestCtx = null;
    const cwd = ctx.cwd || state.cwd;
    if (cwd) {
      shutdownLobbyWorkers(cwd);
    }
    shutdownAllWorkers();
    stopStatusHeartbeat();
    overlayOpening = false;
    overlayHandle = null;
    overlayTui = null;
    if (cwd && isPlanningForCwd(cwd) && planningState.pid === process.pid) {
      clearPlanningState(cwd);
    }
    if (cwd && state.registered) {
      logFeedEvent(cwd, state.agentName, "leave");
    }
    if (state.registryFlushTimer) {
      clearTimeout(state.registryFlushTimer);
      state.registryFlushTimer = null;
    }
    for (const timer of pendingEdits.values()) {
      clearTimeout(timer);
    }
    pendingEdits.clear();
    if (recentCommitTimer) { clearTimeout(recentCommitTimer); recentCommitTimer = null; }
    if (recentTestTimer) { clearTimeout(recentTestTimer); recentTestTimer = null; }
    if (recentEditTimer) { clearTimeout(recentEditTimer); recentEditTimer = null; }
    store.stopWatcher(state);
    try {
      store.unregister(state, dirs);
    } catch {
      // Safe to ignore during shutdown: the process is exiting, so any leftover
      // registration will be cleaned up as stale on the next registry read.
    }
  });

  // ===========================================================================
  // Reservation Enforcement
  // ===========================================================================

  pi.on("tool_call", async (event, _ctx) => {
    if (!["edit", "write"].includes(event.toolName)) return;

    const input = event.input as Record<string, unknown>;
    const filePath = typeof input.path === "string" ? input.path : null;
    if (!filePath) return;

    const conflicts = store.getConflictsWithOtherAgents(filePath, state, dirs);
    if (conflicts.length === 0) return;

    const c = conflicts[0];
    const folder = extractFolder(c.registration.cwd);
    const locationPart = c.registration.gitBranch
      ? ` (in ${folder} on ${c.registration.gitBranch})`
      : ` (in ${folder})`;

    const lines = [filePath, `Reserved by: ${c.agent}${locationPart}`];
    if (c.reason) lines.push(`Reason: "${c.reason}"`);
    lines.push("");
    lines.push(`Coordinate via pi_messenger({ action: "send", to: "${c.agent}", message: "..." })`);

    return { block: true, reason: lines.join("\n") };
  });
}
