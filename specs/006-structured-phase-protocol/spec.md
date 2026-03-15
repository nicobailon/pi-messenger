<!-- Codex Review: 5 rounds, max reached | model: gpt-5.3-codex | date: 2026-03-15 -->
<!-- Status: REVISED -->
<!-- Revisions: R2 clarified as best-effort delivery, D5 renamed to pollTimeoutMs, crew-challenger.md added to scope -->
---
title: "Structured phase protocol — deterministic collaboration termination"
date: 2026-03-15
bead: pi-messenger-3t0
---

# Structured Phase Protocol

## Problem

When a driver agent sends a final message to a spawned collaborator via `pi_messenger({ action: "send" })`, the `send` action blocks waiting for a reply (via `pollForCollaboratorMessage`). If the collaborator has already finished and never replies, the driver hangs indefinitely.

**Observed failure (2026-03-15):** PureYak sent `[COMPLETE]` to YoungYak after receiving `[PHASE:agree]`. The send blocked for 19 minutes. YoungYak was done and never replied. Stall detection (2-minute threshold based on log file growth) never fired because YoungYak's pi process kept writing ~534 bytes of heartbeat/status output to its log — enough to periodically reset the stall timer.

**Two root causes:**
1. **Protocol:** No structured termination signal. The driver's only options are `send` (blocks) or `dismiss` (no final message). Agents are documented to dismiss after receiving agree, but prompt compliance cannot be trusted — agents skip protocol under momentum.
2. **Stall detection:** Based solely on log file growth, not message activity. A slow log drip (heartbeats, status) prevents stall from ever firing even when the collaborator has stopped responding.

## Selected Shape: D (from shaping session)

Structured phase field with layered auto-terminate. Three enforcement layers, each progressively less trusting of agent compliance.

## Requirements

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | The driver agent never blocks indefinitely after the conversation is logically complete | Core goal |
| R1 | The collaborator's "I'm done" signal terminates the blocking poll deterministically | Must-have |
| R2 | The driver can send a final acknowledgment without re-entering a blocking wait (best-effort delivery — message file persists in inbox/feed, but collaborator may exit before consuming it) | Must-have |
| R3 | Stall detection works even when the collaborator's log has slow growth (heartbeat bytes) | Must-have |
| R4 | The protocol is enforceable by the system, not just by prompt compliance | Must-have |
| R6 | Backward compatible — existing agents that don't use new features still work | Must-have |
| R7 | The termination signal must be structured metadata, not parsed from natural language | Must-have |

## Shape D Parts

| Part | Mechanism |
|------|-----------|
| **D1** | Add `phase?: "review" \| "challenge" \| "revise" \| "approved" \| "complete"` parameter to `send` action |
| **D2** | When driver sends with `phase: "complete"` to a collaborator → deliver message non-blocking (skip `pollForCollaboratorMessage`), then auto-call `gracefulDismiss` |
| **D3** | Store `phase` in `AgentMailMessage` so the receiving agent sees the structured field |
| **D4** | When the poll receives a message with `phase: "complete"` from the collaborator, set `entry.peerTerminal = true`. The driver's next send auto-terminates (non-blocking + auto-dismiss) regardless of whether the driver passes a phase |
| **D5** | Fix stall detection: add `pollTimeoutMs` — absolute wall-clock timeout from poll start, independent of log file growth. Default 5 minutes. Fires even when the collaborator's log has slow growth (heartbeat bytes). This is a timeout, not an activity-based stall — it never resets. |

### Phase Values

| Phase value | Meaning | Terminal? |
|-------------|---------|-----------|
| `review` | I've assessed the material | No |
| `challenge` | I disagree / have concerns | No |
| `revise` | Updated approach addressing concerns | No |
| `approved` | The proposal passes scrutiny (verdict, not filler) | No |
| `complete` | I'm done. No more messages from me. | **Yes** |

