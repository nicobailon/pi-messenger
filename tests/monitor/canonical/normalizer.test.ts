/**
 * Canonical state model tests — task-1
 *
 * Covers:
 *  1. Exact lifecycle mapping (SessionStatus → CanonicalLifecycleState)
 *  2. All 7 canonical lifecycle states reachable (including starting/canceled)
 *  3. Exact health mapping (HealthStatus → CanonicalHealthState)
 *  4. All 7 inferHealthFromLifecycle branches (via normalizeSession)
 *  5. Section derivation (Running / Queued / Completed / Failed)
 *  6. Section derivations depend only on lifecycle (health is irrelevant)
 *  7. Attention derivation (degraded / stuck / needingAttention)
 *  8. Attention derives only from health (lifecycle is irrelevant)
 *  9. Richer RuntimeSessionInput fields (taskState, runtimeStatus, process flags, healthStatus)
 * 10. Precedence rules: RuntimeHealthInput > session.healthStatus > inference
 * 11. Existing behavior compatibility (no regressions)
 */

import { describe, it, expect } from "vitest";
import {
  mapSessionLifecycle,
  mapHealthState,
  normalizeSession,
  normalizeSessions,
  deriveSections,
  deriveAttentionView,
  deriveMonitorState,
  type CanonicalSession,
  type RuntimeSessionInput,
  type RuntimeHealthInput,
} from "../../../src/monitor/canonical/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(
  id: string,
  lifecycle: CanonicalSession["lifecycle"],
  health: CanonicalSession["health"] = "active"
): CanonicalSession {
  return { id, lifecycle, health };
}

// ─── 1. Exact legacy lifecycle mapping ───────────────────────────────────────

describe("mapSessionLifecycle — legacy 5-state mapping", () => {
  it('maps "idle" → "queued"', () => {
    expect(mapSessionLifecycle("idle")).toBe("queued");
  });

  it('maps "active" → "running"', () => {
    expect(mapSessionLifecycle("active")).toBe("running");
  });

  it('maps "paused" → "waiting"', () => {
    expect(mapSessionLifecycle("paused")).toBe("waiting");
  });

  it('maps "ended" → "completed"', () => {
    expect(mapSessionLifecycle("ended")).toBe("completed");
  });

  it('maps "error" → "failed"', () => {
    expect(mapSessionLifecycle("error")).toBe("failed");
  });
});

// ─── 2. All 7 canonical lifecycle states reachable ───────────────────────────

describe("mapSessionLifecycle — all canonical lifecycle states reachable", () => {
  it('maps "starting" → "starting" (process-flag input)', () => {
    expect(mapSessionLifecycle("starting")).toBe("starting");
  });

  it('maps "canceled" → "canceled" (explicit cancellation input)', () => {
    expect(mapSessionLifecycle("canceled")).toBe("canceled");
  });

  it("covers all 7 canonical lifecycle states across all inputs", () => {
    // Every canonical lifecycle state must be reachable via mapSessionLifecycle
    const reached = new Set([
      mapSessionLifecycle("idle"),      // → queued
      mapSessionLifecycle("active"),    // → running
      mapSessionLifecycle("paused"),    // → waiting
      mapSessionLifecycle("ended"),     // → completed
      mapSessionLifecycle("error"),     // → failed
      mapSessionLifecycle("starting"),  // → starting
      mapSessionLifecycle("canceled"),  // → canceled
    ]);
    expect(reached).toEqual(
      new Set(["queued", "running", "waiting", "completed", "failed", "starting", "canceled"])
    );
  });
});

// ─── 3. Exact health mapping ──────────────────────────────────────────────────

describe("mapHealthState — health mapping", () => {
  it('maps "healthy" → "active"', () => {
    expect(mapHealthState("healthy")).toBe("active");
  });

  it('maps "degraded" → "degraded"', () => {
    expect(mapHealthState("degraded")).toBe("degraded");
  });

  it('maps "critical" → "stuck"', () => {
    expect(mapHealthState("critical")).toBe("stuck");
  });
});

// ─── 4. All 7 inferHealthFromLifecycle branches (via normalizeSession) ────────

