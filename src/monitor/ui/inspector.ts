import { formatDuration, renderStatusBadge, renderHealthIndicator, ANSI, stripAnsi, visibleLen } from "./render.js";
import type { SessionState } from "../types/session.js";
import type { HealthStatus, HealthAlert } from "../health/types.js";

function pad(str: string, width: number): string {
  const vis = visibleLen(str);
  if (vis >= width) return str;
  return str + " ".repeat(width - vis);
}

function truncate(str: string, width: number): string {
  if (width <= 0) return "";
  const vis = visibleLen(str);
  if (vis <= width) return str;
  return str.substring(0, width - 3) + "...";
}

export function renderSessionInspector(
  session: SessionState,
  health: HealthStatus,
  alert?: HealthAlert,
  width = 80
): string[] {
  const innerWidth = Math.max(20, width);
  const lines: string[] = [];

  lines.push(pad(` ${ANSI.bold}Session Inspector${ANSI.reset}  —  ${session.metadata.name || session.metadata.id}`, innerWidth));
  lines.push(pad(` Status: ${renderStatusBadge(session.status)}    Health: ${renderHealthIndicator(health)}`, innerWidth));
  lines.push("".padEnd(innerWidth, "─"));

  let assignedTask = "Unknown";
  let lastHeartbeat = session.metadata.startedAt;
  let lastToolUsed = "None";
  let lastSuccessfulActivity = "None";
  let failureReason = "None";
  const reservations: string[] = [];
  
  const events = [...session.events].sort((a, b) => {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  if (events.length > 0) {
    lastHeartbeat = events[events.length - 1].timestamp;
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as any;
    // Support both `data` from old schema and `payload` from new schema
    const payload = e.payload || e.data;
    
    if (session.status === "error" && e.type === "session.error" && failureReason === "None") {
      if (payload && payload.message) {
        failureReason = payload.message;
      } else {
        failureReason = "Unknown error";
      }
    }
    
    if (e.type === "tool.call" && lastToolUsed === "None") {
      if (payload && payload.toolName) {
        lastToolUsed = payload.toolName;
      }
    }

    if (e.type === "tool.result" && lastSuccessfulActivity === "None") {
      if (payload && payload.success) {
        lastSuccessfulActivity = `${payload.toolName} (success) at ${new Date(e.timestamp).toLocaleTimeString()}`;
      }
    }

    if (e.type === "tool.call") {
      if (payload && payload.toolName === "reserve" && payload.args && Array.isArray(payload.args.paths)) {
        for (const p of payload.args.paths) {
            if (!reservations.includes(p)) reservations.push(p);
        }
      } else if (payload && payload.toolName === "pi_messenger" && payload.args && payload.args.action === "reserve" && Array.isArray(payload.args.paths)) {
        for (const p of payload.args.paths) {
            if (!reservations.includes(p)) reservations.push(p);
        }
      }
    }
    
    if (assignedTask === "Unknown") {
      if (e.type === "task.start" || e.type === "task.assigned") {
          if (payload && payload.id) assignedTask = payload.id;
      } else if (e.type === "session.start") {
          if (payload && payload.task) assignedTask = payload.task;
      }
    }
  }

  lines.push(pad(` ${ANSI.bold}Task:${ANSI.reset}        ${assignedTask}`, innerWidth));
  lines.push(pad(` ${ANSI.bold}Started:${ANSI.reset}     ${new Date(session.metadata.startedAt).toLocaleString()}`, innerWidth));
  lines.push(pad(` ${ANSI.bold}Last Active:${ANSI.reset} ${new Date(lastHeartbeat).toLocaleString()}`, innerWidth));
  lines.push(pad(` ${ANSI.bold}Last Tool:${ANSI.reset}   ${lastToolUsed}`, innerWidth));
  lines.push(pad(` ${ANSI.bold}Last Success:${ANSI.reset} ${lastSuccessfulActivity}`, innerWidth));
  lines.push(pad(` ${ANSI.bold}Age:${ANSI.reset}        ${formatDuration(Date.now() - Date.parse(lastHeartbeat))}`, innerWidth));
  
  if (reservations.length > 0) {
      lines.push(pad(` ${ANSI.bold}Reservations:${ANSI.reset} ${truncate(reservations.join(", "), innerWidth - 20)}`, innerWidth));
  }

  if (session.status === "error") {
      lines.push("".padEnd(innerWidth, "─"));
      lines.push(pad(` ${ANSI.red}Diagnostics:${ANSI.reset} ${truncate(failureReason, innerWidth - 15)}`, innerWidth));
  } else if (health === "degraded" || health === "critical") {
      lines.push("".padEnd(innerWidth, "─"));
      const selected = alert?.explanation;
      if (selected) {
        const color = health === "critical" ? ANSI.red : ANSI.yellow;
        lines.push(pad(` ${color}Diagnostics:${ANSI.reset} ${truncate(selected.summary, innerWidth - 15)}`, innerWidth));
        lines.push(pad(` ${ANSI.dim}repeat ${selected.repeatCount} / history ${selected.historyCount}${ANSI.reset}`, innerWidth));
        if (selected.recommendedAction) {
          lines.push(pad(` ${ANSI.dim}Action:${ANSI.reset} ${truncate(selected.recommendedAction, innerWidth - 10)}`, innerWidth));
        }
      } else {
        const alertMsg = alert ? alert.reason : "Session is not healthy";
        const color = health === "critical" ? ANSI.red : ANSI.yellow;
        lines.push(pad(` ${color}Diagnostics:${ANSI.reset} ${truncate(alertMsg, innerWidth - 15)}`, innerWidth));
      }
  }

  lines.push("".padEnd(innerWidth, "─"));
  let nextAction = "Monitor session stream";
  if (session.status === "error") nextAction = "Review failure logs and retry or reassign task";
  else if (health === "critical") nextAction = "Escalate to operator / Pause session for inspection";
  else if (health === "degraded") nextAction = "Check if agent is stuck in a loop";
  else if (session.status === "idle") nextAction = "Assign a new task";
  else if (session.status === "paused") nextAction = "Review and resume session";

  lines.push(pad(` ${ANSI.bold}Action:${ANSI.reset}      ${nextAction}`, innerWidth));

  return lines;
}
