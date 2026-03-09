/**
 * Pi Messenger - Types and Pure Utilities
 */

import type * as fs from "node:fs";
import { basename, isAbsolute, resolve, relative } from "node:path";
import { appendFeedEvent } from "./feed.js";

// =============================================================================
// Types
// =============================================================================

export interface FileReservation {
  pattern: string;
  reason?: string;
  since: string;
}

export interface AgentSession {
  toolCalls: number;
  tokens: number;
  filesModified: string[];
}

export interface AgentActivity {
  lastActivityAt: string;
  currentActivity?: string;
  lastToolCall?: string;
}

export interface AgentRegistration {
  name: string;
  pid: number;
  sessionId: string;
  cwd: string;
  model: string;
  startedAt: string;
  reservations?: FileReservation[];
  gitBranch?: string;
  spec?: string;
  isHuman: boolean;
  session: AgentSession;
  activity: AgentActivity;
  statusMessage?: string;
}

export interface AgentMailMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  replyTo: string | null;
}

export interface ReservationConflict {
  path: string;
  agent: string;
  pattern: string;
  reason?: string;
  registration: AgentRegistration;
}

export interface MessengerState {
  agentName: string;
  registered: boolean;
  watcher: fs.FSWatcher | null;
  watcherRetries: number;
  watcherRetryTimer: ReturnType<typeof setTimeout> | null;
  watcherDebounceTimer: ReturnType<typeof setTimeout> | null;
  reservations: FileReservation[];
  chatHistory: Map<string, AgentMailMessage[]>;
  unreadCounts: Map<string, number>;
  broadcastHistory: AgentMailMessage[];
  seenSenders: Map<string, string>;
  model: string;
  gitBranch?: string;
  spec?: string;
  scopeToFolder: boolean;
  isHuman: boolean;
  session: AgentSession;
  activity: AgentActivity;
  statusMessage?: string;
  customStatus: boolean;
  registryFlushTimer: ReturnType<typeof setTimeout> | null;
  sessionStartedAt: string;
}

export interface Dirs {
  base: string;
  registry: string;
  inbox: string;
}

export interface ClaimEntry {
  agent: string;
  sessionId: string;
  pid: number;
  claimedAt: string;
  reason?: string;
}

export interface CompletionEntry {
  completedBy: string;
  completedAt: string;
  notes?: string;
}

export type SpecClaims = Record<string, ClaimEntry>;
export type SpecCompletions = Record<string, CompletionEntry>;
export type AllClaims = Record<string, SpecClaims>;
export type AllCompletions = Record<string, SpecCompletions>;

export type AgentStatus = "active" | "idle" | "away" | "stuck";

export interface ComputedStatus {
  status: AgentStatus;
  idleFor?: string;
}

