/**
 * Crew - Worker Coordination
 *
 * Builds dependency sections, coordination context (concurrent tasks,
 * recent activity, ready tasks), and coordination instructions for
 * worker prompts. All functions use static data available at prompt-build
 * time — no runtime worker state.
 */

import type { Task } from "../types.js";
import type { CrewConfig } from "../utils/config.js";
import { readFeedEvents, type FeedEvent } from "../../feed.js";
import * as store from "../store.js";

// =============================================================================
// Dependency Section
// =============================================================================

export function buildDependencySection(cwd: string, task: Task, config: CrewConfig): string {
  if (config.dependencies === "advisory") {
    const lines: string[] = [
      "## Dependency Status\n",
      "Your task has dependencies on other tasks. Some may not be complete yet — this is expected. Use the coordination system to work through it.",
      "",
    ];

    for (const depId of task.depends_on) {
      const dep = store.getTask(cwd, depId);
      if (!dep) {
        lines.push(`- ○ ${depId} — not yet started`);
        continue;
      }

      if (dep.status === "done") {
        const summary = dep.summary ? ` ${dep.summary}` : "";
        lines.push(`- ✓ ${dep.id} (${dep.title}) — done${summary ? `.${summary}` : ""}`);
      } else if (dep.status === "in_progress") {
        const worker = dep.assigned_to ? `, worker: ${dep.assigned_to}` : "";
        lines.push(`- ⟳ ${dep.id} (${dep.title}) — in progress${worker}`);
      } else {
        lines.push(`- ○ ${dep.id} (${dep.title}) — not yet started`);
      }
    }

    lines.push(
      "",
      "**Working with pending dependencies:**",
      "- Check if the dependency's output files exist. If yes, import and use them.",
      "- If not, define what you need locally based on your task spec. Your spec describes the interfaces.",
    );
    if (config.coordination !== "none") {
      lines.push("- DM in-progress workers for API details they're building.");
    }
    lines.push(
      "- Reserve your files before editing to prevent conflicts.",
      "- Do NOT block yourself because a dependency isn't done. Work around it.",
      "- Log any local definitions in your progress for later reconciliation.",
    );

    return lines.join("\n") + "\n\n";
  }

  const level = config.coordination;
  const lines: string[] = ["## Dependencies\n", "Your task depends on these completed tasks:"];

  for (const depId of task.depends_on) {
    const dep = store.getTask(cwd, depId);
    if (!dep) {
      lines.push(`- ${depId}`);
      continue;
    }

    if (level === "minimal") {
      lines.push(`- ${depId}: ${dep.title}`);
    } else {
      const summary = dep.summary || "(no summary)";
      lines.push(`- ${depId} (${dep.title}): ${summary}`);
    }
  }

  return lines.join("\n") + "\n\n";
}

// =============================================================================
// Coordination Context (concurrent tasks, recent activity, ready tasks)
// =============================================================================

const ACTIVITY_EVENT_TYPES = new Set<string>([
  "task.start", "task.done", "task.block", "task.reset",
  "reserve", "release", "message",
]);

