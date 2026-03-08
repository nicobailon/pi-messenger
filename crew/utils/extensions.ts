import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface PackageEntryObject {
  source?: unknown;
}

interface SettingsFileShape {
  packages?: unknown;
}

export interface ConfiguredPackageExtensionsOptions {
  settingsPath?: string;
  gitRoot?: string;
}

function getDefaultSettingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function getDefaultGitRoot(): string {
  return path.join(os.homedir(), ".pi", "agent", "git");
}

function normalizeGitLocator(rawLocator: string): string | null {
  let locator = rawLocator.trim();
  if (!locator) return null;

  if (locator.startsWith("https://") || locator.startsWith("http://")) {
    try {
      const url = new URL(locator);
      locator = `${url.host}${url.pathname}`;
    } catch {
      return null;
    }
  }

  locator = locator.replace(/\/+$/, "").replace(/\.git$/, "");
  if (locator.startsWith("/")) locator = locator.slice(1);
  if (!locator) return null;

  const segments = locator.split("/").filter(Boolean);
  if (segments.length < 3) return null;
  if (segments.some(segment => segment === "." || segment === "..")) return null;

  return segments.join("/");
}

function resolvePackageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  const source = (entry as PackageEntryObject).source;
  return typeof source === "string" ? source : null;
}

function resolveGitPackageIndexPath(source: string, gitRoot: string): string | null {
  if (!source.startsWith("git:")) return null;
  const locator = normalizeGitLocator(source.slice(4));
  if (!locator) return null;

  const entryPath = path.join(gitRoot, ...locator.split("/"), "index.ts");
  try {
    const stats = fs.statSync(entryPath);
    return stats.isFile() ? entryPath : null;
  } catch {
    return null;
  }
}

export function loadConfiguredPackageExtensions(
  options: ConfiguredPackageExtensionsOptions = {},
): string[] {
  const settingsPath = options.settingsPath ?? getDefaultSettingsPath();
  const gitRoot = options.gitRoot ?? getDefaultGitRoot();

  let settings: SettingsFileShape;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as SettingsFileShape;
  } catch {
    return [];
  }

  if (!Array.isArray(settings.packages)) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const pkg of settings.packages) {
    const source = resolvePackageSource(pkg);
    if (!source) continue;

    const resolvedPath = resolveGitPackageIndexPath(source, gitRoot);
    if (!resolvedPath || seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    paths.push(resolvedPath);
  }

  return paths;
}