export function computeStatus(
  lastActivityAt: string,
  hasTask: boolean,
  hasReservation: boolean,
  thresholdMs: number
): ComputedStatus {
  const elapsed = Date.now() - new Date(lastActivityAt).getTime();
  if (isNaN(elapsed) || elapsed < 0) {
    return { status: "active" };
  }
  const ACTIVE_MS = 30_000;
  const IDLE_MS = 5 * 60_000;

  if (elapsed < ACTIVE_MS) {
    return { status: "active" };
  }
  if (elapsed < IDLE_MS) {
    return { status: "idle", idleFor: formatDuration(elapsed) };
  }
  if (!hasTask && !hasReservation) {
    return { status: "away", idleFor: formatDuration(elapsed) };
  }
  if (elapsed >= thresholdMs) {
    return { status: "stuck", idleFor: formatDuration(elapsed) };
  }
  return { status: "idle", idleFor: formatDuration(elapsed) };
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export const STATUS_INDICATORS: Record<AgentStatus, string> = {
  active: "\u{1F7E2}",
  idle: "\u{1F7E1}",
  away: "\u{1F7E0}",
  stuck: "\u{1F534}",
};

export interface AutoStatusContext {
  currentActivity?: string;
  recentCommit: boolean;
  recentTestRuns: number;
  recentEdits: number;
  sessionStartedAt: string;
}

export function generateAutoStatus(ctx: AutoStatusContext): string | undefined {
  const sessionAge = Date.now() - new Date(ctx.sessionStartedAt).getTime();

  if (sessionAge < 30_000) {
    return "just arrived";
  }

  if (ctx.recentCommit) {
    return "just shipped";
  }

  if (ctx.recentTestRuns >= 3) {
    return "debugging...";
  }

  if (ctx.recentEdits >= 8) {
    return "on fire \u{1F525}";
  }

  if (ctx.currentActivity?.startsWith("reading")) {
    return "exploring the codebase";
  }

  if (ctx.currentActivity?.startsWith("editing")) {
    return "deep in thought";
  }

  return undefined;
}

// =============================================================================
// Constants
// =============================================================================

export const MAX_WATCHER_RETRIES = 5;
export const MAX_CHAT_HISTORY = 50;

const AGENT_COLORS = [
  "38;2;178;129;214",  // purple
  "38;2;215;135;175",  // pink  
  "38;2;254;188;56",   // gold
  "38;2;137;210;129",  // green
  "38;2;0;175;175",    // cyan
  "38;2;23;143;185",   // blue
  "38;2;228;192;15",   // yellow
  "38;2;255;135;135",  // coral
];

const DEFAULT_ADJECTIVES = [
  "Swift", "Bright", "Calm", "Dark", "Epic", "Fast", "Gold", "Happy",
  "Iron", "Jade", "Keen", "Loud", "Mint", "Nice", "Oak", "Pure",
  "Quick", "Red", "Sage", "True", "Ultra", "Vivid", "Wild", "Young", "Zen"
];

const DEFAULT_NOUNS = [
  "Arrow", "Bear", "Castle", "Dragon", "Eagle", "Falcon", "Grove", "Hawk",
  "Ice", "Jaguar", "Knight", "Lion", "Moon", "Nova", "Owl", "Phoenix",
  "Quartz", "Raven", "Storm", "Tiger", "Union", "Viper", "Wolf", "Xenon", "Yak", "Zenith"
];

const NATURE_ADJECTIVES = [
  "Oak", "River", "Mountain", "Cedar", "Storm", "Meadow", "Frost", "Coral",
  "Willow", "Stone", "Ember", "Moss", "Tide", "Fern", "Cloud", "Pine"
];
const NATURE_NOUNS = [
  "Tree", "Stone", "Wind", "Brook", "Peak", "Valley", "Lake", "Ridge",
  "Creek", "Glade", "Fox", "Heron", "Sage", "Thorn", "Dawn", "Dusk"
];

const SPACE_ADJECTIVES = [
  "Nova", "Lunar", "Cosmic", "Solar", "Stellar", "Astral", "Nebula", "Orbit",
  "Pulse", "Quasar", "Void", "Zenith", "Aurora", "Comet", "Warp", "Ion"
];
const SPACE_NOUNS = [
  "Star", "Dust", "Ray", "Flare", "Drift", "Core", "Ring", "Gate",
  "Spark", "Beam", "Wave", "Shard", "Forge", "Bolt", "Glow", "Arc"
];

const MINIMAL_NAMES = [
  "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta",
  "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi",
  "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega"
];

export interface NameThemeConfig {
  theme: string;
  customWords?: { adjectives: string[]; nouns: string[] };
}

// =============================================================================
// Pure Utilities
// =============================================================================

export function generateMemorableName(themeConfig?: NameThemeConfig): string {
  const themeName = themeConfig?.theme ?? "default";

  if (themeName === "minimal") {
    return MINIMAL_NAMES[Math.floor(Math.random() * MINIMAL_NAMES.length)];
  }

  let adjectives: string[];
  let nouns: string[];

  switch (themeName) {
    case "nature":
      adjectives = NATURE_ADJECTIVES;
      nouns = NATURE_NOUNS;
      break;
    case "space":
      adjectives = SPACE_ADJECTIVES;
      nouns = SPACE_NOUNS;
      break;
    case "custom":
      adjectives = themeConfig?.customWords?.adjectives ?? DEFAULT_ADJECTIVES;
      nouns = themeConfig?.customWords?.nouns ?? DEFAULT_NOUNS;
      break;
    default:
      adjectives = DEFAULT_ADJECTIVES;
      nouns = DEFAULT_NOUNS;
      break;
  }

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return adj + noun;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isValidAgentName(name: string): boolean {
  if (!name || name.length > 50) return false;
  return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(name);
}

export function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export function pathMatchesReservation(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/")) {
    return filePath.startsWith(pattern) || filePath + "/" === pattern;
  }
  return filePath === pattern;
}

export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

const colorCache = new Map<string, string>();

export function agentColorCode(name: string): string {
  const cached = colorCache.get(name);
  if (cached) return cached;

  let hash = 0;
  for (const char of name) hash = ((hash << 5) - hash) + char.charCodeAt(0);
  const color = AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
  colorCache.set(name, color);
  return color;
}

export function coloredAgentName(name: string): string {
  return `\x1b[${agentColorCode(name)}m${name}\x1b[0m`;
}

// =============================================================================
// Cost Estimation
// =============================================================================

/** Model pricing per 1M tokens (input, output) in USD */
const MODEL_PRICING: Record<string, [number, number]> = {
  "claude-sonnet-4-5": [3.0, 15.0],
  "claude-sonnet-4": [3.0, 15.0],
  "claude-opus-4": [15.0, 75.0],
  "claude-haiku-4": [0.80, 4.0],
  "gpt-4o": [2.5, 10.0],
  "gpt-4.1": [2.0, 8.0],
  "gemini-2.5-pro": [1.25, 10.0],
  "gemini-2.5-flash": [0.15, 0.60],
  "o3": [2.0, 8.0],
  "o4-mini": [1.10, 4.40],
  "deepseek-r1": [0.55, 2.19],
};

export function estimateCost(tokens: number, model?: string): number {
  if (!model || tokens === 0) return 0;
  const key = Object.keys(MODEL_PRICING).find(k => model.toLowerCase().includes(k));
  if (!key) return 0;
  const [inputRate, outputRate] = MODEL_PRICING[key];
  // Rough estimate: assume 60% input, 40% output
  const avgRate = (inputRate * 0.6 + outputRate * 0.4) / 1_000_000;
  return tokens * avgRate;
}

export function formatCost(cost: number): string {
  if (cost === 0) return "";
  if (cost < 0.01) return `~$${(cost * 100).toFixed(1)}¢`;
  return `~$${cost.toFixed(2)}`;
}

// =============================================================================
// Progress Bar
// =============================================================================

export function renderProgressBar(completed: number, total: number, width: number): string {
  if (total === 0) return "";
  const pct = Math.min(1, completed / total);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pctStr = `${Math.round(pct * 100)}%`;
  return `${bar} ${completed}/${total} (${pctStr})`;
}

// =============================================================================
// Spinner
// =============================================================================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function getSpinnerFrame(): string {
  const idx = Math.floor(Date.now() / 100) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[idx];
}