function formatFeedTime(isoTs: string): string {
  const d = new Date(isoTs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatFeedVerb(type: string): string {
  switch (type) {
    case "task.start": return "started";
    case "task.done": return "completed";
    case "task.block": return "blocked";
    case "task.reset": return "reset";
    case "reserve": return "reserved";
    case "release": return "released";
    default: return type;
  }
}

function formatActivityLine(event: FeedEvent): string {
  const time = formatFeedTime(event.ts);
  if (event.type === "message") {
    if (event.target) {
      return event.preview
        ? `${time} ${event.agent} → ${event.target}: ${event.preview}`
        : `${time} ${event.agent} → ${event.target}`;
    }
    return event.preview
      ? `${time} ${event.agent} ✦ ${event.preview}`
      : `${time} ${event.agent} ✦`;
  }
  const verb = formatFeedVerb(event.type);
  const target = event.target ? ` ${event.target}` : "";
  const preview = event.preview ? ` — ${event.preview}` : "";
  return `${time} ${event.agent} ${verb}${target}${preview}`;
}

export function buildCoordinationContext(
  cwd: string,
  task: Task,
  config: CrewConfig,
  concurrentTasks: Task[],
): string {
  if (config.coordination === "none") return "";

  const level = config.coordination;
  let out = "";

  if (concurrentTasks.length > 0) {
    out += `## Concurrent Tasks

These tasks are being worked on by other workers in this wave. Discover their agent names after joining the mesh via \`pi_messenger({ action: "list" })\`.

`;
    for (const t of concurrentTasks) {
      out += `- ${t.id}: ${t.title}\n`;
    }
    out += "\n";
  }

  if (level === "moderate" || level === "chatty") {
    const events = readFeedEvents(cwd, 20);
    const signal = events.filter(e => ACTIVITY_EVENT_TYPES.has(e.type)).slice(-8);
    if (signal.length > 0) {
      out += "## Recent Activity\n\n";
      for (const e of signal) {
        out += formatActivityLine(e) + "\n";
      }
      out += "\n";
    }
  }

  if (level === "chatty") {
    const concurrentIds = new Set(concurrentTasks.map(t => t.id));
    const ready = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" })
      .filter(t => t.id !== task.id && !concurrentIds.has(t.id));
    if (ready.length > 0) {
      out += `## Ready Tasks

After completing your current task, you can claim one of these:
`;
      for (const t of ready) {
        const deps = t.depends_on.length > 0 ? ` (deps: ${t.depends_on.join(", ")})` : "";
        out += `- ${t.id}: ${t.title}${deps}\n`;
      }
      out += "\n";
    }
  }

  return out;
}

// =============================================================================
// Coordination Instructions
// =============================================================================

export function buildCoordinationInstructions(config: CrewConfig): string {
  const level = config.coordination;
  if (level === "none") return "";

  const budget = config.messageBudgets?.[level] ?? (level === "chatty" ? 10 : 5);

  if (level === "minimal") {
    return `## Coordination

**Message budget: ${budget} messages this session.** The system enforces this.

Before editing files, check if another worker has reserved them by running:

\`\`\`typescript
pi_messenger({ action: "list" })
\`\`\`

If a file you need is reserved by another worker, message them to coordinate:

\`\`\`typescript
pi_messenger({ action: "send", to: "<their-name>", message: "I need to modify <file> for my task, can we coordinate?" })
\`\`\`

Do NOT edit files reserved by another worker without coordinating first.

`;
  }

  let out = `## Coordination

**Message budget: ${budget} messages this session.** The system enforces this — sends are rejected after the limit.

**Broadcasts go to the team feed — only the user sees them live.** Other workers see your broadcasts in their initial context only. Use DMs for time-sensitive peer coordination.

`;

  out += `### Announce yourself
After joining the mesh and starting your task, announce what you're working on:

\`\`\`typescript
pi_messenger({ action: "broadcast", message: "Starting <task-id> (<title>) — will create <files>" })
\`\`\`

`;

  if (level === "chatty") {
    out += `### Coordinate with peers
If a concurrent task involves files or interfaces related to yours, send a brief DM. Only message when there's a concrete coordination need — shared files, interfaces, or blocking questions.

\`\`\`typescript
pi_messenger({ action: "send", to: "<peer-name>", message: "I'm exporting FormatOptions from types.ts — will you need it?" })
\`\`\`

### Responding to messages
If a peer asks you a direct question, reply briefly. Ignore messages that don't require a response. Do NOT start casual conversations.

`;
  }

  out += `### On completion
Announce what you built:

\`\`\`typescript
pi_messenger({ action: "broadcast", message: "Completed <task-id>: <file> exports <symbols>" })
\`\`\`

### Reservations
Before editing files, check if another worker has reserved them via \`pi_messenger({ action: "list" })\`. If a file you need is reserved, message the owner to coordinate. Do NOT edit reserved files without coordinating first.

### Questions about dependencies
If your task depends on a completed task and something about its implementation is unclear, read the code and the task's progress log at \`.pi/messenger/crew/tasks/<task-id>.progress.md\`. Dependency authors are from previous waves and are no longer in the mesh.

`;

  if (level === "chatty") {
    out += `### Claim next task
After completing your assigned task, check if there are ready tasks you can pick up:

\`\`\`typescript
pi_messenger({ action: "task.ready" })
\`\`\`

If a task is ready, claim and implement it. If \`task.start\` fails (another worker claimed it first), check for other ready tasks. Only claim if your current task completed cleanly and quickly.

`;
  }

  return out;
}
