import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";

vi.mock("../../crew/agents.ts", () => ({
  spawnAgents: vi.fn(),
}));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", env: GIT_ENV }).trim();
}

function initRepo(cwd: string): string {
  git("init -q -b main", cwd);
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
  git("add .", cwd);
  git("commit -qm init", cwd);
  return git("rev-parse HEAD", cwd);
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git("add .", cwd);
  git(`commit -qm "${message}"`, cwd);
}

interface Fixture {
  cwd: string;
  base: string;
  taskId: string;
}

async function createReviewedTask(): Promise<Fixture> {
  const store = await import("../../crew/store.ts");
  const dirs = createTempCrewDirs();
  const cwd = dirs.cwd;
  const base = initRepo(cwd);
  store.createPlan(cwd, "docs/PRD.md");
  const task = store.createTask(cwd, "Build feature");
  store.updateTask(cwd, task.id, {
    status: "done",
    base_commit: base,
    assigned_to: "TestWorker",
    attempt_count: 1,
  });

  // crew-reviewer agent so reviewImplementation passes discovery
  const agentsDir = path.join(cwd, ".pi", "messenger", "crew", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, "crew-reviewer.md"),
    `---\nname: crew-reviewer\ndescription: Test reviewer\n---\nYou are a test reviewer.\n`
  );

  return { cwd, base, taskId: task.id };
}

describe("reviewImplementation diff source", () => {
  let spawnAgentsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const agents = await import("../../crew/agents.ts");
    spawnAgentsMock = agents.spawnAgents as ReturnType<typeof vi.fn>;
    spawnAgentsMock.mockReset();
    spawnAgentsMock.mockResolvedValue([
      { exitCode: 0, output: "## Verdict: SHIP\nLooks good.\n" },
    ]);
  });

  async function runReview(cwd: string, taskId: string): Promise<string> {
    const { reviewImplementation } = await import("../../crew/handlers/review.ts");
    const r = await reviewImplementation(cwd, taskId);
    const details = (r as { details?: Record<string, unknown> }).details ?? {};
    expect(details).toEqual(expect.objectContaining({ mode: "review", taskId }));
    expect(spawnAgentsMock).toHaveBeenCalledTimes(1);
    return spawnAgentsMock.mock.calls[0][0][0].task as string;
  }

  it("diffs the task branch (three-dot), not main checkout HEAD", async () => {
    const { cwd, taskId } = await createReviewedTask();

    git(`checkout -qb task/${taskId}`, cwd);
    commitFile(cwd, "src/feature.ts", "export const marker = 'task-work';\n", "feat: task work");
    git("checkout -q main", cwd);
    commitFile(cwd, "src/unrelated.ts", "export const unrelated = true;\n", "chore: other work");

    const prompt = await runReview(cwd, taskId);

    expect(prompt).toContain("task-work");
    expect(prompt).toContain("feat: task work");
    expect(prompt).not.toContain("unrelated = true");
    expect(prompt).not.toContain("chore: other work");
  });

  it("diffs a task branch that lives in a linked worktree", async () => {
    const { cwd, taskId } = await createReviewedTask();

    const wtPath = cwd + "-wt";
    git(`worktree add -q -b task/${taskId} ${wtPath}`, cwd);
    commitFile(wtPath, "src/wt-feature.ts", "export const wtMarker = 'worktree-work';\n", "feat: worktree work");

    try {
      const prompt = await runReview(cwd, taskId);

      expect(prompt).toContain("worktree-work");
      expect(prompt).toContain("feat: worktree work");
    } finally {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  });

  it("surfaces an error in the prompt when the task branch has an empty diff", async () => {
    const { cwd, taskId } = await createReviewedTask();

    git(`branch task/${taskId}`, cwd);

    const prompt = await runReview(cwd, taskId);

    expect(prompt).toContain("**ERROR:**");
    expect(prompt).toContain(`task/${taskId}`);
    expect(prompt).not.toContain("*No changes*");
  });

  it("keeps git diff failures distinct from empty task branches", async () => {
    const { cwd, taskId } = await createReviewedTask();
    const store = await import("../../crew/store.ts");
    git(`branch task/${taskId}`, cwd);
    store.updateTask(cwd, taskId, { base_commit: "missing-base" });

    const prompt = await runReview(cwd, taskId);

    expect(prompt).toContain("*Failed to get diff:");
    expect(prompt).not.toContain("exists but has no changes");
  });

  it("falls back to base..HEAD when no task branch exists", async () => {
    const { cwd, taskId } = await createReviewedTask();

    commitFile(cwd, "src/head-only.ts", "export const headOnly = true;\n", "feat: head work");

    const prompt = await runReview(cwd, taskId);

    expect(prompt).toContain("headOnly = true");
    expect(prompt).toContain("feat: head work");
  });
});
