---
title: "Fast-fail collaborator flows on provider usage/rate/auth errors"
date: 2026-04-05
bead: pi-messenger-3jf
---

<!-- issue:complete:v1 | harness: pi/gpt-5.3-codex | date: 2026-04-05T12:37:07Z -->
<!-- Codex Review: APPROVED after 3 rounds | model: gpt-5.3-codex | date: 2026-04-05 -->
<!-- Status: UNCHANGED -->
<!-- Revisions: none -->

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Blocking `spawn`/`send` waits must terminate quickly once a terminal provider error is observable in collaborator runtime output (bounded by provider-runtime retry layer + poll tick; never multi-minute stall behavior). | Core goal |
| R1 | Error surfaced to caller must include provider, model, status code (if present), error type/class (if present), message, and `request_id` (if present). | Must-have |
| R2 | Terminal outcomes must not be masked by pi-messenger waiting logic (no additional patience loop after terminal classification). | Must-have |
| R3 | Terminal provider error path must deterministically clean up the affected collaborator process (`gracefulDismiss`) and leave no active collaborator session for that exchange. | Must-have |
| R4 | Terminal classification must be explicit and bounded: classify known terminal usage/auth/quota failures while avoiding false positives on transient transport/capacity errors unless policy marks them terminal. | Must-have |
| R5 | `spawn` and `send` must use consistent terminal classification semantics and consistent cleanup/surfacing behavior. | Must-have |
| R6 | Observability must mark this outcome as `provider_error` (not mislabeled as `stalled`/`timeout`/`crashed`). | Must-have |
| R7 | Regression coverage must include positive and negative classification cases across both polling and handler layers. | Must-have |
| R8 | A terminal-classification policy table (status + error-type/code rules + provider notes) must be documented and linked to tests. | Must-have |

---

## Shapes (S)

## CURRENT: Stall/Crash-oriented blocking wait with no dedicated provider terminal channel

| Part | Mechanism |
|------|-----------|
| CUR1 | Blocking poll waits for message, crash, cancellation, stall, or timeout. |
| CUR2 | Provider failures are implicitly observed only if/when they appear as generic error output. |
| CUR3 | No explicit terminal provider classification contract in shaping artifacts. |

## A: Inline poll log scanning + explicit terminal policy table (selected)

| Part | Mechanism | Flag |
|------|-----------|:----:|
| A1 | Incremental log scanner in `pollForCollaboratorMessage` inspects new lines each tick. | |
| A2 | Structured provider-error parser normalizes status-prefixed JSON and provider payload fields (`error.type` and `error.code`). | |
| A3 | Terminal policy map defines status/error-class terminality and explicit exclusions. | |
| A4 | Poll returns `provider_error` immediately on terminal match (short-circuit wait loop). | |
| A5 | `executeSpawn`/`executeSend` consume `provider_error`, call `gracefulDismiss`, and surface rich context (provider/model/status/type/request_id). | |
| A6 | Positive+negative test matrix enforces classification boundaries and bounded failure behavior. | |

## B: Process exit-code + sentinel handoff from Pi core

| Part | Mechanism | Flag |
|------|-----------|:----:|
| B1 | Pi runtime emits reserved exit code for terminal provider failure. | ⚠️ |
| B2 | Pi writes structured sentinel payload for status/type/request_id. | ⚠️ |
| B3 | pi-messenger reads sentinel on exit and maps directly to `provider_error`. | ⚠️ |

## C: Heartbeat protocol carries terminal error payload

| Part | Mechanism | Flag |
|------|-----------|:----:|
| C1 | Heartbeat writer switches to structured `ERROR:{...}` payload on terminal provider failure. | ⚠️ |
| C2 | Poll liveness check parses heartbeat payload for terminal outcome. | ⚠️ |
| C3 | Handler layer maps heartbeat error to dismissal + surfaced response. | ⚠️ |

## D: Adapter-normalized event channel (refactor path)

| Part | Mechanism | Flag |
|------|-----------|:----:|
| D1 | Runtime adapter writes normalized event stream for provider terminal events. | ⚠️ |
| D2 | Poll reads adapter event channel instead of parsing log format directly. | ⚠️ |
| D3 | Shared classification layer used by poll + handlers + telemetry. | ⚠️ |

---

## Fit Check

