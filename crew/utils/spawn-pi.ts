import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface PiProcessSpec {
  command: string;
  args: string[];
}

export function buildPiProcessSpec(args: string[]): PiProcessSpec {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "pi", ...args],
    };
  }

  return {
    command: "pi",
    args,
  };
}

export function spawnPi(args: string[], options: SpawnOptions): ChildProcess {
  const spec = buildPiProcessSpec(args);
  return spawn(spec.command, spec.args, options);
}
