/**
 * Crew - Plan Handler
 * 
 * Orchestrates planning: planner agent → parse tasks → create in store
 * Simplified: PRD → plan → tasks
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { spawnAgents } from "../agents.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { loadCrewConfig } from "../utils/config.js";
import { parseVerdict, type ParsedReview } from "../utils/verdict.js";
import { logFeedEvent } from "../../feed.js";
import {
  finishPlanningRun,
  isPlanningCancelled,
  isPlanningForCwd,
  resetPlanningCancellation,
  setPendingAutoWork,
  setPlanningPhase,
  startPlanningRun,
  type PlanningPhase,
} from "../state.js";
import { getLiveWorkers } from "../live-progress.js";
import * as store from "../store.js";

const PRD_PATTERNS = [
  "PRD.md", "prd.md",
  "SPEC.md", "spec.md",
  "REQUIREMENTS.md", "requirements.md",
  "DESIGN.md", "design.md",
  "PLAN.md", "plan.md",
  "docs/PRD.md", "docs/prd.md",
  "docs/SPEC.md", "docs/spec.md",
];

const PLANNER_AGENT = "crew-planner";
const PROGRESS_FILE = "planning-progress.md";
const OUTLINE_FILE = "planning-outline.md";
const MAX_PROGRESS_PROMPT_SIZE = 50000;

function getProgressPath(cwd: string): string {
  return path.join(store.getCrewDir(cwd), PROGRESS_FILE);
}

function readProgressFile(cwd: string): string {
  const progressPath = getProgressPath(cwd);
  if (!fs.existsSync(progressPath)) return "";
  try {
    return fs.readFileSync(progressPath, "utf-8");
  } catch {
    return "";
  }
}

function readProgressForPrompt(cwd: string): string {
  const content = readProgressFile(cwd);
  if (!content) return "";
  if (content.length <= MAX_PROGRESS_PROMPT_SIZE) return content;

  const runMatches = Array.from(content.matchAll(/^##\s*Run:\s*/gm));
  if (runMatches.length === 0) {
    const marker = "\n\n[Progress truncated]";
    const limit = Math.max(0, MAX_PROGRESS_PROMPT_SIZE - marker.length);
    return content.slice(0, limit) + marker;
  }

  const firstRunIndex = runMatches[0].index ?? 0;
  const lastRunIndex = runMatches[runMatches.length - 1].index ?? firstRunIndex;

  const notesSection = content.slice(0, firstRunIndex).trimEnd();
  const currentRunSection = content.slice(lastRunIndex).trimStart();
  const marker = "[Previous runs truncated]";
  const prefix = `${notesSection}\n\n${marker}\n\n`;
  if (prefix.length >= MAX_PROGRESS_PROMPT_SIZE) {
    return prefix.slice(0, MAX_PROGRESS_PROMPT_SIZE);
  }

  const available = MAX_PROGRESS_PROMPT_SIZE - prefix.length;
  const truncatedRun = currentRunSection.slice(0, available);
  return `${prefix}${truncatedRun}`;
}

function startRunInProgress(cwd: string, prdPath: string): void {
  const progressPath = getProgressPath(cwd);
  if (!fs.existsSync(progressPath)) {
    const initial = `# Planning Progress\n\n## Notes\n<!-- User notes here are read by the planner on every run.\n     Add steering like "ignore auth" or "prioritize performance". -->\n\n`;
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    fs.writeFileSync(progressPath, initial);
  }

  const header = `---\n## Run: ${new Date().toISOString()} — ${prdPath}\n`;
  fs.appendFileSync(progressPath, `\n${header}`);
}

function formatProgressTime(): string {
  return new Date().toISOString().slice(11, 16);
}

function appendPassToProgress(cwd: string, passNum: number, content: string): void {
  const progressPath = getProgressPath(cwd);
  const header = `### Pass ${passNum} (${formatProgressTime()})\n`;
  fs.appendFileSync(progressPath, `\n${header}${content}\n`);
}

function appendReviewToProgress(
  cwd: string,
  reviewNum: number,
  verdict: string,
  content: string
): void {
  const progressPath = getProgressPath(cwd);
  const header = `### Review ${reviewNum} (${formatProgressTime()})\n`;
  fs.appendFileSync(progressPath, `\n${header}**Verdict: ${verdict}**\n${content}\n`);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
}

