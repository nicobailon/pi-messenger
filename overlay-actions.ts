import { randomUUID } from "node:crypto";
import { matchesKey, type TUI } from "@mariozechner/pi-tui";
import type { AgentMailMessage, Dirs, MessengerState } from "./lib.js";
import { MAX_CHAT_HISTORY } from "./lib.js";
import { sendMessageToAgent, getActiveAgents } from "./store.js";
import { logFeedEvent } from "./feed.js";
import * as crewStore from "./crew/store.js";
import { executeTaskAction as runTaskAction } from "./crew/task-actions.js";
import type { Task } from "./crew/types.js";
import { getLiveWorkers } from "./crew/live-progress.js";
import { hasActiveWorker } from "./crew/registry.js";
import { cancelPlanningRun } from "./crew/state.js";

interface ConfirmAction {
  type: "reset" | "cascade-reset" | "delete" | "cancel-planning";
  taskId: string;
  label: string;
}

export interface CrewViewState {
  scrollOffset: number;
  selectedTaskIndex: number;
  mode: "list" | "detail";
  detailScroll: number;
  detailAutoScroll: boolean;
  confirmAction: ConfirmAction | null;
  blockReasonInput: string;
  messageInput: string;
  inputMode: "normal" | "block-reason" | "message" | "revise-prompt";
  reviseScope: "single" | "tree";
  revisePromptInput: string;
  lastSeenEventTs: string | null;
  notification: { message: string; expiresAt: number } | null;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  feedFocus: boolean;
  mentionCandidates: string[];
  mentionIndex: number;
}

export function createCrewViewState(): CrewViewState {
  return {
    scrollOffset: 0,
    selectedTaskIndex: 0,
    mode: "list",
    detailScroll: 0,
    detailAutoScroll: true,
    confirmAction: null,
    blockReasonInput: "",
    messageInput: "",
    inputMode: "normal",
    reviseScope: "single",
    revisePromptInput: "",
    lastSeenEventTs: null,
    notification: null,
    notificationTimer: null,
    feedFocus: false,
    mentionCandidates: [],
    mentionIndex: -1,
  };
}

function hasLiveWorker(cwd: string, taskId: string): boolean {
  return hasActiveWorker(cwd, taskId);
}

function isPrintable(data: string): boolean {
  return data.length > 0 && data.charCodeAt(0) >= 32;
}

function executeTaskAction(
  cwd: string,
  action: string,
  taskId: string,
  agentName: string,
  reason?: string,
): { success: boolean; message: string } {
  if (
    action !== "start" &&
    action !== "block" &&
    action !== "unblock" &&
    action !== "reset" &&
    action !== "cascade-reset" &&
    action !== "delete" &&
    action !== "stop"
  ) {
    return { success: false, message: `Unknown action: ${action}` };
  }

  const result = runTaskAction(cwd, action, taskId, agentName, reason, {
    isWorkerActive: id => hasLiveWorker(cwd, id),
  });
  return { success: result.success, message: result.message };
}

export function setNotification(viewState: CrewViewState, tui: TUI, success: boolean, message: string): void {
  if (viewState.notificationTimer) clearTimeout(viewState.notificationTimer);
  viewState.notification = { message: `${success ? "✓" : "✗"} ${message}`, expiresAt: Date.now() + 2000 };
  viewState.notificationTimer = setTimeout(() => {
    viewState.notificationTimer = null;
    tui.requestRender();
  }, 2000);
}

function addToChatHistory(state: MessengerState, recipient: string, message: AgentMailMessage): void {
  let history = state.chatHistory.get(recipient);
  if (!history) {
    history = [];
    state.chatHistory.set(recipient, history);
  }
  history.push(message);
  if (history.length > MAX_CHAT_HISTORY) history.shift();
}

function addToBroadcastHistory(state: MessengerState, text: string): void {
  const broadcastMsg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to: "broadcast",
    text,
    timestamp: new Date().toISOString(),
    replyTo: null,
  };
  state.broadcastHistory.push(broadcastMsg);
  if (state.broadcastHistory.length > MAX_CHAT_HISTORY) {
    state.broadcastHistory.shift();
  }
}

function previewText(text: string): string {
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export function handleConfirmInput(data: string, viewState: CrewViewState, cwd: string, agentName: string, tui: TUI): void {
  const action = viewState.confirmAction;
  if (!action) return;
  if (matchesKey(data, "y")) {
    if (action.type === "cancel-planning") {
      cancelPlanningRun(cwd);
      logFeedEvent(cwd, agentName, "plan.cancel");
      viewState.confirmAction = null;
      setNotification(viewState, tui, true, "Planning cancelled");
      tui.requestRender();
      return;
    }
    const result = executeTaskAction(cwd, action.type, action.taskId, agentName);
    if (action.type === "delete") {
      const tasks = crewStore.getTasks(cwd);
      if (tasks.length > 0) {
        viewState.selectedTaskIndex = Math.max(0, Math.min(viewState.selectedTaskIndex, tasks.length - 1));
      } else {
        viewState.selectedTaskIndex = 0;
        if (viewState.mode === "detail") viewState.mode = "list";
      }
    }
    viewState.confirmAction = null;
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "n") || matchesKey(data, "escape")) {
    viewState.confirmAction = null;
    tui.requestRender();
  }
}

