/**
 * Canonical Session/Operator Monitor State Model — task-1
 *
 * Defines the canonical state vocabulary for the session monitor.
 * These types are the source of truth for section derivations, attention
 * views, and overall monitor health — consumed by any future UI layer.
 *
 * Design principles:
 *  - Schema-first: every enum is backed by a Zod schema for runtime validation
 *  - Backward compatible: does NOT modify legacy SessionStatus / HealthStatus
 *  - Input types describe what pi-messenger runtime data looks like before mapping
 *  - Output types (CanonicalSession, SessionSections, AttentionView) are pure
 *    data — no rendering dependencies
 *
 * State taxonomy:
 *  - Lifecycle state  → WHERE a session is in its execution arc
 *                       (queued → starting → running → waiting → completed/failed/canceled)
 *  - Health state     → HOW WELL a live/recent session is performing
 *                       (active | idle | waiting | degraded | stuck | offline)
 *  - Task state       → STATUS of the associated task in the task scheduler
 *                       (pending | running | done | failed | canceled)
 *  - Runtime status   → OS/process-level view (spawning | live | draining | terminated)
 *
 * These four dimensions are orthogonal: lifecycle and health are canonical outputs;
 * task state and runtime status are informational inputs only.
 */

import { z } from "zod";

// ─── Canonical lifecycle state ────────────────────────────────────────────────

/**
 * Canonical session lifecycle state.
 *
 * Represents WHERE a session is in its execution arc. Derived deterministically
 * from `RuntimeSessionInput.status` by `mapSessionLifecycle`.
 *
 * | State     | Description                                              | Source status    |
 * |-----------|----------------------------------------------------------|------------------|
 * | queued    | Session created but not yet started (pending activation) | idle             |
 * | starting  | Session is initialising (spawning process, loading tools)| starting         |
 * | running   | Session is actively executing work                       | active           |
 * | waiting   | Session is suspended, awaiting external input            | paused           |
 * | completed | Session finished normally                                | ended            |
 * | failed    | Session terminated due to an unrecoverable error         | error            |
 * | canceled  | Session was deliberately stopped before completion       | canceled         |
 *
 * Precedence note: lifecycle is always derived solely from `status` — no other
 * input field affects it.
 */
export const CanonicalLifecycleStateSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "canceled",
]);
export type CanonicalLifecycleState = z.infer<typeof CanonicalLifecycleStateSchema>;

// ─── Canonical health state ───────────────────────────────────────────────────

/**
 * Canonical health state for a session or operator.
 *
 * Represents HOW WELL a session is performing. Derived via a three-level
 * precedence chain in `normalizeSession`:
 *  1. Explicit `RuntimeHealthInput` parameter (direct mapping from HealthStatus)
 *  2. `RuntimeSessionInput.healthStatus` field (inline health shorthand)
 *  3. Inference from lifecycle via `inferHealthFromLifecycle` (default fallback)
 *
 * Direct-mapping states (from HealthStatus):
 *
 * | State    | Description                                               | Source health |
 * |----------|-----------------------------------------------------------|---------------|
 * | active   | Operating normally with recent activity                   | healthy       |
 * | degraded | Showing signs of staleness — reduced throughput           | degraded      |
 * | stuck    | No progress detected for an extended period               | critical      |
 *
 * Inference-only states (from lifecycle when no health data provided):
 *
 * | State    | Description                                               | Inferred from              |
 * |----------|-----------------------------------------------------------|----------------------------|
 * | idle     | Running but no recent work (normal for queued sessions)   | queued or starting         |
 * | waiting  | Suspended and waiting for input (mirrors lifecycle)       | waiting                    |
 * | offline  | Session has ended or is unreachable                       | completed, canceled, failed|
 *
 * Every live/runtime shape maps to exactly one health state. There are no gaps.
 */
export const CanonicalHealthStateSchema = z.enum([
  "active",
  "idle",
  "waiting",
  "degraded",
  "stuck",
  "offline",
]);
export type CanonicalHealthState = z.infer<typeof CanonicalHealthStateSchema>;

// ─── Canonical monitor/run state ──────────────────────────────────────────────

/**
 * Overall canonical monitor state across all sessions.
 *
 * Derived by `deriveMonitorState` using health-first priority cascade:
 *  1. blocked          — any session health === "stuck"
 *  2. attention_needed — any session health === "degraded" (no stuck)
 *  3. recovering       — all sessions terminal, some failed
 *  4. completed        — all sessions terminal, none failed
 *  5. healthy          — default
 *
 * | State           | Description                                         |
 * |-----------------|-----------------------------------------------------|
 * | healthy         | All sessions are running normally                   |
 * | attention_needed| One or more sessions are degraded (but not blocked) |
 * | blocked         | One or more sessions are stuck                      |
 * | recovering      | All work ended but some sessions failed             |
 * | completed       | All sessions finished without failures              |
 */
export const CanonicalMonitorStateSchema = z.enum([
  "healthy",
  "attention_needed",
  "blocked",
  "recovering",
  "completed",
]);
export type CanonicalMonitorState = z.infer<typeof CanonicalMonitorStateSchema>;

// ─── Input types for runtime mapping ─────────────────────────────────────────

/**
 * Runtime session data needed for lifecycle and health mapping.
 *
 * Accepts the full pi-messenger session status vocabulary — legacy five-state
 * (`idle | active | paused | ended | error`) plus the two richer signals
 * (`starting | canceled`) that carry process-level lifecycle semantics.
 *
 * Field precedence for health derivation in `normalizeSession`:
 *  1. `RuntimeHealthInput` parameter (explicit, highest priority)
 *  2. `healthStatus` field on this object (inline shorthand)
 *  3. Inference from `lifecycle` via `inferHealthFromLifecycle` (default fallback)
 *
 * Field precedence note: `status` → `lifecycle` is always deterministic.
 * `taskState` and `runtimeStatus` are carried through for logging/debugging
 * but do NOT affect lifecycle or health mapping — those derive solely from
 * `status` and the health sources above.
 */
