/**
 * Canonical State Normalizer — task-1
 *
 * Deterministic mapping utilities that translate legacy pi-messenger runtime
 * data into the canonical state model defined in `./types.ts`.
 *
 * All functions are pure (no side effects, no I/O). Each mapping is a direct
 * switch-based lookup so the compiler enforces exhaustiveness.
 *
 * ── Lifecycle mapping (status → CanonicalLifecycleState) ─────────────────────
 *
 *   Legacy SessionStatus:
 *     idle    → queued      (pending activation)
 *     active  → running     (actively executing)
 *     paused  → waiting     (suspended, awaiting human input)
 *     ended   → completed   (finished normally)
 *     error   → failed      (terminated by error)
 *
 *   Extended runtime signals:
 *     starting → starting   (initialising: spawning process, loading tools)
 *     canceled → canceled   (explicitly stopped before completion)
 *
 * ── Health mapping (health → CanonicalHealthState) ────────────────────────────
 *
 *   Direct mapping (from RuntimeHealthInput or RuntimeSessionInput.healthStatus):
 *     healthy  → active     (operating normally)
 *     degraded → degraded   (stale / reduced throughput)
 *     critical → stuck      (no progress for extended period)
 *
 *   Inference fallback (when no health data provided):
 *     queued / starting → idle
 *     running           → active
 *     waiting           → waiting
 *     completed / canceled / failed → offline
 *
 * ── Health derivation precedence in normalizeSession ─────────────────────────
 *
 *   1. RuntimeHealthInput parameter (highest — explicit external data)
 *   2. RuntimeSessionInput.healthStatus (inline shorthand)
 *   3. inferHealthFromLifecycle(lifecycle) (default fallback)
 *
 * Every input shape maps to exactly one health state. There are no gaps.
 */

import type {
  CanonicalLifecycleState,
  CanonicalHealthState,
  CanonicalMonitorState,
  CanonicalSession,
  RuntimeSessionInput,
  RuntimeHealthInput,
  SessionSections,
  AttentionView,
} from "./types.js";

// ─── Lifecycle mapping ────────────────────────────────────────────────────────

/**
 * Map a legacy `SessionStatus` (or extended runtime signal) to a
 * `CanonicalLifecycleState`.
 *
 * The mapping is intentionally explicit (switch, not a lookup table) so the
 * TypeScript compiler enforces exhaustiveness and catches new input values.
 *
 * Lifecycle mapping table:
 *   idle     → queued      | active   → running   | paused → waiting
 *   ended    → completed   | error    → failed
 *   starting → starting    | canceled → canceled
 */
export function mapSessionLifecycle(
  status: RuntimeSessionInput["status"]
): CanonicalLifecycleState {
  switch (status) {
    case "idle":
      return "queued";
    case "active":
      return "running";
    case "paused":
      return "waiting";
    case "ended":
      return "completed";
    case "error":
      return "failed";
    case "starting":
      return "starting";
    case "canceled":
      return "canceled";
    default: {
      // TypeScript exhaustiveness guard — never reached at runtime for valid inputs
      const _exhaustive: never = status;
      throw new Error(`Unknown SessionStatus: ${String(_exhaustive)}`);
    }
  }
}

// ─── Health mapping ───────────────────────────────────────────────────────────

/**
 * Map a legacy `HealthStatus` value to a `CanonicalHealthState`.
 *
 * Used when explicit health data is available (either via `RuntimeHealthInput`
 * parameter or `RuntimeSessionInput.healthStatus` field).
 *
 * The mapping is intentionally explicit (switch, not a lookup table) so the
 * TypeScript compiler enforces exhaustiveness.
 *
 * Health mapping table:
 *   healthy  → active   | degraded → degraded   | critical → stuck
 */
export function mapHealthState(
  health: RuntimeHealthInput["health"]
): CanonicalHealthState {
  switch (health) {
    case "healthy":
      return "active";
    case "degraded":
      return "degraded";
    case "critical":
      return "stuck";
    default: {
      const _exhaustive: never = health;
      throw new Error(`Unknown HealthStatus: ${String(_exhaustive)}`);
    }
  }
}

// ─── Health inference from lifecycle ─────────────────────────────────────────

/**
 * Infer a `CanonicalHealthState` from the lifecycle state when no explicit
 * health data is available. This is the lowest-precedence health source.
 *
 * Inference is intentional design, not a fallback kludge — certain health
 * states (idle, waiting, offline) represent lifecycle phases, not runtime
 * performance metrics, and cannot be measured by the health monitor alone.
 *
 * Inference table:
 *
 * | Lifecycle              | Inferred health | Rationale                              |
 * |------------------------|-----------------|----------------------------------------|
 * | queued / starting      | idle            | Session exists but hasn't started work |
 * | running                | active          | Optimistic default for live sessions   |
 * | waiting                | waiting         | Mirrors the lifecycle state directly   |
 * | completed / canceled   | offline         | Terminal — session is no longer live   |
 * | failed                 | offline         | Terminal — session is no longer live   |
 *
 * Every canonical lifecycle state maps to exactly one health state here.
 */
function inferHealthFromLifecycle(lifecycle: CanonicalLifecycleState): CanonicalHealthState {
  switch (lifecycle) {
    case "queued":
    case "starting":
      return "idle";
    case "running":
      return "active";
    case "waiting":
      return "waiting";
    case "completed":
    case "canceled":
    case "failed":
      return "offline";
    default: {
      const _exhaustive: never = lifecycle;
      throw new Error(`Unknown CanonicalLifecycleState: ${String(_exhaustive)}`);
    }
  }
}

