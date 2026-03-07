/**
 * SessionReplayer
 *
 * Reconstructs session state at any point in time by replaying stored events
 * from the event log maintained by a SessionEventEmitter.
 *
 * Key design:
 * - `replay(sessionId, toSequence?)` — build state up to (inclusive) a given
 *   sequence number, or full history if omitted.
 * - `replayRange(sessionId, from, to)` — return the raw SessionEvent slice
 *   covering [from, to] sequence numbers.
 * - `getSnapshot(sessionId, atTime)` — state as of a given ISO timestamp.
 *
 * Duration accounting mirrors SessionMetricsAggregator: paused intervals are
 * excluded from `metrics.duration`.
 */

import type { SessionEventEmitter } from "../events/emitter.js";
import type { SessionMetricsAggregator } from "../metrics/aggregator.js";
import type { SessionEvent } from "../events/types.js";
import type {
  SessionState,
  SessionStatus,
  SessionMetadata,
  SessionMetrics,
} from "../types/session.js";

// ─── SessionReplayer ──────────────────────────────────────────────────────────

export class SessionReplayer {
  private readonly emitter: SessionEventEmitter;
  // aggregator is accepted but not used for replay (we compute inline to avoid
  // reading live state that includes events beyond the replay boundary).
  // It's kept here for callers that want to pass it through.
  private readonly aggregator: SessionMetricsAggregator | undefined;

  constructor(emitter: SessionEventEmitter, aggregator?: SessionMetricsAggregator) {
    this.emitter = emitter;
    this.aggregator = aggregator;
  }

  /**
   * Replay all events for `sessionId`, optionally capped at `toSequence`
   * (inclusive).  Returns the reconstructed SessionState.
   */
  replay(sessionId: string, toSequence?: number): SessionState {
    const allEvents = this.emitter
      .getHistory()
      .filter((e) => e.sessionId === sessionId);

    const events =
      toSequence !== undefined
        ? allEvents.filter((e) => e.sequence <= toSequence)
        : allEvents;

    return this.buildStateFromEvents(sessionId, events);
  }

  /**
   * Return the raw SessionEvent objects for `sessionId` whose sequence numbers
   * fall within [from, to] (inclusive on both ends).
   */
  replayRange(sessionId: string, from: number, to: number): SessionEvent[] {
    return this.emitter
      .getHistory()
      .filter(
        (e) => e.sessionId === sessionId && e.sequence >= from && e.sequence <= to
      );
  }

  /**
   * Return the reconstructed SessionState as of the given ISO timestamp.
   * Only events whose `timestamp` (milliseconds) is <= the parsed value of
   * `atTime` are included in the replay.
   */
  getSnapshot(sessionId: string, atTime: string): SessionState {
    const cutoffMs = new Date(atTime).getTime();
    const events = this.emitter
      .getHistory()
      .filter((e) => e.sessionId === sessionId && e.timestamp <= cutoffMs);

    return this.buildStateFromEvents(sessionId, events);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Core state reconstruction: fold an ordered list of events into a
   * SessionState value.
   */
  private buildStateFromEvents(
    sessionId: string,
    events: SessionEvent[]
  ): SessionState {
    // ── Status ─────────────────────────────────────────────────────────────
    let status: SessionStatus = "idle";
    for (const event of events) {
      switch (event.type) {
        case "session.start":
          status = "active";
          break;
        case "session.pause":
          status = "paused";
          break;
        case "session.resume":
          status = "active";
          break;
        case "session.end":
          status = "ended";
          break;
        case "session.error":
          status = "error";
          break;
      }
    }

    // ── Metadata ───────────────────────────────────────────────────────────
    const startEvent = events.find((e) => e.type === "session.start");
    let agentName = "unknown";
    let model = "unknown";
    let startedAt: string;

    if (startEvent && startEvent.payload.type === "session.start") {
      agentName = startEvent.payload.agentName;
      model = startEvent.payload.model ?? "unknown";
      startedAt = new Date(startEvent.timestamp).toISOString();
    } else {
      startedAt = new Date(0).toISOString();
    }

    const metadata: SessionMetadata = {
      id: sessionId,
      name: agentName,
      cwd: ".",
      model,
      startedAt,
      agent: agentName,
    };

    // ── Metrics ────────────────────────────────────────────────────────────
    const metrics = this.computeMetricsFromEvents(events);

    // ── Simplified event list ──────────────────────────────────────────────
    const simplifiedEvents = events.map((e) => ({
      type: e.type,
      timestamp: new Date(e.timestamp).toISOString(),
      data: e.payload,
    }));

    return {
      status,
      metadata,
      metrics,
      events: simplifiedEvents,
    };
  }

  /**
   * Compute SessionMetrics from a list of events.
   * Duration excludes paused intervals (mirrors SessionMetricsAggregator logic).
   */
  private computeMetricsFromEvents(events: SessionEvent[]): SessionMetrics {
    let errorCount = 0;
    let toolCalls = 0;
    let activeSince: number | null = null;
    let accumulatedMs = 0;

    for (const event of events) {
      if (event.type === "session.error") errorCount++;
      if (event.type === "tool.call") toolCalls++;

      if (event.type === "session.start" || event.type === "session.resume") {
        if (activeSince === null) {
          activeSince = event.timestamp;
        }
      } else if (event.type === "session.pause") {
        if (activeSince !== null) {
          accumulatedMs += event.timestamp - activeSince;
          activeSince = null;
        }
      } else if (event.type === "session.end") {
        if (activeSince !== null) {
          accumulatedMs += event.timestamp - activeSince;
          activeSince = null;
        }
      }
    }

    // If the session is still active at the replay boundary, do NOT add more
    // time (we don't know how long it ran after the last event in the slice).

    return {
      duration: accumulatedMs,
      eventCount: events.length,
      errorCount,
      toolCalls,
      tokensUsed: 0,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a new SessionReplayer bound to the given emitter.
 * The aggregator parameter is optional — pass it when you want to keep a
 * reference alongside the replayer for other purposes.
 */
export function createSessionReplayer(
  emitter: SessionEventEmitter,
  aggregator?: SessionMetricsAggregator
): SessionReplayer {
  return new SessionReplayer(emitter, aggregator);
}
