/**
 * Crew - Sync Handler
 * 
 * Updates downstream specs after task completion.
 * Works with current plan's tasks.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { spawnAgents } from "../agents.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { loadCrewConfig } from "../utils/config.js";
import * as store from "../store.js";

export async function execute(
  params: CrewParams,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();
  const { target } = params;

  if (!target) {
    return result("Error: target (completed task ID) required for sync action.", {
      mode: "sync",
      error: "missing_target"
    });
  }

  // Verify plan exists
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result("Error: No plan found.", {
      mode: "sync",
      error: "no_plan"
    });
  }

  // Verify task exists and is completed
  const task = store.getTask(cwd, target);
  if (!task) {
    return result(`Error: Task ${target} not found.`, {
      mode: "sync",
      error: "task_not_found",
      target
    });
  }

  if (task.status !== "done") {
    return result(`Error: Task ${target} is ${task.status}, not done. Sync is for completed tasks.`, {
      mode: "sync",
      error: "task_not_done",
      status: task.status
    });
  }

  // Check for plan-sync agent
  const config = loadCrewConfig(store.getCrewDir(cwd));
  const availableAgents = discoverCrewAgents(cwd);
  const hasSyncAgent = availableAgents.some(a => a.name === "crew-plan-sync");
  if (!hasSyncAgent) {
    return result("Error: crew-plan-sync agent not found.", {
      mode: "sync",
      error: "no_sync_agent"
    });
  }

  const allTasks = store.getTasks(cwd);
  
  // Find dependent tasks (tasks that depend on the completed task)
  const dependentTasks = allTasks.filter(t => 
    t.depends_on.includes(target) && t.status === "todo"
  );

  if (dependentTasks.length === 0) {
    return result(`No downstream tasks depend on ${target}. No sync needed.`, {
      mode: "sync",
      taskId: target,
      dependentTasks: [],
      synced: false
    });
  }

  // Get completed task details for context
  const taskSpec = store.getTaskSpec(cwd, target);
  const taskSummary = task.summary ?? "No summary";

  // Build task overview for dependent tasks
  const dependentOverview = dependentTasks.map(t => {
    const spec = store.getTaskSpec(cwd, t.id);
    return `### ${t.id}: ${t.title}

${spec || "*No spec*"}
`;
  }).join("\n");

  // Build sync prompt
  const prompt = `# Spec Sync Request

## Completed Task

**Task ID:** ${target}
**Title:** ${task.title}
**Summary:** ${taskSummary}

### Implementation Details

${taskSpec || "*No detailed spec*"}

## Dependent Tasks to Update

These tasks depend on the completed task and may need spec updates:

${dependentOverview}

## Your Task

1. Review what was implemented in the completed task
2. Check if any dependent task specs need updating based on the implementation
3. Update specs with relevant information (file locations, API details, etc.)
4. Output which specs were updated and why

Follow the output format in your instructions.`;

  // Spawn sync agent
  const [syncResult] = await spawnAgents([{
    agent: "crew-plan-sync",
    task: prompt,
    modelOverride: config.models?.analyst,
  }], cwd);

  if (syncResult.exitCode !== 0) {
    return result(`Error: Sync agent failed: ${syncResult.error ?? "Unknown error"}`, {
      mode: "sync",
      error: "sync_failed"
    });
  }

  // Parse sync results
  const updates = parseSyncUpdates(syncResult.output);

  // Apply updates to task specs
  let updatedCount = 0;
  for (const update of updates) {
    const matchingTask = dependentTasks.find(t => 
      t.id === update.taskId || 
      t.title.toLowerCase().includes(update.taskId.toLowerCase())
    );

    if (matchingTask && update.newContent) {
      const currentSpec = store.getTaskSpec(cwd, matchingTask.id) ?? "";
      
      // Append update to spec (don't replace)
      const updatedSpec = `${currentSpec}

---
*Updated after ${target} completion:*

${update.newContent}`;

      store.setTaskSpec(cwd, matchingTask.id, updatedSpec);
      updatedCount++;
    }
  }

  const readyTasks = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
  const text = `# Sync Complete: ${target}

**Dependent tasks checked:** ${dependentTasks.length}
**Specs updated:** ${updatedCount}

${updates.length > 0 ? `## Updates\n${updates.map(u => `- **${u.taskId}**: ${u.reason}`).join("\n")}` : "## No Updates Needed\n\nDependent task specs are already up to date."}

${updatedCount > 0 ? `\n**Ready tasks:** ${readyTasks.map(t => t.id).join(", ") || "none"}` : ""}`;

  return result(text, {
    mode: "sync",
    taskId: target,
    dependentTasks: dependentTasks.map(t => t.id),
    updatedCount,
    updates: updates.map(u => ({ taskId: u.taskId, reason: u.reason }))
  });
}

// =============================================================================
// Sync Update Parsing
// =============================================================================

interface SyncUpdate {
  taskId: string;
  reason: string;
  newContent?: string;
}

/**
 * Parses sync updates from the sync agent output.
 * 
 * Expected format:
 * ### Updated: [task-id]
 * 
 * Changes made:
 * - Updated section X to reflect...
 * 
 * New content:
 * [content to add to spec]
 */
function parseSyncUpdates(output: string): SyncUpdate[] {
  const updates: SyncUpdate[] = [];

  // Match update blocks
  const updateRegex = /###\s*Updated:\s*(.+?)\n([\s\S]*?)(?=###|$)/gi;
  let match;

  while ((match = updateRegex.exec(output)) !== null) {
    const taskId = match[1].trim();
    const body = match[2].trim();

    // Extract reason (Changes made section)
    const reasonMatch = body.match(/Changes made:?\s*([\s\S]*?)(?=New content:|$)/i);
    const reason = reasonMatch 
      ? reasonMatch[1].trim().replace(/^[-*]\s*/gm, "").split("\n")[0].trim()
      : "Updated based on implementation";

    // Extract new content
    const contentMatch = body.match(/New content:?\s*([\s\S]*?)$/i);
    const newContent = contentMatch ? contentMatch[1].trim() : undefined;

    updates.push({ taskId, reason, newContent });
  }

  return updates;
}