export interface RuntimeSessionInput {
  /** Session identifier (matches SessionMetadata.id) */
  id: string;
  /**
   * Session status driving lifecycle mapping.
   *
   * Legacy values (pi-messenger SessionStatus):
   *   idle    → queued    | active  → running   | paused → waiting
   *   ended   → completed | error   → failed
   *
   * Extended values (richer runtime signals):
   *   starting → starting  (process is initialising before active work)
   *   canceled → canceled  (explicit operator cancellation before completion)
   *
   * Typed as string literal union (not imported from SessionStatus) to avoid
   * import cycles; mapSessionLifecycle enforces exhaustiveness at the switch.
   */
  status:
    | "idle"
    | "active"
    | "paused"
    | "ended"
    | "error"
    | "starting"
    | "canceled";
  /**
   * Task-level state carried from the task scheduler.
   * Informational only — does NOT influence lifecycle or health mapping.
   * Useful for cross-referencing task graph state with session state.
   * Distinct from `lifecycle`: a session can be `running` while its task is `pending`.
   */
  taskState?: "pending" | "running" | "done" | "failed" | "canceled";
  /**
   * Process-level runtime status (OS / subprocess view).
   * Informational only — distinct from session lifecycle and task state.
   * Useful for debugging spawn failures or drain timing.
   */
  runtimeStatus?: "spawning" | "live" | "draining" | "terminated";
  /**
   * Process flag: session is in the initialisation phase.
   * Correlates with `status: "starting"`. Informational only.
   */
  isStarting?: boolean;
  /**
   * Process flag: session was explicitly canceled by the operator.
   * Correlates with `status: "canceled"`. Informational only.
   */
  isCanceled?: boolean;
  /**
   * Inline health shorthand — the legacy HealthStatus value for this session.
   *
   * Used when the caller has health data co-located with session data and does
   * not want to build a separate `RuntimeHealthInput` map.
   *
   * Precedence: explicit `RuntimeHealthInput` parameter > `healthStatus` > inference.
   */
  healthStatus?: "healthy" | "degraded" | "critical";
  /** Epoch ms when the session started (optional for queued sessions) */
  startedAt?: number;
  /** Epoch ms of last recorded activity (for staleness / stuck detection) */
  lastActivityAt?: number;
  /** Cumulative error count for richer failed/recovering distinction */
  errorCount?: number;
}

/**
 * Minimal runtime health data needed for health state mapping.
 *
 * Accepts the legacy `HealthStatus` values from the health monitor
 * (`healthy | degraded | critical`).
 *
 * When provided to `normalizeSession`, this takes the highest precedence
 * over `RuntimeSessionInput.healthStatus` and lifecycle inference.
 */
export interface RuntimeHealthInput {
  /** Session identifier */
  sessionId: string;
  /**
   * Legacy health status from `SessionHealthMonitor`.
   * Typed as string literal union to mirror HealthStatus without a hard
   * import cycle.
   */
  health: "healthy" | "degraded" | "critical";
}

// ─── Canonical session record ─────────────────────────────────────────────────

/**
 * Fully normalized representation of a session with canonical states.
 *
 * Produced by the normalization pipeline; consumed by section and
 * attention derivations. Intentionally minimal — add fields only when
 * a derivation function demonstrably requires them.
 */
export interface CanonicalSession {
  /** Session identifier */
  id: string;
  /** Canonical lifecycle state */
  lifecycle: CanonicalLifecycleState;
  /** Canonical health state */
  health: CanonicalHealthState;
}

// ─── Section view ─────────────────────────────────────────────────────────────

/**
 * Grouped session sections for overview display.
 *
 * Derived deterministically from `CanonicalSession.lifecycle`.
 * Health state does NOT affect section placement.
 * Each array is a stable, ordered subset of the input list.
 *
 * Grouping rules:
 *  - running:   lifecycle === "running" | "starting"
 *  - queued:    lifecycle === "queued"
 *  - completed: lifecycle === "completed" | "canceled"
 *  - failed:    lifecycle === "failed"
 *
 * Sessions with lifecycle === "waiting" are excluded from all sections;
 * they appear in the AttentionView instead.
 */
export interface SessionSections {
  /** Sessions that are actively executing (lifecycle: running | starting) */
  running: CanonicalSession[];
  /** Sessions pending activation (lifecycle: queued) */
  queued: CanonicalSession[];
  /** Sessions that finished normally (lifecycle: completed | canceled) */
  completed: CanonicalSession[];
  /** Sessions that terminated with an error (lifecycle: failed) */
  failed: CanonicalSession[];
}

// ─── Attention view ───────────────────────────────────────────────────────────

/**
 * Filtered sessions needing operator attention.
 *
 * Derived deterministically from `CanonicalSession.health`.
 * Lifecycle state does NOT affect attention placement.
 * `needingAttention` is the ordered union of `degraded` then `stuck`
 * (degraded always precedes stuck for stable display ordering).
 *
 * Included health states: degraded, stuck
 * Excluded health states: active, idle, waiting, offline
 */
export interface AttentionView {
  /** Sessions with degraded health (stale / reduced throughput) */
  degraded: CanonicalSession[];
  /** Sessions with stuck health (no progress detected) */
  stuck: CanonicalSession[];
  /** Union: all sessions with degraded or stuck health, degraded first */
  needingAttention: CanonicalSession[];
}
