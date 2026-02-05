/**
 * Crew - Plan Handler
 * 
 * Orchestrates planning: planner agent → parse tasks → create in store
 * Simplified: PRD → plan → tasks
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { spawnAgents } from "../agents.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { loadCrewConfig } from "../utils/config.js";
import { parseVerdict, type ParsedReview } from "../utils/verdict.js";
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

export async function execute(
  params: CrewParams,
  _state: MessengerState,
  _dirs: Dirs,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();
  const { prd } = params;

  const existingPlan = store.getPlan(cwd);
  if (existingPlan) {
    return result(`A plan already exists for ${existingPlan.prd}.\n\nTo create a new plan, first delete the existing one:\n  - Delete .pi/messenger/crew/ directory\n  - Or reset tasks manually`, {
      mode: "plan",
      error: "plan_exists",
      existingPrd: existingPlan.prd
    });
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
    if (!discovered) {
      return result(`No PRD file found. Create one of: ${PRD_PATTERNS.slice(0, 4).join(", ")}\n\nOr specify path: pi_messenger({ action: "plan", prd: "path/to/PRD.md" })`, {
        mode: "plan",
        error: "no_prd",
        searchedPatterns: PRD_PATTERNS
      });
    }
    prdPath = discovered.relativePath;
    prdContent = discovered.content;
  }

  const availableAgents = discoverCrewAgents(cwd);

  if (!availableAgents.some(a => a.name === PLANNER_AGENT)) {
    return result(`Error: ${PLANNER_AGENT} agent not found. Run crew.install to install crew agents.`, {
      mode: "plan",
      error: "no_planner"
    });
  }

  const config = loadCrewConfig(store.getCrewDir(cwd));
  const maxPasses = Math.max(1, config.planning.maxPasses);
  const hasReviewer = availableAgents.some(a => a.name === "crew-reviewer");

  const existingProgress = readProgressForPrompt(cwd);

  store.createPlan(cwd, prdPath);
  startRunInProgress(cwd, prdPath);

  let lastPlannerOutput = "";
  let lastVerdict: ParsedReview | null = null;
  let lastReviewOutput = "";
  let passesCompleted = 0;
  let plannerFailedPass: number | null = null;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const plannerPrompt = pass === 1
      ? buildFirstPassPrompt(prdPath, prdContent, existingProgress)
      : buildRefinementPrompt(prdPath, prdContent, readProgressForPrompt(cwd));

    const [plannerResult] = await spawnAgents([{
      agent: PLANNER_AGENT,
      task: plannerPrompt
    }], 1, cwd);

    if (plannerResult.exitCode !== 0) {
      if (pass === 1) {
        store.deletePlan(cwd);
        return result(`Error: Planner failed: ${plannerResult.error ?? "Unknown error"}`, {
          mode: "plan",
          error: "planner_failed"
        });
      }

      appendPassToProgress(cwd, pass, `[Planner failed: ${plannerResult.error ?? "Unknown error"}]`);
      plannerFailedPass = pass;
      break;
    }

    lastPlannerOutput = plannerResult.output;
    passesCompleted = pass;
    appendPassToProgress(cwd, pass, lastPlannerOutput);

    if (pass >= maxPasses) break;
    if (!hasReviewer) break;

    const reviewPrompt = buildPlanReviewPrompt(
      prdPath,
      prdContent,
      lastPlannerOutput,
      pass,
      lastReviewOutput
    );

    const [reviewResult] = await spawnAgents([{
      agent: "crew-reviewer",
      task: reviewPrompt
    }], 1, cwd);

    if (reviewResult.exitCode !== 0) {
      break;
    }

    lastVerdict = parseVerdict(reviewResult.output);
    lastReviewOutput = reviewResult.output;
    appendReviewToProgress(cwd, pass, lastVerdict.verdict, reviewResult.output);

    if (lastVerdict.verdict === "SHIP") break;
  }

  const tasks = parseJsonTaskBlock(lastPlannerOutput) ?? parseTasksFromOutput(lastPlannerOutput);

  if (tasks.length === 0) {
    store.setPlanSpec(cwd, lastPlannerOutput);

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

  const text = `✅ Plan created from **${prdPath}**

${planningBlock}**Tasks created:** ${createdTasks.length}
${warningBlock}

${taskList}

**Next steps:**
- Review tasks: \`pi_messenger({ action: "task.list" })\`
- Start work: \`pi_messenger({ action: "work" })\`
- Autonomous: \`pi_messenger({ action: "work", autonomous: true })\``;

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

function buildFirstPassPrompt(prdPath: string, prdContent: string, existingProgress: string): string {
  const progressSection = existingProgress
    ? `\n## Previous Planning Context\n${existingProgress}\n`
    : "";

  return `Create a task breakdown for implementing this PRD.

## PRD: ${prdPath}

${prdContent}
${progressSection}
Rules (strict):
- You are running *inside* pi_messenger crew planning. Do NOT call pi_messenger actions (except the required join).
- Do NOT run commands that modify files (no rm/mv/git commit). Exploration only: ls/find/rg/grep/cat/read.
- Do NOT delete/rename anything under .pi/ (especially .pi/messenger/crew and its artifacts).

Explore the codebase, identify patterns and conventions, then create a task breakdown following the output format in your instructions.`;
}

function buildRefinementPrompt(
  prdPath: string,
  prdContent: string,
  progressFileContent: string
): string {
  return `Refine your task breakdown based on review feedback.

## PRD: ${prdPath}
${prdContent}

## Planning Progress
${progressFileContent}

Rules (strict):
- You are running *inside* pi_messenger crew planning. Do NOT call pi_messenger actions (except the required join).
- Do NOT run commands that modify files (no rm/mv/git commit). Re-examination only.
- Do NOT delete/rename anything under .pi/ (especially .pi/messenger/crew and its artifacts).

The planning progress above contains your previous findings and the reviewer's
feedback. Address the issues raised. You can use tools to re-examine specific
files if needed, but focus on refinement rather than full re-exploration.

Produce an updated task breakdown following the output format in your instructions
(both markdown and JSON formats).`;
}

function buildPlanReviewPrompt(
  prdPath: string,
  prdContent: string,
  plannerOutput: string,
  passNum: number,
  previousReviewOutput: string
): string {
  const previousReviewSection = previousReviewOutput
    ? `## Previous Review Feedback\n${previousReviewOutput}\n\nCheck whether the planner addressed the issues from your previous review.\n`
    : "";

  return `# Plan Review Request

**PRD:** ${prdPath}
**Planning Pass:** ${passNum}

## PRD Content
${prdContent}

## Planner Output (Pass ${passNum})
${plannerOutput}

${previousReviewSection}## Your Review
Evaluate this plan against the PRD:
1. Completeness — are all requirements from the PRD covered?
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

interface ParsedTask {
  title: string;
  description: string;
  dependsOn: string[];
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
