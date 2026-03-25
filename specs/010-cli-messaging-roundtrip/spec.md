---
title: "CLI Messaging Round-Trip for Non-Pi Agents"
date: 2026-03-25
bead: pi-messenger-75c
shaped: true
---

<!-- gate:issue:complete pi/claude-sonnet-4 2026-03-25T10:17:16Z -->
<!-- Codex Review: 5 rounds, max reached | model: gpt-5.3-codex | date: 2026-03-25 -->
<!-- Status: REVISED -->
<!-- Revisions: test count 13→14, leave ambiguity as scope expansion from shaping -->

# 010 — CLI Messaging Round-Trip for Non-Pi Agents

## Problem

The pi-messenger CLI — built explicitly for non-pi agents (Claude Code, Codex, Gemini CLI) to participate in the mesh — fails at the most basic messaging round-trip: send a message, get a reply.

Three compounding failures surfaced during a real Claude Code ↔ pi-extension interaction (2026-03-25):

1. **Identity rotates between commands.** `join --self-model "claude-opus-4-6"` creates a session keyed on `sha256(cwd + "claude-opus-4-6")`. The next `send` (without `--self-model`) auto-detects `"claude-code"` via `ANTHROPIC_API_KEY`, computes a different session key, finds no session, generates a new name. Message arrives from a stranger.

2. **There is no way to receive messages.** The CLI has `send` but no `receive` command. Messages sit in `~/.pi/agent/messenger/inbox/<name>/` unread.

3. **Pre-join and post-join UX gives no guidance.** `status` before `join` returns `You: anonymous` with no hint. `join` doesn't mention how to receive messages.

## Evidence

