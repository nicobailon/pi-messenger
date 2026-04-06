---
title: "Plan: Fast-fail provider errors in collaborator spawn/send"
date: 2026-04-05
bead: pi-messenger-3jf
---

<!-- plan:complete:v1 | harness: pi/gpt-5.3-codex | date: 2026-04-05T23:20:02Z -->
<!-- Codex Review: APPROVED after 3 rounds | model: gpt-5.3-codex | date: 2026-04-05 -->
<!-- Status: REVISED -->
<!-- Revisions: Added send-baseline replay guard via minLogOffset; extracted classifier module; added policy table + exact matching + error.code fallback; expanded cleanup/bounded-latency/provider-model/redaction verification strategy -->

# Plan: 012 — Fast-fail provider errors (Codex-approved)

## Background

Shape A remains selected. Existing implementation already emits/surfaces `provider_error`, but still needs hardened classification contracts and stronger proof coverage.

Codex review rounds focused on closing these gaps:
1) stale-log replay risk,
2) cleanup proof depth,
3) bounded-latency assertions,
4) provider/model assertion coverage,
5) external runtime assumption handling,
6) sensitive payload exposure policy.

## Architecture Decisions

### AD1 — Extract classifier into pure helper module
Create `crew/utils/provider-classification.ts`:
- `parseProviderTerminalErrorMessage(rawError)`
- `extractProviderTerminalErrorFromLogLine(line)`

`crew/handlers/collab.ts` imports this module. This is the single classification contract and primary unit-test target.

### AD2 — Field precedence and exact matching
Classification precedence:
1. `parsed.error.type`
2. `parsed.error.code` (fallback)

If both exist and differ, `type` is canonical and `code` may be retained in debug metadata.
Use exact normalized equality for class matching (no substring matching).

### AD3 — Normative policy table + test linkage
In `crew/utils/provider-classification.ts`, add a code-adjacent policy block:
- Terminal statuses: 401, 402, 403, 429
- Terminal classes: `rate_limit_error`, `insufficient_quota`, `quota_exceeded`, `usage_limit_exceeded`, `authentication_error`, `permission_error`, `billing_error`, `credit_balance_too_low`
- Explicit non-terminal defaults: 500/502/503/504/529 + overloaded/server/network transport classes
- 429 observability note: may appear after upstream retry budget
- Linked test file: `tests/crew/provider-classification.test.ts`

### AD4 — Stale-log replay guard with unambiguous send baseline
Add `minLogOffset?: number` to `PollOptions`.

Behavior:
- **spawn**: `minLogOffset=0` (scan full new collaborator log)
- **send**: capture `sendBaselineOffset = current log size` **immediately before send write** in `executeSend`.
  - ordering in handler: compute baseline → write/send message → call poll with `minLogOffset=sendBaselineOffset`
  - poll scanner initializes `providerScanOffset = max(providerScanOffset, minLogOffset)` before first scan read

This removes ambiguity and closes the race window between send and poll initialization.

### AD5 — Cleanup invariants as stateful tests
For provider_error outcomes, assert invariants in test harness state (not just mocks):
- collaborator no longer active for target exchange,
- completion state set where contract requires,
- registry/worker visibility reflects cleanup outcome.

Where spawn interception is limited by ESM constraints, use stateful store/registry checks and deterministic harness setup.

### AD6 — Bounded-latency test strategy (CI-safe)
R0 validation is measured from terminal-line observability to provider_error result, with deterministic margins:
- controlled fixture appends terminal line at `t0`
- assert resolve time <= `max(1000ms, 6 * POLL_INTERVAL_MS)`
- avoid brittle sub-100ms expectations

This keeps tests stable under CI variance while enforcing “no multi-minute stall after observable terminal signal.”

### AD7 — Redaction compatibility contract
Surface fields contract (stable API):
- always: `error`, `providerError.statusCode`, `providerError.errorType`, `providerError.errorMessage`, `providerError.requestId`, `providerError.provider`, `providerError.model`
- optional debug-only: sanitized `providerError.raw`, sanitized `logTail`

Default behavior: redact token-like substrings (`sk-*`, bearer-like secrets, key-value credential patterns) before optional surfacing.

### AD8 — External dependency boundary
Do not encode Pi-core retry internals as repo-verified truth; treat as external assumption/risk and keep correctness tests anchored to local observability behavior.

## File-Level Implementation Map

| File | Planned change |
|------|----------------|
| `crew/utils/provider-classification.ts` (new) | parser/extractor + policy table + exact matching |
| `crew/handlers/collab.ts` | consume classifier module; support `minLogOffset` in poll scanner init |
| `handlers.ts` | capture `sendBaselineOffset` before send write; pass to poll via `minLogOffset`; preserve cleanup semantics |
| `crew/utils/redaction.ts` (new or local helper) | sanitize raw/log-tail payloads |
| `tests/crew/provider-classification.test.ts` (new) | positive/negative matrix; type-vs-code precedence |
| `tests/crew/collab-blocking.test.ts` | stale-log replay guard test, bounded-latency assertion, provider/model assertions |
| `tests/crew/provider-cleanup-invariants.test.ts` (new or extension) | stateful cleanup invariants for provider_error flows |

## Requirement Traceability

- **R0**: AD4 + AD6 ensure bounded short-circuit once terminal output is observable.
- **R1**: AD2 + AD7 plus assertions for provider/model/status/type/message/request_id.
- **R2**: terminal classification bypasses stall wait loops after detection.
- **R3**: AD5 stateful cleanup invariants.
- **R4**: AD2/AD3 explicit boundaries + negative transient tests.
- **R5**: same classifier + same poll mechanism for spawn/send; send adds explicit baseline safety.
- **R6**: assert `provider_error` labeling in terminal cases.
- **R7**: dedicated parser matrix + blocking flow integration + cleanup invariant tests.
- **R8**: normative policy table with direct test linkage.

## Verification Strategy

### Tests
- `npm test -- tests/crew/provider-classification.test.ts tests/crew/collab-blocking.test.ts tests/crew/provider-cleanup-invariants.test.ts`

### Guard checks
- `rg -n "minLogOffset|sendBaselineOffset" crew/handlers/collab.ts handlers.ts`
- `rg -n "error\.type|error\.code" crew/utils/provider-classification.ts`
- `rg -n "includes\(t\)" crew/utils/provider-classification.ts crew/handlers/collab.ts` (no class-substring matcher)
- `rg -n "request_id|provider|model" tests/crew/provider-classification.test.ts tests/crew/collab-blocking.test.ts`
- `rg -n "401|402|403|429|500|503|529|overloaded|network" tests/crew/provider-classification.test.ts`

### Replay-guard proof case
- preseed collaborator log with historical 429 line
- compute send baseline offset before new send
- append fresh non-terminal/terminal lines after send
- assert historical line is ignored and only post-baseline lines affect result

## Risks and Mitigations

1. Baseline capture ordering regressions
   - Mitigation: explicit send-order step + dedicated replay-guard test.
2. Over-redaction reducing operability
   - Mitigation: stable structured fields remain unredacted; only sensitive substrings redacted in optional raw/logTail.
3. CI timing variance
   - Mitigation: bounded assertion uses interval-scaled threshold, not brittle micro-timings.

## Out of Scope
- Pi-core retry engine changes.
- Automatic account switching/failover.
- Provider quota orchestration across accounts.
