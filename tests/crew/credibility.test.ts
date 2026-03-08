import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadCredibility,
  saveCredibility,
  recordReviewOutcome,
  getReviewIntensity,
  getCredibility,
  type AgentCredibility,
  type CredibilityStore,
} from "../../crew/credibility.js";

// Override the store path for tests
const TEST_DIR = path.join(os.tmpdir(), `credibility-test-${Date.now()}`);
const TEST_FILE = path.join(TEST_DIR, "credibility.json");

// We'll monkey-patch the module's internal path via env var
beforeEach(() => {
  process.env.PI_CREDIBILITY_FILE = TEST_FILE;
  // Clean up any existing test file
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

import { afterEach } from "vitest";
afterEach(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.PI_CREDIBILITY_FILE;
});

describe("crew/credibility", () => {
  describe("loadCredibility", () => {
    it("returns empty store when file does not exist", () => {
      const store = loadCredibility();
      expect(store).toEqual({});
    });

    it("returns persisted data when file exists", () => {
      const data: CredibilityStore = {
        "test-agent": {
          totalCompletions: 5,
          survivedReviews: 4,
          rejectedReviews: 1,
          credibilityScore: 80,
          lastUpdated: "2026-01-01T00:00:00.000Z",
        },
      };
      fs.writeFileSync(TEST_FILE, JSON.stringify(data));
      const store = loadCredibility();
      expect(store["test-agent"]).toBeDefined();
      expect(store["test-agent"].credibilityScore).toBe(80);
    });
  });

  describe("saveCredibility", () => {
    it("persists store to disk", () => {
      const data: CredibilityStore = {
        "worker-a": {
          totalCompletions: 3,
          survivedReviews: 2,
          rejectedReviews: 1,
          credibilityScore: 66.67,
          lastUpdated: "2026-01-01T00:00:00.000Z",
        },
      };
      saveCredibility(data);
      const raw = JSON.parse(fs.readFileSync(TEST_FILE, "utf-8"));
      expect(raw["worker-a"].totalCompletions).toBe(3);
    });

    it("creates directory if it doesn't exist", () => {
      // Remove dir entirely
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
      const data: CredibilityStore = {};
      saveCredibility(data);
      expect(fs.existsSync(TEST_FILE)).toBe(true);
    });
  });

  describe("recordReviewOutcome", () => {
    it("creates new agent record on first review (survived)", () => {
      const result = recordReviewOutcome("new-agent", true);
      expect(result.totalCompletions).toBe(1);
      expect(result.survivedReviews).toBe(1);
      expect(result.rejectedReviews).toBe(0);
      expect(result.credibilityScore).toBe(100);
    });

    it("creates new agent record on first review (rejected)", () => {
      const result = recordReviewOutcome("bad-agent", false);
      expect(result.totalCompletions).toBe(1);
      expect(result.survivedReviews).toBe(0);
      expect(result.rejectedReviews).toBe(1);
      expect(result.credibilityScore).toBe(0);
    });

    it("updates existing agent record correctly", () => {
      // Build up some history
      recordReviewOutcome("agent-x", true);
      recordReviewOutcome("agent-x", true);
      recordReviewOutcome("agent-x", true);
      const result = recordReviewOutcome("agent-x", false);

      expect(result.totalCompletions).toBe(4);
      expect(result.survivedReviews).toBe(3);
      expect(result.rejectedReviews).toBe(1);
      // Score = (3/4) * 100 = 75
      expect(result.credibilityScore).toBe(75);
    });

    it("persists to disk after each call", () => {
      recordReviewOutcome("persistent-agent", true);
      // Load from disk to verify
      const store = loadCredibility();
      expect(store["persistent-agent"]).toBeDefined();
      expect(store["persistent-agent"].totalCompletions).toBe(1);
    });

    it("sets lastUpdated to ISO-8601", () => {
      const before = new Date().toISOString();
      const result = recordReviewOutcome("time-agent", true);
      const after = new Date().toISOString();
      expect(result.lastUpdated >= before).toBe(true);
      expect(result.lastUpdated <= after).toBe(true);
    });
  });

  describe("getReviewIntensity", () => {
    it("returns 'full' for agents with score < 50", () => {
      // 1 survived, 3 rejected => score = 25
      recordReviewOutcome("low-agent", true);
      recordReviewOutcome("low-agent", false);
      recordReviewOutcome("low-agent", false);
      recordReviewOutcome("low-agent", false);
      expect(getReviewIntensity("low-agent")).toBe("full");
    });

    it("returns 'standard' for agents with score 50-80", () => {
      // 3 survived, 1 rejected => score = 75
      recordReviewOutcome("mid-agent", true);
      recordReviewOutcome("mid-agent", true);
      recordReviewOutcome("mid-agent", true);
      recordReviewOutcome("mid-agent", false);
      expect(getReviewIntensity("mid-agent")).toBe("standard");
    });

    it("returns 'light' for agents with score > 80", () => {
      // 9 survived, 1 rejected => score = 90
      for (let i = 0; i < 9; i++) recordReviewOutcome("high-agent", true);
      recordReviewOutcome("high-agent", false);
      expect(getReviewIntensity("high-agent")).toBe("light");
    });

    it("returns 'standard' for unknown agents", () => {
      expect(getReviewIntensity("unknown-agent")).toBe("standard");
    });

    it("returns 'light' for agent at exactly 81", () => {
      // Need score > 80. E.g. 81/100 completions survived
      // Actually let's do: 5 survived, 1 rejected = 83.33
      for (let i = 0; i < 5; i++) recordReviewOutcome("edge-high", true);
      recordReviewOutcome("edge-high", false);
      // score = 83.33 > 80
      expect(getReviewIntensity("edge-high")).toBe("light");
    });

    it("returns 'standard' for agent at exactly 80", () => {
      // 4 survived, 1 rejected = 80
      for (let i = 0; i < 4; i++) recordReviewOutcome("edge-80", true);
      recordReviewOutcome("edge-80", false);
      // score = 80, boundary: 50-80 = standard
      expect(getReviewIntensity("edge-80")).toBe("standard");
    });

    it("returns 'full' for agent at exactly 50", () => {
      // 1 survived, 1 rejected = 50
      recordReviewOutcome("edge-50", true);
      recordReviewOutcome("edge-50", false);
      // score = 50, boundary: <50 = full, so 50 is standard
      expect(getReviewIntensity("edge-50")).toBe("standard");
    });
  });

  describe("getCredibility", () => {
    it("returns null for unknown agent", () => {
      expect(getCredibility("nobody")).toBeNull();
    });

    it("returns agent record when it exists", () => {
      recordReviewOutcome("known-agent", true);
      const cred = getCredibility("known-agent");
      expect(cred).not.toBeNull();
      expect(cred!.totalCompletions).toBe(1);
      expect(cred!.credibilityScore).toBe(100);
    });
  });

  describe("persistence round-trip", () => {
    it("survives save/load cycle with multiple agents", () => {
      recordReviewOutcome("agent-1", true);
      recordReviewOutcome("agent-1", true);
      recordReviewOutcome("agent-2", false);
      recordReviewOutcome("agent-2", true);

      // Load fresh from disk
      const store = loadCredibility();
      expect(Object.keys(store)).toHaveLength(2);
      expect(store["agent-1"].credibilityScore).toBe(100);
      expect(store["agent-2"].credibilityScore).toBe(50);
    });
  });
});
