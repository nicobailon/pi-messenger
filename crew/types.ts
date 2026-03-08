/**
 * Crew - Type Definitions
 * 
 * Simplified PRD-based workflow types.
 */

import type { MaxOutputConfig } from "./utils/truncate.js";
import type { AgentProgress } from "./utils/progress.js";
import type { CrewAgentConfig } from "./utils/discover.js";

// =============================================================================
// Plan Types
// =============================================================================

export interface Plan {
  prd: string;                   // Path to PRD file (relative to cwd)
  prompt?: string;               // Inline prompt text (when no PRD file)
  created_at: string;            // ISO timestamp
  updated_at: string;            // ISO timestamp
  task_count: number;            // Total tasks
  completed_count: number;       // Completed tasks

  /** NEW: All source specs for this plan (multi-spec support) */
  sources?: SpecSource[];
}

// =============================================================================
// Task Types
// =============================================================================

export type TaskStatus =
  | "todo"
  | "assigned"       // worker allocated, not yet spawned
  | "starting"       // process spawned, awaiting first heartbeat
  | "in_progress"    // heartbeat received, actively working
  | "done"
  | "blocked";

export interface TaskEvidence {
  commits?: string[];            // Commit SHAs
  tests?: string[];              // Test commands/files run
  prs?: string[];                // PR URLs
}

export interface Task {
  id: string;                    // task-N format
  namespace?: string;            // Crew namespace owner (defaults to shared)
  title: string;
  status: TaskStatus;
  milestone?: boolean;
  model?: string;
  depends_on: string[];          // Task IDs this depends on
  created_at: string;            // ISO timestamp
  updated_at: string;            // ISO timestamp
  started_at?: string;           // When task.start was called
  completed_at?: string;         // When task.done was called
  base_commit?: string;          // Git commit SHA at task.start
  assigned_to?: string;          // Agent name currently working on it
  summary?: string;              // Completion summary from task.done
  evidence?: TaskEvidence;       // Evidence from task.done
  blocked_reason?: string;       // Reason from task.block
  attempt_count: number;         // How many times attempted (for auto-block)

  /** NEW: Which spec produced this task (for multi-spec pools) */
  source_spec_id?: string;

  /** NEW: ISO timestamp when task was assigned to a worker */
  assigned_at?: string;

  /** NEW: Worker ID holding current lease */
  worker_id?: string;

  /** NEW: How many times this task has been reset/retried */
  retry_count?: number;
  spawn_failure_count?: number;  // How many times the spawned process failed to start (ENOENT/EACCES/etc.)
  last_review?: ReviewFeedback;  // Feedback from last review (for retry)
  rollback_reason?: string;      // Reason task was rolled back and re-queued

  /** When true, task gets dual-worker verification: two independent workers, outputs compared */
  critical?: boolean;
}

export interface ReviewFeedback {
  verdict: ReviewVerdict;
  summary: string;
  issues: string[];
  suggestions: string[];
  reviewed_at: string;           // ISO timestamp
}

// =============================================================================
// Crew Params (Tool Parameters)
// =============================================================================

export interface CrewParams {
  // Action
  action?: string;

  // Plan
  prd?: string;                  // PRD file path for plan action

  // Task IDs
  id?: string;                   // Task ID (task-N)
  taskId?: string;               // Swarm task ID (for claim/unclaim/complete)

  // Creation
  title?: string;
  dependsOn?: string[];

  // Completion
  summary?: string;
  evidence?: TaskEvidence;

  // Content
  content?: string;                // Task description/spec content
  count?: number;
  subtasks?: { title: string; content?: string }[];

  // Review
  target?: string;               // Task ID to review
  type?: "plan" | "impl";

  // Plan options
  autoWork?: boolean;

  // Work options
  autonomous?: boolean;
  concurrency?: number;
  model?: string;

  // Handoff
  handoffBrief?: {
    changes: string[];
    assumptions: string[];
    warnings: string[];
  };

  // Task reset
  cascade?: boolean;
  force?: boolean;

  // Critical task dual-verification
  critical?: boolean;
  // Revision
  prompt?: string;

  // Feed
  limit?: number;

  // Question protocol
  question?: string;
  questionId?: string;
  answer?: string;
  context?: string;

  // Coordination
  spec?: string;
  to?: string | string[];
  message?: string;
  replyTo?: string;
  paths?: string[];
  reason?: string;
  name?: string;
  notes?: string;
  autoRegisterPath?: "add" | "remove" | "list";

  // Blackboard
  key?: string;
  value?: string;
  reasoning?: string;
  challenge?: string;
  resolution?: string;
}

// =============================================================================
// Review Types
// =============================================================================

export type ReviewVerdict = "SHIP" | "NEEDS_WORK" | "MAJOR_RETHINK";

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  issues?: string[];
  suggestions?: string[];
}

// =============================================================================
// Agent Spawning Types
// =============================================================================

export interface AgentTask {
  agent: string;
  task: string;
  taskId?: string;
  modelOverride?: string;
  maxOutput?: MaxOutputConfig;
  workerName?: string;           // pre-assigned worker name for duplicate dispatch prevention
}

export interface AgentResult {
  agent: string;
  exitCode: number;
  output: string;
  truncated: boolean;
  progress: AgentProgress;
  config?: CrewAgentConfig;
  taskId?: string;
  wasGracefullyShutdown?: boolean;
  error?: string;
  artifactPaths?: {
    input: string;
    output: string;
    jsonl: string;
    metadata: string;
  };
}

// =============================================================================
// Callback Types
// =============================================================================

export type AppendEntryFn = (type: string, data: unknown) => void;

// =============================================================================
// Worker Lease Types (durable lease store)
// =============================================================================

export type WorkerLeaseStatus = "assigned" | "starting" | "active" | "completed" | "failed";

export interface WorkerLease {
  /** Matches Task.id */
  taskId: string;
  /** Unique worker identifier: crew-worker-{shortHash} */
  workerId: string;
  /** OS PID of spawned pi process */
  pid: number | null;
  /** ISO 8601 — when task was assigned */
  assignedAt: string;
  /** ISO 8601 — when process was spawned */
  spawnedAt: string | null;
  /** ISO 8601 — last heartbeat (updated every 30 s by worker) */
  heartbeatAt: string | null;
  /** ISO 8601 — first heartbeat received */
  startedAt: string | null;
  /** Current lease status */
  status: WorkerLeaseStatus;
  /** Model used for this worker (provider/model-id) */
  model: string | null;
  /** How many consecutive restart attempts */
  restartCount: number;
}

export interface WorkerLeaseStore {
  version: "1";
  updatedAt: string;
  leases: WorkerLease[];
}

// =============================================================================
// Multi-Spec Plan Types
// =============================================================================

export type SpecSourceType = "prd" | "prompt" | "github_issue" | "user_request" | "inline";

export interface SpecSource {
  /** e.g. "spec-1", "spec-2" */
  id: string;
  type: SpecSourceType;
  /** Relative or absolute path to spec file */
  path?: string;
  /** Inline spec content (for prompt/inline types) */
  content?: string;
  created_at: string;
  /** Optional display title */
  title?: string;
}
