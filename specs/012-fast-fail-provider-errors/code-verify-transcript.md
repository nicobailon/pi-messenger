<!-- code-verify:approved:v1 | harness: codex/gpt-5.3-codex | date: 2026-04-06T01:32:38Z | rounds: 2 -->

## Round 1 — Codex
## Findings
1. **High — Spawn cleanup invariants are not behavior-tested (plan gap).**  
The plan calls for stateful cleanup invariants on provider-error flows, including spawn-path coverage ([plan.md:62](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:62), [tasks.md:88](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/tasks.md:88)).  
Current spawn test only does source-string inspection, not runtime state validation ([provider-cleanup-invariants.test.ts:164](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:164)).  
Action: add a runtime spawn-path test seam (or extracted helper) that asserts collaborator de-registration and no active worker after `provider_error`.

2. **Medium — Replay-guard wiring in `executeSend` is implemented but not directly tested at handler level.**  
Code computes and passes `sendBaselineOffset` (`minLogOffset`) in send flow ([handlers.ts:389](/Users/dalecarman/dev/pi-messenger/handlers.ts:389), [handlers.ts:444](/Users/dalecarman/dev/pi-messenger/handlers.ts:444)).  
Existing replay test validates `pollForCollaboratorMessage` directly, not `executeSend` argument wiring ([collab-blocking.test.ts:239](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:239)).  
Action: add a send-handler test that inspects poll-call args and ordering.

3. **Medium — Spawn `provider_error` output contract (R1/R6) lacks direct test assertions.**  
Spawn code surfaces `provider_error` details + message fields ([collab.ts:677](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:677), [collab.ts:689](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:689)).  
But tests do not assert spawn result payload fields (`provider`, `model`, `request_id`, status/type); current spawn test is structural only ([provider-cleanup-invariants.test.ts:170](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:170)).  
Action: add spawn-path assertion test for surfaced details.

## Adversarial Gate
6. **3 riskiest code paths + tests**
1. Poll log scanner + terminal classification in `pollForCollaboratorMessage` ([collab.ts:198](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:198), [collab.ts:364](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:364)).  
Tested: yes, via poll-level tests including replay and bounded latency ([collab-blocking.test.ts:200](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:200), [collab-blocking.test.ts:239](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:239)).

2. Send handler provider-error cleanup + surfacing ([handlers.ts:470](/Users/dalecarman/dev/pi-messenger/handlers.ts:470)).  
Tested: yes, with mocked poll + cleanup assertions ([collab-blocking.test.ts:1624](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1624), [provider-cleanup-invariants.test.ts:74](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:74)).

3. Spawn handler provider-error cleanup + surfacing ([collab.ts:677](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:677)).  
Tested: partially only (source inspection, not runtime behavior) ([provider-cleanup-invariants.test.ts:164](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:164)).

7. **Likely first reviewer objection**  
“Spawn-path proof is weak: you’re asserting code text, not runtime behavior/invariants.”

8. **What this does NOT fully handle from plan**  
AD5’s spawn cleanup invariants are not validated statefully in tests ([plan.md:62](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:62), [tasks.md:92](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/tasks.md:92)).

9. **Are tests validating behavior or just coverage?**  
Mixed. Parser/poll/send tests are behaviorful and meaningful. Spawn coverage is partly “coverage by source inspection,” not true behavior verification.

## What I Verified
- **Files read**
1. `/tmp/claude-verify-3c0d91d0.md`
2. [spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md)
3. [plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md)
4. [tasks.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/tasks.md)
5. [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts)
6. [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts)
7. [provider-classification.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts)
8. [redaction.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/redaction.ts)
9. [provider-classification.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-classification.test.ts)
10. [provider-cleanup-invariants.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts)
11. [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts)

- **Test files found**
1. `tests/crew/stall.test.ts`
2. `tests/crew/collab-blocking.test.ts`
3. `tests/crew/provider-classification.test.ts`
4. `tests/crew/provider-cleanup-invariants.test.ts`

- **How many tests ran and pass/fail**
1. I could not run Vitest in this sandbox: `EPERM ... vitest.config.ts.timestamp-...mjs` (read-only FS prevented Vite temp file creation).
2. Verification packet reports **96 tests passed** for the targeted command.
3. Source count check found **96 `it(...)` tests** across those 4 files (`rg ... | wc -l`).

- **Assumptions tested against source**
1. Type-over-code precedence exists in classifier ([provider-classification.ts:69](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts:69), [provider-classification.ts:74](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts:74)).
2. `minLogOffset` replay guard is implemented in poll and wired from send ([collab.ts:105](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:105), [collab.ts:208](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:208), [handlers.ts:390](/Users/dalecarman/dev/pi-messenger/handlers.ts:390), [handlers.ts:444](/Users/dalecarman/dev/pi-messenger/handlers.ts:444)).
3. Provider-error cleanup calls `gracefulDismiss` in spawn/send paths ([collab.ts:678](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:678), [handlers.ts:472](/Users/dalecarman/dev/pi-messenger/handlers.ts:472)).
4. Sensitive payload redaction is applied before surfacing debug fields ([redaction.ts:14](/Users/dalecarman/dev/pi-messenger/crew/utils/redaction.ts:14), [handlers.ts:477](/Users/dalecarman/dev/pi-messenger/handlers.ts:477), [collab.ts:117](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:117)).
5. No unchecked checklist items remain in tasks (`grep -c '^- \[ \]'` => `0`).

