import type { SessionEvent, EventType } from "./types.js";

// Handler type for session events
export type SessionEventHandler = (event: SessionEvent) => void;

// Optional filter function or event type array
export type SessionEventFilter = EventType[] | ((event: SessionEvent) => boolean);

interface Subscription {
  handler: SessionEventHandler;
  filter?: SessionEventFilter;
}

export class SessionEventEmitter {
  private subscriptions: Set<Subscription> = new Set();
  private history: SessionEvent[] = [];
  private sequenceCounter: number = 0;

  /**
   * Emit an event. Auto-assigns a monotonically increasing sequence number.
   * Stores the event in history and delivers to all matching subscribers.
   */
  emit(event: SessionEvent): void {
    // Auto-increment sequence number — overwrite whatever was passed in
    const sequenced: SessionEvent = {
      ...event,
      sequence: this.sequenceCounter++,
    };
    this.history.push(sequenced);

    for (const sub of this.subscriptions) {
      if (this.matchesFilter(sequenced, sub.filter)) {
        try {
          sub.handler(sequenced);
        } catch {
          // Swallow handler errors so one bad handler doesn't break others
        }
      }
    }
  }

  /**
   * Subscribe to events.
   * @param handler  Called for each matching event.
   * @param filter   Optional array of event types OR a predicate function.
   * @returns        An unsubscribe function.
   */
  subscribe(handler: SessionEventHandler, filter?: SessionEventFilter): () => void {
    const sub: Subscription = { handler, filter };
    this.subscriptions.add(sub);
    return () => {
      this.subscriptions.delete(sub);
    };
  }

  /**
   * Remove a handler added via subscribe.
   * Removes ALL subscriptions whose handler reference matches.
   */
  unsubscribe(handler: SessionEventHandler): void {
    for (const sub of this.subscriptions) {
      if (sub.handler === handler) {
        this.subscriptions.delete(sub);
      }
    }
  }

  /**
   * Return up to `limit` most recent events (newest last).
   * If limit is omitted, returns the full history.
   */
  getHistory(limit?: number): SessionEvent[] {
    if (limit === undefined) {
      return [...this.history];
    }
    return this.history.slice(-limit);
  }

  /**
   * Clear event history and reset the sequence counter.
   * Subscriptions are NOT cleared.
   */
  clear(): void {
    this.history = [];
    this.sequenceCounter = 0;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private matchesFilter(event: SessionEvent, filter?: SessionEventFilter): boolean {
    if (!filter) return true;
    if (Array.isArray(filter)) {
      return (filter as EventType[]).includes(event.type);
    }
    return filter(event);
  }
}

/**
 * Factory function for convenience.
 */
export function createSessionEventEmitter(): SessionEventEmitter {
  return new SessionEventEmitter();
}
