/**
 * Crew - Debug Artifacts
 * 
 * Writes debug files for troubleshooting agent failures.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  jsonlPath: string;
  metadataPath: string;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  // dirname("foo") -> "."; don't attempt to mkdirSync(".")
  if (!dir || dir === ".") return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort: artifacts must never crash crew execution.
  }
}

function isRetryableFsError(err: unknown): boolean {
  const code = (err as any)?.code;
  return code === "ENOENT" || code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "ENOTDIR";
}

export function getArtifactPaths(
  artifactsDir: string,
  runId: string,
  agent: string,
  index?: number
): ArtifactPaths {
  const suffix = index !== undefined ? `_${index}` : "";
  const safeAgent = agent.replace(/[^\w.-]/g, "_");
  const base = `${runId}_${safeAgent}${suffix}`;

  return {
    inputPath: path.join(artifactsDir, `${base}_input.md`),
    outputPath: path.join(artifactsDir, `${base}_output.md`),
    jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
    metadataPath: path.join(artifactsDir, `${base}_meta.json`),
  };
}

export function ensureArtifactsDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort
  }
}

export function writeArtifact(filePath: string, content: string): void {
  // Artifacts are debugging aids; never fail the run because they couldn't be written.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ensureParentDir(filePath);
      fs.writeFileSync(filePath, content, "utf-8");
      return;
    } catch (err) {
      if (attempt === 0 && isRetryableFsError(err)) continue;
      return;
    }
  }
}

export function writeMetadata(filePath: string, metadata: object): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ensureParentDir(filePath);
      fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
      return;
    } catch (err) {
      if (attempt === 0 && isRetryableFsError(err)) continue;
      return;
    }
  }
}

export function appendJsonl(filePath: string, line: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ensureParentDir(filePath);
      fs.appendFileSync(filePath, `${line}\n`, "utf-8");
      return;
    } catch (err) {
      if (attempt === 0 && isRetryableFsError(err)) continue;
      return;
    }
  }
}