export function handleBlockReasonInput(
  data: string,
  viewState: CrewViewState,
  cwd: string,
  task: Task | undefined,
  agentName: string,
  tui: TUI,
): void {
  if (matchesKey(data, "escape")) {
    viewState.inputMode = "normal";
    viewState.blockReasonInput = "";
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "enter")) {
    const reason = viewState.blockReasonInput.trim();
    if (!reason || !task) return;
    const result = executeTaskAction(cwd, "block", task.id, agentName, reason);
    viewState.inputMode = "normal";
    viewState.blockReasonInput = "";
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "backspace")) {
    if (viewState.blockReasonInput.length > 0) {
      viewState.blockReasonInput = viewState.blockReasonInput.slice(0, -1);
      tui.requestRender();
    }
    return;
  }
  if (isPrintable(data)) {
    viewState.blockReasonInput += data;
    tui.requestRender();
  }
}

export function handleRevisePromptInput(
  data: string,
  viewState: CrewViewState,
  cwd: string,
  task: Task | undefined,
  agentName: string,
  tui: TUI,
): void {
  if (matchesKey(data, "escape")) {
    viewState.inputMode = "normal";
    viewState.revisePromptInput = "";
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "enter")) {
    if (!task) return;
    if (task.status === "in_progress") {
      setNotification(viewState, tui, false, "Cannot revise in_progress task");
      viewState.inputMode = "normal";
      viewState.revisePromptInput = "";
      tui.requestRender();
      return;
    }

    const prompt = viewState.revisePromptInput.trim() || undefined;
    const scope = viewState.reviseScope;
    viewState.inputMode = "normal";
    viewState.revisePromptInput = "";

    const label = scope === "tree" ? `Revising ${task.id} + tree...` : `Revising ${task.id}...`;
    setNotification(viewState, tui, true, label);

    const vs = viewState;
    const t = tui;
    const fn = scope === "tree" ? "executeReviseTree" : "executeRevise";
    import("./crew/handlers/revise.js")
      .then(m => m[fn](cwd, task.id, prompt, agentName))
      .then(result => {
        setNotification(vs, t, result.success, result.message);
      })
      .catch(err => {
        logFeedEvent(cwd, agentName, scope === "tree" ? "task.revise-tree" : "task.revise", task.id, `failed: ${err instanceof Error ? err.message : "unknown"}`);
      });
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "backspace")) {
    if (viewState.revisePromptInput.length > 0) {
      viewState.revisePromptInput = viewState.revisePromptInput.slice(0, -1);
      tui.requestRender();
    }
    return;
  }
  if (isPrintable(data)) {
    viewState.revisePromptInput += data;
    tui.requestRender();
  }
}

function resetMessageInput(viewState: CrewViewState): void {
  viewState.inputMode = "normal";
  viewState.messageInput = "";
  viewState.mentionCandidates = [];
  viewState.mentionIndex = -1;
}

function collectMentionCandidates(
  prefix: string,
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const agent of getActiveAgents(state, dirs)) {
    if (agent.name === state.agentName) continue;
    if (!seen.has(agent.name)) {
      seen.add(agent.name);
      names.push(agent.name);
    }
  }

  for (const worker of getLiveWorkers(cwd).values()) {
    if (!seen.has(worker.name)) {
      seen.add(worker.name);
      names.push(worker.name);
    }
  }

  names.push("all");

  if (!prefix) return names;
  const lower = prefix.toLowerCase();
  return names.filter(n => n.toLowerCase().startsWith(lower));
}

function sendDirectMessage(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  target: string,
  text: string,
  tui: TUI,
  viewState: CrewViewState,
): void {
  try {
    const msg = sendMessageToAgent(state, dirs, target, text);
    addToChatHistory(state, target, msg);
    logFeedEvent(cwd, state.agentName, "message", target, previewText(text));
    resetMessageInput(viewState);
    setNotification(viewState, tui, true, `Sent to ${target}`);
    tui.requestRender();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    setNotification(viewState, tui, false, `Failed to send to ${target}: ${msg}`);
    tui.requestRender();
  }
}

