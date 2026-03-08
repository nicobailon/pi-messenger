import { describe, expect, it } from "vitest";
import {
  SessionMetadataSchema,
  buildWorkerSessionMetadata,
  buildWorkerSessionState,
} from "../../../src/monitor/types/session.js";
import { renderSessionDetailView, stripDetailAnsi } from "../../../src/monitor/ui/session-detail.js";
import type { LiveWorkerInfo, WorkerRuntimeSession } from "../../../crew/live-progress.js";

describe("SessionMetadataSchema crew fields", () => {
  it("accepts optional crew worker fields", () => {
    const metadata = SessionMetadataSchema.parse({
      id: "task-2",
      name: "FastNova",
      cwd: "/tmp/project",
      model: "anthropic/claude-haiku-4-5",
      startedAt: "2026-03-08T03:35:16.816Z",
      agent: "crew-worker",
      taskId: "task-2",
      workerPid: 1234,
      agentRole: "crew-worker",
    });

    expect(metadata.taskId).toBe("task-2");
    expect(metadata.workerPid).toBe(1234);
    expect(metadata.agentRole).toBe("crew-worker");
  });

  it("builds session metadata from a live worker snapshot", () => {
    const worker: LiveWorkerInfo = {
      cwd: "/tmp/project",
      taskId: "task-2",
      agent: "crew-worker",
      name: "FastNova",
      startedAt: Date.UTC(2026, 2, 8, 3, 35, 16, 816),
      progress: {
        agent: "crew-worker",
        status: "running",
        recentTools: [],
        toolCallCount: 1,
        tokens: 24,
        durationMs: 1000,
        filesModified: [],
        toolCallBuckets: [],
        model: "anthropic/claude-haiku-4-5",
      },
    };

    const metadata = buildWorkerSessionMetadata(worker);
    expect(metadata.id).toBe("task-2");
    expect(metadata.name).toBe("FastNova");
    expect(metadata.taskId).toBe("task-2");
    expect(metadata.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("builds a detail-view-friendly session state from actual pi runtime events", () => {
    const worker: LiveWorkerInfo = {
      cwd: "/tmp/project",
      taskId: "task-6",
      agent: "crew-worker",
      name: "SwiftGrove",
      startedAt: Date.UTC(2026, 2, 8, 12, 0, 0, 0),
      progress: {
        agent: "crew-worker",
        status: "completed",
        currentTool: undefined,
        currentToolArgs: undefined,
        recentTools: [],
        toolCallCount: 1,
        tokens: 42,
        durationMs: 4_000,
        filesModified: [],
        toolCallBuckets: [],
        model: "anthropic/claude-haiku-4-5",
      },
    };

    const runtime: WorkerRuntimeSession = {
      cwd: worker.cwd,
      taskId: worker.taskId,
      startedAt: worker.startedAt,
      endedAt: worker.startedAt + 4_000,
      status: "completed",
      exitCode: 0,
      finalOutput: "Completed detail integration",
      events: [
        {
          timestamp: worker.startedAt + 500,
          event: {
            type: "tool_execution_start",
            toolName: "bash",
            args: { command: "npm test" },
          },
        },
        {
          timestamp: worker.startedAt + 1_500,
          event: {
            type: "tool_execution_end",
            toolName: "bash",
            result: {
              content: [{ type: "text", text: "PASS tests/monitor/ui/session-detail.test.ts" }],
              isError: false,
            },
          },
        },
        {
          timestamp: worker.startedAt + 2_500,
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              model: "anthropic/claude-haiku-4-5",
              content: [{ type: "text", text: "Integrated runtime session output" }],
            },
          },
        },
      ],
    };

    const session = buildWorkerSessionState(worker, runtime);

    expect(session.status).toBe("ended");
    expect(session.metadata.id).toBe("task-6");
    expect(session.metrics.toolCalls).toBe(1);
    expect(session.metrics.tokensUsed).toBe(42);
    expect(session.events.map((event) => event.type)).toEqual([
      "session.start",
      "tool.call",
      "execution.output",
      "agent.progress",
      "session.end",
    ]);
    expect(session.events[1]?.data).toEqual({
      toolName: "bash",
      args: { command: "npm test" },
    });
    expect(session.events[2]?.data).toEqual({
      text: "PASS tests/monitor/ui/session-detail.test.ts",
      stream: "stdout",
    });
    expect(session.events[3]?.data).toEqual({
      message: "Integrated runtime session output",
      step: "assistant-response",
    });
    expect(session.events[4]?.data).toEqual({
      summary: "Completed detail integration",
      exitCode: 0,
    });

    const rendered = stripDetailAnsi(
      renderSessionDetailView(session, "healthy", 120, 18, worker.startedAt + 4_000).join("\n"),
    );
    expect(rendered).toContain("Running bash");
    expect(rendered).toContain("PASS tests/monitor/ui/session-detail.test.ts");
    expect(rendered).toContain("Integrated runtime session output");
    expect(rendered).toContain("Completed detail integration");
  });
});