- **Supporting counts/diffs/grep**
1. Feature commit footprint: **7 files, 737 insertions, 6 deletions** (`git show --stat a4934cc`).
2. Targeted open checklist items: **0** in `tasks.md`.
3. `includes(t)` substring-matching check: **no matches** in classifier/collab files.
4. Recent commit pattern is incremental (feature commit followed by spec/docs commits) (`git log --oneline -20`).

VERDICT: REVISE
## Round 1 — Revisions
- Extracted spawn provider-error branch into exported runtime helper: finalizeSpawnProviderError(...) in crew/handlers/collab.ts; executeSpawn now delegates to this helper.
- Replaced spawn source-inspection test with runtime invariant test in tests/crew/provider-cleanup-invariants.test.ts that asserts provider/model/request_id surfacing and registry cleanup after provider_error.
- Added executeSend handler-level replay wiring test in tests/crew/collab-blocking.test.ts proving minLogOffset equals pre-send baseline and that poll runs after send write mutation.
- Re-ran full target command from receipt: npm test -- tests/crew/stall.test.ts tests/crew/collab-blocking.test.ts tests/crew/provider-classification.test.ts tests/crew/provider-cleanup-invariants.test.ts (97 passed).

## Round 2 — Codex
## Findings
1. No blocking findings. The implementation now fulfills the plan/spec requirements R0–R8 with behavioral coverage across parser, poll loop, send handler, and spawn cleanup seam.
2. Non-blocking note: exporting `finalizeSpawnProviderError` is a testability seam and slightly broadens API surface ([collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:122)). It is reasonable here, but likely the first stylistic review question.

## Adversarial Gate
6. **3 riskiest code paths and test status**
1. Terminal classification/parser logic (`error.type` precedence, `error.code` fallback, status/class policy): tested.  
Code: [provider-classification.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts:46), [provider-classification.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts:73).  
Tests: [provider-classification.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-classification.test.ts:8), [provider-classification.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-classification.test.ts:28), [provider-classification.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-classification.test.ts:47).

2. Poll-loop replay guard + bounded-latency short-circuit from observable terminal line: tested.  
Code: [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:194), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:229), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:365).  
Tests: [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:239), [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:289).

3. Cleanup invariants and output contract on terminal provider error (send + spawn): tested.  
Code: [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:470), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:122), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:698).  
Tests: [provider-cleanup-invariants.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:74), [provider-cleanup-invariants.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:164), [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1624), [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1673).

7. **Likely first reviewer objection**  
“Why is `finalizeSpawnProviderError` exported?” (test seam/API surface concern) at [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:122).

8. **What this does NOT handle from the plan**  
No material implementation gap remains versus plan/tasks. The remaining limitation is external-runtime verification (Pi retry internals), which plan explicitly marks as external boundary (AD8) ([plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:85)).

9. **Are tests meaningful or just coverage?**  
They are behavior-focused: replay guard, latency bound, classification negatives, sanitized payloads, worker deregistration, and handler wiring are all asserted behaviorally, not existence-only ([collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:239), [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1673), [provider-cleanup-invariants.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:155)).

## What I Verified
- Files read:
1. [/tmp/claude-verify-3c0d91d0.md](/tmp/claude-verify-3c0d91d0.md:1)
2. [spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md:12)
3. [plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:26)
4. [tasks.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/tasks.md:16)
5. [provider-classification.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts:1)
6. [redaction.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/redaction.ts:1)
7. [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:88)
8. [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:338)
9. [provider-classification.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-classification.test.ts:1)
10. [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:200)
11. [provider-cleanup-invariants.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:60)

- Test files found: 4  
`tests/crew/stall.test.ts`, `tests/crew/collab-blocking.test.ts`, `tests/crew/provider-classification.test.ts`, `tests/crew/provider-cleanup-invariants.test.ts` (also listed in packet at [claude-verify-3c0d91d0.md](/tmp/claude-verify-3c0d91d0.md:6872)).

- Tests ran and pass status:
1. Packet reports targeted run passed: `97 tests` ([claude-verify-3c0d91d0.md](/tmp/claude-verify-3c0d91d0.md:6885)).
2. I could not execute Vitest in this sandbox due read-only EPERM temp-file creation in Vite config.
3. Independent source count confirms `97` `it(...)` tests across those 4 files.

- Assumptions tested against source:
1. Plan T1/T2 policy and precedence are implemented in classifier ([provider-classification.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts:26), [provider-classification.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts:74)).
2. Plan T3 replay guard wiring is in send path and poll init ([handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:390), [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:444), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:229)).
3. Plan T4/T5 handler and cleanup invariants are behavior-tested for both send and spawn seam ([provider-cleanup-invariants.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:74), [provider-cleanup-invariants.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/provider-cleanup-invariants.test.ts:164), [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1673)).

- Counts/diffs/grep supporting verdict:
1. Unchecked tasks count: `0` (`grep -c '^- \\[ \\]'`).
2. Classifier policy grep confirms normative table/test linkage entries at [provider-classification.ts](/Users/dalecarman/dev/pi-messenger/crew/utils/provider-classification.ts:26).
3. Feature commit is substantial and scoped (`a4934cc`: 7 files, 737 insertions) and follow-up test-hardening commit is incremental (`37e29c4`: 3 files, 110 insertions).
4. Commit pattern is incremental/informationally good: feature commit, docs/provenance commits, then focused test-hardening commit (`git log --oneline -12`).

VERDICT: APPROVED
