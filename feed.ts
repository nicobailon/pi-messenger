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

export function appendFeedEvent(cwd: string, event: FeedEvent): void {
  const p = feedPath(cwd);
  try {
    const feedDir = path.dirname(p);
    if (!fs.existsSync(feedDir)) {
      fs.mkdirSync(feedDir, { recursive: true });
    }
    fs.appendFileSync(p, JSON.stringify(event) + "\n");
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
        events.push(JSON.parse(line));
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
  const time = new Date(event.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const isCrew = CREW_EVENT_TYPES.has(event.type);
  const prefix = isCrew ? "[Crew] " : "";
  let line = `${time} ${prefix}${event.agent}`;

  const rawPreview = event.preview?.trim();
  const preview = rawPreview
    ? rawPreview.length > 90 ? rawPreview.slice(0, 87) + "..." : rawPreview
    : "";
  const withPreview = (base: string) => preview ? `${base} — ${preview}` : base;

  switch (event.type) {
    case "join": line += " joined"; break;
    case "leave": line = withPreview(line + " left"); break;
    case "reserve": line += ` reserved ${event.target ?? ""}`; break;
    case "release": line += ` released ${event.target ?? ""}`; break;
    case "message":
      if (event.target) {
        line += ` → ${event.target}`;
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
    case "edit": line += ` editing ${event.target ?? ""}`; break;
    case "task.start": line += withPreview(` started ${event.target ?? ""}`); break;
    case "task.done": line += withPreview(` completed ${event.target ?? ""}`); break;
    case "task.block": line += withPreview(` blocked ${event.target ?? ""}`); break;
    case "task.unblock": line += withPreview(` unblocked ${event.target ?? ""}`); break;
    case "task.reset": line += withPreview(` reset ${event.target ?? ""}`); break;
    case "task.delete": line += withPreview(` deleted ${event.target ?? ""}`); break;
    case "task.split": line += withPreview(` split ${event.target ?? ""}`); break;
    case "task.revise": line += withPreview(` revised ${event.target ?? ""}`); break;
    case "task.revise-tree": line += withPreview(` revised ${event.target ?? ""} + dependents`); break;
    case "plan.start": line += withPreview(" planning started"); break;
    case "plan.pass.start": line += withPreview(" planning pass started"); break;
    case "plan.pass.done": line += withPreview(" planning pass finished"); break;
    case "plan.review.start": line += withPreview(" planning review started"); break;
    case "plan.review.done": line += withPreview(" planning review finished"); break;
    case "plan.done": line += withPreview(" planning completed"); break;
    case "plan.cancel": line += " planning cancelled"; break;
    case "plan.failed": line += withPreview(" planning failed"); break;
    case "stuck": line += " appears stuck"; break;
    default: line += ` ${event.type}`; break;
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