// =============================================================================
// Tool Icons
// =============================================================================

export const TOOL_ICONS: Record<string, string> = {
  read: "📖",
  edit: "✏️",
  write: "💾",
  bash: "$",
  ls: "📂",
  fetch_content: "🌐",
  web_search: "🔍",
  mcp: "🔌",
  interactive_shell: "🖥️",
  interview: "📋",
  design_deck: "🎨",
  switch_model: "🔄",
  review_loop: "🔁",
  annotate: "🏷️",
};

export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? "⚙️";
}

// =============================================================================
// Sparkline
// =============================================================================

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function renderSparkline(values: number[], width: number): string {
  if (values.length === 0) return "";
  const display = values.slice(-width);
  const max = Math.max(...display, 1);
  return display.map(v => SPARK_CHARS[Math.min(7, Math.floor((v / max) * 7))]).join("");
}

/**
 * Render a file tree visualization from file paths.
 * 
 *   src/
 *   ├── auth.ts  ✏️
 *   └── utils/
 *       └── hash.ts  💾
 */
export function renderFileTree(
  files: Array<{ path: string; action?: string }>,
  maxWidth = 60,
): string[] {
  if (files.length === 0) return [];

  // Build tree
  const tree: Record<string, unknown> = {};
  for (const { path: fp, action } of files) {
    const parts = fp.replace(/^~\//, "").split("/");
    let node = tree as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = action || "modified";
  }

  const lines: string[] = [];
  renderTreeNode(tree, "", lines, maxWidth);
  return lines;
}

function renderTreeNode(
  node: Record<string, unknown>,
  prefix: string,
  lines: string[],
  maxWidth: number,
): void {
  const entries = Object.entries(node);
  for (let i = 0; i < entries.length; i++) {
    const [name, value] = entries[i];
    const last = i === entries.length - 1;
    const connector = last ? "└── " : "├── ";
    const childPrefix = prefix + (last ? "    " : "│   ");

    if (typeof value === "string") {
      const icon = value === "created" ? " 💾" : value === "deleted" ? " 🗑️" : " ✏️";
      lines.push((prefix + connector + name + icon).slice(0, maxWidth));
    } else {
      lines.push((prefix + connector + name + "/").slice(0, maxWidth));
      renderTreeNode(value as Record<string, unknown>, childPrefix, lines, maxWidth);
    }
  }
}

/**
 * Render an agent execution pipeline visualization.
 * 
 *   ✓ Plan ─→ ● Execute ─→ ○ Review ─→ ○ Done
 */
export function renderAgentPipeline(
  steps: Array<{ label: string; status: "done" | "active" | "pending" | "error" }>,
): string {
  return steps.map(step => {
    const icon = step.status === "done" ? "✓"
               : step.status === "active" ? "●"
               : step.status === "error" ? "✗"
               : "○";
    return `${icon} ${step.label}`;
  }).join(" ─→ ");
}

/**
 * Render a diff stats bar: +5 -3 ████░░ 8 changes
 */
export function renderDiffStatsBar(diffText: string): string {
  let additions = 0, deletions = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  const total = additions + deletions;
  if (total === 0) return "";
  const barW = Math.min(12, total);
  const addBar = Math.max(0, Math.round((additions / total) * barW));
  const delBar = barW - addBar;
  return `+${additions} -${deletions}  ${"█".repeat(addBar)}${"░".repeat(delBar)}  ${total} changes`;
}

export function extractFolder(cwd: string): string {
  return basename(cwd) || cwd;
}

export function resolveSpecPath(specPath: string, cwd: string): string {
  if (isAbsolute(specPath)) return specPath;
  return resolve(cwd, specPath);
}

export function displaySpecPath(absPath: string, cwd: string): string {
  try {
    const rel = relative(cwd, absPath);
    if (rel === "") return ".";
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return "./" + rel;
    }
  } catch {
    // Ignore and fall back to absolute
  }
  return absPath;
}