describe("inferHealthFromLifecycle — all inference branches (no health input)", () => {
  it('infers "idle" from lifecycle "queued" (status: idle → queued)', () => {
    const result = normalizeSession({ id: "s1", status: "idle" });
    expect(result.lifecycle).toBe("queued");
    expect(result.health).toBe("idle");
  });

  it('infers "idle" from lifecycle "starting" (status: starting)', () => {
    const result = normalizeSession({ id: "s2", status: "starting" });
    expect(result.lifecycle).toBe("starting");
    expect(result.health).toBe("idle");
  });

  it('infers "active" from lifecycle "running" (status: active)', () => {
    const result = normalizeSession({ id: "s3", status: "active" });
    expect(result.lifecycle).toBe("running");
    expect(result.health).toBe("active");
  });

  it('infers "waiting" from lifecycle "waiting" (status: paused)', () => {
    const result = normalizeSession({ id: "s4", status: "paused" });
    expect(result.lifecycle).toBe("waiting");
    expect(result.health).toBe("waiting");
  });

  it('infers "offline" from lifecycle "completed" (status: ended)', () => {
    const result = normalizeSession({ id: "s5", status: "ended" });
    expect(result.lifecycle).toBe("completed");
    expect(result.health).toBe("offline");
  });

  it('infers "offline" from lifecycle "canceled" (status: canceled)', () => {
    const result = normalizeSession({ id: "s6", status: "canceled" });
    expect(result.lifecycle).toBe("canceled");
    expect(result.health).toBe("offline");
  });

  it('infers "offline" from lifecycle "failed" (status: error)', () => {
    const result = normalizeSession({ id: "s7", status: "error" });
    expect(result.lifecycle).toBe("failed");
    expect(result.health).toBe("offline");
  });

  it("covers all 6 canonical health states via inference + direct mapping", () => {
    // idle, active, waiting, offline via inference
    const inferred = new Set([
      normalizeSession({ id: "a", status: "idle" }).health,       // idle
      normalizeSession({ id: "b", status: "starting" }).health,   // idle
      normalizeSession({ id: "c", status: "active" }).health,     // active
      normalizeSession({ id: "d", status: "paused" }).health,     // waiting
      normalizeSession({ id: "e", status: "ended" }).health,      // offline
      normalizeSession({ id: "f", status: "canceled" }).health,   // offline
      normalizeSession({ id: "g", status: "error" }).health,      // offline
    ]);
    // degraded and stuck via direct mapping
    const h = { sessionId: "x", health: "degraded" as const };
    const s = { sessionId: "y", health: "critical" as const };
    inferred.add(
      normalizeSession({ id: "x", status: "active" }, h).health   // degraded
    );
    inferred.add(
      normalizeSession({ id: "y", status: "active" }, s).health   // stuck
    );
    expect(inferred).toEqual(
      new Set(["active", "idle", "waiting", "degraded", "stuck", "offline"])
    );
  });
});

// ─── normalization pipeline ───────────────────────────────────────────────────

describe("normalizeSession", () => {
  it("produces a CanonicalSession with lifecycle and health from inputs", () => {
    const session: RuntimeSessionInput = { id: "s1", status: "active" };
    const health: RuntimeHealthInput = { sessionId: "s1", health: "healthy" };
    const result = normalizeSession(session, health);

    expect(result).toEqual({ id: "s1", lifecycle: "running", health: "active" });
  });

  it("infers health from lifecycle when no health input provided", () => {
    const session: RuntimeSessionInput = { id: "s2", status: "idle" };
    const result = normalizeSession(session);

    expect(result.id).toBe("s2");
    expect(result.lifecycle).toBe("queued");
    // No health input → inferred from lifecycle (queued → idle)
    expect(result.health).toBe("idle");
  });

  it("maps paused session with degraded health correctly", () => {
    const session: RuntimeSessionInput = { id: "s3", status: "paused" };
    const health: RuntimeHealthInput = { sessionId: "s3", health: "degraded" };
    const result = normalizeSession(session, health);

    expect(result).toEqual({ id: "s3", lifecycle: "waiting", health: "degraded" });
  });
});

// ─── 9. Richer RuntimeSessionInput: healthStatus precedence ──────────────────

