#!/usr/bin/env bash
set -e

ROOT="/Users/chikochingaya/.pi/agent/git/github.com/nicobailon/pi-messenger"
cd "$ROOT"

###############################################################################
# CHANGE 1: Fix attentionText() default in session-row.ts
###############################################################################
python3 - <<'PYEOF'
import re

path = "src/monitor/ui/session-row.ts"
with open(path, "r") as f:
    content = f.read()

old = """    default:
      return reason;"""

new = """    default: {
      // TypeScript exhaustiveness guard — unreachable at runtime.
      // Adding a new AttentionReason without updating this switch will cause a TSC error.
      const _exhaustive: never = reason;
      throw new Error(`Unhandled AttentionReason: ${String(_exhaustive)}`);
    }"""

assert old in content, f"CHANGE 1: Could not find old text in {path}"
content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("CHANGE 1: done")
PYEOF

###############################################################################
# CHANGE 2: Add escalate() method to lifecycle/manager.ts
###############################################################################
python3 - <<'PYEOF'
path = "src/monitor/lifecycle/manager.ts"
with open(path, "r") as f:
    content = f.read()

# Insert after end() method, before getState()
old = """  /**
   * Get the current status of a session.
   * Returns undefined if the session does not exist.
   */
  getState(sessionId: string): SessionStatus | undefined {"""

new = """  /**
   * Escalate a session to the error state for operator review.
   * Transitions active → error via the FSM and emits a "session.error" event.
   */
  escalate(sessionId: string, reason?: string): void {
    this.transition(sessionId, "error");

    this.emitter.emit({
      id: randomUUID(),
      type: "session.error",
      sessionId,
      timestamp: Date.now(),
      sequence: this.nextSequence(sessionId),
      payload: {
        type: "session.error",
        message: reason ?? "Session escalated for operator review",
        fatal: false,
      },
    });
  }

  /**
   * Get the current status of a session.
   * Returns undefined if the session does not exist.
   */
  getState(sessionId: string): SessionStatus | undefined {"""

assert old in content, f"CHANGE 2: Could not find old text in {path}"
content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("CHANGE 2: done")
PYEOF

###############################################################################
# CHANGE 3: Fix escalate case in handler.ts
###############################################################################
python3 - <<'PYEOF'
path = "src/monitor/commands/handler.ts"
with open(path, "r") as f:
    content = f.read()

old = """      case "escalate": {
        const store = this.lifecycle.getStore();
        const state = store.get(sessionId);
        if (!state) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        // Escalate marks the session in an error state for operator review
        store.update(sessionId, { status: "error" });
        return store.get(sessionId);
      }"""

new = """      case "escalate": {
        // Route through the lifecycle FSM so the active→error transition is
        // validated and a session.error event is emitted.
        this.lifecycle.escalate(sessionId, command.reason);
        const store = this.lifecycle.getStore();
        return store.get(sessionId);
      }"""

assert old in content, f"CHANGE 3: Could not find old text in {path}"
content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("CHANGE 3: done")
PYEOF

###############################################################################
# CHANGE 4A: Add lastAlertStatus field to health/monitor.ts
###############################################################################
python3 - <<'PYEOF'
path = "src/monitor/health/monitor.ts"
with open(path, "r") as f:
    content = f.read()

old = """  /** Track last event timestamp per session (sessionId → epoch ms) */
  private lastEventAt: Map<string, number> = new Map();"""

new = """  /** Track last event timestamp per session (sessionId → epoch ms) */
  private lastEventAt: Map<string, number> = new Map();
  /** Track last emitted alert status per session to suppress duplicate alerts */
  private lastAlertStatus: Map<string, HealthStatus> = new Map();"""

assert old in content, f"CHANGE 4A: Could not find old text in {path}"
content = content.replace(old, new, 1)

###############################################################################
# CHANGE 4B: Replace alert emission block with deduplication logic
###############################################################################
old2 = """    if (status !== "healthy") {
      const alert: HealthAlert = {
        sessionId,
        status,
        reason,
        detectedAt: now,
      };
      this.emitAlert(alert);
    }"""

new2 = """    if (status !== "healthy") {
      // Deduplicate: only emit when the alert status changes for this session
      if (this.lastAlertStatus.get(sessionId) !== status) {
        this.lastAlertStatus.set(sessionId, status);
        const alert: HealthAlert = {
          sessionId,
          status,
          reason,
          detectedAt: now,
        };
        this.emitAlert(alert);
      }
    } else {
      // Reset tracking when session recovers to healthy
      this.lastAlertStatus.delete(sessionId);
    }"""

assert old2 in content, f"CHANGE 4B: Could not find old text in {path}"
content = content.replace(old2, new2, 1)

with open(path, "w") as f:
    f.write(content)
print("CHANGE 4: done")
PYEOF

###############################################################################
# CHANGE 5: Update types/session.ts — SessionHistoryEntry alias
###############################################################################
python3 - <<'PYEOF'
path = "src/monitor/types/session.ts"
with open(path, "r") as f:
    content = f.read()

