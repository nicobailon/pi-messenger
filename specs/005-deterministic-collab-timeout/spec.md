<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.3-codex | date: 2026-03-12 -->
<!-- Status: UNCHANGED -->
<!-- Revisions: none -->
---
title: "Deterministic Collaborator Timeout"
date: 2026-03-12
bead: pi-messenger-2f7
shaping: specs/005-deterministic-collab-timeout/shaping.md
---

# 005 — Deterministic Collaborator Timeout

## Problem

Spec 004 (Blocking Collaborator Exchange) replaced the ambiguous "wait and hope the LLM doesn't proceed solo" pattern with blocking tool calls. The core design principle, stated in the shaping, was:

> **Outcome**: Collaborator exchanges are deterministic — each tool call returns the information the agent needs. No ambiguous waiting states exist in the protocol.

The implementation delivers on this for three exit conditions: message received, crash detected, and user cancellation. Each fires because **an observable event occurred**.

But it also added hardcoded wall-clock timeouts — `SPAWN_FIRST_MESSAGE_TIMEOUT_MS = 600_000` (10 min) and `SEND_REPLY_TIMEOUT_MS = 300_000` (5 min). These fire because **nothing happened fast enough according to an arbitrary guess**. This contradicts the deterministic design principle:

- A collaborator actively working (log growing at 1.5MB in 3 minutes) gets killed at the 10-minute mark.
- The spawning agent receives `error: "timeout"` with guidance to retry — producing the same premature dismissal that spec 004 was designed to eliminate.
- The retry often spawns a new collaborator that does the same work again, doubling compute waste.

**Observed failure**: During `/plan` on spec 005, challenger "ZenCastle" (crew-challenger, claude-sonnet-4-6) was actively processing — 10 minutes of log output — and got killed by the fixed timeout. The retry ("IronCastle") was at 180s with 1.5MB of log data when observed. The collaborator was doing exactly what it should — reading files, analyzing, formulating challenges. The timeout punished thoroughness.

## Root Cause

The three deterministic exit conditions (response, crash, cancel) already cover every real failure mode. The fixed timeout was added as a "safety valve" against indefinite hangs, but it catches the wrong case. A collaborator that is alive (`proc.exitCode === null`) and producing output (log file growing) is **not stuck** — it's working. Killing it based on elapsed wall-clock time is a heuristic, not a deterministic signal.

The actual stuck case — collaborator alive but making zero progress — needs a different signal: **stall detection based on absence of observable work**, not elapsed time since spawn.

## Solution

Replace the fixed wall-clock timeout with progress-aware stall detection. The poll loop already tracks log file size delta for progress reporting. Use the same signal for stall detection: if the log file hasn't grown for a sustained period, the collaborator is genuinely stuck.

### Deterministic exit conditions (complete set)

| Condition | Signal | Action |
|-----------|--------|--------|
| Message received | File appears in inbox matching collaborator | Return success with message content |
| Crash | `proc.exitCode !== null` | Return error with log tail |
| User cancellation | `signal.aborted` | Clean up and return cancelled |
| Stall | Log file unchanged for `stallThresholdMs` | Return error: stalled, with log tail |

All four are deterministic — each fires because of an **observable state change** (or sustained absence of change), not an arbitrary clock.

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | No fixed wall-clock timeout — collaborator is never killed while actively producing output |
| R2 | Stall detection: if log file size is unchanged for a configurable threshold, return stall error |
| R3 | Stall error includes log tail and actionable guidance (same quality as crash error) |
| R4 | Progress updates continue to show elapsed time + log delta (unchanged from spec 004) |
| R5 | Stall threshold is configurable via crew config (reasonable default — e.g., 120s of zero log growth) |
| R6 | `pollForCollaboratorMessage` signature change: replace `timeoutMs` with stall-based options |
| R7 | Tests updated: timeout tests become stall-detection tests; test injection via options, not timeout constants |
| R8 | No change to the three existing deterministic exits (message, crash, cancel) |

## Acceptance Criteria

### AC1: Fixed timeouts removed
- `SPAWN_FIRST_MESSAGE_TIMEOUT_MS` and `SEND_REPLY_TIMEOUT_MS` constants removed
- `timeoutMs` parameter removed from `PollOptions` interface
- Wall-clock timeout check removed from poll loop
- `error: "timeout"` type removed from `PollResult`

### AC2: Stall detection added
- Poll loop tracks last log file size change timestamp (`lastLogChangeTime`)
- If `Date.now() - lastLogChangeTime >= stallThresholdMs` AND log file exists AND `proc.exitCode === null`: resolve with `error: "stalled"`
- If no log file exists (edge case): fall back to process health only (crash/cancel exits still work; no stall detection possible without log evidence)
- `PollResult` error union becomes `"crashed" | "cancelled" | "stalled"`

### AC3: Stall error quality
- Error result includes `logTail` (last 2KB of log file, same as crash path)
- Error message says the collaborator appears stalled (no output for N seconds), includes actionable guidance: retry, dismiss, or escalate to user
- Does NOT auto-dismiss the collaborator on stall — lets the spawning agent (or error guidance) decide

### AC4: Configurable stall threshold
- `stallThresholdMs` in `PollOptions` with a reasonable default (120_000 = 2 minutes of silence)
- Overridable in crew config: `crew.collaboration.stallThresholdMs` or equivalent
- Injected by tests for fast test execution

### AC5: PollOptions interface updated
- `timeoutMs: number` replaced with `stallThresholdMs?: number` (optional, default 120s)
- All call sites updated: `executeSpawn`, `executeSend` (in handlers.ts), test suite

### AC6: Tests updated
- Existing "resolves with timeout when no message arrives" tests → "resolves with stalled when log stops growing"
- New test: collaborator with growing log is NOT stalled (active work continues indefinitely)
- New test: collaborator with static log for > stallThresholdMs resolves as stalled
- New test: collaborator with no log file — stall detection skipped, only crash/cancel exits apply

### AC7: Error message updated
- Spawn timeout message updated: no "did not send within Ns" phrasing
- Replaced with stall-specific language: "Collaborator appears stalled — no output for Ns"
- Send timeout message updated similarly
- Guidance still says do NOT proceed solo

## Scope

**In scope:**
- `pollForCollaboratorMessage` in `crew/handlers/collab.ts`
- `executeSpawn` in `crew/handlers/collab.ts`
- `executeSend` blocking path in `handlers.ts`
- `PollOptions` and `PollResult` type definitions
- Test suite `tests/crew/collab-blocking.test.ts`
- Timeout-related constants and exports

**Out of scope:**
- `POLL_TIMEOUT_MS` (30s mesh-join timeout) — this is a different concern (process failed to start)
- Crew worker timeouts (different system)
- Non-collaborator send paths
- Agent definitions or workflow commands