describe("normalizeSession — inline healthStatus field (precedence rule)", () => {
  it("uses inline healthStatus when no RuntimeHealthInput provided", () => {
    const session: RuntimeSessionInput = {
      id: "s1",
      status: "active",
      healthStatus: "degraded",
    };
    const result = normalizeSession(session);
    expect(result.health).toBe("degraded");
  });

  it("RuntimeHealthInput takes precedence over inline healthStatus", () => {
    const session: RuntimeSessionInput = {
      id: "s2",
      status: "active",
      healthStatus: "degraded", // lower precedence
    };
    const healthInput: RuntimeHealthInput = { sessionId: "s2", health: "critical" }; // higher
    const result = normalizeSession(session, healthInput);
    expect(result.health).toBe("stuck"); // from RuntimeHealthInput
  });

  it("falls back to lifecycle inference when neither healthInput nor healthStatus provided", () => {
    const session: RuntimeSessionInput = { id: "s3", status: "active" };
    const result = normalizeSession(session);
    expect(result.health).toBe("active"); // inferred from running
  });
});

describe("normalizeSession — richer input fields (taskState, runtimeStatus, process flags)", () => {
  it("accepts taskState without affecting lifecycle or health mapping", () => {
    const session: RuntimeSessionInput = {
      id: "t1",
      status: "active",
      taskState: "running",
    };
    const result = normalizeSession(session);
    expect(result.lifecycle).toBe("running");
    expect(result.health).toBe("active");
  });

  it("accepts runtimeStatus without affecting lifecycle or health mapping", () => {
    const session: RuntimeSessionInput = {
      id: "t2",
      status: "idle",
      runtimeStatus: "spawning",
    };
    const result = normalizeSession(session);
    expect(result.lifecycle).toBe("queued");
    expect(result.health).toBe("idle");
  });

  it("accepts isStarting process flag (maps via status: starting)", () => {
    const session: RuntimeSessionInput = {
      id: "t3",
      status: "starting",
      isStarting: true,
    };
    const result = normalizeSession(session);
    expect(result.lifecycle).toBe("starting");
  });

  it("accepts isCanceled process flag (maps via status: canceled)", () => {
    const session: RuntimeSessionInput = {
      id: "t4",
      status: "canceled",
      isCanceled: true,
    };
    const result = normalizeSession(session);
    expect(result.lifecycle).toBe("canceled");
    expect(result.health).toBe("offline");
  });
});

describe("normalizeSessions", () => {
  it("maps multiple sessions with a health map", () => {
    const sessions: RuntimeSessionInput[] = [
      { id: "a", status: "active" },
      { id: "b", status: "idle" },
      { id: "c", status: "error" },
    ];
    const healthMap = new Map<string, RuntimeHealthInput>([
      ["a", { sessionId: "a", health: "healthy" }],
      ["c", { sessionId: "c", health: "critical" }],
    ]);

    const results = normalizeSessions(sessions, healthMap);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ id: "a", lifecycle: "running", health: "active" });
    expect(results[1]).toEqual({ id: "b", lifecycle: "queued", health: "idle" });
    expect(results[2]).toEqual({ id: "c", lifecycle: "failed", health: "stuck" });
  });
});

// ─── 5. Section derivation ────────────────────────────────────────────────────

