/**
 * Context isolation tests for collaborator spawn (spec 062, 067).
 *
 * Two levels:
 * - Level 1 (unit): Source code assertions — flags are present in spawn paths.
 *   Runs in CI, no network required.
 * - Level 2 (integration): Live Pi spawn — measures actual tool count and
 *   response focus with different flag combos. Requires PI runtime + API key.
 *   Skipped in CI; run with PI_LIVE_TESTS=1.
 *
 * The Level 2 tests reproduce the contamination bug (spec 062/067): spawning
 * a collaborator with insufficient isolation flags causes it to load 20+
 * extension tools from settings.json packages, drowning the task prompt in
 * irrelevant cross-project context.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Level 1: Source-level flag assertions (fast, no network)
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ISOLATION_FLAGS = [
  "--no-session",
  "--no-skills",
  "--no-extensions",
  "--no-prompt-templates",
  "--no-themes",
];

describe("Level 1: spawn arg isolation flags", () => {
  const collabSource = fs.readFileSync(
    new URL("../../crew/handlers/collab.ts", import.meta.url).pathname,
    "utf-8",
  );
  const cliSource = fs.readFileSync(
    new URL("../../cli/index.ts", import.meta.url).pathname,
    "utf-8",
  );

  for (const flag of REQUIRED_ISOLATION_FLAGS) {
    it(`extension collab.ts includes ${flag}`, () => {
      expect(collabSource).toContain(`"${flag}"`);
    });
    it(`CLI index.ts includes ${flag}`, () => {
      expect(cliSource).toContain(`"${flag}"`);
    });
  }

  it("collab.ts has all flags in a single args array declaration", () => {
    // Ensure they're all in the same const args = [...] — not scattered
    const argsMatch = collabSource.match(/const args\s*=\s*\[([^\]]+)\]/);
    expect(argsMatch).not.toBeNull();
    const argsContent = argsMatch![1];
    for (const flag of REQUIRED_ISOLATION_FLAGS) {
      expect(argsContent).toContain(`"${flag}"`);
    }
  });

  it("cli/index.ts has all flags in a single args array declaration", () => {
    const argsMatch = cliSource.match(/const args\s*=\s*\[([^\]]+)\]/);
    expect(argsMatch).not.toBeNull();
    const argsContent = argsMatch![1];
    for (const flag of REQUIRED_ISOLATION_FLAGS) {
      expect(argsContent).toContain(`"${flag}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Level 2: Live Pi spawn — measures actual context contamination
// Requires: pi binary, API key, network access
// Run with: PI_LIVE_TESTS=1 npx vitest run tests/crew/context-isolation.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.PI_LIVE_TESTS === "1";
const TOOL_LIST_PROMPT = "List ALL tool names available to you. Output ONLY tool names, one per line. No descriptions, no numbering, no markdown.";
const MODEL = "anthropic/claude-sonnet-4-6";
const SPAWN_TIMEOUT = 30_000;

/** Spawn pi with given flags, return stdout text (strips Warning: lines). */
function spawnPi(extraFlags: string[], prompt: string): string {
  const args = [
    "--print", "--no-session", "--model", MODEL,
    ...extraFlags,
    "-p", prompt,
  ];
  const result = childProcess.spawnSync("pi", args, {
    cwd: "/tmp",
    timeout: SPAWN_TIMEOUT,
    encoding: "utf-8",
    env: { ...process.env },
  });
  if (result.error) throw result.error;
  // Strip Pi warning lines from output
  return (result.stdout ?? "")
    .split("\n")
    .filter((l: string) => !l.startsWith("Warning:"))
    .join("\n")
    .trim();
}

/** Parse tool names from Pi's tool list response. */
function parseToolNames(output: string): string[] {
  return output
    .split("\n")
    .map((l: string) => l.replace(/^[\d.)\-*\s]+/, "").trim())  // strip numbering/bullets
    .filter((l: string) => l.length > 0 && l.length < 60 && !l.includes(" "));  // tool names are single words
}

