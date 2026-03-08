/**
 * Shared helpers for integration tests.
 *
 * Wires all monitor components together into a full pipeline.
 */

import { SessionStore } from "../../../src/monitor/store/session-store.js";
import { SessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import { SessionLifecycleManager } from "../../../src/monitor/lifecycle/manager.js";
import { SessionMetricsAggregator } from "../../../src/monitor/metrics/aggregator.js";
import { OperatorCommandHandler } from "../../../src/monitor/commands/handler.js";
import { SessionHealthMonitor } from "../../../src/monitor/health/monitor.js";
import { SessionReplayer } from "../../../src/monitor/replay/replayer.js";
import { SessionExporter } from "../../../src/monitor/export/exporter.js";
import { SessionFeedSubscriber } from "../../../src/monitor/feed/subscriber.js";
import type { SessionEvent } from "../../../src/monitor/events/types.js";
import { randomUUID } from "node:crypto";

// ─── Pipeline wiring ──────────────────────────────────────────────────────────

export interface FullPipeline {
  store: SessionStore;
  emitter: SessionEventEmitter;
  lifecycle: SessionLifecycleManager;
  aggregator: SessionMetricsAggregator;
  commandHandler: OperatorCommandHandler;
  healthMonitor: SessionHealthMonitor;
  replayer: SessionReplayer;
  exporter: SessionExporter;
  feedSubscriber: SessionFeedSubscriber;
}

/**
 * Wire all monitor components together into a full pipeline.
 * All components share the same store and emitter.
 * No external state (no file system, no real timers).
 */
export function setupFullPipeline(): FullPipeline {
  const store = new SessionStore();
  const emitter = new SessionEventEmitter();
  const lifecycle = new SessionLifecycleManager(store, emitter);
  const aggregator = new SessionMetricsAggregator(emitter, store);
  const commandHandler = new OperatorCommandHandler(lifecycle);
  const healthMonitor = new SessionHealthMonitor(store, emitter, aggregator);
  const replayer = new SessionReplayer(emitter, aggregator);
  const exporter = new SessionExporter(
    (id) => store.get(id),
    (id) => emitter.getHistory().filter((e: SessionEvent) => e.sessionId === id),
  );
  const feedSubscriber = new SessionFeedSubscriber(emitter);
  feedSubscriber.subscribe();

  return {
    store,
    emitter,
    lifecycle,
    aggregator,
    commandHandler,
    healthMonitor,
    replayer,
    exporter,
    feedSubscriber,
  };
}

// ─── Session creation helpers ─────────────────────────────────────────────────

/**
 * Return a minimal valid session metadata object.
 * `id` and `startedAt` are excluded so SessionLifecycleManager auto-generates them.
 */
export function makeMetadata(overrides: Partial<{
  name: string;
  cwd: string;
  model: string;
  agent: string;
  taskId: string;
}> = {}) {
  return {
    name: overrides.name ?? "test-session",
    cwd: overrides.cwd ?? "/tmp/test",
    model: overrides.model ?? "claude-3",
    agent: overrides.agent ?? "test-agent",
    taskId: overrides.taskId ?? randomUUID(),
  };
}

/**
 * Create a new session via the lifecycle manager and return its ID.
 */
export function createTestSession(
  lifecycle: SessionLifecycleManager,
  overrides: Parameters<typeof makeMetadata>[0] = {},
): string {
  return lifecycle.start(makeMetadata(overrides));
}

/**
 * Emit `count` tool.call events for the given session onto `emitter`.
 * Sequence numbers are auto-assigned by the emitter.
 */
export function emitTestEvents(
  emitter: SessionEventEmitter,
  sessionId: string,
  count = 3,
): void {
  for (let i = 0; i < count; i++) {
    emitter.emit({
      id: randomUUID(),
      type: "tool.call",
      sessionId,
      timestamp: Date.now(),
      sequence: 0, // overwritten by emitter
      payload: {
        type: "tool.call",
        toolName: `tool-${i}`,
        args: { index: i },
      },
    });
  }
}
