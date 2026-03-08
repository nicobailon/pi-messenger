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

// Event system — exports the rich SessionEvent / SessionEventSchema stream types
export * from "./events/index.js";

// Data export
export * from "./export/index.js";

// Event feed
export * from "./feed/index.js";

// Health monitoring — exports HealthStatus (canonical source in the barrel)
export * from "./health/index.js";

// Session lifecycle FSM
export * from "./lifecycle/index.js";

// Metrics aggregation
export * from "./metrics/index.js";

// Event replay
export * from "./replay/index.js";

// Session store
export * from "./store/index.js";

// Registry
export { MonitorRegistry, createMonitorRegistry } from "./registry.js";

// Types (attention, operator, commands) — session types exported selectively below
export * from "./types/attention.js";
export * from "./types/operator.js";

// Attention derivation
export { deriveAttentionItems } from "./attention/derivation.js";

// Session types — export new canonical names; omit backward-compat SessionEvent/SessionEventSchema
// aliases to avoid conflict with the richer types from events/index.js.
export type {
  SessionStatus,
  SessionMetadata,
  SessionMetrics,
  SessionHistoryEntry,
  SessionState,
} from "./types/session.js";
export {
  SessionStatusSchema,
  SessionMetadataSchema,
  SessionMetricsSchema,
  SessionHistoryEntrySchema,
  SessionStateSchema,
  buildWorkerSessionMetadata,
  buildWorkerSessionState,
} from "./types/session.js";

// UI rendering components — export selectively to avoid re-exporting HealthStatus
// (already exported by health/index.js above).
export { AttentionQueuePanel, type AttentionQueuePanelOptions } from "./ui/attention.js";
export {
  renderSessionRow,
  renderStatusBadge,
  renderMetricsSummary,
  renderHealthIndicator,
  renderGroupedSessions,
  groupSessionsByLifecycle,
  formatDuration,
  stripAnsi,
  visibleLen,
  ANSI,
  type SessionGroup,
} from "./ui/render.js";
export {
  renderSessionRow as renderSharedSessionRow,
  renderFreshnessBadge,
  renderAttentionBadge,
  formatFreshness,
  stripAnsi as stripSessionRowAnsi,
  ANSI as SESSION_ROW_ANSI,
  type SessionRowData,
} from "./ui/session-row.js";
export * from "./ui/inspector.js";
export { SessionDetailView, renderSessionDetailView, stripDetailAnsi } from "./ui/session-detail.js";
