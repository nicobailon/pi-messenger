/**
 * Pi Messenger - Activity Feed
 *
 * Append-only JSONL feed stored at <cwd>/.pi/messenger/feed.jsonl
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type FeedEventType =
  | "join"
  | "leave"
  | "reserve"
  | "release"
  | "message"
  | "commit"
  | "test"
  | "edit"
  | "task.start"
  | "task.done"
  | "task.block"
  | "task.unblock"
  | "task.reset"
  | "task.delete"
  | "task.split"
  | "task.revise"
  | "task.revise-tree"
  | "plan.start"
  | "plan.pass.start"
  | "plan.pass.done"
  | "plan.review.start"
  | "plan.review.done"
  | "plan.done"
  | "plan.cancel"
  | "plan.failed"
  | "stuck"
  | "agent.health"
  | "task.progress"
  | "task.heartbeat"
  | "suggestion.new"
  | "suggestion.approved"
  | "suggestion.rejected"
  | "reaction";

export interface MessageContent {
  type: 'text' | 'code' | 'diff' | 'file' | 'table';
  content: string;
  lang?: string;   // For code blocks
  path?: string;   // For file references
}

export interface FeedEvent {
  ts: string;
  agent: string;
  type: FeedEventType;
  target?: string;
  preview?: string;
  // New fields (optional, backward-compatible)
  threadId?: string;           // Thread grouping: defaults to target taskId
  content?: MessageContent[];  // Rich content blocks
  reactionTo?: string;         // Target event ts for reactions
  emoji?: string;              // Reaction emoji
  severity?: 'info' | 'warn' | 'error' | 'critical';
  metadata?: Record<string, unknown>;
}

function feedPath(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "feed.jsonl");
}

function sanitizeInlineText(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeAgentName(value: string): string {
  return sanitizeInlineText(value) ?? "unknown";
}

export function sanitizeFeedEvent(event: FeedEvent): FeedEvent {
  const sanitized: FeedEvent = {
    ts: event.ts,
    type: event.type,
    agent: sanitizeAgentName(event.agent),
    target: sanitizeInlineText(event.target),
    preview: sanitizeInlineText(event.preview),
  };
  // Pass through new optional fields
  if (event.threadId !== undefined) sanitized.threadId = sanitizeInlineText(event.threadId);
  if (event.content !== undefined) sanitized.content = event.content;
  if (event.reactionTo !== undefined) sanitized.reactionTo = event.reactionTo;
  if (event.emoji !== undefined) sanitized.emoji = event.emoji;
  if (event.severity !== undefined) sanitized.severity = event.severity;
  if (event.metadata !== undefined) sanitized.metadata = event.metadata;
  return sanitized;
}

const TASK_ID_PATTERN = /^task-\d+$/;

export function appendFeedEvent(cwd: string, event: FeedEvent): void {
  const p = feedPath(cwd);
  try {
    const feedDir = path.dirname(p);
    if (!fs.existsSync(feedDir)) {
      fs.mkdirSync(feedDir, { recursive: true });
    }
    // Auto-assign threadId from target when it looks like a task ID
    if (!event.threadId && event.target && TASK_ID_PATTERN.test(event.target)) {
      event = { ...event, threadId: event.target };
    }
    const sanitized = sanitizeFeedEvent(event);
    fs.appendFileSync(p, JSON.stringify(sanitized) + "\n");
  } catch {
    // Best effort
  }
}

export function readFeedEvents(cwd: string, limit: number = 20): FeedEvent[] {
  const p = feedPath(cwd);
  if (!fs.existsSync(p)) return [];

  try {
    const content = fs.readFileSync(p, "utf-8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    const events: FeedEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as FeedEvent;
        events.push(sanitizeFeedEvent(parsed));
      } catch {
        // Skip malformed lines
      }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

export function pruneFeed(cwd: string, maxEvents: number): void {
  const p = feedPath(cwd);
  if (!fs.existsSync(p)) return;

  try {
    const content = fs.readFileSync(p, "utf-8").trim();
    if (!content) return;
    const lines = content.split("\n");
    if (lines.length <= maxEvents) return;
    const pruned = lines.slice(-maxEvents);
    fs.writeFileSync(p, pruned.join("\n") + "\n");
  } catch {
    // Best effort
  }
}

const CREW_EVENT_TYPES = new Set<FeedEventType>([
  "task.start",
  "task.done",
  "task.block",
  "task.unblock",
  "task.reset",
  "task.delete",
  "task.split",
  "task.revise",
  "task.revise-tree",
  "plan.start",
  "plan.pass.start",
  "plan.pass.done",
  "plan.review.start",
  "plan.review.done",
  "plan.done",
  "plan.cancel",
  "plan.failed",
]);

export function formatFeedLine(event: FeedEvent): string {
  const sanitized = sanitizeFeedEvent(event);
  const time = new Date(sanitized.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const isCrew = CREW_EVENT_TYPES.has(sanitized.type);
  const prefix = isCrew ? "[Crew] " : "";
  let line = `${time} ${prefix}${sanitized.agent}`;

  const rawPreview = sanitized.preview;
  const preview = rawPreview
    ? rawPreview.length > 90 ? rawPreview.slice(0, 87) + "..." : rawPreview
    : "";
  const withPreview = (base: string) => preview ? `${base} — ${preview}` : base;
  const target = sanitized.target ?? "";

  switch (sanitized.type) {
    case "join": line += " joined"; break;
    case "leave": line = withPreview(line + " left"); break;
    case "reserve": line += ` reserved ${target}`; break;
    case "release": line += ` released ${target}`; break;
    case "message":
      if (target) {
        line += ` → ${target}`;
        if (preview) line += `: ${preview}`;
      } else {
        line += " ✦";
        if (preview) line += ` ${preview}`;
      }
      break;
    case "commit":
      line += preview ? ` committed "${preview}"` : " committed";
      break;
    case "test":
      line += preview ? ` ran tests (${preview})` : " ran tests";
      break;
    case "edit": line += ` editing ${target}`; break;
    case "task.start": line += withPreview(` started ${target}`); break;
    case "task.done": line += withPreview(` completed ${target}`); break;
    case "task.block": line += withPreview(` blocked ${target}`); break;
    case "task.unblock": line += withPreview(` unblocked ${target}`); break;
    case "task.reset": line += withPreview(` reset ${target}`); break;
    case "task.delete": line += withPreview(` deleted ${target}`); break;
    case "task.split": line += withPreview(` split ${target}`); break;
    case "task.revise": line += withPreview(` revised ${target}`); break;
    case "task.revise-tree": line += withPreview(` revised ${target} + dependents`); break;
    case "plan.start": line += withPreview(" planning started"); break;
    case "plan.pass.start": line += withPreview(" planning pass started"); break;
    case "plan.pass.done": line += withPreview(" planning pass finished"); break;
    case "plan.review.start": line += withPreview(" planning review started"); break;
    case "plan.review.done": line += withPreview(" planning review finished"); break;
    case "plan.done": line += withPreview(" planning completed"); break;
    case "plan.cancel": line += " planning cancelled"; break;
    case "plan.failed": line += withPreview(" planning failed"); break;
    case "stuck": line += " appears stuck"; break;
    case "agent.health": line += ` ❤️ health: ${preview}`; break;
    case "task.progress": line += ` 📊 progress: ${preview}`; break;
    case "task.heartbeat": line += ` 💓 heartbeat: ${preview}`; break;
    case "suggestion.new": line += ` 💡 suggestion: ${preview}`; break;
    case "suggestion.approved": line += ` ✅ approved: ${preview}`; break;
    case "suggestion.rejected": line += ` ❌ rejected: ${preview}`; break;
    case "reaction": line += ` ${sanitized.emoji ?? '👍'} reacted to ${target}`; break;
    default: line += ` ${sanitized.type}`; break;
  }
  return line;
}

export function isCrewEvent(type: FeedEventType): boolean {
  return CREW_EVENT_TYPES.has(type);
}

export function logFeedEvent(
  cwd: string,
  agent: string,
  type: FeedEventType,
  target?: string,
  preview?: string
): void {
  appendFeedEvent(cwd, {
    ts: new Date().toISOString(),
    agent,
    type,
    target,
    preview,
  });
}

export function searchFeed(cwd: string, query: string, options?: { since?: number, limit?: number }): FeedEvent[] {
  const events = readFeedEvents(cwd, 1000);
  const regex = new RegExp(query, 'i');
  let filtered = events.filter(e =>
    regex.test(e.preview ?? '') ||
    regex.test(e.target ?? '') ||
    regex.test(e.agent) ||
    regex.test(e.type)
  );
  if (options?.since) {
    const sinceTs = Date.now() - options.since;
    filtered = filtered.filter(e => new Date(e.ts).getTime() >= sinceTs);
  }
  return filtered.slice(-(options?.limit ?? 20));
}

export function readFeedByThread(cwd: string, limit: number = 50): Map<string, FeedEvent[]> {
  const events = readFeedEvents(cwd, limit);
  const threads = new Map<string, FeedEvent[]>();
  for (const event of events) {
    const tid = event.threadId ?? '__global';
    if (!threads.has(tid)) threads.set(tid, []);
    threads.get(tid)!.push(event);
  }
  return threads;
}
