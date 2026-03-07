import { describe, it, expect } from "vitest";
import { isValidTransition, validNextStates } from "../../../src/monitor/lifecycle/transitions.js";
import type { SessionStatus } from "../../../src/monitor/types/session.js";

describe("isValidTransition", () => {
  // ─── Valid transitions ────────────────────────────────────────────────────

  it("allows idle → active (start)", () => {
    expect(isValidTransition("idle", "active")).toBe(true);
  });

  it("allows active → paused (pause)", () => {
    expect(isValidTransition("active", "paused")).toBe(true);
  });

  it("allows active → ended (end from active)", () => {
    expect(isValidTransition("active", "ended")).toBe(true);
  });

  it("allows active → error (error)", () => {
    expect(isValidTransition("active", "error")).toBe(true);
  });

  it("allows paused → active (resume)", () => {
    expect(isValidTransition("paused", "active")).toBe(true);
  });

  it("allows paused → ended (end from paused)", () => {
    expect(isValidTransition("paused", "ended")).toBe(true);
  });

  it("allows error → ended (cleanup after error)", () => {
    expect(isValidTransition("error", "ended")).toBe(true);
  });

  // ─── Invalid transitions ──────────────────────────────────────────────────

  it("rejects idle → paused", () => {
    expect(isValidTransition("idle", "paused")).toBe(false);
  });

  it("rejects idle → ended", () => {
    expect(isValidTransition("idle", "ended")).toBe(false);
  });

  it("rejects idle → error", () => {
    expect(isValidTransition("idle", "error")).toBe(false);
  });

  it("rejects ended → active", () => {
    expect(isValidTransition("ended", "active")).toBe(false);
  });

  it("rejects ended → paused", () => {
    expect(isValidTransition("ended", "paused")).toBe(false);
  });

  it("rejects ended → idle", () => {
    expect(isValidTransition("ended", "idle")).toBe(false);
  });

  it("rejects paused → error", () => {
    expect(isValidTransition("paused", "error")).toBe(false);
  });

  it("rejects error → active", () => {
    expect(isValidTransition("error", "active")).toBe(false);
  });

  it("rejects error → paused", () => {
    expect(isValidTransition("error", "paused")).toBe(false);
  });

  // ─── validNextStates ─────────────────────────────────────────────────────

  it("returns correct next states for idle", () => {
    expect(validNextStates("idle")).toEqual(["active"]);
  });

  it("returns correct next states for active", () => {
    const states = validNextStates("active");
    expect(states).toContain("paused");
    expect(states).toContain("ended");
    expect(states).toContain("error");
  });

  it("returns empty array for ended (terminal state)", () => {
    expect(validNextStates("ended")).toEqual([]);
  });
});