Only `complete` is terminal. `approved` is a deliberate verdict (heavier than "agree") but does not end the conversation — the driver may still have follow-up.

### Enforcement Layers

1. **Layer 1 (D2) — Agent cooperates:** Driver passes `phase: "complete"` → system auto-terminates immediately.
2. **Layer 2 (D4) — Agent doesn't cooperate:** Driver sends without phase after collaborator sent `phase: "complete"` → system catches it, auto-terminates anyway.
3. **Layer 3 (D5) — Both fail:** Absolute poll timeout (5 min wall-clock from poll start) fires regardless of log growth.

### Fit Check

| Req | Requirement | D |
|-----|-------------|---|
| R0 | Driver never blocks indefinitely | ✅ |
| R1 | Collaborator done signal terminates poll | ✅ |
| R2 | Driver can send final ack without blocking | ✅ |
| R3 | Stall detection works despite log growth | ✅ |
| R4 | System-enforceable, not prompt-dependent | ✅ |
| R6 | Backward compatible | ✅ |
| R7 | Structured metadata, not text parsing | ✅ |

## Scope

### In scope

- `phase` parameter on `send` action (D1)
- Non-blocking send + auto-dismiss for terminal phases (D2)
- `phase` field on `AgentMailMessage` (D3)
- `peerTerminal` tracking on `CollaboratorEntry` (D4)
- Message-based stall threshold in `pollForCollaboratorMessage` (D5)
- Tool parameter schema update in `index.ts`
- Update `crew/agents/crew-challenger.md` to emit structured `phase` parameter on sends (mandatory — without this, D2/D4 never fire for the built-in collaborator)
- Doc updates in `~/.agent-config/docs/agent-collaboration.md` (external repo) — phase table and send examples
- Doc updates to workflow commands in `~/.agent-config/commands/` (external repo) — reference structured `phase` parameter

### Out of scope

- Changing the spawn protocol (works fine)
- Changing dismiss behavior (already non-blocking)
- Removing text-based `[PHASE:*]` markers from agent messages (backward compat — agents can use both)
- Conversation state machine / round counting (Shape E, rejected)
- Bidirectional convergence tracking (Shape F, rejected — fragile)

## Files Changed

| File | Changes | Est. lines |
|------|---------|------------|
| `lib.ts` | Add `phase?: string` to `AgentMailMessage` | ~1 |
| `crew/types.ts` | Add `phase?: string` to `CrewParams` | ~1 |
| `crew/registry.ts` | Add `peerTerminal?: boolean` to `CollaboratorEntry` | ~1 |
| `store.ts` | Add `phase` param to `sendMessageToAgent`, write into message object | ~3 |
| `crew/index.ts` | Pass `params.phase` to `executeSend` | ~1 |
| `handlers.ts` | Add `phase` param to `executeSend`. Before blocking poll: check D2 + D4 → non-blocking path | ~25 |
| `crew/handlers/collab.ts` | Read `msg.phase`, set `peerTerminal`. Add poll timeout tracking | ~20 |
| `index.ts` | Add `phase` to tool parameter schema | ~3 |
| `crew/agents/crew-challenger.md` | Update phase signal instructions to use structured `phase` parameter on sends | ~10 |
| **Total** | | **~65 lines code + docs** |

## Acceptance Criteria

- [ ] `pi_messenger({ action: "send", to: "X", message: "...", phase: "complete" })` delivers message and returns immediately without blocking
- [ ] Collaborator is auto-dismissed after a `phase: "complete"` send
- [ ] After receiving `phase: "complete"` from collaborator, driver's next send (with or without phase) auto-terminates
- [ ] Stall detection fires within 5 minutes even when collaborator log is growing
- [ ] Existing agents that don't pass `phase` work exactly as before (blocking send, existing stall detection)
- [ ] `AgentMailMessage` JSON includes `phase` field when set
- [ ] Tests cover: D2 path, D4 path, D5 message-based stall, backward compat (no phase)
