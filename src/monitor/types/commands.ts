import { z } from "zod";

// Base fields shared by all operator commands
const BaseCommandSchema = z.object({
  sessionId: z.string(),
  reason: z.string().optional(),
});

// Discriminated union on the 'action' field
export const OperatorCommandSchema = z.discriminatedUnion("action", [
  BaseCommandSchema.extend({ action: z.literal("pause") }),
  BaseCommandSchema.extend({ action: z.literal("resume") }),
  BaseCommandSchema.extend({ action: z.literal("end") }),
  BaseCommandSchema.extend({ action: z.literal("inspect") }),
  BaseCommandSchema.extend({ action: z.literal("escalate") }),
]);

export type OperatorCommand = z.infer<typeof OperatorCommandSchema>;

// Schema for the result of executing an operator command
export const CommandResultSchema = z.object({
  success: z.boolean(),
  command: OperatorCommandSchema,
  result: z.unknown().optional(),
  error: z.string().optional(),
  executedAt: z.string().datetime(),
});

export type CommandResult = z.infer<typeof CommandResultSchema>;

// Schema for validating command execution configuration
export const CommandValidatorSchema = z.object({
  allowedActions: z.array(z.enum(["pause", "resume", "end", "inspect", "escalate"])),
  requireReason: z.boolean(),
  maxConcurrent: z.number().int().positive(),
});

export type CommandValidator = z.infer<typeof CommandValidatorSchema>;
