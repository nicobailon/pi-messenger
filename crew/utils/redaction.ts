const KEY_PREFIX_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9_-]{8,}\b/gi,
  /\bBearer\s+[a-z0-9._-]{8,}\b/gi,
];

const KV_PATTERNS: RegExp[] = [
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|auth|token|secret)\s*[:=]\s*)([^\s,;"'}]{6,})/gi,
  /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|auth|token|secret)"\s*:\s*")([^"]+)(")/gi,
];

/**
 * Redact credentials/tokens from optional debug payloads before surfacing.
 */
export function redactSensitiveText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;

  let redacted = value;
  for (const pattern of KEY_PREFIX_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  for (const pattern of KV_PATTERNS) {
    redacted = redacted.replace(pattern, "$1[REDACTED]$3");
  }

  return redacted;
}
