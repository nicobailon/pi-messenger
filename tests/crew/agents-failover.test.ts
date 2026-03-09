import { describe, expect, it } from "vitest";
import { parseModelCandidates } from "../../crew/agents.js";

describe("crew/agents failover helpers", () => {
  it("parses comma-separated model candidates", () => {
    expect(parseModelCandidates("anthropic/claude-opus-4-6, openai-codex/gpt-5.3-codex, google/gemini-3.1-pro-preview")).toEqual([
      "anthropic/claude-opus-4-6",
      "openai-codex/gpt-5.3-codex",
      "google/gemini-3.1-pro-preview",
    ]);
  });

  it("returns empty for undefined model", () => {
    expect(parseModelCandidates(undefined)).toEqual([]);
  });
});
