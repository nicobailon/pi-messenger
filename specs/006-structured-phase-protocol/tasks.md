<!-- Codex Review: 5 rounds, max reached | model: gpt-5.3-codex | date: 2026-03-15 -->
<!-- Status: REVISED -->
<!-- Revisions: T3b expanded to all constructors, T14 triple-gate, T16 mesh-aware tests, T17 mesh-aware spawn collision -->
---
title: "Tasks: Structured phase protocol"
date: 2026-03-15
bead: pi-messenger-3t0
---

# Tasks

Ordered by dependency. Each task is independently testable.

## Phase 1: Type Foundation (no behavior change)

- [x] **T1: Add `phase` to AgentMailMessage** — `lib.ts` line 60. Add `phase?: string` to interface. Zero behavior change.
- [x] **T2: Add `phase` to CrewParams** — `crew/types.ts` line 69. Add `phase?: string` to Coordination section.
- [x] **T3: Add `peerTerminal` to CollaboratorEntry** — `crew/registry.ts` line 32. Add `peerTerminal?: boolean`.
- [x] **T3b: Add `completedCollaborators` to MessengerState** — `lib.ts` MessengerState interface. Add `completedCollaborators: Set<string>`. Initialize as `new Set()` in ALL constructors: `index.ts` (~line 100), `cli/index.ts` (`createMinimalState` ~line 37), `tests/crew/collab-blocking.test.ts` (`makeMinimalState` ~line 71), `tests/crew/router-status.test.ts` (`createTestState` ~line 9), and any other typed `MessengerState` constructors.
- [x] **T4: Add `phase` to sendMessageToAgent** — `store.ts` line 1011. Add optional `phase` parameter, write into message JSON. Only include in JSON when set (no `phase: undefined` in files). Test: phase appears in written JSON file.

## Phase 2: Plumbing (wire phase through, no behavior change yet)

- [x] **T5: Pass `phase` through crew/index.ts dispatch** — Line 106. Add `params.phase` to `executeSend` call. Depends on T2.
- [x] **T6: Add `phase` to executeSend signature** — `handlers.ts` line 262. Add `phase?: string` parameter. Thread it to `sendMessageToAgent` call at line 352. No behavior change yet — phase is stored in messages but doesn't affect flow. Depends on T4, T5.
- [x] **T7: Add `phase` to tool parameter schema** — `index.ts` ~line 430. Add `Type.Optional(StringEnum(["review", "challenge", "revise", "approved", "complete"]))` with description. Depends on T2.

## Phase 3: PollResult + D4 arming (read-side behavior)

- [x] **T8: Update PollResult type** — `crew/handlers/collab.ts`. Add `peerComplete?: boolean` to success result. Add `stallType?: "log" | "timeout"` to error result.
- [x] **T9: Set peerComplete + peerTerminal on phase:"complete" match** — In `pollForCollaboratorMessage`, after `checkMessage` returns a match: if `msg.phase === "complete"`, set `entry.peerTerminal = true` and resolve with `peerComplete: true`. Depends on T3, T8.
- [x] **T10: Tests for T9** — Test: poll returns `peerComplete: true` when message has `phase: "complete"`. Test: poll returns `peerComplete: undefined` when message has no phase. Test: `entry.peerTerminal` is set to true. Add to `tests/crew/collab-blocking.test.ts`. Depends on T9.

## Phase 4: D5 — Absolute poll timeout

- [x] **T11: Add pollTimeoutMs to PollOptions and config** — Add to `PollOptions` interface. Read from `crewConfig.collaboration.pollTimeoutMs` in both executeSend (handlers.ts) and executeSpawn (collab.ts) with same validation pattern as `stallThresholdMs`. Default 300_000 (5 min). Minimum: MIN_STALL_THRESHOLD_MS.
- [x] **T12: Implement poll timeout check** — In poll loop, after inbox check and before/after log-stall check: if `now - startTime >= resolvedPollTimeoutMs`, resolve with `{ error: "stalled", stallType: "timeout", stallDurationMs }`. Add `stallType: "log"` to existing log-stall resolve. Depends on T8, T11.
- [x] **T13: Tests for D5** — Test: timeout fires at threshold despite log growth. Test: timeout is configurable. Test: stallType is "timeout" for poll timeout, "log" for log stall. Depends on T12.

## Phase 5: D2 — Driver terminal send (non-blocking path)

- [x] **T14: Implement D2 non-blocking path in executeSend** — In collaborator send path: (0) call `findCollaboratorByName(recipient)` — if live entry exists, proceed to D2/D4/poll; (1) if no live entry → call `validateTargetAgent(recipient, dirs)` — if live mesh agent exists, fall through to non-collaborator send path; (2) if no live mesh agent AND `state.completedCollaborators.has(recipient)` → return conversationComplete without delivery (triple-gate dead-collaborator fallback); (2) if `phase === "complete"` OR `collabEntry.peerTerminal === true` → deliver message via `sendMessageToAgent(... phase)` (best-effort), add to `state.completedCollaborators`, sync `unregisterWorker`, fire-and-forget `gracefulDismiss(...).catch(() => {})`, log dismiss feed event, return with `{ conversationComplete: true, dismissed: recipient }`. Depends on T3b, T6, T9.
- [x] **T15: Handle peerComplete on poll success** — In executeSend, after poll returns successfully: if `pollResult.peerComplete === true`, add to `state.completedCollaborators`, sync unregister + fire-and-forget dismiss + return with `conversationComplete: true`. Depends on T3b, T9, T14 (same patterns).
- [x] **T16: Tests for D2 + D4** — Test: send with `phase: "complete"` returns immediately (non-blocking). Test: collaborator dismissed after `phase: "complete"` send. Test: D4 — receive `phase: "complete"`, next send auto-terminates. Test: D4-after-death — completedCollaborators set returns conversationComplete (not not_found). Test: backward compat — send without phase blocks as before. Test: D2 feed event logged after terminal send (verify logFeedEvent called). Test: spawn clears stale completedCollaborators entry for reused name. Depends on T14, T15, T17.

## Phase 6: Spawn propagation

- [x] **T17: Auto-dismiss one-shot collaborators in executeSpawn + name-collision guard** — Add name-collision avoidance loop (up to 5 retries of `generateMemorableName()` if name collides with a live collaborator via `findCollaboratorByName` OR any live mesh agent via `validateTargetAgent`). Clear `state.completedCollaborators` for the chosen name. After spawn poll success, if `pollResult.peerComplete`: add to `completedCollaborators`, sync unregister, fire-and-forget dismiss, return completion text without follow-up instructions. Otherwise: existing spawn success path. Add test: spawn retries when generated name matches a live non-collaborator mesh agent. Depends on T3b, T9.
- [x] **T18: Test for spawn with phase:"complete"** — Test: spawn result includes `conversationComplete: true` when first message has `phase: "complete"`. Depends on T17.

## Phase 7: Collaborator Prompt + Documentation

- [x] **T19: Update crew/agents/crew-challenger.md** — **Mandatory.** Update Phase 4 (Signal) section to instruct collaborator to pass structured `phase` parameter on sends: `phase: "approved"` when approving, `phase: "complete"` when done. Keep text markers for readability. Without this, D2/D4 never fire for the built-in collaborator.
- [x] **T20: Update external docs (agent-config repo)** — `~/.agent-config/docs/agent-collaboration.md`: add phase values table, document `phase` parameter on `send`, update examples. `~/.agent-config/commands/{shape,plan,implement}.md`: reference structured `phase` parameter alongside text markers. Note: these are in the agent-config repo, not pi-messenger.
