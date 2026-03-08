import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createMonitorRegistry, MonitorRegistry } from "../../src/monitor/index.js";
import type { HealthAlert } from "../../src/monitor/health/types.js";

describe("MonitorRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates all monitor services behind a single import and wires them together", () => {
    const registry = createMonitorRegistry();

    expect(registry).toBeInstanceOf(MonitorRegistry);
    expect(registry.store).toBeDefined();
    expect(registry.emitter).toBeDefined();
    expect(registry.lifecycle).toBeDefined();
    expect(registry.aggregator).toBeDefined();
    expect(registry.commandHandler).toBeDefined();
    expect(registry.healthMonitor).toBeDefined();
    expect(registry.replayer).toBeDefined();
    expect(registry.exporter).toBeDefined();
    expect(registry.feedSubscriber).toBeDefined();

    const sessionId = registry.lifecycle.start({
      name: "registry-session",
      cwd: "/tmp/registry",
      model: "claude-test",
      agent: "ZenJaguar",
      taskId: "task-3",
    });

    registry.emitter.emit({
      id: randomUUID(),
      type: "tool.call",
      sessionId,
      timestamp: Date.now(),
      sequence: 0,
      payload: {
        type: "tool.call",
        toolName: "bash",
        args: { command: "npm test" },
      },
    });

    expect(registry.store.get(sessionId)?.status).toBe("active");
    expect(registry.commandHandler.execute({ action: "inspect", sessionId }).success).toBe(true);
    expect(registry.aggregator.computeMetrics(sessionId).toolCalls).toBe(1);
    expect(registry.replayer.replay(sessionId).metadata.id).toBe(sessionId);
    expect(registry.exporter.toJSON(sessionId)).toContain(`"sessionId": "${sessionId}"`);
    expect(registry.feedSubscriber.getBuffer().some((event) => event.sessionId === sessionId)).toBe(true);

    registry.dispose();
  });

  it("dispose stops health polling and detaches metric aggregation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));

    const registry = createMonitorRegistry();
    registry.healthMonitor.setThresholds({
      staleAfterMs: 10,
      stuckAfterMs: 20,
      errorRateThreshold: 0.5,
    });

    const alerts: HealthAlert[] = [];
    registry.healthMonitor.onAlert((alert) => alerts.push(alert));

    const sessionId = registry.lifecycle.start({
      name: "polling-session",
      cwd: "/tmp/registry",
      model: "claude-test",
      agent: "ZenJaguar",
      taskId: "task-3",
    });

    registry.healthMonitor.start(5);
    registry.dispose();

    vi.advanceTimersByTime(100);
    expect(alerts).toHaveLength(0);

    const metricsBefore = registry.aggregator.computeMetrics(sessionId);
    registry.emitter.emit({
      id: randomUUID(),
      type: "tool.call",
      sessionId,
      timestamp: Date.now(),
      sequence: 0,
      payload: {
        type: "tool.call",
        toolName: "bash",
      },
    });

    const metricsAfter = registry.aggregator.computeMetrics(sessionId);
    expect(metricsAfter.totalEvents).toBe(metricsBefore.totalEvents);
  });
});