old = """export const SessionEventSchema = z.object({
  type: z.string(),
  timestamp: z.string().datetime(),
  data: z.unknown().optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;"""

new = """/**
 * SessionHistoryEntry — a lightweight session-history record (type + timestamp + optional data).
 * This is the simple event format stored on SessionState.events.
 *
 * Note: For the rich stream-event type used by SessionEventEmitter, see
 * src/monitor/events/types.ts which exports its own SessionEvent / SessionEventSchema.
 * Prefer importing from the correct module to avoid name collisions.
 */
export const SessionHistoryEntrySchema = z.object({
  type: z.string(),
  timestamp: z.string().datetime(),
  data: z.unknown().optional(),
});
export type SessionHistoryEntry = z.infer<typeof SessionHistoryEntrySchema>;

// Backward-compat aliases (use SessionHistoryEntry / SessionHistoryEntrySchema for new code)
export const SessionEventSchema = SessionHistoryEntrySchema;
export type SessionEvent = SessionHistoryEntry;"""

assert old in content, f"CHANGE 5A: Could not find old text in {path}"
content = content.replace(old, new, 1)

old2 = """export const SessionStateSchema = z.object({
  status: SessionStatusSchema,
  metadata: SessionMetadataSchema,
  metrics: SessionMetricsSchema,
  events: z.array(SessionEventSchema),
});"""

new2 = """export const SessionStateSchema = z.object({
  status: SessionStatusSchema,
  metadata: SessionMetadataSchema,
  metrics: SessionMetricsSchema,
  events: z.array(SessionHistoryEntrySchema),
});"""

assert old2 in content, f"CHANGE 5B: Could not find old text in {path}"
content = content.replace(old2, new2, 1)

with open(path, "w") as f:
    f.write(content)
print("CHANGE 5: done")
PYEOF

###############################################################################
# CHANGE 6: Create src/monitor/ui/session-detail.ts
###############################################################################
cat > src/monitor/ui/session-detail.ts << 'TSEOF'
/**
 * SessionDetailView — expanded single-session detail panel.
 *
 * Exported API:
 *   renderSessionDetailView(session, health, width, maxHeight, now) → string[]
 *   SessionDetailView class (stateful, scrollable)
 *   stripDetailAnsi(text) → string
 */

import { ANSI, stripAnsi } from "./session-row.js";
import type { SessionState } from "../types/session.js";
import type { HealthStatus } from "../health/types.js";

// ─── Public re-export ────────────────────────────────────────────────────────