function advancePhase(
  cwd: string,
  phase: PlanningPhase,
  agentName: string,
  feedType: "plan.pass.start" | "plan.pass.done" | "plan.review.start" | "plan.review.done",
  target: string,
  preview: string,
  pass: number,
): void {
  setPlanningPhase(cwd, phase, pass);
  logFeedEvent(cwd, agentName, feedType, target, preview);
}

function wipeTasks(cwd: string): void {
  const tasksDir = path.join(store.getCrewDir(cwd), "tasks");
  if (fs.existsSync(tasksDir)) {
    fs.rmSync(tasksDir, { recursive: true, force: true });
  }
  const blocksDir = path.join(store.getCrewDir(cwd), "blocks");
  if (fs.existsSync(blocksDir)) {
    fs.rmSync(blocksDir, { recursive: true, force: true });
  }
  store.updatePlan(cwd, { task_count: 0, completed_count: 0 });
}

function injectSteeringPrompt(cwd: string, prompt: string): void {
  const progressPath = getProgressPath(cwd);
  if (!fs.existsSync(progressPath)) return;
  const content = fs.readFileSync(progressPath, "utf-8");
  const runMatch = content.match(/^##\s+Run:/m);
  const entry = `[${new Date().toISOString()}] Re-plan: ${prompt}\n\n`;
  if (runMatch && runMatch.index !== undefined) {
    const before = content.slice(0, runMatch.index);
    const after = content.slice(runMatch.index);
    fs.writeFileSync(progressPath, before + entry + after);
  } else {
    fs.appendFileSync(progressPath, `\n${entry}`);
  }
}

function setPlanningOutline(cwd: string, content: string): void {
  const outlinePath = path.join(store.getCrewDir(cwd), OUTLINE_FILE);
  fs.mkdirSync(path.dirname(outlinePath), { recursive: true });
  fs.writeFileSync(outlinePath, content);
}

function pruneTransitiveDeps(cwd: string, taskIds: string[]): void {
  const idDeps = new Map<string, string[]>();
  for (const id of taskIds) {
    const task = store.getTask(cwd, id);
    if (task) idDeps.set(id, [...task.depends_on]);
  }

  function isReachable(from: string, to: string, visited = new Set<string>()): boolean {
    if (visited.has(from)) return false;
    visited.add(from);
    const deps = idDeps.get(from);
    if (!deps) return false;
    if (deps.includes(to)) return true;
    return deps.some(d => isReachable(d, to, visited));
  }

  for (const id of taskIds) {
    const deps = idDeps.get(id);
    if (!deps || deps.length < 2) continue;
    const pruned = deps.filter(dep =>
      !deps.some(other => other !== dep && isReachable(other, dep))
    );
    if (pruned.length < deps.length) {
      store.updateTask(cwd, id, { depends_on: pruned });
    }
  }
}

export async function execute(
  params: CrewParams,
  ctx: ExtensionContext,
  agentName: string,
  onProgress?: () => void,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const { prd, prompt } = params;
  const reportProgress = () => onProgress?.();
  resetPlanningCancellation();

  const existingPlan = store.getPlan(cwd);
  if (existingPlan) {
    const existingTasks = store.getTasks(cwd);
    const planningActive = isPlanningForCwd(cwd);

    if (planningActive) {
      return result("Planning is already in progress.", { mode: "plan", error: "planning_active" });
    }

    if (existingTasks.length > 0 && !prompt) {
      const planRef = existingPlan.prompt
        ? `"${store.getPlanLabel(existingPlan)}"`
        : existingPlan.prd;
      return result(`A plan already exists for ${planRef}.\n\nTo re-plan with a steering prompt:\n  pi_messenger({ action: "plan", prompt: "focus on..." })`, {
        mode: "plan",
        error: "plan_exists",
        existingPrd: existingPlan.prd,
      });
    }

    if (existingTasks.length > 0 && prompt) {
      const liveWorkers = getLiveWorkers(cwd);
      const inProgress = existingTasks.filter(t => t.status === "in_progress" || liveWorkers.has(t.id));
      if (inProgress.length > 0) {
        return result(`Cannot re-plan: ${inProgress.length} task(s) in progress (${inProgress.map(t => t.id).join(", ")}). Stop or complete them first.`, {
          mode: "plan",
          error: "tasks_in_progress",
          inProgress: inProgress.map(t => t.id),
        });
      }
      wipeTasks(cwd);
    }

    if (existingTasks.length === 0 && !prompt) {
      const crewDir = store.getCrewDir(cwd);
      try { fs.rmSync(crewDir, { recursive: true, force: true }); } catch {}
    }
  }

  let prdPath: string;
  let prdContent: string;

  if (prd) {
    prdPath = prd;
    const fullPath = path.isAbsolute(prd) ? prd : path.join(cwd, prd);
    if (!fs.existsSync(fullPath)) {
      return result(`PRD file not found: ${prd}`, {
        mode: "plan",
        error: "prd_not_found",
        prd
      });
    }
    prdContent = fs.readFileSync(fullPath, "utf-8");
    if (prdContent.length > MAX_PRD_SIZE) {
      prdContent = prdContent.slice(0, MAX_PRD_SIZE) + "\n\n[Content truncated]";
    }
  } else {
    const discovered = discoverPRD(cwd);
    if (discovered) {
      prdPath = discovered.relativePath;
      prdContent = discovered.content;
    } else if (prompt) {
      prdPath = "(prompt)";
      prdContent = prompt;
      if (prdContent.length > MAX_PRD_SIZE) {
        prdContent = prdContent.slice(0, MAX_PRD_SIZE) + "\n\n[Content truncated]";
      }
    } else {
      return result(`No PRD file found. Create one of: ${PRD_PATTERNS.slice(0, 4).join(", ")}\n\nOr:\n  pi_messenger({ action: "plan", prd: "path/to/PRD.md" })\n  pi_messenger({ action: "plan", prompt: "Scan for bugs" })`, {
        mode: "plan",
        error: "no_prd",
        searchedPatterns: PRD_PATTERNS
      });
    }
  }

  const isPromptBased = prdPath === "(prompt)";

  const availableAgents = discoverCrewAgents(cwd);

  if (!availableAgents.some(a => a.name === PLANNER_AGENT)) {
    return result(`Error: ${PLANNER_AGENT} agent not found. Check extension installation.`, {
      mode: "plan",
      error: "no_planner"
    });
  }

  const config = loadCrewConfig(store.getCrewDir(cwd));
  const maxPasses = Math.max(1, config.planning.maxPasses);
  const hasReviewer = availableAgents.some(a => a.name === "crew-reviewer");

  const existingProgress = readProgressForPrompt(cwd);

  const runLabel = isPromptBased
    ? (prompt!.length > 60 ? prompt!.slice(0, 57) + "..." : prompt!)
    : prdPath;

  store.createPlan(cwd, prdPath, isPromptBased ? prompt : undefined);
  startRunInProgress(cwd, runLabel);
  if (prompt && !isPromptBased) injectSteeringPrompt(cwd, prompt);
  startPlanningRun(cwd, maxPasses);
  setPlanningPhase(cwd, "read-prd", 0);
  logFeedEvent(cwd, agentName, "plan.start", prdPath, `max passes ${maxPasses}`);
  notify(ctx, `Planning started: ${isPromptBased ? runLabel : path.basename(prdPath)} (${maxPasses} pass${maxPasses === 1 ? "" : "es"})`, "info");
  reportProgress();

  let lastPlannerOutput = "";
  let lastVerdict: ParsedReview | null = null;
  let lastReviewOutput = "";
  let passesCompleted = 0;
  let plannerFailedPass: number | null = null;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const passPhase: PlanningPhase = pass === 1 ? "scan-code" : "gap-analysis";
    advancePhase(cwd, passPhase, agentName, "plan.pass.start", prdPath, `pass ${pass}/${maxPasses}`, pass);
    reportProgress();
    notify(ctx, `Planning pass ${pass}/${maxPasses} in progress`, "info");

    const plannerPrompt = pass === 1
      ? buildFirstPassPrompt(prdPath, prdContent, existingProgress, isPromptBased)
      : buildRefinementPrompt(prdPath, prdContent, readProgressForPrompt(cwd), isPromptBased);

    const [plannerResult] = await spawnAgents([{
      agent: PLANNER_AGENT,
      task: plannerPrompt,
      modelOverride: config.models?.planner,
      taskId: "__planner__",
    }], cwd);

    if (isPlanningCancelled()) {
      return result("Planning cancelled.", { mode: "plan", error: "cancelled" });
    }

    if (plannerResult.exitCode !== 0) {
      if (pass === 1) {
        finishPlanningRun(cwd, "failed", pass);
        reportProgress();
        logFeedEvent(cwd, agentName, "plan.failed", prdPath, `pass ${pass} failed`);
        notify(ctx, "Planning failed on pass 1. No tasks were created.", "error");
        store.deletePlan(cwd);
        return result(`Error: Planner failed: ${plannerResult.error ?? "Unknown error"}`, {
          mode: "plan",
          error: "planner_failed"
        });
      }

      appendPassToProgress(cwd, pass, `[Planner failed: ${plannerResult.error ?? "Unknown error"}]`);
      logFeedEvent(cwd, agentName, "plan.failed", prdPath, `pass ${pass} failed, using previous pass output`);
      notify(ctx, `Planner failed on pass ${pass}; using previous pass output.`, "warning");
      plannerFailedPass = pass;
      break;
    }

    lastPlannerOutput = plannerResult.output;
    passesCompleted = pass;
    appendPassToProgress(cwd, pass, lastPlannerOutput);
    advancePhase(cwd, "build-task-graph", agentName, "plan.pass.done", prdPath, `pass ${pass}/${maxPasses} complete`, pass);
    reportProgress();

    if (pass >= maxPasses) break;
    if (!hasReviewer) break;

    advancePhase(cwd, "review-pass", agentName, "plan.review.start", prdPath, `review pass ${pass}`, pass);
    reportProgress();
    notify(ctx, `Reviewing planning pass ${pass}/${maxPasses}`, "info");

    const reviewPrompt = buildPlanReviewPrompt(
      prdPath,
      prdContent,
      lastPlannerOutput,
      pass,
      lastReviewOutput,
      isPromptBased,
    );

    const [reviewResult] = await spawnAgents([{
      agent: "crew-reviewer",
      task: reviewPrompt,
      modelOverride: config.models?.reviewer,
      taskId: "__reviewer__",
    }], cwd);

    if (isPlanningCancelled()) {
      return result("Planning cancelled.", { mode: "plan", error: "cancelled" });
    }

    if (reviewResult.exitCode !== 0) {
      logFeedEvent(cwd, agentName, "plan.review.done", prdPath, `review pass ${pass} failed`);
      setPlanningPhase(cwd, "build-steps", pass);
      reportProgress();
      notify(ctx, `Review failed on pass ${pass}; continuing with planner output.`, "warning");
      break;
    }

    lastVerdict = parseVerdict(reviewResult.output);
    lastReviewOutput = reviewResult.output;
    appendReviewToProgress(cwd, pass, lastVerdict.verdict, reviewResult.output);
    advancePhase(cwd, "build-steps", agentName, "plan.review.done", prdPath, `review ${pass}: ${lastVerdict.verdict}`, pass);
    reportProgress();

    if (lastVerdict.verdict === "SHIP") break;
  }

  setPlanningPhase(cwd, "build-steps", passesCompleted);
  reportProgress();

  const tasks = parseJsonTaskBlock(lastPlannerOutput) ?? parseTasksFromOutput(lastPlannerOutput);
  const sections = extractPlanSections(lastPlannerOutput);
  const outlineContent = sections
    ? `# Planning Outline\n\n## 1. PRD Understanding Summary\n${sections.prdSummary}\n\n## 2. Relevant Code/Docs/Resources Reviewed\n${sections.resourcesReviewed}\n\n## 3. Sequential Implementation Steps\n${sections.sequentialSteps}\n\n## 4. Parallelized Task Graph\n${sections.parallelTaskGraph}\n`
    : `# Planning Outline\n\nStructured sections were not detected. Full planner output is included below.\n\n${lastPlannerOutput}`;
  try { setPlanningOutline(cwd, outlineContent); } catch {}

  if (tasks.length === 0) {
    store.setPlanSpec(cwd, lastPlannerOutput);
    finishPlanningRun(cwd, "failed", passesCompleted);
    reportProgress();
    logFeedEvent(cwd, agentName, "plan.failed", prdPath, "no tasks parsed");
    notify(ctx, "Planning finished but no tasks could be parsed. Review plan.md.", "warning");

    return result(`Plan analysis complete but no tasks could be parsed.\n\nAnalysis saved to plan.md. Review and create tasks manually.`, {
      mode: "plan",
      prd: prdPath,
      analysisLength: lastPlannerOutput.length
    });
  }

  const createdTasks: { id: string; title: string; dependsOn: string[] }[] = [];
  const titleToId = new Map<string, string>();

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const created = store.createTask(cwd, task.title, task.description);
    createdTasks.push({ id: created.id, title: task.title, dependsOn: task.dependsOn });
    titleToId.set(task.title.toLowerCase(), created.id);
    titleToId.set(`task ${i + 1}`, created.id);
    titleToId.set(`task-${i + 1}`, created.id);
  }

  for (const task of createdTasks) {
    if (task.dependsOn.length > 0) {
      const resolvedDeps: string[] = [];
      for (const dep of task.dependsOn) {
        const depId = titleToId.get(dep.toLowerCase());
        if (depId && depId !== task.id) {
          resolvedDeps.push(depId);
        }
      }
      if (resolvedDeps.length > 0) {
        store.updateTask(cwd, task.id, { depends_on: resolvedDeps });
      }
    }
  }

  pruneTransitiveDeps(cwd, createdTasks.map(t => t.id));

  store.setPlanSpec(cwd, lastPlannerOutput);

  const taskList = createdTasks.map(t => {
    const task = store.getTask(cwd, t.id);
    const deps = task?.depends_on.length ? ` → deps: ${task.depends_on.join(", ")}` : "";
    return `  - ${t.id}: ${t.title}${deps}`;
  }).join("\n");

  const passLabel = passesCompleted === 1 ? "pass" : "passes";
  let planningSummary = "";
  let warningLine = "";

  if (plannerFailedPass !== null) {
    planningSummary = `**Planning:** ${passesCompleted} ${passLabel} (pass ${plannerFailedPass} planner failed, using pass ${passesCompleted} output)`;
    warningLine = "⚠️ Planner failed on refinement pass. Tasks created from initial plan.";
  } else if (hasReviewer && maxPasses > 1 && lastVerdict) {
    if (lastVerdict.verdict === "SHIP") {
      planningSummary = `**Planning:** ${passesCompleted} ${passLabel}, reviewer verdict: SHIP`;
    } else if (passesCompleted >= maxPasses) {
      planningSummary = `**Planning:** ${passesCompleted} ${passLabel} (max reached, last verdict: ${lastVerdict.verdict})`;
      warningLine = `⚠️ Unresolved review feedback saved to ${PROGRESS_FILE}`;
    } else {
      planningSummary = `**Planning:** ${passesCompleted} ${passLabel}, reviewer verdict: ${lastVerdict.verdict}`;
    }
  }

  const planningBlock = planningSummary ? `${planningSummary}\n` : "";
  const warningBlock = warningLine ? `${warningLine}\n` : "";

  setPlanningPhase(cwd, "finalizing", passesCompleted);
  reportProgress();

  const successLabel = isPromptBased ? `"${runLabel}"` : `**${prdPath}**`;
  const shouldAutoWork = params.autoWork !== false;
  const nextSteps = shouldAutoWork
    ? `Workers will start automatically.`
    : `**Next steps:**
- Review tasks: \`pi_messenger({ action: "task.list" })\`
- Start work: \`pi_messenger({ action: "work" })\`
- Autonomous: \`pi_messenger({ action: "work", autonomous: true })\``;

  const text = `✅ Plan created from ${successLabel}

${planningBlock}**Tasks created:** ${createdTasks.length}
${warningBlock}

${taskList}

${nextSteps}`;

  finishPlanningRun(cwd, "completed", passesCompleted);
  reportProgress();
  logFeedEvent(cwd, agentName, "plan.done", prdPath, `${createdTasks.length} tasks created`);
  if (warningLine) {
    notify(ctx, `Plan created with ${createdTasks.length} tasks (${warningLine})`, "warning");
  } else {
    notify(ctx, `Plan created with ${createdTasks.length} tasks.`, "info");
  }

  if (shouldAutoWork) {
    setPendingAutoWork(cwd);
  }

  return result(text, {
    mode: "plan",
    prd: prdPath,
    plannerAgent: PLANNER_AGENT,
    tasksCreated: createdTasks.map(t => ({ id: t.id, title: t.title }))
  });
}

