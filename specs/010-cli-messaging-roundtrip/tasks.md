---
title: "CLI Messaging Round-Trip — Tasks"
date: 2026-03-25
bead: pi-messenger-75c
---

<!-- tasks:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T10:44:51Z -->
<!-- Codex Review: APPROVED after 3 rounds (session 2) | model: gpt-5.3-codex | date: 2026-03-25 -->
<!-- Status: RECONCILED -->
<!-- Revisions: CWD fallback disabled for explicit --self-model, read-only ambiguity errors, shape validation in readInboxMessages, action threading explicit, R0 AC narrowed -->

# 010 — Tasks

## Dependencies

```
Task 1 → Task 2 → Task 3
Task 1 → Task 4
Task 5 (independent — do first)
Task 6 → depends on Task 5
Task 7 (independent of receive)
Task 8 → depends on Tasks 6, 7
Task 9 → depends on all
```

## Tasks

- [x] **Task 1: Extract `findSessionByCwd()`**
  - Extract CWD-scan logic from `leave` into standalone function
  - Validate `name/model/cwd/startedAt` fields (same as `readCliSession` line 231)
  - Returns: null (0 matches), session (1 match), throws (2+ matches)
  - Insert after `writeCliSession()` (~line 260)
  - File: `cli/index.ts`

- [x] **Task 2: Restructure `bootstrapExternal()`**
  - Add `action?: string` parameter
  - Wrap `detectModel()` in try/catch with CWD fallback on both miss and throw
  - **Critical:** CWD fallback → `resolvedModel = session.model` (NOT detectModel result)
  - **Critical (R7):** CWD fallback DISABLED when `--self-model` explicit (`!!modelFlag`)
  - **Join-only session creation:** Only `action === "join"` creates new sessions
  - Non-join commands with no session → error "No active session. Run join first"
  - **Action threading:** `bootstrap()` passes `cmd.action` → `bootstrapExternal()` 4th param
  - File: `cli/index.ts` (lines 275-318)

- [x] **Task 3: Update read-only `bootstrap()` path**
  - Same chain with explicit-model guard: exact key → CWD fallback (only if no --self-model) → anonymous
  - Model from CWD-fallback session propagated to `sessionModel`
  - **Ambiguity (2+ matches) → error with guidance** (consistent with registering/leave paths)
  - File: `cli/index.ts` (lines 441-456)

- [ ] **Task 4: Refactor `leave` to use `findSessionByCwd()`**
  - Same three-step chain for both success-but-miss AND throw paths
  - Ambiguity error: print guidance, set exitCode, break
  - File: `cli/index.ts` (lines 609-695)

- [x] **Task 5: Rename `READ_ONLY_COMMANDS` → `NO_REGISTER_COMMANDS`**
  - Rename constant and all references, update comment
  - Add `"receive"` to the set
  - File: `cli/index.ts` (line 411-416, line 479)

- [ ] **Task 6: Extract `readInboxMessages()` + Add `receive` command**
  - Extract shared `readInboxMessages(inboxDir)` returning `{ messages, malformed }` with `isValidInboxMessage()` shape validation (from/text/timestamp)
  - `receive` command: anonymous → guidance, empty → "No new messages.", print format `[Sender Timestamp] text`, delete after print, warn+skip malformed
  - File: `cli/index.ts` (~line 533)

- [ ] **Task 7: Add `send --wait` with double-wait guard**
  - **Double-wait guard:** Skip poll if `details.reply || details.conversationComplete`
  - Parse `--wait` flag, `--timeout` with fail-fast validation (NaN/≤0 → error)
  - Poll using `readInboxMessages()`, match `msg.from === to`
  - `failedFiles` Set for malformed, race-safe `unlinkSync`
  - Timeout → clear error with `receive` hint
  - File: `cli/index.ts` (~lines 510-518)

- [ ] **Task 8: UX guidance text**
  - `join` output: append "To check for messages: pi-messenger-cli receive"
  - `executeStatus()`: if agentName === "anonymous", append join guidance
  - `printHelp()`: add `receive`, `--wait`, `--timeout`
  - Files: `cli/index.ts` (lines 498, 1048), `handlers.ts` (~line 170)

- [ ] **Task 9: Tests — 14 scenarios**
  - Add `runCliAsync()` helper using `child_process.spawn`
  - 14 test scenarios:
    1. Identity stable: join → send (no --self-model) → same name
    2. Identity stable: join → detectModel throw → CWD fallback → same name
    3. CWD ambiguity: two sessions same CWD → error
    4. Receive reads inbox → prints → deletes
    5. Receive malformed → stderr warning, file preserved
    6. Receive before join → guidance
    7. Receive empty → "No new messages."
    8. Send --wait gets reply (runCliAsync)
    9. Send --wait timeout --timeout 1 (runCliAsync)
    10. Send --wait non-consumption (runCliAsync)
    11. UX: join mentions receive
    12. UX: status anonymous mentions join
    13. Full round-trip: join → send → receive
    14. Leave ambiguity: two sessions → error
  - File: `tests/crew/cli.test.ts`

- [ ] **Task 10: Verify no regressions**
  - Run `npx vitest run` — all tests pass
