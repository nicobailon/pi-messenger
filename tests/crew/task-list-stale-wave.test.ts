import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { MessengerState } from "../../lib.ts";
import type { Plan } from "../../crew/types.ts";
import * as taskHandler from "../../crew/handlers/task.ts";
import * as store from "../../crew/store.ts";
import { createMockContext } from "../helpers/mock-context.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";

const DAY_MS = 86_400_000;

function createState(agentName = "Lead"): MessengerState {
  return { agentName } as MessengerState;
}

// updatePlan force-stamps updated_at, so backdate plan.json directly.
function backdatePlan(cwd: string, days: number): void {
  const plan = store.getPlan(cwd);
  if (!plan) throw new Error("no plan to backdate");
  const old = new Date(Date.now() - days * DAY_MS).toISOString();
  fs.writeFileSync(
    path.join(cwd, ".pi", "messenger", "crew", "plan.json"),
    JSON.stringify({ ...plan, created_at: old, updated_at: old } satisfies Plan),
  );
}

function completeFirstTask(cwd: string, title: string): void {
  const task = store.createTask(cwd, title);
  store.startTask(cwd, task.id, "Worker");
  store.completeTask(cwd, task.id, "Shipped");
}

async function listText(cwd: string): Promise<string> {
  const list = await taskHandler.execute("list", {}, createState(), createMockContext(cwd));
  return list.content[0].text;
}

describe("task.list wave age and stale-wave notices", () => {
  it("flags a fully-completed old wave and points at the spec path from the prompt", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md", "Land specs/20261013-124607-nessus-upload-into-execution");
    completeFirstTask(cwd, "Upload scan output");
    backdatePlan(cwd, 30);

    const text = await listText(cwd);
    const oldDay = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);

    expect(text).toContain(`⚠ STALE WAVE — completed ${oldDay} (30d ago). No active crew wave. Authority for current work: the spec's tasks.md (e.g. specs/<id>/<slug>/tasks.md) and GitLab issues — task.list does not track them.`);
    expect(text).toContain(`Wave: created ${oldDay}, updated ${oldDay} (30d old)`);
    expect(text).toContain("Spec: specs/20261013-124607-nessus-upload-into-execution/");
    expect(text.indexOf("⚠ STALE WAVE")).toBeLessThan(text.indexOf("# Tasks"));
  });

  it("shows the wave age line without a stale notice for a fresh active plan", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md", "Refactor the parser");
    store.createTask(cwd, "Split parser module");

    const text = await listText(cwd);

    expect(text).toMatch(/^Wave: created \d{4}-\d{2}-\d{2}, updated \d{4}-\d{2}-\d{2} \(\d+d old\)$/m);
    expect(text).not.toContain("STALE WAVE");
    expect(text).toContain("**Progress:** 0/1");
  });

  it("shows the wave age line without a stale notice when an old plan is only partially complete", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md", "Refactor the parser");
    completeFirstTask(cwd, "Split parser module");
    store.createTask(cwd, "Migrate call sites");
    backdatePlan(cwd, 30);

    const text = await listText(cwd);

    expect(text).toMatch(/^Wave: created \d{4}-\d{2}-\d{2}, updated \d{4}-\d{2}-\d{2} \(30d old\)$/m);
    expect(text).not.toContain("STALE WAVE");
    expect(text).toContain("**Progress:** 1/2");
  });

  it("points planless projects at spec tasks.md and GitLab issues", async () => {
    const { cwd } = createTempCrewDirs();

    const text = await listText(cwd);

    expect(text).toContain("No plan found.");
    expect(text).toContain("Authority for current work: spec tasks.md / GitLab issues — no crew wave exists.");
  });

  it("omits the Spec line when neither prompt nor prd carries a specs/ reference", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md", "Refactor the parser");
    completeFirstTask(cwd, "Split parser module");
    backdatePlan(cwd, 30);

    const text = await listText(cwd);

    expect(text).not.toMatch(/^Spec: /m);
    expect(text).toContain("⚠ STALE WAVE");
    expect(text).toContain("(30d old)");
  });
});
