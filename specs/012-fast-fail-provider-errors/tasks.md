---
title: "Tasks: Fast-fail provider errors in collaborator spawn/send"
date: 2026-04-05
bead: pi-messenger-3jf
---

<!-- plan:complete:v1 | harness: pi/gpt-5.3-codex | date: 2026-04-05T23:20:02Z -->
<!-- Codex Review: APPROVED after 3 rounds | model: gpt-5.3-codex | date: 2026-04-05 -->
<!-- Status: REVISED -->
<!-- Revisions: Added send-baseline replay guard tasks, classifier extraction tasks, cleanup-invariant suite, CI-safe bounded-latency assertions, and redaction contract checks -->

# Tasks: 012 — Fast-fail provider errors

Dependency order: **T1 → T2 → T3 → T4 → T5**

## T1 — Extract classifier contract (`crew/utils/provider-classification.ts`)

- [x] Create `crew/utils/provider-classification.ts`
- [x] Move parser/extractor logic into exported functions:
  - [x] `parseProviderTerminalErrorMessage(rawError)`
  - [x] `extractProviderTerminalErrorFromLogLine(line)`
- [x] Add explicit precedence: `error.type` first, `error.code` fallback
- [x] Replace substring class matching with exact normalized matching
- [x] Keep returned shape compatible with existing `ProviderTerminalError` consumers

### Verification
- [x] `rg -n "export function parseProviderTerminalErrorMessage|export function extractProviderTerminalErrorFromLogLine" crew/utils/provider-classification.ts`
- [x] `rg -n "error\.type|error\.code" crew/utils/provider-classification.ts`
- [x] `rg -n "includes\(t\)" crew/utils/provider-classification.ts` returns no class-substring matching

---

## T2 — Add policy table + redaction contract (R8 + security)

- [x] Add normative terminal-classification policy table comment in `crew/utils/provider-classification.ts`
- [x] Include terminal statuses and classes from approved plan
- [x] Include explicit non-terminal exclusions (500/502/503/504/529 + overloaded/server/network)
- [x] Include bounded-latency 429 note (external retry layer)
- [x] Add explicit test linkage note to `tests/crew/provider-classification.test.ts`
- [x] Add redaction helper (`crew/utils/redaction.ts` or local helper) for optional raw/logTail payloads
- [x] Document stable surfaced fields vs debug-only optional payload fields

### Verification
- [x] `rg -n "Terminal classification policy|non-terminal defaults|provider-classification.test.ts" crew/utils/provider-classification.ts`
- [x] `rg -n "redact|sanitiz" crew/utils/redaction.ts crew/handlers/collab.ts handlers.ts`

---

## T3 — Poll/handler wiring updates (`collab.ts` + `handlers.ts`)

- [x] Update `crew/handlers/collab.ts` to consume classifier module
- [x] Add `minLogOffset?: number` to `PollOptions`
- [x] Initialize scanner offset using `providerScanOffset = max(providerScanOffset, minLogOffset)` before first read
- [x] In `handlers.ts` send path:
  - [x] capture `sendBaselineOffset = current log size` immediately before send write
  - [x] pass `minLogOffset: sendBaselineOffset` into `pollForCollaboratorMessage`
- [x] Keep spawn semantics unchanged (`minLogOffset=0` / full scan behavior)
- [x] Keep existing cleanup semantics; only classification precision and replay-guard behavior change

### Verification
- [x] `rg -n "minLogOffset|providerScanOffset|sendBaselineOffset" crew/handlers/collab.ts handlers.ts`
- [x] `rg -n "provider_error" crew/handlers/collab.ts handlers.ts`

---

## T4 — Add classification and replay/latency tests

- [x] Create `tests/crew/provider-classification.test.ts`
  - [x] positive status cases: 401/402/403/429
  - [x] positive class cases from both `error.type` and `error.code`
  - [x] precedence case where both fields exist and differ
  - [x] negative transient cases: 500/503/529/overloaded/network/malformed payload
  - [x] provider/model/request_id extraction checks
- [x] Extend `tests/crew/collab-blocking.test.ts`
  - [x] replay-guard test with preseeded historical terminal line + post-baseline assertion
  - [x] bounded-latency assertion for observable terminal line (`<= max(1000ms, 6 * POLL_INTERVAL_MS)`)
  - [x] provider/model assertions in provider_error paths

### Verification
- [x] `npm test -- tests/crew/provider-classification.test.ts tests/crew/collab-blocking.test.ts`
- [x] `rg -n "401|402|403|429|500|503|529|overloaded|network|error\.code|error\.type" tests/crew/provider-classification.test.ts`

---

## T5 — Cleanup invariants suite

- [x] Create/extend `tests/crew/provider-cleanup-invariants.test.ts`
- [x] Assert stateful invariants after provider_error flows:
  - [x] collaborator not active for exchange
  - [x] completion state set where required
  - [x] registry/worker visibility reflects cleanup outcome
- [x] Cover both send and spawn paths with best available harness strategy despite ESM interception constraints

### Verification
- [x] `npm test -- tests/crew/provider-cleanup-invariants.test.ts tests/crew/collab-blocking.test.ts`
- [x] `rg -n "cleanup|registry|completedCollaborators|provider_error" tests/crew/provider-cleanup-invariants.test.ts tests/crew/collab-blocking.test.ts`

---

## Final checklist

- [x] All targeted suites pass
- [x] No requirement traceability gaps vs `specs/012-fast-fail-provider-errors/spec.md` (R0–R8)
- [x] Guard commands in plan all produce expected signatures
- [x] No behavior changes outside approved scope (classification precision, replay-guard, verification completeness, safe redaction contract)
