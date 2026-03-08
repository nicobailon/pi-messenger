import type { SessionState, SessionStatus } from "../types/session.js";
import type { HealthStatus } from "../health/types.js";
import type { ComputedMetrics } from "../metrics/aggregator.js";
import type { AttentionItem, AttentionReason } from "../types/attention.js";

export function deriveAttentionItems(
  sessions: SessionState[],
  healthMap: Map<string, HealthStatus>,
  metricsMap: Map<string, ComputedMetrics>
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = new Date().toISOString();

  for (const session of sessions) {
    const health = healthMap.get(session.metadata.id) ?? "healthy";
    const metrics = metricsMap.get(session.metadata.id);

    if (session.status === "paused") {
      items.push({
        id: `att-${session.metadata.id}-paused`,
        sessionId: session.metadata.id,
        reason: "waiting_on_human",
        message: "Session is paused and waiting for human input.",
        recommendedAction: "Review and provide input to resume.",
        timestamp: now,
      });
      continue;
    }

    if (session.status === "error") {
      items.push({
        id: `att-${session.metadata.id}-error`,
        sessionId: session.metadata.id,
        reason: "failed_recoverable",
        message: "Session encountered an error and stopped.",
        recommendedAction: "Inspect logs and retry or fix issue.",
        timestamp: now,
      });
      continue;
    }

    if (health === "critical") {
      items.push({
        id: `att-${session.metadata.id}-critical`,
        sessionId: session.metadata.id,
        reason: "stuck",
        message: "Session appears to be stuck with no progress.",
        recommendedAction: "Investigate if the session is looping or blocked.",
        timestamp: now,
      });
    } else if (health === "degraded") {
      items.push({
        id: `att-${session.metadata.id}-degraded`,
        sessionId: session.metadata.id,
        reason: "degraded",
        message: "Session is showing signs of being stale.",
        recommendedAction: "Monitor session for continued inactivity.",
        timestamp: now,
      });
    }

    if (metrics && metrics.errorRate > 0.5 && metrics.totalEvents > 10) {
      items.push({
        id: `att-${session.metadata.id}-errors`,
        sessionId: session.metadata.id,
        reason: "high_error_rate",
        message: `High error rate detected (${(metrics.errorRate * 100).toFixed(0)}%).`,
        recommendedAction: "Check tool usage or agent logic.",
        timestamp: now,
      });
    }
  }

  return items;
}