// =============================================================================
// Prompt Builders
// =============================================================================

function buildFirstPassPrompt(prdPath: string, prdContent: string, existingProgress: string, isPromptBased: boolean): string {
  const specType = isPromptBased ? "request" : "PRD";
  const specLabel = isPromptBased ? "Request" : `PRD: ${prdPath}`;
  const progressSection = existingProgress
    ? `\n## Previous Planning Context\n${existingProgress}\n`
    : "";

  return `Create a task breakdown for implementing this ${specType}.

## ${specLabel}

${prdContent}
${progressSection}
You must follow this sequence strictly:
1) Understand the ${specType}
2) Review relevant code/docs/reference resources
3) Produce sequential implementation steps
4) Produce a parallel task graph

Return output in this exact section order and headings:
## 1. PRD Understanding Summary
## 2. Relevant Code/Docs/Resources Reviewed
## 3. Sequential Implementation Steps
## 4. Parallelized Task Graph

In section 4, include both:
- markdown task breakdown
- a \`tasks-json\` fenced block with task objects containing title, description, and dependsOn.`;
}

function buildRefinementPrompt(
  prdPath: string,
  prdContent: string,
  progressFileContent: string,
  isPromptBased: boolean,
): string {
  const specLabel = isPromptBased ? "Request" : `PRD: ${prdPath}`;
  return `Refine your task breakdown based on review feedback.

## ${specLabel}
${prdContent}

## Planning Progress
${progressFileContent}

The planning progress above contains your previous findings and the reviewer's
feedback. Address the issues raised. You can use tools to re-examine specific
files if needed, but focus on refinement rather than full re-exploration.

Return output in this exact section order and headings:
## 1. PRD Understanding Summary
## 2. Relevant Code/Docs/Resources Reviewed
## 3. Sequential Implementation Steps
## 4. Parallelized Task Graph

In section 4, include both:
- markdown task breakdown
- a \`tasks-json\` fenced block with task objects containing title, description, and dependsOn.`;
}

