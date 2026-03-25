---
shaping: true
---

<!-- shape:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T10:31:54Z -->

# 010 — CLI Messaging Round-Trip: Shaping Transcript

**Participants:** PureStorm (pi/claude-opus-4-6, proposer) × SageWolf (crew-challenger, pi/claude-opus-4-6)
**Date:** 2026-03-25
**Rounds:** 3 (challenge → revise → challenge → revise → approved → complete)

---

## Frame

### Problem

The pi-messenger CLI — built for non-pi agents (Claude Code, Codex, Gemini CLI) — fails at the most basic messaging round-trip: send a message, get a reply. Three compounding failures:

1. **Identity rotates between commands.** Session keyed on `sha256(cwd + model)`. `join --self-model "claude-opus-4-6"` and subsequent `send` (auto-detects `"claude-code"`) produce different keys → different identity.
2. **No receive command.** Messages sit in inbox with no way to read them.
3. **No UX guidance.** Anonymous status with no hint to join; join output with no hint to receive.

### Evidence

Real Claude Code ↔ pi-extension interaction (2026-03-25): Agent joined as UltraMoon, sent message as PureDragon, recipient couldn't reply to either name, neither could read replies.

---

## Requirements (R)

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

### Requirement Evolution

- R0-R6 proposed by PureStorm in initial requirements
- R7 added after SageWolf's Concern 1 (CWD fallback identity theft — the `readdirSync` scan picks nondeterministically when multiple sessions match CWD)
- R8 added after SageWolf's Concern 3 (`processAllPendingMessages` deletes on failure, but CLI `receive` is one-shot with no retry loop)
- R9 added after SageWolf's round 2 challenge (LLM consumers need specified output format)

---

## Shapes Explored

### Shape A: CWD Fallback with Ambiguity Guard

Session key stays `sha256(cwd + model)`. When exact key misses, scan session files by CWD. If exactly 1 match: use it. If 2+ matches: error requiring `--self-model`.