export function truncatePathLeft(filePath: string, maxLen: number): string {
  if (filePath.length <= maxLen) return filePath;
  if (maxLen <= 1) return '…';
  const truncated = filePath.slice(-(maxLen - 1));
  const slashIdx = truncated.indexOf('/');
  if (slashIdx > 0) {
    return '…' + truncated.slice(slashIdx);
  }
  return '…' + truncated;
}

export function buildSelfRegistration(state: MessengerState): AgentRegistration {
  return {
    name: state.agentName,
    pid: process.pid,
    sessionId: "",
    cwd: process.cwd(),
    model: state.model,
    startedAt: state.sessionStartedAt,
    gitBranch: state.gitBranch,
    spec: state.spec,
    isHuman: state.isHuman,
    session: { ...state.session },
    activity: { ...state.activity },
    reservations: state.reservations.length > 0 ? state.reservations : undefined,
    statusMessage: state.statusMessage,
  };
}

export function agentHasTask(
  name: string,
  allClaims: AllClaims,
  crewTasks: Array<{ assigned_to?: string; status: string }>
): boolean {
  for (const tasks of Object.values(allClaims)) {
    for (const claim of Object.values(tasks)) {
      if (claim.agent === name) return true;
    }
  }
  return crewTasks.some(t => t.assigned_to === name && t.status === "in_progress");
}

