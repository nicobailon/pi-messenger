import { z } from "zod";

export const OperatorActionSchema = z.enum(["pause", "resume", "end", "inspect", "escalate"]);
export type OperatorAction = z.infer<typeof OperatorActionSchema>;

export const OperatorPresenceSchema = z.object({
  agentName: z.string(),
  role: z.string(),
  joinedAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
  status: z.enum(["online", "idle", "offline"]),
});
export type OperatorPresence = z.infer<typeof OperatorPresenceSchema>;

export const OperatorStateSchema = z.object({
  presence: OperatorPresenceSchema,
  permissions: z.array(OperatorActionSchema),
  activeSession: z.string().nullable(),
});
export type OperatorState = z.infer<typeof OperatorStateSchema>;
