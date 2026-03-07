/**
 * Session State Store
 *
 * In-memory store with file-backed persistence for session state.
 * Follows the pattern in crew/store.ts: atomic JSON writes via temp files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  SessionStateSchema,
  SessionMetadataSchema,
  type SessionState,
  type SessionMetadata,
  type SessionMetrics,
} from "../types/session.js";

// =============================================================================
// Types
// =============================================================================

export type SessionPatch = {
  status?: SessionState["status"];
  metadata?: Partial<SessionMetadata>;
  metrics?: Partial<SessionMetrics>;
  events?: SessionState["events"];
};

// =============================================================================
// Helpers
// =============================================================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, filePath);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function defaultMetrics(): SessionMetrics {
  return {
    duration: 0,
    eventCount: 0,
    errorCount: 0,
    toolCalls: 0,
    tokensUsed: 0,
  };
}

// =============================================================================
// SessionStore
// =============================================================================

export class SessionStore {
  private sessions: Map<string, SessionState> = new Map();

  /**
   * Create a new session from metadata.
   * Validates the metadata via Zod before storing.
   * Returns the new SessionState.
   */
  create(metadata: unknown): SessionState {
    const validMeta = SessionMetadataSchema.parse(metadata);

    const session: SessionState = {
      status: "idle",
      metadata: validMeta,
      metrics: defaultMetrics(),
      events: [],
    };

    // Full schema validation before storing
    const validated = SessionStateSchema.parse(session);
    this.sessions.set(validated.metadata.id, validated);
    return validated;
  }

  /**
   * Get a session by ID. Returns undefined if not found.
   */
  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  /**
   * Update a session with a partial patch.
   * Validates the merged result via Zod before storing.
   */
  update(id: string, patch: SessionPatch): SessionState {
    const existing = this.sessions.get(id);
    if (!existing) {
      throw new Error(`Session not found: ${id}`);
    }

    const merged: SessionState = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      metadata: patch.metadata
        ? { ...existing.metadata, ...patch.metadata }
        : existing.metadata,
      metrics: patch.metrics
        ? { ...existing.metrics, ...patch.metrics }
        : existing.metrics,
      events: patch.events !== undefined ? patch.events : existing.events,
    };

    // Validate merged state
    const validated = SessionStateSchema.parse(merged);
    this.sessions.set(id, validated);
    return validated;
  }

  /**
   * Delete a session by ID. Returns true if it existed, false otherwise.
   */
  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /**
   * List all sessions. Optionally filter by status.
   */
  list(filter?: { status?: SessionState["status"] }): SessionState[] {
    const all = Array.from(this.sessions.values());
    if (!filter) return all;

    return all.filter((s) => {
      if (filter.status !== undefined && s.status !== filter.status) return false;
      return true;
    });
  }

  /**
   * Persist all sessions to a directory using atomic file writes.
   * Each session is written as <id>.json
   */
  persist(dir: string): void {
    ensureDir(dir);
    for (const [id, session] of this.sessions) {
      const filePath = path.join(dir, `${id}.json`);
      writeJsonAtomic(filePath, session);
    }
  }

  /**
   * Restore sessions from a directory.
   * Reads all *.json files and validates them via Zod.
   * Invalid files are skipped with a warning.
   */
  restore(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = readJsonFile<unknown>(filePath);
      if (raw === null) continue;

      const result = SessionStateSchema.safeParse(raw);
      if (!result.success) {
        console.warn(`[SessionStore] Skipping invalid session file: ${file}`, result.error.message);
        continue;
      }

      this.sessions.set(result.data.metadata.id, result.data);
    }
  }

  /**
   * Return the number of sessions in the store.
   */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Clear all sessions from the in-memory store.
   */
  clear(): void {
    this.sessions.clear();
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create and return a new SessionStore instance.
 */
export function createSessionStore(): SessionStore {
  return new SessionStore();
}