function buildPlanReviewPrompt(
  prdPath: string,
  prdContent: string,
  plannerOutput: string,
  passNum: number,
  previousReviewOutput: string,
  isPromptBased: boolean,
): string {
  const specType = isPromptBased ? "request" : "PRD";
  const specHeader = isPromptBased ? "Request" : "PRD";
  const specRef = isPromptBased ? "(see below)" : prdPath;
  const previousReviewSection = previousReviewOutput
    ? `## Previous Review Feedback\n${previousReviewOutput}\n\nCheck whether the planner addressed the issues from your previous review.\n`
    : "";

  return `# Plan Review Request

**${specHeader}:** ${specRef}
**Planning Pass:** ${passNum}

## ${isPromptBased ? "Request" : "PRD Content"}
${prdContent}

## Planner Output (Pass ${passNum})
${plannerOutput}

${previousReviewSection}## Your Review
Evaluate this plan against the ${specType}:
1. Completeness — are all requirements from the ${specType} covered?
2. Task granularity — is each task completable in one work session?
3. Dependencies — correct and complete dependency chain?
4. Gaps — missing tasks, edge cases, security concerns?
5. Parallelism — are there unnecessary sequential dependencies? Tasks that don't share files or types should be independent. Flag any chain that could be split into concurrent streams.
6. Critical path — what's the longest dependency chain? Could it be shortened by restructuring?

Output your verdict as SHIP, NEEDS_WORK, or MAJOR_RETHINK with detailed feedback.`;
}