export type DisplayMode = "same-folder-branch" | "same-folder" | "different";

export function getDisplayMode(agents: AgentRegistration[]): DisplayMode {
  if (agents.length === 0) return "different";
  
  const folders = agents.map(a => extractFolder(a.cwd));
  const uniqueFolders = new Set(folders);
  
  if (uniqueFolders.size > 1) return "different";
  
  const branches = agents.map(a => a.gitBranch).filter(Boolean);
  const uniqueBranches = new Set(branches);
  
  if (uniqueBranches.size <= 1) return "same-folder-branch";
  
  return "same-folder";
}

// =============================================================================
// Task Heartbeat Infrastructure
// =============================================================================

/** Map of active heartbeat timers: taskId → timer handle */
const _heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Map of last heartbeat timestamps: taskId → ISO string */
export const heartbeatTimestamps = new Map<string, string>();

/**
 * Start auto-publishing task.heartbeat feed events for a given task.
 *
 * @param cwd        Working directory (determines feed path)
 * @param agentName  Name of the agent emitting heartbeats
 * @param taskId     ID of the in-progress task
 * @param intervalMs How often to emit a heartbeat (default: 60 000 ms)
 * @returns A cleanup function that stops the heartbeat
 */
export function startHeartbeat(
  cwd: string,
  agentName: string,
  taskId: string,
  intervalMs = 60_000
): () => void {
  // Stop any existing heartbeat for this task
  stopHeartbeat(taskId);

  // Lazily import to avoid circular dependency at module load time
  // (feed.ts imports nothing from lib.ts, but lib.ts is used widely)
  function emitHeartbeatEvent(): void {
    try {
      const ts = new Date().toISOString();
      heartbeatTimestamps.set(taskId, ts);
      appendFeedEvent(cwd, {
        ts,
        agent: agentName,
        type: "task.heartbeat",
        target: taskId,
        heartbeat: { taskId, status: "active" },
      });
    } catch {
      // Best-effort — if feed write fails, heartbeat silently skips
    }
  }

  // Emit an initial heartbeat immediately
  emitHeartbeatEvent();

  const timer = setInterval(emitHeartbeatEvent, intervalMs);
  _heartbeatTimers.set(taskId, timer);

  return () => stopHeartbeat(taskId);
}

/**
 * Stop the heartbeat for a given task and clean up its timestamp entry.
 */
export function stopHeartbeat(taskId: string): void {
  const timer = _heartbeatTimers.get(taskId);
  if (timer) {
    clearInterval(timer);
    _heartbeatTimers.delete(taskId);
  }
  heartbeatTimestamps.delete(taskId);
}

/**
 * Check all active heartbeat timestamps and emit `heartbeat.stale` feed events
 * for any task whose last heartbeat is older than `thresholdMs` (default: 120 s).
 *
 * Call this from a background poll loop (e.g. every 30 s) in the extension.
 *
 * @param cwd         Working directory for the feed
 * @param agentName   Name of the agent performing the stale check
 * @param thresholdMs Age threshold in milliseconds (default: 120 000 ms)
 * @returns Array of taskIds whose heartbeats were found stale
 */
export function checkStaleHeartbeats(
  cwd: string,
  agentName: string,
  thresholdMs = 120_000
): string[] {
  const stale: string[] = [];
  const now = Date.now();

  for (const [taskId, lastTs] of heartbeatTimestamps.entries()) {
    const age = now - new Date(lastTs).getTime();
    if (age > thresholdMs) {
      stale.push(taskId);
      try {
        appendFeedEvent(cwd, {
          ts: new Date().toISOString(),
          agent: agentName,
          type: "heartbeat.stale",
          target: taskId,
          preview: `No heartbeat for ${Math.round(age / 1000)}s (threshold: ${thresholdMs / 1000}s)`,
        });
      } catch {
        // Best-effort
      }
    }
  }

  return stale;
}

