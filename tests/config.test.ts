import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "./helpers/temp-dirs.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

async function loadConfigModule() {
  vi.resetModules();
  return import("../config.js");
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe("config autoOverlayPlanning", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(path.join(dirs.root, ".pi-home"));
  });

  it("defaults autoOverlayPlanning to true", async () => {
    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig(dirs.cwd);
    expect(cfg.autoOverlayPlanning).toBe(true);
  });

  it("applies project override for autoOverlayPlanning", async () => {
    const homeDir = path.join(dirs.root, ".pi-home");
    writeJson(path.join(homeDir, ".pi", "agent", "pi-messenger.json"), {
      autoOverlayPlanning: true,
    });
    writeJson(path.join(dirs.cwd, ".pi", "pi-messenger.json"), {
      autoOverlayPlanning: false,
    });

    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig(dirs.cwd);

    expect(cfg.autoOverlayPlanning).toBe(false);
  });
});