describe.skipIf(!LIVE)("Level 2: live context isolation (PI_LIVE_TESTS=1)", () => {
  // ── Contaminated baseline: --no-skills only (pre-067 flags) ──

  it("CONTAMINATED: --no-skills alone loads 10+ extension tools", () => {
    const output = spawnPi(["--no-skills"], TOOL_LIST_PROMPT);
    const tools = parseToolNames(output);

    console.log(`\n  [CONTAMINATED] Tools found (${tools.length}): ${tools.join(", ")}`);

    // Pre-067: Pi loads all packages from settings.json → 20+ tools
    expect(tools.length).toBeGreaterThan(10);

    // Specific contamination markers from packages
    const contaminants = ["pi_messenger", "ralph_status", "design_deck", "subagent", "init_experiment"];
    const found = contaminants.filter(c => tools.some(t => t.includes(c)));
    expect(found.length).toBeGreaterThan(0);
    console.log(`  [CONTAMINATED] Cross-project tools present: ${found.join(", ")}`);
  }, SPAWN_TIMEOUT + 5000);

  // ── Isolated: all flags (post-067) ──

  it("ISOLATED: all flags reduce to 4 builtin tools only", () => {
    const output = spawnPi(
      ["--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes"],
      TOOL_LIST_PROMPT,
    );
    const tools = parseToolNames(output);

    console.log(`\n  [ISOLATED] Tools found (${tools.length}): ${tools.join(", ")}`);

    // Post-067: only builtins remain
    expect(tools.length).toBeLessThanOrEqual(6);  // Read, Bash, Edit, Write + possible grep/find

    // No extension tools should be present
    const contaminants = ["pi_messenger", "ralph_status", "design_deck", "subagent", "init_experiment"];
    const found = contaminants.filter(c => tools.some(t => t.includes(c)));
    expect(found).toHaveLength(0);
    console.log(`  [ISOLATED] Cross-project tools present: none (clean)`);
  }, SPAWN_TIMEOUT + 5000);

  // ── Focus test: does the model stay on-topic? ──

  it("CONTAMINATED: off-topic response when asked about unrelated domain", () => {
    const prompt = [
      "You are reviewing a Python Flask API for a healthcare startup.",
      "The API has a /patients endpoint. What HTTP methods should it support?",
      "Reply in under 50 words. Do NOT mention Apple, Swift, xcodebuild, AVPStreamKit, or agent-config.",
    ].join(" ");

    const output = spawnPi(["--no-skills"], prompt);

    // With contamination, the model sometimes references cross-project content
    // We check for the presence of contamination markers in the response
    const contaminationKeywords = ["AVPStreamKit", "gj build", "agent-config", "pi-messenger", "beads_rust"];
    const contaminated = contaminationKeywords.some(k => output.includes(k));
    console.log(`\n  [FOCUS-CONTAMINATED] Response:\n  ${output.slice(0, 300)}`);
    console.log(`  Contamination detected: ${contaminated}`);
    // Note: contamination is probabilistic — this test documents the risk,
    // it may not fail every run. The tool count test above is deterministic.
  }, SPAWN_TIMEOUT + 5000);

  it("ISOLATED: on-topic response stays focused on the actual task", () => {
    const prompt = [
      "You are reviewing a Python Flask API for a healthcare startup.",
      "The API has a /patients endpoint. What HTTP methods should it support?",
      "Reply in under 50 words. Do NOT mention Apple, Swift, xcodebuild, AVPStreamKit, or agent-config.",
    ].join(" ");

    const output = spawnPi(
      ["--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes"],
      prompt,
    );

    const contaminationKeywords = ["AVPStreamKit", "gj build", "agent-config", "pi-messenger", "beads_rust"];
    const contaminated = contaminationKeywords.some(k => output.includes(k));
    console.log(`\n  [FOCUS-ISOLATED] Response:\n  ${output.slice(0, 300)}`);
    expect(contaminated).toBe(false);
  }, SPAWN_TIMEOUT + 5000);

  // ── Explicit extension still loads with --no-extensions ──

  it("explicit --extension still loads despite --no-extensions", () => {
    const extensionDir = new URL("../../", import.meta.url).pathname;
    const output = spawnPi(
      ["--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes",
       "--extension", extensionDir],
      TOOL_LIST_PROMPT,
    );
    const tools = parseToolNames(output);

    console.log(`\n  [EXPLICIT-EXT] Tools found (${tools.length}): ${tools.join(", ")}`);

    // pi-messenger tool should be present (loaded via explicit --extension)
    const hasPiMessenger = tools.some(t => t.includes("pi_messenger"));
    expect(hasPiMessenger).toBe(true);

    // But ralph, design_deck, etc. should NOT be present (they come from package discovery)
    const packageTools = ["ralph_status", "design_deck", "init_experiment"];
    const found = packageTools.filter(c => tools.some(t => t.includes(c)));
    expect(found).toHaveLength(0);
    console.log(`  [EXPLICIT-EXT] pi_messenger: present, package tools: absent (correct)`);
  }, SPAWN_TIMEOUT + 5000);
});
