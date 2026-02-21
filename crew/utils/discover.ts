/**
 * Crew - Agent Discovery
 *
 * Discovers agent definitions from extension and project directories.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MaxOutputConfig } from "./truncate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_EXTENSION_AGENTS_DIR = path.resolve(__dirname, "..", "agents");

export type CrewRole = "planner" | "worker" | "reviewer" | "analyst";

export interface CrewAgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPrompt: string;
  source: "extension" | "project";
  filePath: string;
  crewRole?: CrewRole;
  maxOutput?: MaxOutputConfig;
  parallel?: boolean;
  retryable?: boolean;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const frontmatterBlock = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();

  const frontmatter: Record<string, unknown> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      let value: unknown = match[2].trim();
      if ((value as string).startsWith("\"") || (value as string).startsWith("'")) {
        value = (value as string).slice(1, -1);
      }
      if ((value as string).startsWith("{") && (value as string).endsWith("}")) {
        try {
          const jsonStr = (value as string).replace(/(\w+):/g, "\"$1\":");
          value = JSON.parse(jsonStr);
        } catch {
          // Keep as string if parse fails
        }
      }
      if (value === "true") value = true;
      if (value === "false") value = false;
      frontmatter[match[1]] = value;
    }
  }

  return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: "extension" | "project"): CrewAgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  const agents: CrewAgentConfig[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = (frontmatter.tools as string)
      ?.split(",")
      .map(t => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name as string,
      description: frontmatter.description as string,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model as string | undefined,
      thinking: frontmatter.thinking as string | undefined,
      systemPrompt: body,
      source,
      filePath,
      crewRole: frontmatter.crewRole as CrewRole | undefined,
      maxOutput: frontmatter.maxOutput as MaxOutputConfig | undefined,
      parallel: (frontmatter.parallel as boolean | undefined) ?? true,
      retryable: (frontmatter.retryable as boolean | undefined) ?? true,
    });
  }

  return agents;
}

export function discoverCrewAgents(cwd: string, extensionAgentsDir?: string): CrewAgentConfig[] {
  const extDir = extensionAgentsDir ?? DEFAULT_EXTENSION_AGENTS_DIR;
  const projectAgentsDir = path.join(cwd, ".pi", "messenger", "crew", "agents");

  const extensionAgents = loadAgentsFromDir(extDir, "extension");
  const projectAgents = loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, CrewAgentConfig>();
  for (const agent of extensionAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  return Array.from(agentMap.values());
}