// ─── Normalization pipeline ───────────────────────────────────────────────────

/**
 * Normalize a single runtime session + optional health input into a
 * `CanonicalSession`.
 *
 * Health derivation precedence (highest → lowest):
 *  1. `healthInput` parameter   — explicit `RuntimeHealthInput` from health monitor
 *  2. `session.healthStatus`    — inline legacy health shorthand on the session object
 *  3. `inferHealthFromLifecycle` — pure lifecycle-based inference (default fallback)
 *
 * Lifecycle derivation: always from `session.status` only, via `mapSessionLifecycle`.
 * No other field influences lifecycle.
 */
export function normalizeSession(
  session: RuntimeSessionInput,
  healthInput?: RuntimeHealthInput
): CanonicalSession {
  const lifecycle = mapSessionLifecycle(session.status);
  let health: CanonicalHealthState;
  if (healthInput) {
    // Precedence 1: explicit RuntimeHealthInput (highest)
    health = mapHealthState(healthInput.health);
  } else if (session.healthStatus !== undefined) {
    // Precedence 2: inline healthStatus shorthand
    health = mapHealthState(session.healthStatus);
  } else {
    // Precedence 3: infer from lifecycle (fallback)
    health = inferHealthFromLifecycle(lifecycle);
  }
  return { id: session.id, lifecycle, health };
}

/**
 * Normalize an array of runtime sessions with an optional health map.
 *
 * @param sessions   - Array of runtime session inputs
 * @param healthMap  - Optional map of sessionId → RuntimeHealthInput (highest precedence)
 */
export function normalizeSessions(
  sessions: RuntimeSessionInput[],
  healthMap?: Map<string, RuntimeHealthInput>
): CanonicalSession[] {
  return sessions.map((s) => normalizeSession(s, healthMap?.get(s.id)));
}

// ─── Section derivations ──────────────────────────────────────────────────────

/**
 * Derive Running / Queued / Completed / Failed sections from canonical sessions.
 *
 * Sections are derived solely from `lifecycle`. Health state does NOT affect
 * section placement — a stuck running session still appears in `running`.
 *
 * Grouping rules:
 *  - running:   lifecycle === "running" | "starting"
 *  - queued:    lifecycle === "queued"
 *  - completed: lifecycle === "completed" | "canceled"
 *  - failed:    lifecycle === "failed"
 *
 * Sessions with lifecycle === "waiting" are excluded from all sections;
 * they appear in the attention view instead.
 *
 * Sections are mutually exclusive (no session appears in two sections).
 * This function is pure and stable: input order is preserved within each group.
 */
export function deriveSections(sessions: CanonicalSession[]): SessionSections {
  return {
    running: sessions.filter(
      (s) => s.lifecycle === "running" || s.lifecycle === "starting"
    ),
    queued: sessions.filter((s) => s.lifecycle === "queued"),
    completed: sessions.filter(
      (s) => s.lifecycle === "completed" || s.lifecycle === "canceled"
    ),
    failed: sessions.filter((s) => s.lifecycle === "failed"),
  };
}

// ─── Attention derivations ────────────────────────────────────────────────────

/**
 * Derive attention / degraded / stuck views from canonical sessions.
 *
 * Attention is derived solely from `health`. Lifecycle state does NOT affect
 * attention placement — a completed session with degraded health still appears
 * in the attention view.
 *
 * Grouping rules:
 *  - degraded:         health === "degraded"
 *  - stuck:            health === "stuck"
 *  - needingAttention: [...degraded, ...stuck] (degraded first, then stuck)
 *
 * Ordering guarantee: all degraded sessions precede all stuck sessions in
 * `needingAttention`. Input order is preserved within each health group.
 *
 * This function is pure and stable: input order is preserved within each group.
 */
export function deriveAttentionView(sessions: CanonicalSession[]): AttentionView {
  const degraded = sessions.filter((s) => s.health === "degraded");
  const stuck = sessions.filter((s) => s.health === "stuck");
  return {
    degraded,
    stuck,
    needingAttention: [...degraded, ...stuck],
  };
}

// ─── Overall monitor state derivation ────────────────────────────────────────

/**
 * Derive the overall `CanonicalMonitorState` from a set of canonical sessions.
 *
 * Uses a health-first priority cascade — health drives the top two outcomes;
 * lifecycle drives the terminal outcomes.
 *
 * Priority (highest wins):
 *  1. blocked          — any session health === "stuck"
 *  2. attention_needed — any session health === "degraded" (no stuck)
 *  3. recovering       — all sessions terminal but some failed
 *  4. completed        — all sessions terminal, none failed
 *  5. healthy          — default (no special conditions)
 *
 * Terminal lifecycle states: completed | canceled | failed
 * Empty sessions list returns "healthy".
 */
export function deriveMonitorState(sessions: CanonicalSession[]): CanonicalMonitorState {
  if (sessions.length === 0) return "healthy";

  if (sessions.some((s) => s.health === "stuck")) return "blocked";
  if (sessions.some((s) => s.health === "degraded")) return "attention_needed";

  const allTerminal = sessions.every(
    (s) =>
      s.lifecycle === "completed" ||
      s.lifecycle === "canceled" ||
      s.lifecycle === "failed"
  );

  if (allTerminal) {
    return sessions.some((s) => s.lifecycle === "failed") ? "recovering" : "completed";
  }

  return "healthy";
}
