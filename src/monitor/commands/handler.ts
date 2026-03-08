/**
 * OperatorCommandHandler
 *
 * Dispatches OperatorCommand objects to the SessionLifecycleManager,
 * validates commands against CommandValidator constraints, and returns
 * structured CommandResult responses.
 */

import { randomUUID } from "node:crypto";
import { SessionLifecycleManager } from "../lifecycle/manager.js";
import type {
  OperatorCommand,
  CommandResult,
  CommandValidator,
} from "../types/commands.js";

// =============================================================================
// Types
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// =============================================================================
// OperatorCommandHandler
// =============================================================================

export class OperatorCommandHandler {
  private lifecycle: SessionLifecycleManager;
  private validatorConfig: CommandValidator | null = null;
  private activeCount = 0;

  constructor(lifecycle?: SessionLifecycleManager) {
    this.lifecycle = lifecycle ?? new SessionLifecycleManager();
  }

  /**
   * Set a CommandValidator configuration for subsequent commands.
   */
  setValidator(config: CommandValidator): void {
    this.validatorConfig = config;
  }

  /**
   * Validate an OperatorCommand against the current CommandValidator config.
   * Returns { valid: true, errors: [] } if no validator is configured.
   */
  validate(command: OperatorCommand): ValidationResult {
    const errors: string[] = [];

    if (this.validatorConfig === null) {
      return { valid: true, errors: [] };
    }

    const config = this.validatorConfig;

    // Check allowedActions
    if (!config.allowedActions.includes(command.action)) {
      errors.push(
        `Action "${command.action}" is not allowed. Allowed actions: ${config.allowedActions.join(", ")}.`
      );
    }

    // Check requireReason
    if (config.requireReason && !command.reason) {
      errors.push(`A reason is required for command action "${command.action}".`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Execute an OperatorCommand.
   * Validates the command, routes to the lifecycle manager, and returns CommandResult.
   * Always returns a structured result — errors are caught and wrapped.
   */
  execute(command: OperatorCommand): CommandResult {
    const executedAt = new Date().toISOString();

    // Validate first
    const validation = this.validate(command);
    if (!validation.valid) {
      return {
        success: false,
        command,
        error: validation.errors.join("; "),
        executedAt,
      };
    }

    // Check maxConcurrent
    if (
      this.validatorConfig !== null &&
      this.activeCount >= this.validatorConfig.maxConcurrent
    ) {
      return {
        success: false,
        command,
        error: `Maximum concurrent commands (${this.validatorConfig.maxConcurrent}) exceeded.`,
        executedAt,
      };
    }

    this.activeCount++;
    try {
      const result = this.dispatch(command);
      return {
        success: true,
        command,
        result,
        executedAt,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        command,
        error: message,
        executedAt,
      };
    } finally {
      this.activeCount--;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Route a validated command to the appropriate lifecycle manager method.
   * Returns the updated session state or relevant data for the action.
   */
  private dispatch(command: OperatorCommand): unknown {
    const { action, sessionId } = command;

    switch (action) {
      case "pause": {
        this.lifecycle.pause(sessionId, command.reason);
        const store = this.lifecycle.getStore();
        return store.get(sessionId);
      }

      case "resume": {
        this.lifecycle.resume(sessionId, command.reason);
        const store = this.lifecycle.getStore();
        return store.get(sessionId);
      }

      case "end": {
        this.lifecycle.end(sessionId, command.reason);
        const store = this.lifecycle.getStore();
        return store.get(sessionId);
      }

      case "inspect": {
        const store = this.lifecycle.getStore();
        const state = store.get(sessionId);
        if (!state) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        return state;
      }

      case "escalate": {
        // Route through the lifecycle FSM so the active→error transition is
        // validated and a session.error event is emitted.
        this.lifecycle.escalate(sessionId, command.reason);
        const store = this.lifecycle.getStore();
        return store.get(sessionId);
      }

      default: {
        // TypeScript exhaustiveness — should never reach here
        const _exhaustive: never = action;
        throw new Error(`Unknown command action: ${String(_exhaustive)}`);
      }
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create and return a new OperatorCommandHandler.
 */
export function createOperatorCommandHandler(
  lifecycle?: SessionLifecycleManager
): OperatorCommandHandler {
  return new OperatorCommandHandler(lifecycle);
}
