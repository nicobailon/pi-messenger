export interface ProviderTerminalError {
  statusCode?: number;
  errorType?: string;
  errorCode?: string;
  errorMessage: string;
  requestId?: string;
  provider?: string;
  model?: string;
  raw: string;
}

export const TERMINAL_PROVIDER_STATUS_CODES = new Set([401, 402, 403, 429]);

export const TERMINAL_PROVIDER_ERROR_TYPES = new Set([
  "rate_limit_error",
  "insufficient_quota",
  "quota_exceeded",
  "usage_limit_exceeded",
  "authentication_error",
  "permission_error",
  "billing_error",
  "credit_balance_too_low",
]);

/**
 * Terminal classification policy (normative)
 *
 * Canonical fields:
 * - primary class source: error.type
 * - fallback class source: error.code
 *
 * Terminal by status: 401, 402, 403, 429
 * Terminal by class: rate_limit_error, insufficient_quota, quota_exceeded,
 * usage_limit_exceeded, authentication_error, permission_error,
 * billing_error, credit_balance_too_low
 *
 * non-terminal defaults: 500/502/503/504/529 and overloaded/server/network classes
 * remain non-terminal unless policy is explicitly expanded.
 *
 * 429 bounded-latency note: upstream provider/runtime retry layers can delay when
 * a terminal line becomes observable. Once observable, poll must short-circuit quickly.
 *
 * Test linkage: tests/crew/provider-classification.test.ts
 */

export function parseProviderTerminalErrorMessage(
  rawError: string,
): Omit<ProviderTerminalError, "provider" | "model"> | null {
  const text = rawError.trim();
  if (!text) return null;

  let statusCode: number | undefined;
  let payloadRaw = text;

  const statusPrefix = text.match(/^(\d{3})\s+(\{[\s\S]*\})$/);
  if (statusPrefix) {
    statusCode = Number(statusPrefix[1]);
    payloadRaw = statusPrefix[2];
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(payloadRaw);
  } catch {
    // Keep raw text path below
  }

  const requestId = parsed?.request_id;
  const parsedType = parsed?.error?.type;
  const parsedCode = parsed?.error?.code;
  const errorMessage = parsed?.error?.message ?? text;

  const isTerminalStatus = statusCode !== undefined && TERMINAL_PROVIDER_STATUS_CODES.has(statusCode);
  const normalizedType = String(parsedType ?? parsedCode ?? "").toLowerCase();
  const isTerminalType = TERMINAL_PROVIDER_ERROR_TYPES.has(normalizedType);

  if (!isTerminalStatus && !isTerminalType) return null;

  return {
    statusCode,
    errorType: typeof (parsedType ?? parsedCode) === "string" ? String(parsedType ?? parsedCode) : undefined,
    errorCode: typeof parsedCode === "string" ? parsedCode : undefined,
    errorMessage: String(errorMessage),
    requestId: typeof requestId === "string" ? requestId : undefined,
    raw: text,
  };
}

export function extractProviderTerminalErrorFromLogLine(line: string): ProviderTerminalError | null {
  if (!line.trim().startsWith("{")) return null;

  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  const provider = typeof event?.message?.provider === "string" ? event.message.provider : undefined;
  const model = typeof event?.message?.model === "string" ? event.message.model : undefined;

  const candidates: string[] = [];
  if (typeof event?.message?.errorMessage === "string") {
    candidates.push(event.message.errorMessage);
  }
  if (Array.isArray(event?.messages)) {
    for (const msg of event.messages) {
      if (typeof msg?.errorMessage === "string") {
        candidates.push(msg.errorMessage);
      }
    }
  }

  for (const candidate of candidates) {
    const parsed = parseProviderTerminalErrorMessage(candidate);
    if (parsed) {
      return { ...parsed, provider, model };
    }
  }

  return null;
}
