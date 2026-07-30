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
  | "task.review"
  | "task.block"
  | "task.unblock"
  | "task.reset"
  | "task.delete"
  | "task.split"
  | "task.revise"
  | "task.revise-tree"
  | "task.approve"
  | "task.reject"
  | "plan.start"
  | "plan.pass.start"
  | "plan.pass.done"
  | "plan.review.start"
  | "plan.review.done"
  | "plan.done"
  | "plan.cancel"
  | "plan.failed"
  | "stuck";

export interface FeedEvent {
  ts: string;
  agent: string;
  type: FeedEventType;
  target?: string;
  preview?: string;
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
  return {
    ts: event.ts,
    type: event.type,
    agent: sanitizeAgentName(event.agent),
    target: sanitizeInlineText(event.target),
    preview: sanitizeInlineText(event.preview),
  };
}

export function appendFeedEvent(cwd: string, event: FeedEvent): void {
  const p = feedPath(cwd);
  try {
    const feedDir = path.dirname(p);
    if (!fs.existsSync(feedDir)) {
      fs.mkdirSync(feedDir, { recursive: true });
    }
    const sanitized = sanitizeFeedEvent(event);
    fs.appendFileSync(p, JSON.stringify(sanitized) + "\n");
  } catch {
    // Best effort
  }
}

export function readFeedEvents(cwd: string, limit: number = 20): FeedEvent[] {
  const p = feedPath(cwd);
  const maxEvents = Math.trunc(limit);
  if (!Number.isFinite(maxEvents) || maxEvents <= 0) return [];
  if (!fs.existsSync(p)) return [];

  try {
    const fd = fs.openSync(p, "r");
    try {
      // Read backward in chunks, carrying the partial first line of each chunk
      // as raw bytes so lines (and multibyte sequences) are only decoded once complete.
      const events: FeedEvent[] = [];
      let position = fs.fstatSync(fd).size;
      let carry = Buffer.alloc(0);
      const chunkSize = 64 * 1024;

      while (position > 0 && events.length < maxEvents) {
        const start = Math.max(0, position - chunkSize);
        const chunk = Buffer.allocUnsafe(position - start);
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, start);
        const current = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
        const combined = carry.length > 0 ? Buffer.concat([current, carry]) : current;
        const firstNewline = combined.indexOf(0x0a);
        let complete: Buffer;

        if (start === 0) {
          complete = combined;
          carry = Buffer.alloc(0);
        } else if (firstNewline === -1) {
          carry = combined;
          position = start;
          continue;
        } else {
          carry = combined.subarray(0, firstNewline);
          complete = combined.subarray(firstNewline + 1);
        }

        const lines = complete.toString("utf-8").split("\n");
        for (let i = lines.length - 1; i >= 0 && events.length < maxEvents; i--) {
          if (!lines[i]) continue;
          try {
            events.push(sanitizeFeedEvent(JSON.parse(lines[i]) as FeedEvent));
          } catch {
            // Skip malformed lines and continue scanning backward.
          }
        }
        position = start;
      }

      return events.reverse();
    } finally {
      fs.closeSync(fd);
    }
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
  "task.review",
  "task.block",
  "task.unblock",
  "task.reset",
  "task.delete",
  "task.split",
  "task.revise",
  "task.revise-tree",
  "task.approve",
  "task.reject",
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
    case "task.review": line += withPreview(` reviewed ${target}`); break;
    case "task.block": line += withPreview(` blocked ${target}`); break;
    case "task.unblock": line += withPreview(` unblocked ${target}`); break;
    case "task.reset": line += withPreview(` reset ${target}`); break;
    case "task.delete": line += withPreview(` deleted ${target}`); break;
    case "task.split": line += withPreview(` split ${target}`); break;
    case "task.revise": line += withPreview(` revised ${target}`); break;
    case "task.revise-tree": line += withPreview(` revised ${target} + dependents`); break;
    case "task.approve": line += withPreview(` approved ${target}`); break;
    case "task.reject": line += withPreview(` rejected ${target}`); break;
    case "plan.start": line += withPreview(" planning started"); break;
    case "plan.pass.start": line += withPreview(" planning pass started"); break;
    case "plan.pass.done": line += withPreview(" planning pass finished"); break;
    case "plan.review.start": line += withPreview(" planning review started"); break;
    case "plan.review.done": line += withPreview(" planning review finished"); break;
    case "plan.done": line += withPreview(" planning completed"); break;
    case "plan.cancel": line += " planning cancelled"; break;
    case "plan.failed": line += withPreview(" planning failed"); break;
    case "stuck": line += " appears stuck"; break;
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