| Req | Requirement | Status | A | B | C | D |
|-----|-------------|--------|---|---|---|---|
| R0 | Blocking `spawn`/`send` waits must terminate quickly once a terminal provider error is observable in collaborator runtime output (bounded by provider-runtime retry layer + poll tick; never multi-minute stall behavior). | Core goal | ✅ | ✅ | ✅ | ✅ |
| R1 | Error surfaced to caller must include provider, model, status code (if present), error type/class (if present), message, and `request_id` (if present). | Must-have | ✅ | ✅ | ✅ | ✅ |
| R2 | Terminal outcomes must not be masked by pi-messenger waiting logic (no additional patience loop after terminal classification). | Must-have | ✅ | ✅ | ✅ | ✅ |
| R3 | Terminal provider error path must deterministically clean up the affected collaborator process (`gracefulDismiss`) and leave no active collaborator session for that exchange. | Must-have | ✅ | ✅ | ✅ | ✅ |
| R4 | Terminal classification must be explicit and bounded: classify known terminal usage/auth/quota failures while avoiding false positives on transient transport/capacity errors unless policy marks them terminal. | Must-have | ✅ | ❌ | ❌ | ✅ |
| R5 | `spawn` and `send` must use consistent terminal classification semantics and consistent cleanup/surfacing behavior. | Must-have | ✅ | ❌ | ✅ | ✅ |
| R6 | Observability must mark this outcome as `provider_error` (not mislabeled as `stalled`/`timeout`/`crashed`). | Must-have | ✅ | ❌ | ✅ | ✅ |
| R7 | Regression coverage must include positive and negative classification cases across both polling and handler layers. | Must-have | ✅ | ❌ | ❌ | ❌ |
| R8 | A terminal-classification policy table (status + error-type/code rules + provider notes) must be documented and linked to tests. | Must-have | ✅ | ❌ | ❌ | ✅ |

**Notes:**
- B fails R4/R5/R6/R7/R8 because it depends on Pi-core contracts not owned in this repo and has no local verification path.
- C fails R4/R7/R8 due heartbeat-protocol coupling and large new protocol surface for this incident scope.
- D can satisfy architecture goals but fails R7 in this spec scope due refactor size vs immediate incident objective.

---

## Selected Shape

**Selected shape: A — Inline poll log scanning + explicit terminal policy table**

### Why A
- Meets all R0–R8 within pi-messenger repo boundaries.
- Smallest blast radius for incident response while still fixing root cause (missing terminal provider channel in blocking wait logic).
- Supports immediate operator action (switch/reload account) by surfacing actionable provider context.
- Enables strict regression coverage without requiring cross-repo Pi runtime changes.

### Explicit constraints on A
1. Policy table is normative and test-linked (R8), including provider-specific notes and exclusions.
2. Parser must support both `error.type` and `error.code`-style payloads.
3. Negative tests for non-terminal/transient classes (e.g. 500/503/529/overloaded/network) are required.
4. Bounded-latency language is explicit: 429 may be delayed by upstream Pi retry budget before becoming observable in logs.

---

## Breadboard (Detail A)

### UI Affordances

| Affordance | Place | Purpose | Wires Out |
|------------|-------|---------|-----------|
| U1: Spawn terminal error output | `executeSpawn` result text/details | Immediate actionable failure message with provider context | N4 |
| U2: Send terminal error output | `executeSend` result text/details | Immediate actionable failure + dismissal confirmation | N4 |
| U3: Machine-readable error field | Tool result `details.error="provider_error"` | Enables automation/telemetry to distinguish from stall/timeout/crash | N4, N6 |

### Non-UI Affordances

| Affordance | Place | Mechanism | Wires Out |
|------------|-------|-----------|-----------|
| N1: Terminal policy map | `crew/handlers/collab.ts` | Status + error-class terminal classification table | N2, N3 |
| N2: Incremental log scanner | `pollForCollaboratorMessage` | Reads only appended log bytes and parses JSONL event lines | N3 |
| N3: Provider error normalizer | `parseProviderTerminalErrorMessage` + extractor | Normalizes status/type/code/message/request_id/provider/model | N4 |
| N4: Provider terminal result channel | `PollResult.error="provider_error"` | Short-circuits wait loop and passes structured error to handlers | U1, U2, U3, N5 |
| N5: Cleanup coordinator | `gracefulDismiss` path in spawn/send | Deterministic collaborator teardown on terminal provider error | U2 |
| N6: Regression matrix | `tests/crew/collab-blocking.test.ts` (+ related tests) | Positive + negative classification tests and handler behavior checks | U3 |

### Wiring (grouped by place)

- **Collaborator process (`pi --mode rpc`)**
  - emits provider error events/log lines.
- **Spawner poll loop (`pollForCollaboratorMessage`)**
  - consumes incremental log bytes → parses provider terminal payload → emits `provider_error` result.
- **Handler layer (`executeSpawn` / `executeSend`)**
  - consumes `provider_error` → surfaces structured message/details → runs cleanup.
- **Test layer**
  - validates classification boundaries and ensures terminal provider failures are not reported as stalls.

---

## Acceptance Criteria

1. Terminal provider failures no longer appear as multi-minute collaborator stalls.
2. `spawn` and `send` both surface `provider_error` with provider/model/status/type/message/request_id when available.
3. Collaborator teardown occurs deterministically on terminal provider error.
4. Classification policy table is documented and mapped to tests.
5. Negative tests prove transient errors are not misclassified as terminal by default.

## In Scope
- Blocking collaborator flows: `pollForCollaboratorMessage`, `executeSpawn`, `executeSend`.
- Terminal provider classification and surfacing behavior.
- Regression tests for classification and handler behavior.

## Out of Scope
- Cross-repo changes to Pi core retry engine.
- Automatic credential/account switching.
- Global model failover or quota balancing across providers.
