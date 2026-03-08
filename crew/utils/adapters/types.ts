/**
 * Crew - Runtime Adapter Types
 *
 * Interface for pluggable CLI runtimes (pi, Claude Code, etc.).
 * Each adapter knows how to build spawn args, parse progress events,
 * and declare feature support for its runtime.
 */

// =============================================================================
// Feature Declaration
// =============================================================================

export type RuntimeFeature =
  | "streaming"
  | "thinking"
  | "tool-restriction"
  | "extension-loading"
  | "system-prompt-file"
  | "system-prompt-inline";

// =============================================================================
// Spawn Configuration
// =============================================================================

export interface SpawnTask {
  prompt: string;
  systemPrompt?: string;
  systemPromptPath?: string;
}

export interface AdapterConfig {
  model?: string;
  thinking?: string;
  tools?: string[];
  extensionDir: string;
}

// =============================================================================
// Progress Events (normalized across runtimes)
// =============================================================================

export interface ProgressEvent {
  type: "tool_call" | "tool_result" | "message" | "error" | "unknown";
  toolName?: string;
  args?: Record<string, unknown>;
  tokens?: { input?: number; output?: number };
  model?: string;
  content?: string;
  errorMessage?: string;
}

// =============================================================================
// Adapter Interface
// =============================================================================

export interface RuntimeAdapter {
  /** Runtime identifier (e.g. "pi", "claude") */
  readonly name: string;

  /** CLI command to spawn (e.g. "pi", "claude") */
  getCommand(): string;

  /** Build CLI arguments for a spawn task */
  buildArgs(task: SpawnTask, config: AdapterConfig): string[];

  /** Build environment variables, extending the provided base env */
  buildEnv(base: Record<string, string>): Record<string, string>;

  /** Parse a single stdout line into a normalized progress event */
  parseProgressEvent(line: string): ProgressEvent | null;

  /** Check whether this runtime supports a given feature */
  supportsFeature(feature: RuntimeFeature): boolean;
}
