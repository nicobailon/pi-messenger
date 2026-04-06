import { describe, it, expect } from "vitest";
import {
  parseProviderTerminalErrorMessage,
  extractProviderTerminalErrorFromLogLine,
} from "../../crew/utils/provider-classification.js";

describe("crew/utils/provider-classification", () => {
  it("classifies terminal statuses 401/402/403/429", () => {
    for (const status of [401, 402, 403, 429]) {
      const parsed = parseProviderTerminalErrorMessage(
        `${status} {"type":"error","error":{"type":"server_error","message":"blocked"},"request_id":"req_${status}"}`,
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.statusCode).toBe(status);
      expect(parsed?.requestId).toBe(`req_${status}`);
    }
  });

  it("classifies terminal class from error.type", () => {
    const parsed = parseProviderTerminalErrorMessage(
      '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"},"request_id":"req_type"}',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.errorType).toBe("rate_limit_error");
    expect(parsed?.requestId).toBe("req_type");
  });

  it("classifies terminal class from error.code fallback when error.type missing", () => {
    const parsed = parseProviderTerminalErrorMessage(
      '{"type":"error","error":{"code":"usage_limit_exceeded","message":"quota"},"request_id":"req_code"}',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.errorType).toBe("usage_limit_exceeded");
    expect(parsed?.errorCode).toBe("usage_limit_exceeded");
    expect(parsed?.requestId).toBe("req_code");
  });

  it("uses error.type precedence when both error.type and error.code exist", () => {
    const parsed = parseProviderTerminalErrorMessage(
      '{"type":"error","error":{"type":"authentication_error","code":"rate_limit_error","message":"auth"},"request_id":"req_precedence"}',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.errorType).toBe("authentication_error");
    expect(parsed?.errorCode).toBe("rate_limit_error");
  });

  it("does not classify transient statuses 500/503/529 as terminal by default", () => {
    for (const status of [500, 503, 529]) {
      const parsed = parseProviderTerminalErrorMessage(
        `${status} {"type":"error","error":{"type":"server_error","message":"transient"},"request_id":"req_${status}"}`,
      );
      expect(parsed).toBeNull();
    }
  });

  it("does not classify overloaded/server/network classes as terminal by default", () => {
    expect(
      parseProviderTerminalErrorMessage('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}'),
    ).toBeNull();
    expect(
      parseProviderTerminalErrorMessage('{"type":"error","error":{"type":"server_error","message":"boom"}}'),
    ).toBeNull();
    expect(
      parseProviderTerminalErrorMessage('{"type":"error","error":{"type":"network_error","message":"retry"}}'),
    ).toBeNull();
  });

  it("returns null for malformed payloads", () => {
    expect(parseProviderTerminalErrorMessage("totally malformed")).toBeNull();
  });

  it("extracts provider/model/request_id from log line", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-6",
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"limit"},"request_id":"req_extract"}',
      },
    });

    const parsed = extractProviderTerminalErrorFromLogLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("anthropic");
    expect(parsed?.model).toBe("claude-opus-4-6");
    expect(parsed?.requestId).toBe("req_extract");
    expect(parsed?.statusCode).toBe(429);
    expect(parsed?.errorType).toBe("rate_limit_error");
  });
});