describe("deriveSections — section derivation", () => {
  it("groups sessions into Running/Queued/Completed/Failed", () => {
    const sessions: CanonicalSession[] = [
      makeSession("r1", "running"),
      makeSession("r2", "starting"),
      makeSession("q1", "queued"),
      makeSession("c1", "completed"),
      makeSession("c2", "canceled"),
      makeSession("f1", "failed"),
    ];

    const sections = deriveSections(sessions);

    expect(sections.running.map((s) => s.id)).toEqual(["r1", "r2"]);
    expect(sections.queued.map((s) => s.id)).toEqual(["q1"]);
    expect(sections.completed.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(sections.failed.map((s) => s.id)).toEqual(["f1"]);
  });

  it("returns empty arrays when no sessions match a section", () => {
    const sessions: CanonicalSession[] = [makeSession("r1", "running")];
    const sections = deriveSections(sessions);

    expect(sections.queued).toHaveLength(0);
    expect(sections.completed).toHaveLength(0);
    expect(sections.failed).toHaveLength(0);
  });

  it("handles empty input", () => {
    const sections = deriveSections([]);
    expect(sections.running).toHaveLength(0);
    expect(sections.queued).toHaveLength(0);
    expect(sections.completed).toHaveLength(0);
    expect(sections.failed).toHaveLength(0);
  });

  it("excludes waiting sessions from all sections", () => {
    const sessions: CanonicalSession[] = [
      makeSession("w1", "waiting", "waiting"),
      makeSession("w2", "waiting", "degraded"),
    ];
    const sections = deriveSections(sessions);

    expect(sections.running).toHaveLength(0);
    expect(sections.queued).toHaveLength(0);
    expect(sections.completed).toHaveLength(0);
    expect(sections.failed).toHaveLength(0);
  });
});

// ─── 6. Section derivations depend only on lifecycle ─────────────────────────

describe("deriveSections — depends only on lifecycle (health ignored)", () => {
  it("places degraded running session in running section, not attention section", () => {
    // Health is irrelevant for section placement
    const degradedRunner = makeSession("d1", "running", "degraded");
    const stuckRunner = makeSession("d2", "running", "stuck");
    const sections = deriveSections([degradedRunner, stuckRunner]);

    expect(sections.running).toHaveLength(2);
    expect(sections.running.map((s) => s.id)).toEqual(["d1", "d2"]);
  });

  it("places offline queued session in queued section regardless of health", () => {
    const offlineQueued = makeSession("q1", "queued", "offline");
    const sections = deriveSections([offlineQueued]);

    expect(sections.queued).toHaveLength(1);
    expect(sections.queued[0].id).toBe("q1");
  });

  it("places failed session in failed section regardless of health", () => {
    const failedActive = makeSession("f1", "failed", "active"); // unusual but valid
    const sections = deriveSections([failedActive]);

    expect(sections.failed).toHaveLength(1);
    expect(sections.failed[0].id).toBe("f1");
  });

  it("sections are mutually exclusive and cover all lifecycle states except waiting", () => {
    const allLifecycles: CanonicalSession[] = [
      makeSession("a", "running"),
      makeSession("b", "starting"),
      makeSession("c", "queued"),
      makeSession("d", "completed"),
      makeSession("e", "canceled"),
      makeSession("f", "failed"),
    ];
    const sections = deriveSections(allLifecycles);
    const allPlaced = [
      ...sections.running,
      ...sections.queued,
      ...sections.completed,
      ...sections.failed,
    ];

    // All 6 non-waiting sessions placed exactly once
    expect(allPlaced).toHaveLength(6);
    expect(new Set(allPlaced.map((s) => s.id)).size).toBe(6);
  });
});

// ─── 7. Attention derivation ──────────────────────────────────────────────────

describe("deriveAttentionView — attention derivation", () => {
  it("separates degraded and stuck sessions, unions into needingAttention", () => {
    const sessions: CanonicalSession[] = [
      makeSession("ok", "running", "active"),
      makeSession("d1", "running", "degraded"),
      makeSession("d2", "waiting", "degraded"),
      makeSession("s1", "running", "stuck"),
    ];

    const view = deriveAttentionView(sessions);

    expect(view.degraded.map((s) => s.id)).toEqual(["d1", "d2"]);
    expect(view.stuck.map((s) => s.id)).toEqual(["s1"]);
    // needingAttention = degraded then stuck
    expect(view.needingAttention.map((s) => s.id)).toEqual(["d1", "d2", "s1"]);
  });

  it("returns empty attention view when all sessions are healthy", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "active"),
      makeSession("b", "queued", "idle"),
    ];

    const view = deriveAttentionView(sessions);

    expect(view.degraded).toHaveLength(0);
    expect(view.stuck).toHaveLength(0);
    expect(view.needingAttention).toHaveLength(0);
  });
});

// ─── 8. Attention derives only from health (lifecycle irrelevant) ─────────────

describe("deriveAttentionView — depends only on health (lifecycle ignored)", () => {
  it("places degraded session in attention regardless of lifecycle state", () => {
    // A completed session that's degraded? Unusual but the rule is: health drives attention
    const sessions: CanonicalSession[] = [
      makeSession("a", "completed", "degraded"),
      makeSession("b", "queued", "degraded"),
      makeSession("c", "failed", "stuck"),
    ];
    const view = deriveAttentionView(sessions);

    expect(view.degraded.map((s) => s.id)).toEqual(["a", "b"]);
    expect(view.stuck.map((s) => s.id)).toEqual(["c"]);
    expect(view.needingAttention).toHaveLength(3);
  });

  it("does NOT include idle/waiting/offline/active sessions in attention", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "queued", "idle"),
      makeSession("b", "waiting", "waiting"),
      makeSession("c", "completed", "offline"),
      makeSession("d", "running", "active"),
    ];
    const view = deriveAttentionView(sessions);

    expect(view.degraded).toHaveLength(0);
    expect(view.stuck).toHaveLength(0);
    expect(view.needingAttention).toHaveLength(0);
  });

  it("needingAttention ordering: degraded always precedes stuck", () => {
    const sessions: CanonicalSession[] = [
      makeSession("s1", "running", "stuck"),
      makeSession("d1", "running", "degraded"),
      makeSession("s2", "waiting", "stuck"),
      makeSession("d2", "queued", "degraded"),
    ];
    const view = deriveAttentionView(sessions);

    const ids = view.needingAttention.map((s) => s.id);
    // All degraded first, then all stuck
    expect(ids.indexOf("d1")).toBeLessThan(ids.indexOf("s1"));
    expect(ids.indexOf("d2")).toBeLessThan(ids.indexOf("s2"));
    expect(ids.slice(0, 2)).toEqual(["d1", "d2"]);
    expect(ids.slice(2)).toEqual(["s1", "s2"]);
  });
});

