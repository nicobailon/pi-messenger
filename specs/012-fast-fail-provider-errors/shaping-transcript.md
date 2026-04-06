---
shaping: true
title: "Shaping Transcript — spec 012 fast-fail provider errors"
date: 2026-04-05
bead: pi-messenger-3jf
participants:
  - BrightWolf (pi/gpt-5.3-codex)
  - SageNova (crew-challenger)
---

<!-- shape:complete:v1 | harness: pi/gpt-5.3-codex | date: 2026-04-05T14:29:25Z -->

## Session Setup
- Spec in scope: `specs/012-fast-fail-provider-errors/spec.md`
- Code examined:
  - `crew/handlers/collab.ts`
  - `handlers.ts`
  - `tests/crew/collab-blocking.test.ts`
- Protocol followed: `docs/agent-collaboration.md` Mode 1 (spawn fresh collaborator)

## Round 1 — Adversarial challenge from collaborator
SageNova produced:
1. R-set draft (R0..R8) emphasizing terminal fast-fail semantics, cleanup, and classification policy.
2. Multiple shapes:
   - **A** Inline log scanning in poll loop
   - **B** Process-exit + sentinel contract (Pi core change)
   - **C** Heartbeat-channel error protocol
3. Failure modes per shape.
4. Concrete verifications (grep/count/file checks), including:
   - `TERMINAL_PROVIDER_STATUS_CODES = [401, 402, 403, 429]` exists in `collab.ts`
   - Provider-error tests are currently sparse relative to total test volume
   - Negative tests for 5xx/transient misclassification were missing

## Round 2 — Driver revision, collaborator re-challenge
Driver proposed refined requirements and 4-shape space (A/B/C/D), with expected selection:
- **Selected direction candidate:** Shape A + hardening constraints
  - explicit terminal policy table
  - parser fallback for `error.code` in addition to `error.type`
  - positive/negative test matrix

SageNova response: **Conditionally approved** with one critical risk:
- Pi core retries some provider errors (notably 429/rate-limit), so detection in pi-messenger has bounded latency floor instead of literal immediate failure.
- Verification provided:
  - `settings-manager.js` defaults: `maxRetries=3`, `baseDelayMs=2000`
  - `agent-session.js` retryable regex includes `rate_limit|429|500|502|503|504|overloaded...`

Conclusion from challenge:
- R0 wording must be bounded and realistic: immediate after propagation to collab log stream, not immediate at first upstream failure event inside Pi core.
- Classification policy table must explicitly document this retry-layer interaction.

## Round 3 — Completion signal
Driver sent `[COMPLETE]` with `phase: "complete"`.
Tool result: conversation complete, collaborator auto-dismissed.

## Final shaping decisions
- Keep requirements at top-level R0..R8 (<=9 rule).
- Compare at least 3 alternatives (A/B/C; D retained for completeness).
- Select **Shape A** for this spec, with mandatory hardening constraints from challenge.
- Add breadboarded affordances (UI + non-UI + wiring) into the spec body.
