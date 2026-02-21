import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../../helpers/temp-dirs.js";
import { discoverCrewAgents } from "../../../crew/utils/discover.js";

function writeAgent(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("crew/utils/discover", () => {
  let dirs: TempCrewDirs;
  let extensionAgentsDir: string;
  let projectAgentsDir: string;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    extensionAgentsDir = path.join(dirs.root, "extension-agents");
    projectAgentsDir = path.join(dirs.cwd, ".pi", "messenger", "crew", "agents");
    fs.mkdirSync(extensionAgentsDir, { recursive: true });
  });

  it("discovers agents from injected extension directory", () => {
    writeAgent(path.join(extensionAgentsDir, "crew-worker.md"), `---
name: crew-worker
description: Worker implementation agent
tools: read, bash, pi_messenger
model: gpt-4.1-mini
crewRole: worker
---
You are a worker.
`);

    const agents = discoverCrewAgents(dirs.cwd, extensionAgentsDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("crew-worker");
    expect(agents[0].source).toBe("extension");
    expect(agents[0].model).toBe("gpt-4.1-mini");
    expect(agents[0].tools).toEqual(["read", "bash", "pi_messenger"]);
  });

  it("project agents override extension agents with the same name", () => {
    writeAgent(path.join(extensionAgentsDir, "crew-reviewer.md"), `---
name: crew-reviewer
description: Extension reviewer
crewRole: reviewer
model: extension-model
---
Extension prompt.
`);

    writeAgent(path.join(projectAgentsDir, "crew-reviewer.md"), `---
name: crew-reviewer
description: Project reviewer
crewRole: reviewer
model: project-model
---
Project prompt.
`);

    const agents = discoverCrewAgents(dirs.cwd, extensionAgentsDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("crew-reviewer");
    expect(agents[0].description).toBe("Project reviewer");
    expect(agents[0].model).toBe("project-model");
    expect(agents[0].source).toBe("project");
    expect(agents[0].systemPrompt).toContain("Project prompt.");
  });

  it("includes project-only agents alongside extension defaults", () => {
    writeAgent(path.join(extensionAgentsDir, "crew-worker.md"), `---
name: crew-worker
description: Extension worker
crewRole: worker
---
Extension worker prompt.
`);

    writeAgent(path.join(projectAgentsDir, "crew-custom.md"), `---
name: crew-custom
description: Project custom agent
crewRole: worker
---
Project custom prompt.
`);

    const agents = discoverCrewAgents(dirs.cwd, extensionAgentsDir);
    const names = agents.map(agent => agent.name).sort();
    expect(names).toEqual(["crew-custom", "crew-worker"]);
    expect(agents.find(agent => agent.name === "crew-worker")?.source).toBe("extension");
    expect(agents.find(agent => agent.name === "crew-custom")?.source).toBe("project");
  });

  it("returns extension agents when project directory is missing", () => {
    writeAgent(path.join(extensionAgentsDir, "crew-planner.md"), `---
name: crew-planner
description: Planner
crewRole: planner
---
Planner prompt.
`);

    const agents = discoverCrewAgents(dirs.cwd, extensionAgentsDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("crew-planner");
    expect(agents[0].source).toBe("extension");
  });

  it("parses thinking from frontmatter", () => {
    writeAgent(path.join(extensionAgentsDir, "crew-thinker.md"), `---
name: crew-thinker
description: Deep thinker
thinking: high
model: claude-opus-4-6
---
Think hard.
`);
    const agents = discoverCrewAgents(dirs.cwd, extensionAgentsDir);
    expect(agents[0].thinking).toBe("high");
  });

  it("thinking defaults to undefined when not specified", () => {
    writeAgent(path.join(extensionAgentsDir, "crew-simple.md"), `---
name: crew-simple
description: No thinking
---
Simple.
`);
    const agents = discoverCrewAgents(dirs.cwd, extensionAgentsDir);
    expect(agents[0].thinking).toBeUndefined();
  });

  it("parses frontmatter fields", () => {
    writeAgent(path.join(extensionAgentsDir, "crew-analyst.md"), `---
name: crew-analyst
description: Analyst
tools: read,  bash ,edit,   , write
crewRole: analyst
model: claude-3-5-haiku
maxOutput: { bytes: 2048, lines: 100 }
---
Analyst prompt
`);

    const agents = discoverCrewAgents(dirs.cwd, extensionAgentsDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("crew-analyst");
    expect(agents[0].model).toBe("claude-3-5-haiku");
    expect(agents[0].crewRole).toBe("analyst");
    expect(agents[0].tools).toEqual(["read", "bash", "edit", "write"]);
    expect(agents[0].maxOutput).toEqual({ bytes: 2048, lines: 100 });
  });
});