// ─── Overall monitor state derivation ────────────────────────────────────────

describe("deriveMonitorState", () => {
  it("returns healthy when all sessions are running/active", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "active"),
      makeSession("b", "queued", "idle"),
    ];
    expect(deriveMonitorState(sessions)).toBe("healthy");
  });

  it("returns blocked when any session is stuck", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "active"),
      makeSession("b", "running", "stuck"),
    ];
    expect(deriveMonitorState(sessions)).toBe("blocked");
  });

  it("blocked takes priority over attention_needed (stuck wins over degraded)", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "degraded"),
      makeSession("b", "running", "stuck"),
    ];
    expect(deriveMonitorState(sessions)).toBe("blocked");
  });

  it("returns attention_needed when any session is degraded (no stuck)", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "running", "active"),
      makeSession("b", "running", "degraded"),
    ];
    expect(deriveMonitorState(sessions)).toBe("attention_needed");
  });

  it("returns completed when all sessions are terminal with no failures", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "completed", "offline"),
      makeSession("b", "canceled", "offline"),
    ];
    expect(deriveMonitorState(sessions)).toBe("completed");
  });

  it("returns recovering when all sessions are terminal but some failed", () => {
    const sessions: CanonicalSession[] = [
      makeSession("a", "completed", "offline"),
      makeSession("b", "failed", "offline"),
    ];
    expect(deriveMonitorState(sessions)).toBe("recovering");
  });

  it("returns healthy for empty sessions list", () => {
    expect(deriveMonitorState([])).toBe("healthy");
  });

  it("deriveMonitorState uses health not lifecycle for blocked/attention decisions", () => {
    // A session that is 'waiting' in lifecycle but 'stuck' in health → blocked
    const sessions: CanonicalSession[] = [
      makeSession("a", "waiting", "stuck"),
    ];
    expect(deriveMonitorState(sessions)).toBe("blocked");
  });
});

// ─── Zod schema validation ────────────────────────────────────────────────────

describe("CanonicalLifecycleStateSchema", () => {
  it("accepts all defined lifecycle states", async () => {
    const { CanonicalLifecycleStateSchema } = await import(
      "../../../src/monitor/canonical/index.js"
    );

    const valid = ["queued", "starting", "running", "waiting", "completed", "failed", "canceled"];
    for (const v of valid) {
      expect(CanonicalLifecycleStateSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown lifecycle states", async () => {
    const { CanonicalLifecycleStateSchema } = await import(
      "../../../src/monitor/canonical/index.js"
    );
    expect(() => CanonicalLifecycleStateSchema.parse("unknown")).toThrow();
  });
});

describe("CanonicalHealthStateSchema", () => {
  it("accepts all defined health states", async () => {
    const { CanonicalHealthStateSchema } = await import(
      "../../../src/monitor/canonical/index.js"
    );

    const valid = ["active", "idle", "waiting", "degraded", "stuck", "offline"];
    for (const v of valid) {
      expect(CanonicalHealthStateSchema.parse(v)).toBe(v);
    }
  });
});

describe("CanonicalMonitorStateSchema", () => {
  it("accepts all defined monitor states", async () => {
    const { CanonicalMonitorStateSchema } = await import(
      "../../../src/monitor/canonical/index.js"
    );

    const valid = ["healthy", "attention_needed", "blocked", "recovering", "completed"];
    for (const v of valid) {
      expect(CanonicalMonitorStateSchema.parse(v)).toBe(v);
    }
  });
});