// =============================================================================
// Task Parsing
// =============================================================================

interface PlanSections {
  prdSummary: string;
  resourcesReviewed: string;
  sequentialSteps: string;
  parallelTaskGraph: string;
}

interface ParsedTask {
  title: string;
  description: string;
  dependsOn: string[];
}

function extractPlanSections(output: string): PlanSections | null {
  const headingRegex = /^##\s+([1-4])\.\s+(.+)$/gm;
  const headings: Array<{ index: number; num: number }> = [];

  for (const match of output.matchAll(headingRegex)) {
    headings.push({ index: match.index ?? 0, num: Number(match[1]) });
  }

  const expectedOrder = [1, 2, 3, 4];
  if (headings.length < 4) return null;
  const firstFour = headings.slice(0, 4);
  if (!firstFour.every((h, idx) => h.num === expectedOrder[idx])) return null;

  const end = output.length;
  const section = (start: number, nextStart: number) => output.slice(start, nextStart).trim();

  const s1Start = firstFour[0].index;
  const s2Start = firstFour[1].index;
  const s3Start = firstFour[2].index;
  const s4Start = firstFour[3].index;

  const s1Body = section(s1Start, s2Start).replace(/^##\s+1\.\s+.+\n?/, "").trim();
  const s2Body = section(s2Start, s3Start).replace(/^##\s+2\.\s+.+\n?/, "").trim();
  const s3Body = section(s3Start, s4Start).replace(/^##\s+3\.\s+.+\n?/, "").trim();
  const s4Body = section(s4Start, end).replace(/^##\s+4\.\s+.+\n?/, "").trim();

  if (!s1Body || !s2Body || !s3Body || !s4Body) return null;

  return {
    prdSummary: s1Body,
    resourcesReviewed: s2Body,
    sequentialSteps: s3Body,
    parallelTaskGraph: s4Body,
  };
}

function parseJsonTaskBlock(output: string): ParsedTask[] | null {
  const match = output.match(/```tasks-json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return null;
    const tasks = parsed
      .filter((t: Record<string, unknown>) => typeof t.title === "string" && t.title.trim().length > 0)
      .map((t: Record<string, unknown>) => ({
        title: (t.title as string).trim(),
        description: typeof t.description === "string" ? t.description : "",
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d: unknown) => typeof d === "string") : []
      }));
    return tasks.length > 0 ? tasks : null;
  } catch {
    return null;
  }
}

/**
 * Parses tasks from planner output (markdown fallback).
 * 
 * Expected format:
 * ### Task 1: [Title]
 * [Description...]
 * Dependencies: none | Task 1, Task 2
 */
function parseTasksFromOutput(output: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  
  const taskRegex = /###\s*Task\s*\d+:\s*(.+?)\n([\s\S]*?)(?=###\s*Task\s*\d+:|## |$)/gi;
  let match;

  while ((match = taskRegex.exec(output)) !== null) {
    const title = match[1].trim();
    const body = match[2].trim();

    const depsMatch = body.match(/Dependencies?:\s*(.+?)(?:\n|$)/i);
    let dependsOn: string[] = [];
    
    if (depsMatch) {
      const depsText = depsMatch[1].trim().toLowerCase();
      if (depsText !== "none" && depsText !== "n/a" && depsText !== "-") {
        dependsOn = depsText
          .split(/,\s*/)
          .map(d => d.trim())
          .filter(d => d.length > 0);
      }
    }

    const description = body
      .replace(/Dependencies?:\s*.+?(?:\n|$)/i, "")
      .trim();

    tasks.push({ title, description, dependsOn });
  }

  return tasks;
}

// =============================================================================
// PRD Discovery
// =============================================================================

interface DiscoveredPRD {
  relativePath: string;
  content: string;
}

const MAX_PRD_SIZE = 100000;

function discoverPRD(cwd: string): DiscoveredPRD | null {
  const seenPaths = new Set<string>();

  for (const pattern of PRD_PATTERNS) {
    const filePath = path.join(cwd, pattern);
    if (fs.existsSync(filePath)) {
      try {
        const realPath = fs.realpathSync(filePath);
        if (seenPaths.has(realPath)) continue;
        seenPaths.add(realPath);
        
        let content = fs.readFileSync(filePath, "utf-8");
        
        if (content.length > MAX_PRD_SIZE) {
          content = content.slice(0, MAX_PRD_SIZE) + "\n\n[Content truncated]";
        }
        
        return { relativePath: pattern, content };
      } catch {
        // Ignore read errors
      }
    }
  }

  return null;
}
