import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as store from "../../crew/store.js";
import { buildWorkerPrompt } from "../../crew/prompt.js";
import type { CrewConfig } from "../../crew/utils/config.js";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

describe("handoff brief injection", () => {
  let dirs: TempCrewDirs;
  let cwd: string;

  const defaultConfig: CrewConfig = {
    dependencies: "strict",
    coordination: "none",
    messageBudgets: {},
  };

  beforeEach(() => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store.createPlan(cwd, "docs/PRD.md");
  });

  it("injects handoff brief from a completed dependency into the worker prompt", () => {
    // Create dep task and mark it done
    const dep = store.createTask(cwd, "Setup database", "Create DB schema");
    store.startTask(cwd, dep.id, "worker-1");
    // Write handoff artifact (required by taskDone)
    const artifactsDir = path.join(dirs.crewDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const handoffContent = `# Handoff: ${dep.id}\n\n## Changes\n- Created schema.sql\n\n## Assumptions\n- Using PostgreSQL 15`;
    fs.writeFileSync(path.join(artifactsDir, `${dep.id}-handoff.md`), handoffContent);
    store.completeTask(cwd, dep.id, "DB schema created", { commits: ["abc123"], tests: ["test-db"] });
    store.acceptTask(cwd, dep.id);

    // Create dependent task
    const task = store.createTask(cwd, "Build API", "Create REST endpoints", [dep.id]);

    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, defaultConfig, []);

    expect(prompt).toContain("## Handoff Briefs from Dependencies");
    expect(prompt).toContain(`### ${dep.id}: Setup database`);
    expect(prompt).toContain("Created schema.sql");
    expect(prompt).toContain("Using PostgreSQL 15");
  });

  it("does NOT inject handoff section when no dependency has a handoff artifact", () => {
    const dep = store.createTask(cwd, "Setup infra", "Infra task");
    store.startTask(cwd, dep.id, "worker-1");
    // Write handoff artifact for taskDone but then we won't create the file for the test
    const artifactsDir = path.join(dirs.crewDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, `${dep.id}-handoff.md`), "placeholder");
    store.completeTask(cwd, dep.id, "Done", { commits: ["abc"], tests: ["t1"] });
    // Now remove the handoff artifact
    fs.unlinkSync(path.join(artifactsDir, `${dep.id}-handoff.md`));

    const task = store.createTask(cwd, "Build UI", "UI task", [dep.id]);
    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, defaultConfig, []);

    expect(prompt).not.toContain("## Handoff Briefs from Dependencies");
  });

  it("does NOT inject handoff section when task has no dependencies", () => {
    const task = store.createTask(cwd, "Standalone task", "No deps");
    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, defaultConfig, []);

    expect(prompt).not.toContain("## Handoff Briefs from Dependencies");
  });

  it("injects multiple handoff briefs when multiple deps are done", () => {
    const artifactsDir = path.join(dirs.crewDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });

    const dep1 = store.createTask(cwd, "Auth module", "Auth");
    store.startTask(cwd, dep1.id, "w1");
    fs.writeFileSync(path.join(artifactsDir, `${dep1.id}-handoff.md`), "Auth handoff content");
    store.completeTask(cwd, dep1.id, "Auth done", { commits: ["a1"], tests: ["t1"] });
    store.acceptTask(cwd, dep1.id);

    const dep2 = store.createTask(cwd, "DB module", "DB");
    store.startTask(cwd, dep2.id, "w2");
    fs.writeFileSync(path.join(artifactsDir, `${dep2.id}-handoff.md`), "DB handoff content");
    store.completeTask(cwd, dep2.id, "DB done", { commits: ["a2"], tests: ["t2"] });
    store.acceptTask(cwd, dep2.id);

    const task = store.createTask(cwd, "API layer", "Depends on both", [dep1.id, dep2.id]);
    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, defaultConfig, []);

    expect(prompt).toContain("## Handoff Briefs from Dependencies");
    expect(prompt).toContain("Auth handoff content");
    expect(prompt).toContain("DB handoff content");
    expect(prompt).toContain(`### ${dep1.id}: Auth module`);
    expect(prompt).toContain(`### ${dep2.id}: DB module`);
  });
});
