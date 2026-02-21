import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

const CREW_AGENTS = [
  "crew-planner.md",
  "crew-plan-sync.md",
  "crew-worker.md",
  "crew-reviewer.md",
];

const DEPRECATED_AGENTS = [
  "crew-repo-scout.md",
  "crew-practice-scout.md",
  "crew-docs-scout.md",
  "crew-web-scout.md",
  "crew-github-scout.md",
  "crew-gap-analyst.md",
  "crew-interview-generator.md",
];

const DEFAULT_MIGRATION_MARKER = "legacy-crew-agent-cleanup-v1.json";

export interface InstallOptions {
  homeDir?: string;
  migrationMarker?: string;
}

function getTargetAgentsDir(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "agents");
}

function getMigrationMarkerPath(homeDir: string, marker: string): string {
  return path.join(homeDir, ".pi", "agent", "messenger", "migrations", marker);
}

export function uninstallAgents(options: InstallOptions = {}): { removed: string[]; errors: string[] } {
  const homeDir = options.homeDir ?? homedir();
  const targetAgentsDir = getTargetAgentsDir(homeDir);
  const removed: string[] = [];
  const errors: string[] = [];

  for (const agent of [...CREW_AGENTS, ...DEPRECATED_AGENTS]) {
    const target = path.join(targetAgentsDir, agent);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(agent);
      }
    } catch (err) {
      errors.push(`Failed to remove ${agent}: ${err}`);
    }
  }

  return { removed, errors };
}

export function runLegacyAgentCleanupMigration(options: InstallOptions = {}): {
  ran: boolean;
  removed: string[];
  errors: string[];
} {
  const homeDir = options.homeDir ?? homedir();
  const migrationMarker = options.migrationMarker ?? DEFAULT_MIGRATION_MARKER;
  const markerPath = getMigrationMarkerPath(homeDir, migrationMarker);

  if (fs.existsSync(markerPath)) {
    return { ran: false, removed: [], errors: [] };
  }

  const uninstallResult = uninstallAgents({ homeDir });

  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      migratedAt: new Date().toISOString(),
      removed: uninstallResult.removed,
      errors: uninstallResult.errors,
    }, null, 2));
  } catch (err) {
    uninstallResult.errors.push(`Failed to persist migration marker: ${err}`);
  }

  return { ran: true, removed: uninstallResult.removed, errors: uninstallResult.errors };
}