- Claude Code ran `pi-messenger-cli join --self-model "claude-opus-4-6"` → `Joined mesh as UltraMoon`
- Ran `pi-messenger-cli send --to RedZenith --message "..."` → message arrived from **PureDragon** (not UltraMoon)
- RedZenith replied via `pi_messenger({ action: "send" })` — wrote to PureDragon's inbox
- Neither agent could read the reply — no receive command exists
- RedZenith tried sending to UltraMoon — `Failed to send: UltraMoon (not found)` (overwritten by PureDragon's registration)

## Root Cause Analysis

### Bug 1: Identity rotation

**Location:** `cli/index.ts` — `bootstrapExternal()` (~line 275) and `bootstrap()` (~line 415)

Session key is `sha256(cwd + model)`. `detectModel()` priority: (1) `--self-model` flag, (2) `PI_AGENT_MODEL` env, (3) Codex config, (4) API key env vars, (5) throw. When `--self-model` is provided on `join` but omitted on `send`, step 4 returns a different model string → different key → new session.

### Bug 2: No receive command

**Location:** `cli/index.ts` — `runCommand()` switch. Messages are JSON files in `~/.pi/agent/messenger/inbox/<agentName>/`. The pi extension reads them via `fs.watch()` + `processAllPendingMessages()`. CLI has no equivalent.

### Bug 3: No UX guidance

**Location:** `cli/index.ts` join case (~line 477), `handlers.ts` `executeStatus()` (~line 135).

## Requirements

Shaped with adversarial challenger (SageWolf). See `shaping-transcript.md` for full negotiation.

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | A non-pi agent can complete a full send→receive round-trip using only CLI commands | Core goal |
| R1 | Identity is stable across all CLI commands within a session — no rotation when `--self-model` is omitted after `join` | Must-have |
| R2 | CLI agents can read messages sent to their inbox via a `receive` command | Must-have |
| R3 | Pre-join `status` and `receive` clearly tell the agent to run `join` and how | Must-have |
| R4 | Post-join `join` output tells the agent how to check for messages | Must-have |
| R5 | `send --wait` blocks for reply, filtering by `msg.from === recipient`, leaving other messages untouched, with configurable timeout and clear error on expiration | Must-have |
| R6 | Every requirement has an automated test that catches regression, including timeout/error paths | Must-have |
| R7 | CWD fallback must not enable identity theft when multiple harnesses share a CWD | Must-have |
| R8 | `receive` warns on unparseable messages instead of silently deleting them | Must-have |
| R9 | `receive` output format is specified and consistent for LLM consumption | Must-have |

## Selected Shape: A — CWD Fallback with Ambiguity Guard

Three shapes explored (A, B, C). B and C killed — see shaping transcript for fit check and rationale. Shape A selected with three refinements from challenger review.

### Parts

| Part | Mechanism |
|------|-----------|
| **A1** | **`findSessionByCwd(dirs, cwd)`** — Extracted from `leave`'s CWD scan. Returns: null (0 matches), session (1 match), throws (2+ matches: "Multiple sessions for this CWD — use --self-model"). |
| **A2** | **`bootstrapExternal()` restructured lookup chain:** `detectModel()` in try/catch. If succeeds → exact key → if miss, `findSessionByCwd()`. If throws → `findSessionByCwd()` directly. If all fail: on `join` → error "need --self-model"; on other commands → error "no session, run join first". New sessions only created when `detectModel()` succeeded. **Breaking change:** commands other than `join` no longer auto-create sessions. Agents must explicitly `join` first. This is intentional — auto-create was the root cause of identity rotation. |
| **A3** | **Read-only `bootstrap()` path:** Same chain — `detectModel()` try/catch → exact key → `findSessionByCwd()` → anonymous with guidance. |
| **A4** | **`receive` command:** Read inbox dir. Sort files by timestamp (filename prefix). Print each as `[SenderName YYYY-MM-DDTHH:MM:SSZ] message text`. Delete after printing. Warn+skip malformed (stderr, file NOT deleted). Zero messages → "No new messages." to stdout. When anonymous → guidance. In `NO_REGISTER_COMMANDS`. |
| **A5** | **`send --wait`:** After `executeSend()`, poll inbox for `msg.from === recipient` (matching spawn pattern at line 938). Default 5min timeout, `--timeout <seconds>` override. Non-matching messages untouched. On timeout: "No reply from \<name\> within \<N\>s. Check later with: pi-messenger-cli receive". Known limitation: first `msg.from` match wins, no `replyTo` correlation. |
| **A6** | **UX guidance:** `join` → "To check for messages: pi-messenger-cli receive". `status` anonymous → "Run: pi-messenger-cli join --self-model \<model\>". `receive` anonymous → same. `receive` empty → "No new messages." |
| **A7** | **Rename `READ_ONLY_COMMANDS` → `NO_REGISTER_COMMANDS`** with comment: "Commands that must NOT re-register — prevents PID clobber of long-running processes." |

## Acceptance Criteria

1. **Identity stability:** `join --self-model X` followed by `send` (no `--self-model`) uses the same agent name. Verified by test.
2. **Identity stability (no model detection):** `join --self-model X` followed by command where `detectModel()` throws → CWD fallback finds session → same name. Verified by test.
3. **CWD ambiguity guard:** Two sessions for same CWD with different models → command without `--self-model` → error mentions `--self-model`. Verified by test.
4. **Receive works:** Message written to inbox → `receive` prints it → file deleted. Verified by test.
5. **Receive malformed:** Invalid JSON in inbox → `receive` warns on stderr → file NOT deleted. Verified by test.
6. **Receive empty:** No messages → "No new messages." printed. Verified by test.
7. **Send-wait works:** `send --wait` → reply written during poll → reply printed. Verified by test.
8. **Send-wait timeout:** `send --wait --timeout 1` with no reply → clear error. Verified by test.
9. **Send-wait non-consumption:** Message from Agent C in inbox during wait for Agent B → C's message untouched. Verified by test.
10. **UX guidance present:** `join` mentions `receive`. `status` anonymous mentions `join`. `receive` anonymous mentions `join`. Verified by test.
11. **Full round-trip:** join → inbox write (same format as sendMessageToAgent) → receive reads reply. Send path proven separately by tests 8-10 (send --wait with live process). True two-process CLI-to-CLI deferred pending multi-process test harness. Verified by test.
12. **No regressions:** All existing `cli.test.ts` tests pass.

## Constraints

- `receive` must be in `NO_REGISTER_COMMANDS` — must not re-register and clobber PIDs
- CWD fallback must not break harness isolation — two harnesses with different models in the same CWD still get separate sessions when using `--self-model`
- `send --wait` timeout must be configurable with sane default (5 minutes)
- No daemons, no background processes, no watchers — file-based stateless-process design preserved
- Commands other than `join` no longer auto-create sessions (intentional breaking change)

## Scope

### In scope

- `findSessionByCwd()` extraction and integration into both bootstrap paths
- `receive` command with specified output format, malformed handling, guidance
- `send --wait` with `msg.from` filter, timeout, non-consumption guarantee
- UX guidance in join, status, receive outputs
- Rename `READ_ONLY_COMMANDS` → `NO_REGISTER_COMMANDS`
- 14 test scenarios covering all acceptance criteria (13 original + leave ambiguity from shaping scope expansion)

### Out of scope

- Push/proactive delivery (hooks, piggyback, watchers) — deferred until real-agent testing
- Changes to pi extension message delivery
- MCP server mode
- Crew-spawned worker message paths

## File Impact

| File | Change |
|------|--------|
| `cli/index.ts` | `findSessionByCwd()`, restructured `bootstrapExternal()` and read-only `bootstrap()`, `receive` command, `send --wait`, UX text, rename constant |
| `handlers.ts` | UX guidance in `executeStatus()` for anonymous state |
| `tests/crew/cli.test.ts` | 14 new test scenarios |
