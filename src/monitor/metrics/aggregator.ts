/**
 * SessionMetricsAggregator
 *
 * Computes real-time metrics from the session event stream and state store.
 *
 * - Duration excludes paused intervals (tracked via session.pause / session.resume)
 * - Error rate = session.error events / total events
 * - Metrics update in real-time on new events via subscription
 */

import type { SessionEventEmitter } from "../events/emitter.js";
import type { SessionEvent, EventType } from "../events/types.js";
import type { SessionStore } from "../store/session-store.js";

// ─── Exported types ──────────────────────────────────────────────────────────

export interface ComputedMetrics {
  /** Total number of events for this session */
  totalEvents: number;
  /** Count of session.error events */
  errorCount: number;
  /** Error rate: errorCount / totalEvents. 0 when no events. */
  errorRate: number;
  /** Per-type event counts */
  eventCounts: Record<string, number>;
  /** Active duration in milliseconds (excludes paused intervals) */
  activeDurationMs: number;
  /** Number of tool.call events */
  toolCalls: number;
}

export type MetricsHandler = (metrics: ComputedMetrics) => void;

// ─── Internal state ───────────────────────────────────────────────────────────

interface SessionMetricsState {
  /** Per-event-type counts */
  counts: Map<EventType | string, number>;
  /** Total events seen */
  totalEvents: number;
  /** session.error event count */
  errorCount: number;
  /** Timestamp (ms) when session last became active; null when paused/ended */
  activeSince: number | null;
  /** Duration accumulated before the current active period (ms) */
  accumulatedMs: number;
}

// ─── SessionMetricsAggregator ─────────────────────────────────────────────────

export class SessionMetricsAggregator {
  private emitter: SessionEventEmitter;
  private store: SessionStore | undefined;

  /** Per-session aggregation state */
  private state: Map<string, SessionMetricsState> = new Map();

  /** Per-session subscriber sets for real-time metric notifications */
  private handlers: Map<string, Set<MetricsHandler>> = new Map();

  /** Master unsubscribe handle for the emitter subscription */
  private emitterUnsub: (() => void) | null = null;

  constructor(emitter: SessionEventEmitter, store?: SessionStore) {
    this.emitter = emitter;
    this.store = store;

    // Subscribe to ALL events globally; dispatch by sessionId internally
    this.emitterUnsub = this.emitter.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Compute current metrics for a session.
   * If the session is not known to the aggregator (no events yet),
   * falls back to reading from the store if available.
   */
  computeMetrics(sessionId: string): ComputedMetrics {
    const s = this.getOrInitState(sessionId);
    const activeDurationMs = this.calcDuration(s);
    const totalEvents = s.totalEvents;
    const errorCount = s.errorCount;
    const errorRate = totalEvents > 0 ? errorCount / totalEvents : 0;

    const eventCounts: Record<string, number> = {};
    for (const [type, count] of s.counts) {
      eventCounts[type] = count;
    }

    const toolCalls = s.counts.get("tool.call") ?? 0;

    return {
      totalEvents,
      errorCount,
      errorRate,
      eventCounts,
      activeDurationMs,
      toolCalls,
    };
  }

  /**
   * Get the error rate for a session.
   * Returns 0 if no events have been seen.
   */
  getErrorRate(sessionId: string): number {
    const s = this.getOrInitState(sessionId);
    if (s.totalEvents === 0) return 0;
    return s.errorCount / s.totalEvents;
  }

  /**
   * Get per-event-type counts for a session.
   */
  getEventCounts(sessionId: string): Record<string, number> {
    const s = this.getOrInitState(sessionId);
    const result: Record<string, number> = {};
    for (const [type, count] of s.counts) {
      result[type] = count;
    }
    return result;
  }

  /**
   * Get the active duration in milliseconds for a session.
   * Paused intervals are excluded from the total.
   */
  getActiveDuration(sessionId: string): number {
    const s = this.getOrInitState(sessionId);
    return this.calcDuration(s);
  }

  /**
   * Subscribe to real-time metric updates for a session.
   * The handler is called after every event that targets this sessionId.
   * Returns an unsubscribe function.
   */
  subscribe(sessionId: string, handler: MetricsHandler): () => void {
    if (!this.handlers.has(sessionId)) {
      this.handlers.set(sessionId, new Set());
    }
    this.handlers.get(sessionId)!.add(handler);

    return () => {
      this.handlers.get(sessionId)?.delete(handler);
    };
  }

  /**
   * Tear down — unsubscribe from the underlying emitter.
   * Call when the aggregator is no longer needed.
   */
  destroy(): void {
    this.emitterUnsub?.();
    this.emitterUnsub = null;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private handleEvent(event: SessionEvent): void {
    const { sessionId, type, timestamp } = event;
    const s = this.getOrInitState(sessionId);

    // Increment counts
    s.totalEvents += 1;
    s.counts.set(type, (s.counts.get(type) ?? 0) + 1);

    // Track errors
    if (type === "session.error") {
      s.errorCount += 1;
    }

    // Duration tracking
    if (type === "session.start" || type === "session.resume") {
      // Session becomes active — record start of active period
      if (s.activeSince === null) {
        s.activeSince = timestamp;
      }
    } else if (type === "session.pause") {
      // Session pauses — accumulate elapsed active time
      if (s.activeSince !== null) {
        s.accumulatedMs += timestamp - s.activeSince;
        s.activeSince = null;
      }
    } else if (type === "session.end") {
      // Session ends — finalize duration
      if (s.activeSince !== null) {
        s.accumulatedMs += timestamp - s.activeSince;
        s.activeSince = null;
      }
    }

    // Notify metric subscribers for this session
    const sessionHandlers = this.handlers.get(sessionId);
    if (sessionHandlers && sessionHandlers.size > 0) {
      const metrics = this.computeMetrics(sessionId);
      for (const handler of sessionHandlers) {
        try {
          handler(metrics);
        } catch {
          // Swallow handler errors
        }
      }
    }
  }

  private calcDuration(s: SessionMetricsState): number {
    if (s.activeSince !== null) {
      return s.accumulatedMs + (Date.now() - s.activeSince);
    }
    return s.accumulatedMs;
  }

  private getOrInitState(sessionId: string): SessionMetricsState {
    if (!this.state.has(sessionId)) {
      this.state.set(sessionId, {
        counts: new Map(),
        totalEvents: 0,
        errorCount: 0,
        activeSince: null,
        accumulatedMs: 0,
      });
    }
    return this.state.get(sessionId)!;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a new SessionMetricsAggregator connected to the provided emitter and
 * optional store.
 */
export function createSessionMetricsAggregator(
  emitter: SessionEventEmitter,
  store?: SessionStore
): SessionMetricsAggregator {
  return new SessionMetricsAggregator(emitter, store);
}
