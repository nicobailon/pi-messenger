import { afterEach, describe, expect, it, vi } from "vitest";

describe("crew/spawn-pi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses the pi binary directly on non-Windows platforms", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const { buildPiProcessSpec } = await import("../../crew/utils/spawn-pi.js");
    expect(buildPiProcessSpec(["--version"])).toEqual({
      command: "pi",
      args: ["--version"],
    });
  });

  it("uses cmd.exe shell resolution on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe");

    const { buildPiProcessSpec } = await import("../../crew/utils/spawn-pi.js");
    expect(buildPiProcessSpec(["--version"])).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pi", "--version"],
    });
  });

  it("falls back to cmd.exe when ComSpec is missing on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("ComSpec", "");

    const { buildPiProcessSpec } = await import("../../crew/utils/spawn-pi.js");
    expect(buildPiProcessSpec(["--mode", "json"])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "pi", "--mode", "json"],
    });
  });
});
