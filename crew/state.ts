/**
 * Crew - Shared Runtime State (barrel)
 *
 * Re-exports autonomous and planning state from focused sibling modules.
 * Shared utility functions used by both modules live here.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function normalizeCwd(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export * from "./state-autonomous.js";
export * from "./state-planning.js";
