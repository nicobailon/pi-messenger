import { z } from "zod";

/**
 * Attention Queue Types
 */

export const AttentionReasonSchema = z.enum([
  "waiting_on_human",
  "stuck",
  "degraded",
  "high_error_rate",
  "repeated_retries",
  "failed_recoverable",
  "stale_running",
]);
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;

export const AttentionItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  reason: AttentionReasonSchema,
  message: z.string(),
  recommendedAction: z.string(),
  timestamp: z.string().datetime(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;
