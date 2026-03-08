import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";
import {
  postEntry,
  readEntry,
  listEntries,
  challengeEntry,
  resolveChallenge,
} from "../../crew/blackboard.js";

describe("crew/blackboard", () => {
  let dirs: TempCrewDirs;
  let cwd: string;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
  });

  describe("postEntry", () => {
    it("creates a new entry with timestamp and empty challenges", () => {
      const entry = postEntry(cwd, {
        key: "arch-decision",
        value: "Use event sourcing",
        reasoning: "Better audit trail and replay capability",
        postedBy: "agent-1",
      });

      expect(entry.key).toBe("arch-decision");
      expect(entry.value).toBe("Use event sourcing");
      expect(entry.reasoning).toBe("Better audit trail and replay capability");
      expect(entry.postedBy).toBe("agent-1");
      expect(entry.challenges).toEqual([]);
      expect(entry.timestamp).toBeTruthy();
      // Verify ISO timestamp format
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    it("persists entry to blackboard.json", () => {
      postEntry(cwd, {
        key: "db-choice",
        value: "PostgreSQL",
        reasoning: "ACID compliance needed",
        postedBy: "agent-2",
      });

      const filePath = path.join(dirs.crewDir, "blackboard.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(data["db-choice"]).toBeDefined();
      expect(data["db-choice"].value).toBe("PostgreSQL");
    });

    it("overwrites existing entry with same key", () => {
      postEntry(cwd, {
        key: "api-style",
        value: "REST",
        reasoning: "Simple and well-known",
        postedBy: "agent-1",
      });

      const updated = postEntry(cwd, {
        key: "api-style",
        value: "GraphQL",
        reasoning: "Flexible queries needed",
        postedBy: "agent-2",
      });

      expect(updated.value).toBe("GraphQL");
      expect(updated.postedBy).toBe("agent-2");

      const all = listEntries(cwd);
      expect(all.length).toBe(1);
    });
  });

  describe("readEntry", () => {
    it("returns entry by key", () => {
      postEntry(cwd, {
        key: "cache-strategy",
        value: "Redis",
        reasoning: "Low latency needed",
        postedBy: "agent-1",
      });

      const entry = readEntry(cwd, "cache-strategy");
      expect(entry).not.toBeNull();
      expect(entry!.value).toBe("Redis");
    });

    it("returns null for missing key", () => {
      const entry = readEntry(cwd, "nonexistent");
      expect(entry).toBeNull();
    });

    it("returns null when no blackboard file exists", () => {
      const entry = readEntry(cwd, "anything");
      expect(entry).toBeNull();
    });
  });

  describe("listEntries", () => {
    it("returns empty array when no entries", () => {
      expect(listEntries(cwd)).toEqual([]);
    });

    it("returns all entries", () => {
      postEntry(cwd, { key: "a", value: "v1", reasoning: "r1", postedBy: "agent-1" });
      postEntry(cwd, { key: "b", value: "v2", reasoning: "r2", postedBy: "agent-2" });
      postEntry(cwd, { key: "c", value: "v3", reasoning: "r3", postedBy: "agent-3" });

      const entries = listEntries(cwd);
      expect(entries.length).toBe(3);
      expect(entries.map(e => e.key).sort()).toEqual(["a", "b", "c"]);
    });
  });

  describe("challengeEntry", () => {
    it("adds a challenge to an existing entry", () => {
      postEntry(cwd, {
        key: "framework",
        value: "React",
        reasoning: "Large ecosystem",
        postedBy: "agent-1",
      });

      const result = challengeEntry(cwd, "framework", "agent-2", "Vue has better DX");
      expect(result).not.toBeNull();
      expect(result!.challenges.length).toBe(1);
      expect(result!.challenges[0].challengedBy).toBe("agent-2");
      expect(result!.challenges[0].challenge).toBe("Vue has better DX");
      expect(result!.challenges[0].timestamp).toBeTruthy();
      expect(result!.challenges[0].resolution).toBeUndefined();
    });

    it("supports multiple challenges on same entry", () => {
      postEntry(cwd, {
        key: "framework",
        value: "React",
        reasoning: "Large ecosystem",
        postedBy: "agent-1",
      });

      challengeEntry(cwd, "framework", "agent-2", "Vue has better DX");
      const result = challengeEntry(cwd, "framework", "agent-3", "Svelte is faster");

      expect(result!.challenges.length).toBe(2);
      expect(result!.challenges[1].challengedBy).toBe("agent-3");
    });

    it("returns null for nonexistent key", () => {
      const result = challengeEntry(cwd, "nonexistent", "agent-1", "challenge");
      expect(result).toBeNull();
    });
  });

  describe("resolveChallenge", () => {
    it("adds resolution to a specific challenge", () => {
      postEntry(cwd, {
        key: "lang",
        value: "TypeScript",
        reasoning: "Type safety",
        postedBy: "agent-1",
      });
      challengeEntry(cwd, "lang", "agent-2", "Rust is safer");

      const result = resolveChallenge(cwd, "lang", 0, "TS is sufficient for our use case");
      expect(result).not.toBeNull();
      expect(result!.challenges[0].resolution).toBe("TS is sufficient for our use case");
    });

    it("returns null for nonexistent key", () => {
      const result = resolveChallenge(cwd, "nonexistent", 0, "resolution");
      expect(result).toBeNull();
    });

    it("returns null for out-of-bounds challenge index", () => {
      postEntry(cwd, {
        key: "lang",
        value: "TypeScript",
        reasoning: "Type safety",
        postedBy: "agent-1",
      });

      const result = resolveChallenge(cwd, "lang", 0, "resolution");
      expect(result).toBeNull();
    });
  });
});
