import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLegacyAgentCleanupMigration, uninstallAgents } from "../../../crew/utils/install.js";

const roots = new Set<string>();

function createTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-install-test-"));
  roots.add(home);
  return home;
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "agent");
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe("crew/utils/install", () => {
  it("uninstallAgents removes legacy shared crew agent files", () => {
    const homeDir = createTempHome();
    const agentsDir = path.join(homeDir, ".pi", "agent", "agents");

    writeFile(path.join(agentsDir, "crew-worker.md"));
    writeFile(path.join(agentsDir, "crew-planner.md"));
    writeFile(path.join(agentsDir, "crew-repo-scout.md"));
    writeFile(path.join(agentsDir, "other-agent.md"));

    const result = uninstallAgents({ homeDir });

    expect(result.errors).toEqual([]);
    expect(result.removed.sort()).toEqual([
      "crew-planner.md",
      "crew-repo-scout.md",
      "crew-worker.md",
    ]);
    expect(fs.existsSync(path.join(agentsDir, "other-agent.md"))).toBe(true);
  });

  it("runLegacyAgentCleanupMigration runs once and uses marker file", () => {
    const homeDir = createTempHome();
    const agentsDir = path.join(homeDir, ".pi", "agent", "agents");
    const markerPath = path.join(homeDir, ".pi", "agent", "messenger", "migrations", "legacy-crew-agent-cleanup-v1.json");

    writeFile(path.join(agentsDir, "crew-worker.md"));

    const first = runLegacyAgentCleanupMigration({ homeDir });
    expect(first.ran).toBe(true);
    expect(first.removed).toContain("crew-worker.md");
    expect(fs.existsSync(markerPath)).toBe(true);

    writeFile(path.join(agentsDir, "crew-worker.md"));

    const second = runLegacyAgentCleanupMigration({ homeDir });
    expect(second.ran).toBe(false);
    expect(second.removed).toEqual([]);
    expect(fs.existsSync(path.join(agentsDir, "crew-worker.md"))).toBe(true);
  });
});
