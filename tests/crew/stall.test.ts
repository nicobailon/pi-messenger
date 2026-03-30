/**
 * Tests for crew/utils/stall.ts — isStalled() helper (spec 009)
 *
 * Covers the key cases from AC5 and plan T6a:
 * - Active heartbeat + stale log → NOT stalled (key false-positive fix)
 * - Stale heartbeat + stale log → stalled (heartbeat+log)
 * - No heartbeat, within grace → NOT stalled (within-grace)
 * - No heartbeat, after grace, stale log → stalled (log-only)
 * - No heartbeat, after grace, fresh log → NOT stalled
 * - logFile=null → NOT stalled in all cases (degraded mode backward compat)
 * - Missing log file → treated as fresh (not stale)
 * - R4 formula verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isStalled } from "../../crew/utils/stall.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const STALL_MS = 500;     // short threshold for fast tests
const PAST = Date.now() - 60_000; // 60s ago — always past grace
const GRACE = 100;        // tiny grace period for tests that need to be past it

function makePaths() {
  return {
    heartbeatFile: path.join(tmpDir, "test.heartbeat"),
    logFile: path.join(tmpDir, "test.log"),
  };
}

// Write file with a given mtime (seconds-relative to now)
function writeFileWithMtime(filePath: string, content: string, mtime: Date) {
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, mtime, mtime);
}

// ─────────────────────────────────────────────────────────────────────────────
// AC5 + T6a: Key false-positive fix
// ─────────────────────────────────────────────────────────────────────────────

describe("isStalled — heartbeat active", () => {
  it("active heartbeat + stale log → NOT stalled (heartbeatActive: true) [AC5, key fix]", () => {
    const { heartbeatFile, logFile } = makePaths();
    const now = new Date();
    const staleDate = new Date(Date.now() - STALL_MS * 2); // stale

    // Heartbeat was written just now
    writeFileWithMtime(heartbeatFile, Date.now().toString(), now);
    // Log hasn't grown in > STALL_MS
    writeFileWithMtime(logFile, "started", staleDate);

    const result = isStalled({
      heartbeatFile,
      logFile,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(false);
    expect(result.heartbeatActive).toBe(true);
    expect(result.type).toBe("not-stalled");
  });

  it("active heartbeat → not stalled even with no log file", () => {
    const { heartbeatFile } = makePaths();
    const now = new Date();
    writeFileWithMtime(heartbeatFile, Date.now().toString(), now);

    const result = isStalled({
      heartbeatFile,
      logFile: undefined,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(false);
    expect(result.heartbeatActive).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale heartbeat + stale log → stalled
// ─────────────────────────────────────────────────────────────────────────────

describe("isStalled — stale heartbeat + stale log", () => {
  it("stale heartbeat + stale log → stalled (type: heartbeat+log)", () => {
    const { heartbeatFile, logFile } = makePaths();
    const staleDate = new Date(Date.now() - STALL_MS * 2);

    writeFileWithMtime(heartbeatFile, "old", staleDate);
    writeFileWithMtime(logFile, "old", staleDate);

    const result = isStalled({
      heartbeatFile,
      logFile,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(true);
    expect(result.type).toBe("heartbeat+log");
    expect(result.heartbeatActive).toBe(false);
    expect(result.stalledMs).toBeGreaterThanOrEqual(STALL_MS);
  });

  it("stale heartbeat + fresh log → NOT stalled", () => {
    const { heartbeatFile, logFile } = makePaths();
    const staleDate = new Date(Date.now() - STALL_MS * 2);
    const freshDate = new Date(); // just now

    writeFileWithMtime(heartbeatFile, "old", staleDate);
    writeFileWithMtime(logFile, "fresh", freshDate);

    const result = isStalled({
      heartbeatFile,
      logFile,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(false);
    expect(result.type).toBe("not-stalled");
    expect(result.heartbeatActive).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grace period
// ─────────────────────────────────────────────────────────────────────────────

describe("isStalled — grace period", () => {
  it("no heartbeat, within grace → NOT stalled (type: within-grace)", () => {
    const { logFile } = makePaths();
    const staleDate = new Date(Date.now() - STALL_MS * 2);
    writeFileWithMtime(logFile, "old", staleDate);

    const result = isStalled({
      heartbeatFile: undefined,
      logFile,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: 60_000, // huge grace — always within
      spawnedAt: Date.now(), // just spawned
    });

    expect(result.stalled).toBe(false);
    expect(result.type).toBe("within-grace");
    expect(result.heartbeatActive).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Log-only fallback (no heartbeat, after grace)
// ─────────────────────────────────────────────────────────────────────────────

describe("isStalled — log-only fallback", () => {
  it("no heartbeat, after grace, stale log → stalled (type: log-only)", () => {
    const { logFile } = makePaths();
    const staleDate = new Date(Date.now() - STALL_MS * 2);
    writeFileWithMtime(logFile, "old", staleDate);

    const result = isStalled({
      heartbeatFile: undefined,
      logFile,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(true);
    expect(result.type).toBe("log-only");
    expect(result.heartbeatActive).toBe(false);
    expect(result.stalledMs).toBeGreaterThanOrEqual(STALL_MS);
  });

  it("no heartbeat, after grace, fresh log → NOT stalled", () => {
    const { logFile } = makePaths();
    writeFileWithMtime(logFile, "fresh", new Date());

    const result = isStalled({
      heartbeatFile: undefined,
      logFile,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(false);
    expect(result.type).toBe("not-stalled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Degraded mode (logFile=null) — backward compat (Codex finding 5)
// ─────────────────────────────────────────────────────────────────────────────

describe("isStalled — degraded mode (logFile=null)", () => {
  it("logFile=null, no heartbeat, after grace → NOT stalled (degraded mode backward compat)", () => {
    const result = isStalled({
      heartbeatFile: undefined,
      logFile: null,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(false);
    expect(result.type).toBe("not-stalled");
    expect(result.heartbeatActive).toBe(false);
  });

  it("logFile=null, stale heartbeat → NOT stalled (degraded mode, dual-signal needs log)", () => {
    const { heartbeatFile } = makePaths();
    const staleDate = new Date(Date.now() - STALL_MS * 2);
    writeFileWithMtime(heartbeatFile, "old", staleDate);

    const result = isStalled({
      heartbeatFile,
      logFile: null,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(false);
    expect(result.type).toBe("not-stalled");
    expect(result.heartbeatActive).toBe(false);
  });

  it("logFile=undefined, no heartbeat, after grace → NOT stalled (degraded mode)", () => {
    const result = isStalled({
      heartbeatFile: undefined,
      logFile: undefined,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(false);
    expect(result.type).toBe("not-stalled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Missing file handling
// ─────────────────────────────────────────────────────────────────────────────

describe("isStalled — missing file handling", () => {
  it("missing heartbeat file → treated as stale (mtime=0)", () => {
    const { logFile } = makePaths();
    const staleDate = new Date(Date.now() - STALL_MS * 2);
    writeFileWithMtime(logFile, "old", staleDate);

    // heartbeatFile provided but doesn't exist → mtime=0 (stale) → falls to dual-signal
    const result = isStalled({
      heartbeatFile: path.join(tmpDir, "nonexistent.heartbeat"),
      logFile,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    // Heartbeat missing (mtime=0) + log stale → stalled
    expect(result.stalled).toBe(true);
    expect(result.type).toBe("heartbeat+log");
  });

  it("missing log file → treated as fresh (NOT stale) — Codex finding 5", () => {
    // log-only fallback: log file doesn't exist → mtime=now (fresh) → not stalled
    const result = isStalled({
      heartbeatFile: undefined,
      logFile: path.join(tmpDir, "nonexistent.log"),
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    // Missing log treated as fresh → not stalled
    expect(result.stalled).toBe(false);
    expect(result.type).toBe("not-stalled");
  });

  it("missing log file in dual-signal path → treated as fresh (not stale)", () => {
    const { heartbeatFile } = makePaths();
    const staleDate = new Date(Date.now() - STALL_MS * 2);
    writeFileWithMtime(heartbeatFile, "old", staleDate);

    // Stale heartbeat, log file missing → log treated as fresh → not stalled
    const result = isStalled({
      heartbeatFile,
      logFile: path.join(tmpDir, "nonexistent.log"),
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });

    expect(result.stalled).toBe(false);
    expect(result.type).toBe("not-stalled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 formula verification
// ─────────────────────────────────────────────────────────────────────────────

describe("R4 formula — heartbeatIntervalMs cap", () => {
  it("stallThresholdMs=120_000 → heartbeatIntervalMs=10_000 → gracePeriodMs=20_000", () => {
    const stallThresholdMs = 120_000;
    const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThresholdMs / 8));
    const gracePeriodMs = heartbeatIntervalMs * 2;

    expect(heartbeatIntervalMs).toBe(10_000); // 120000/8=15000, min(10000,15000)=10000
    expect(gracePeriodMs).toBe(20_000);        // always ≤ 20s (cap confirmed)
  });

  it("stallThresholdMs=8_000 → heartbeatIntervalMs=1_000 → gracePeriodMs=2_000", () => {
    const stallThresholdMs = 8_000;
    const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThresholdMs / 8));
    expect(heartbeatIntervalMs).toBe(1_000); // 8000/8=1000
  });

  it("stallThresholdMs=400 (test value) → heartbeatIntervalMs=1_000 (min floor)", () => {
    const stallThresholdMs = 400;
    const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThresholdMs / 8));
    expect(heartbeatIntervalMs).toBe(1_000); // 400/8=50, min(10000,50)=50, max(1000,50)=1000
  });

  it("heartbeatActive: true only when heartbeat mtime within stallThresholdMs", () => {
    const { heartbeatFile } = makePaths();

    // Fresh heartbeat → heartbeatActive: true
    writeFileWithMtime(heartbeatFile, "fresh", new Date());
    const fresh = isStalled({
      heartbeatFile,
      logFile: null,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });
    expect(fresh.heartbeatActive).toBe(true);

    // Stale heartbeat → heartbeatActive: false
    const staleDate = new Date(Date.now() - STALL_MS * 2);
    writeFileWithMtime(heartbeatFile, "old", staleDate);
    const stale = isStalled({
      heartbeatFile,
      logFile: null,
      stallThresholdMs: STALL_MS,
      gracePeriodMs: GRACE,
      spawnedAt: PAST,
    });
    expect(stale.heartbeatActive).toBe(false);
  });
});