function sendBroadcastMessage(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  text: string,
  tui: TUI,
  viewState: CrewViewState,
): void {
  const peers = getActiveAgents(state, dirs);
  if (peers.length === 0) {
    setNotification(viewState, tui, false, "No peers available for @all");
    tui.requestRender();
    return;
  }

  let sentCount = 0;
  for (const peer of peers) {
    try {
      sendMessageToAgent(state, dirs, peer.name, text);
      sentCount++;
    } catch {
      // Ignore per-recipient failures
    }
  }

  if (sentCount === 0) {
    setNotification(viewState, tui, false, "Broadcast failed");
    tui.requestRender();
    return;
  }

  addToBroadcastHistory(state, text);
  logFeedEvent(cwd, state.agentName, "message", undefined, previewText(text));
  resetMessageInput(viewState);
  setNotification(viewState, tui, true, `Broadcast to ${sentCount} peer${sentCount === 1 ? "" : "s"}`);
  tui.requestRender();
}

export function handleMessageInput(
  data: string,
  viewState: CrewViewState,
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  tui: TUI,
): void {
  if (matchesKey(data, "escape")) {
    resetMessageInput(viewState);
    tui.requestRender();
    return;
  }

  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    const input = viewState.messageInput;
    const cycling = viewState.mentionIndex >= 0 && viewState.mentionCandidates.length > 0;
    if (!input.startsWith("@") || (input.includes(" ") && !cycling)) return;

    const reverse = matchesKey(data, "shift+tab");

    if (!cycling) {
      const prefix = input.slice(1);
      viewState.mentionCandidates = collectMentionCandidates(prefix, state, dirs, cwd);
      if (viewState.mentionCandidates.length === 0) return;
      viewState.mentionIndex = 0;
    } else {
      const delta = reverse ? -1 : 1;
      viewState.mentionIndex = (viewState.mentionIndex + delta + viewState.mentionCandidates.length) % viewState.mentionCandidates.length;
    }

    viewState.messageInput = `@${viewState.mentionCandidates[viewState.mentionIndex]} `;
    tui.requestRender();
    return;
  }

  if (matchesKey(data, "enter")) {
    const raw = viewState.messageInput.trim();
    if (!raw) return;

    if (raw.startsWith("@all ")) {
      const text = raw.slice(5).trim();
      if (!text) return;
      sendBroadcastMessage(state, dirs, cwd, text, tui, viewState);
      return;
    }

    if (raw.startsWith("@")) {
      const firstSpace = raw.indexOf(" ");
      if (firstSpace <= 1) {
        setNotification(viewState, tui, false, "Use @name <message> or type to broadcast");
        tui.requestRender();
        return;
      }

      const target = raw.slice(1, firstSpace).trim();
      const text = raw.slice(firstSpace + 1).trim();
      if (!target || !text) {
        setNotification(viewState, tui, false, "Use @name <message> or type to broadcast");
        tui.requestRender();
        return;
      }

      sendDirectMessage(state, dirs, cwd, target, text, tui, viewState);
      return;
    }

    sendBroadcastMessage(state, dirs, cwd, raw, tui, viewState);
    return;
  }

  if (matchesKey(data, "backspace")) {
    if (viewState.messageInput.length > 0) {
      viewState.messageInput = viewState.messageInput.slice(0, -1);
      viewState.mentionCandidates = [];
      viewState.mentionIndex = -1;
      tui.requestRender();
    }
    return;
  }

  if (isPrintable(data)) {
    viewState.messageInput += data;
    viewState.mentionCandidates = [];
    viewState.mentionIndex = -1;
    tui.requestRender();
  }
}

export function handleCrewKeyBinding(
  data: string,
  task: Task,
  viewState: CrewViewState,
  cwd: string,
  agentName: string,
  tui: TUI,
): void {
  if (matchesKey(data, "r") && ["done", "blocked", "in_progress"].includes(task.status)) {
    viewState.confirmAction = { type: "reset", taskId: task.id, label: task.title };
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "shift+r") && ["done", "blocked", "in_progress"].includes(task.status)) {
    viewState.confirmAction = { type: "cascade-reset", taskId: task.id, label: task.title };
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "u") && task.status === "blocked") {
    const result = executeTaskAction(cwd, "unblock", task.id, agentName);
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "shift+s") && task.status !== "done" && !task.milestone) {
    setNotification(viewState, tui, true, `Split: pi_messenger({ action: "task.split", id: "${task.id}" })`);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "b") && task.status === "in_progress") {
    viewState.inputMode = "block-reason";
    viewState.blockReasonInput = "";
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "q") && task.status === "in_progress") {
    const result = executeTaskAction(cwd, "stop", task.id, agentName);
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "x")) {
    if (task.status === "in_progress" && hasLiveWorker(cwd, task.id)) return;
    viewState.confirmAction = { type: "delete", taskId: task.id, label: task.title };
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "p") && task.status !== "in_progress" && !task.milestone) {
    viewState.inputMode = "revise-prompt";
    viewState.reviseScope = "single";
    viewState.revisePromptInput = "";
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "shift+p") && task.status !== "in_progress" && !task.milestone) {
    viewState.inputMode = "revise-prompt";
    viewState.reviseScope = "tree";
    viewState.revisePromptInput = "";
    tui.requestRender();
    return;
  }
}
