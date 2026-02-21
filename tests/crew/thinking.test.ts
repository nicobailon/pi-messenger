import { describe, expect, it } from "vitest";
import { resolveThinking, modelHasThinkingSuffix } from "../../crew/agents.js";

describe("resolveThinking", () => {
  it("config thinking wins over agent thinking", () => {
    expect(resolveThinking("high", "low")).toBe("high");
  });

  it("falls back to agent thinking when config is undefined", () => {
    expect(resolveThinking(undefined, "medium")).toBe("medium");
  });

  it("returns undefined for 'off'", () => {
    expect(resolveThinking("off", "high")).toBeUndefined();
  });

  it("returns undefined when both are undefined", () => {
    expect(resolveThinking(undefined, undefined)).toBeUndefined();
  });

  it("agent 'off' also returns undefined", () => {
    expect(resolveThinking(undefined, "off")).toBeUndefined();
  });
});

describe("modelHasThinkingSuffix", () => {
  it("detects :high suffix", () => {
    expect(modelHasThinkingSuffix("claude-sonnet-4-5:high")).toBe(true);
  });

  it("detects all valid thinking levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      expect(modelHasThinkingSuffix(`some-model:${level}`)).toBe(true);
    }
  });

  it("returns false for plain model", () => {
    expect(modelHasThinkingSuffix("claude-sonnet-4-5")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(modelHasThinkingSuffix(undefined)).toBe(false);
  });

  it("returns false for non-thinking suffix", () => {
    expect(modelHasThinkingSuffix("my-model:v2")).toBe(false);
  });

  it("returns false for provider prefix without thinking", () => {
    expect(modelHasThinkingSuffix("openai-codex/gpt-5.2")).toBe(false);
  });

  it("detects thinking suffix on provider-prefixed model", () => {
    expect(modelHasThinkingSuffix("anthropic/claude-sonnet-4-5:high")).toBe(true);
  });
});
