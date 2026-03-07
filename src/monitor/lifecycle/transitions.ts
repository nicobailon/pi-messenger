/**
 * Session lifecycle transition table.
 *
 * Defines which state transitions are valid in the FSM.
 * idle → active (start)
 * active → paused (pause)
 * active → ended (end)
 * active → error (error)
 * paused → active (resume)
 * paused → ended (end)
 * error → ended (end — allow cleanup)
 */

import type { SessionStatus } from "../types/session.js";

// Transition table: from → set of valid "to" states
const TRANSITIONS: Record<SessionStatus, ReadonlySet<SessionStatus>> = {
  idle: new Set<SessionStatus>(["active"]),
  active: new Set<SessionStatus>(["paused", "ended", "error"]),
  paused: new Set<SessionStatus>(["active", "ended"]),
  ended: new Set<SessionStatus>([]),
  error: new Set<SessionStatus>(["ended"]),
};

/**
 * Returns true if transitioning from `from` to `to` is a valid lifecycle move.
 */
export function isValidTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].has(to);
}

/**
 * Returns all valid next states from a given state.
 */
export function validNextStates(from: SessionStatus): SessionStatus[] {
  return Array.from(TRANSITIONS[from]);
}
