/**
 * Pi Messenger - Types and Pure Utilities
 */

import type * as fs from "node:fs";
import { basename, isAbsolute, resolve, relative } from "node:path";

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