export function stripDetailAnsi(text: string): string {
  return stripAnsi(text);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const YYYY = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}Z`;
}

function formatDateTimeMs(ms: number): string {
  return formatDateTime(new Date(ms).toISOString());
}

// ─── Event rendering ─────────────────────────────────────────────────────────

function eventLabel(type: string): string {
  switch (type) {
    case "agent.thinking":
      return "THINK";
    case "tool.call":
      return "TOOL";
    case "agent.progress":
      return "PROGRESS";
    case "execution.output":
    case "execution.start":
    case "execution.end":
      return "EXEC";
    case "session.error":
      return "ERROR";
    case "session.end":
      return "DONE";
    case "session.start":
      return "START";
    default:
      return "INFO";
  }
}

function eventContent(type: string, data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;

  switch (type) {
    case "agent.thinking":
    case "agent.progress":
      return typeof d["message"] === "string" ? d["message"] : "";
    case "tool.call": {
      const toolName = typeof d["toolName"] === "string" ? d["toolName"] : "unknown";
      return `Running ${toolName}`;
    }
    case "execution.output":
      return typeof d["text"] === "string" ? d["text"] : "";
    case "session.error":
      return typeof d["message"] === "string" ? d["message"] : "";
    case "session.end":
      return typeof d["summary"] === "string" ? d["summary"] : "";
    default:
      return "";
  }
}

// ─── Header rendering ────────────────────────────────────────────────────────

const HEADER_LINE_COUNT = 4;

function renderHeader(
  session: SessionState,
  health: HealthStatus,
  width: number,
  now: number,
): string[] {
  const sepLen = Math.max(0, width - 18);
  const sep = "─".repeat(sepLen);

  return [
    `${ANSI.green}── Session Detail ${sep}${ANSI.reset}`,
    `  ${ANSI.yellow}Agent:${ANSI.reset} ${session.metadata.agent}  ${ANSI.yellow}Task:${ANSI.reset} ${session.metadata.taskId ?? ""}  ${ANSI.yellow}Status:${ANSI.reset} ${session.status}  ${ANSI.yellow}Health:${ANSI.reset} ${health}`,
    `  ${ANSI.yellow}Started:${ANSI.reset} ${formatDateTime(session.metadata.startedAt)}  ${ANSI.yellow}Now:${ANSI.reset} ${formatDateTimeMs(now)}`,
    "─".repeat(width),
  ];
}

function buildEventLines(session: SessionState): string[] {
  return session.events.map((event) => {
    const label = eventLabel(event.type);
    const content = eventContent(event.type, event.data);
    const time = formatDateTime(event.timestamp);
    return `  [${time}] ${label}${content ? " " + content : ""}`;
  });
}

// ─── Functional API ───────────────────────────────────────────────────────────

/**
 * Render a read-only snapshot of a session as an array of terminal lines.
 * Always auto-follows (shows the most recent events).
 */
export function renderSessionDetailView(
  session: SessionState,
  health: HealthStatus,
  width: number,
  maxHeight: number,
  now: number,
): string[] {
  const header = renderHeader(session, health, width, now);
  const eventLines = buildEventLines(session);

  const availableLines = Math.max(0, maxHeight - header.length);
  const visible = eventLines.slice(-availableLines);

  return [...header, ...visible];
}

// ─── Stateful class API ──────────────────────────────────────────────────────

/**
 * SessionDetailView — interactive, scrollable detail panel.
 *
 * Key inputs:
 *   'f'    — toggle auto-follow
 *   'home' — scroll to top (disables auto-follow)
 *   'end'  — scroll to bottom
 *   'up'   — scroll up one line
 *   'down' — scroll down one line
 */
export class SessionDetailView {
  private readonly maxHeight: number;
  private session: SessionState | null = null;
  private health: HealthStatus = "healthy";
  private autoFollow = true;
  private scrollOffset = 0; // index into event lines; 0 = top

  constructor(options: { maxHeight: number }) {
    this.maxHeight = options.maxHeight;
  }

  setSession(session: SessionState, opts: { health: HealthStatus }): void {
    this.session = session;
    this.health = opts.health;
    // When auto-following, jump to the end
    if (this.autoFollow) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
    }
  }

  handleInput(key: string): void {
    switch (key) {
      case "f":
        this.autoFollow = !this.autoFollow;
        if (this.autoFollow) {
          this.scrollOffset = Number.MAX_SAFE_INTEGER;
        }
        break;
      case "home":
        this.autoFollow = false;
        this.scrollOffset = 0;
        break;
      case "end":
        this.scrollOffset = Number.MAX_SAFE_INTEGER;
        break;
      case "up":
        this.autoFollow = false;
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        break;
      case "down":
        this.autoFollow = false;
        this.scrollOffset++;
        break;
    }
  }

  isAutoFollowEnabled(): boolean {
    return this.autoFollow;
  }

  render(width: number): string[] {
    if (!this.session) return [];

    const header = renderHeader(this.session, this.health, width, Date.now());
    const eventLines = buildEventLines(this.session);
    const totalEvents = eventLines.length;
    const availableLines = Math.max(0, this.maxHeight - header.length);

    let start: number;
    if (this.autoFollow || this.scrollOffset === Number.MAX_SAFE_INTEGER) {
      // Pin to bottom
      start = Math.max(0, totalEvents - availableLines);
    } else {
      // Clamp scroll to valid range
      const maxStart = Math.max(0, totalEvents - availableLines);
      start = Math.min(this.scrollOffset, maxStart);
    }

    const visible = eventLines.slice(start, start + availableLines);
    return [...header, ...visible];
  }
}
TSEOF
echo "CHANGE 6: done"

###############################################################################
# CHANGE 7: Create src/monitor/index.ts
###############################################################################
cat > src/monitor/index.ts << 'TSEOF'
/**
 * src/monitor/index.ts
 *
 * Top-level barrel export for the monitor subsystem.
 * Import from this file to access all public monitor APIs.
 */

// Canonical normalisation
export * from "./canonical/index.js";

// Command dispatch
export * from "./commands/index.js";

// Event system
export * from "./events/index.js";

// Data export
export * from "./export/index.js";

// Event feed
export * from "./feed/index.js";

// Health monitoring
export * from "./health/index.js";

// Session lifecycle FSM
export * from "./lifecycle/index.js";

// Metrics aggregation
export * from "./metrics/index.js";

// Event replay
export * from "./replay/index.js";

// Session store
export * from "./store/index.js";

// Types (session, attention, operator, commands)
export * from "./types/index.js";

// UI rendering components
export * from "./ui/index.js";
TSEOF
echo "CHANGE 7: done"

###############################################################################
# CHANGE 8: Add session-detail to ui/index.ts
###############################################################################
python3 - <<'PYEOF'
path = "src/monitor/ui/index.ts"
with open(path, "r") as f:
    content = f.read()

addition = '\nexport { SessionDetailView, renderSessionDetailView, stripDetailAnsi } from "./session-detail.js";\n'

if "session-detail" not in content:
    content = content.rstrip() + addition
    with open(path, "w") as f:
        f.write(content)
    print("CHANGE 8: done")
else:
    print("CHANGE 8: already present, skipping")
PYEOF

echo "All changes applied."
