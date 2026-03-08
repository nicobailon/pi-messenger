import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../../helpers/temp-dirs.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

async function loadExtensionsModule() {
  vi.resetModules();
  return import("../../../crew/utils/extensions.js");
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "// extension entry\n");
}

describe("crew/utils/extensions", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(dirs.root);
  });

  it("returns an empty list when settings.json is missing", async () => {
    const { loadConfiguredPackageExtensions } = await loadExtensionsModule();
    expect(loadConfiguredPackageExtensions()).toEqual([]);
  });

  it("resolves git package entries with existing local index.ts files", async () => {
    const settingsPath = path.join(dirs.root, ".pi", "agent", "settings.json");
    const gitRoot = path.join(dirs.root, ".pi", "agent", "git");
    const extA = path.join(gitRoot, "github.com", "acme", "pkg-a", "index.ts");
    const extB = path.join(gitRoot, "github.com", "acme", "pkg-b", "index.ts");
    touch(extA);
    touch(extB);

    writeJson(settingsPath, {
      packages: [
        "npm:ignore-me",
        "git:github.com/acme/pkg-a",
        { source: "git:github.com/acme/pkg-b" },
      ],
    });

    const { loadConfiguredPackageExtensions } = await loadExtensionsModule();
    expect(loadConfiguredPackageExtensions()).toEqual([extA, extB]);
  });

  it("skips missing or unresolvable package entries and deduplicates paths", async () => {
    const settingsPath = path.join(dirs.root, ".pi", "agent", "settings.json");
    const gitRoot = path.join(dirs.root, ".pi", "agent", "git");
    const ext = path.join(gitRoot, "github.com", "acme", "pkg-a", "index.ts");
    touch(ext);

    writeJson(settingsPath, {
      packages: [
        "git:github.com/acme/pkg-a",
        "git:github.com/acme/pkg-a",
        { source: "git:github.com/acme/missing" },
        { source: 123 },
        {},
        "git:not-enough-segments",
      ],
    });

    const { loadConfiguredPackageExtensions } = await loadExtensionsModule();
    expect(loadConfiguredPackageExtensions()).toEqual([ext]);
  });
});