**Outcome:** Selected (revised with three refinements from SageWolf's challenges).

### Shape B: CWD-Only Session Key

Replace session key with `sha256(cwd)`. One session per CWD, model stored inside.

**Outcome:** Killed. SageWolf identified ntm (Named Tmux Manager) as a real scenario where Claude Code and Codex run in side-by-side tmux panes pointed at the same repo. Both use pi-messenger-cli. Shape B makes them share one identity.

### Shape C: CWD Pointer File

Keep model-keyed sessions. On `join`, also write a `sha256(cwd)` pointer file that maps to the session key. Last writer wins.

**Outcome:** Killed by proposer. "Last writer wins" = deterministic identity theft. Same bug, different source of nondeterminism.

---

## Fit Check: R × Shapes

| Req | Requirement | A | B | C |
|-----|-------------|---|---|---|
| R0 | Full send→receive round-trip via CLI | ✅ | ✅ | ✅ |
| R1 | Identity stable across commands without --self-model | ✅ | ✅ | ✅ |
| R2 | `receive` command reads inbox messages | ✅ | ✅ | ✅ |
| R3 | Pre-join status/receive shows guidance | ✅ | ✅ | ✅ |
| R4 | join output mentions receive | ✅ | ✅ | ✅ |
| R5 | `send --wait` with msg.from filter, timeout, clear error | ✅ | ✅ | ✅ |
| R6 | Automated tests for all requirements | ✅ | ✅ | ✅ |
| R7 | CWD fallback doesn't enable identity theft | ✅ | ❌ | ❌ |
| R8 | `receive` warns on unparseable, doesn't silently delete | ✅ | ✅ | ✅ |
| R9 | `receive` output format specified | ✅ | ✅ | ✅ |

**Notes:**
- B fails R7: two harnesses in same CWD share one session → identity collision (ntm scenario)
- C fails R7: pointer file "last writer wins" → second harness overwrites first's pointer → identity theft

---

## Selected Shape: A (revised)

### Parts

| Part | Mechanism |
|------|-----------|
| **A1** | **`findSessionByCwd(dirs, cwd)`** — Extracted from `leave`'s CWD scan. Returns: null (0 matches), session (1 match), throws (2+ matches: "Multiple sessions for this CWD — use --self-model"). |
| **A2** | **`bootstrapExternal()` restructured lookup chain:** `detectModel()` in try/catch. If succeeds → exact key → if miss, `findSessionByCwd()`. If throws → `findSessionByCwd()` directly. If all fail: on `join` → error "need --self-model"; on other commands → error "no session, run join first". New sessions only created when `detectModel()` succeeded. **Breaking change:** commands other than `join` no longer auto-create sessions. Agents must explicitly `join` first. This is intentional — auto-create was the root cause of identity rotation. |
| **A3** | **Read-only `bootstrap()` path:** Same chain — `detectModel()` try/catch → exact key → `findSessionByCwd()` → anonymous with guidance. |
| **A4** | **`receive` command:** Read inbox dir. Sort files by timestamp (filename prefix). Print each as `[SenderName YYYY-MM-DDTHH:MM:SSZ] message text`. Delete after printing. Warn+skip malformed (stderr, file NOT deleted). Zero messages → "No new messages." to stdout. When anonymous → guidance. In `NO_REGISTER_COMMANDS`. |
| **A5** | **`send --wait`:** After `executeSend()`, poll inbox for `msg.from === recipient` (matching spawn pattern). Default 5min timeout, `--timeout <seconds>` override. Non-matching messages untouched. On timeout: "No reply from <name> within <N>s. Check later with: pi-messenger-cli receive". Known limitation: first `msg.from` match wins, no `replyTo` correlation. |
| **A6** | **UX guidance:** `join` → "To check for messages: pi-messenger-cli receive". `status` anonymous → "Run: pi-messenger-cli join --self-model <model>". `receive` anonymous → same. `receive` empty → "No new messages." |
| **A7** | **Rename `READ_ONLY_COMMANDS` → `NO_REGISTER_COMMANDS`** with comment: "Commands that must NOT re-register — prevents PID clobber of long-running processes." |

### Tests Required

1. Identity stability: `join --self-model X` → `send` (no --self-model, different detectModel) → same name
2. Identity stability (detectModel throws): `join --self-model X` → command with no detectable model → CWD fallback → same name
3. CWD ambiguity guard: two sessions for same CWD, different models → command without --self-model → error mentions --self-model
4. Receive reads inbox: write message → `receive` → prints message → file deleted
5. Receive warns on malformed: invalid JSON → `receive` → stderr warning, file NOT deleted
6. Receive before join: no session → prints guidance
7. Receive empty inbox: session exists, inbox empty → "No new messages."
8. Send --wait gets reply: `send --wait` → write reply during poll → reply printed
9. Send --wait timeout: `send --wait --timeout 1` with no reply → timeout error
10. Send --wait leaves other messages: msg from C in inbox → waiting for B → C's message still there after timeout
11. UX: join mentions receive
12. UX: status anonymous mentions join
13. Full round-trip: join → send (write to recipient inbox) → reply written to sender inbox → receive reads reply

---

## Challenger's Concerns and Resolutions

### Round 1 (SageWolf → PureStorm)

| # | Concern | Severity | Resolution |
|---|---------|----------|------------|
| 1 | CWD fallback identity theft: `readdirSync` scan nondeterministic with multiple sessions | 🔴 Blocker | Added R7, Shape A's ambiguity guard (2+ matches → error) |
| 2 | `send --wait` filtering underspecified | 🔴 Blocker | R5 revised: `msg.from === recipient`, non-matching untouched, only match deleted |
| 3 | `receive` silently deleting on parse failure | 🟡 | Added R8: warn+skip malformed |
| 4 | `receive` before join — no guidance | 🟡 | R3 expanded to include `receive` |
| 5 | No test for `send --wait` timeout path | 🟡 | Test 9 added |
| 6 | `READ_ONLY_COMMANDS` misnomer | 🟡 | A7: rename to `NO_REGISTER_COMMANDS` |

### Round 2 (SageWolf → PureStorm)

| # | Concern | Severity | Resolution |
|---|---------|----------|------------|
| 7 | CWD fallback doesn't fire when `detectModel()` throws (process.exit) | Refinement | A2 restructured: try/catch around `detectModel()`, CWD fallback on throw |
| 8 | `send --wait` message ID plumbing missing for replyTo filter | Refinement | Accepted: use `msg.from` only (matches spawn pattern), documented as known limitation |
| 9 | `receive` output format unspecified | Refinement | A4 specifies `[SenderName timestamp] text` format, R9 added |

### Round 3 (SageWolf → PureStorm, approval)

| # | Note | Severity | Resolution |
|---|------|----------|------------|
| 10 | Breaking change: commands other than `join` no longer auto-create sessions | Documentation | A2 documents this explicitly with rationale |
| 11 | `receive` with zero messages should print confirmation | Documentation | A4 adds "No new messages." output |
