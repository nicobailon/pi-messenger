<!-- codex-review:approved:v1 | harness: codex/gpt-5.3-codex | date: 2026-04-06T00:41:06Z | rounds: 3 -->

# Codex Review Transcript — spec 012-fast-fail-provider-errors

Review ID: 651d4748
Model target: gpt-5.3-codex (default)


## Round 1 — Codex

**Findings (Severity-Ordered)**
1. High: The plan does not address stale-log replay risk, which can misclassify old errors as current terminal failures and incorrectly dismiss active collaborators.
Evidence: scanner starts at offset `0` for each poll call ([collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:279)); send path reuses the existing collaborator/log entry ([handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:419), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:639)); plan explicitly avoids lifecycle changes ([plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:73)).
Action: in send context, initialize scan offset to current log size (or send timestamp boundary), and add a regression test with pre-existing terminal-like lines.

2. High: R3 cleanup proof is incomplete; plan does not verify “no active collaborator session remains” end-to-end.
Evidence: spec requires deterministic cleanup/no active session ([spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md:16)); plan says “keep existing cleanup behavior” with limited assertions ([plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:100)); existing tests note executeSpawn handler behavior is hard to intercept and relies on source inspection ([collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1447)).
Action: add stateful integration assertions that registry/worker state is cleared after provider_error in both spawn and send paths.

3. Medium-High: R0 bounded-latency behavior is not concretely test-defined in the plan.
Evidence: spec requires bounded fast-fail (no multi-minute stalls) ([spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md:13)); plan references bounded behavior but no explicit timing assertion strategy ([plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:97)); current 429 test checks classification, not elapsed bound ([collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:200)).
Action: add explicit elapsed-time assertions (post-terminal-line detection) to enforce bounded failure behavior.

4. Medium: R1 requires provider/model in surfaced errors when present, but plan’s explicit test wording omits provider/model assertions.
Evidence: requirement text includes provider/model ([spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md:14)); plan traceability only calls out status/type/message/request_id assertions ([plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:98)).
Action: add explicit provider/model assertions in parser and integration tests.

5. Medium: A core runtime assumption is external and unverified in repo context.
Evidence: plan depends on Pi-core retry behavior (`agent-session.js`/backoff) ([plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:35)); those files are not in this repo.
Action: either add fixture evidence from real runtime logs or clearly gate this as an external dependency/risk.

6. Medium (Security): plan does not address potential sensitive-data exposure in surfaced raw/log-tail error content.
Evidence: spawn provider_error can include log tail ([collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:761)); send returns providerError object including `raw` ([handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:473), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:109)).
Action: redact sensitive tokens in `raw`/`logTail` or gate detailed payloads behind debug mode.

**Adversarial Gate**
7. Three riskiest assumptions and verification status:
1. “Pi runtime only surfaces terminal provider errors after retries are exhausted, so log parsing won’t catch transient retries.”  
Verified against source context: No. This repo does not contain the referenced Pi-core files; assumption is external ([plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:35)).
2. “Keeping lifecycle semantics unchanged is safe for send-path classification correctness.”  
Verified against source context: Partially, and risky. I verified poll scanning starts from beginning each call ([collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:279)) while send reuses collaborator state ([handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:419)); this can replay historical lines.
3. “Existing cleanup behavior is sufficient to satisfy deterministic no-active-session guarantees.”  
Verified against source context: Partially. Cleanup calls exist ([collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:752), [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:460), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:893)), but planned verification does not prove this end-to-end for spawn/send.

8. Skeptical senior engineer’s first objection:
“You are driving terminal behavior from ad-hoc log-string parsing; where is proof this won’t kill healthy collaborators on retryable/intermediate errors?”

9. What this plan does not address that production needs:
1. Real-runtime integration proof (non-mocked) for spawn+send terminal paths.
2. Cleanup invariants validated in registry/process state, not just mocked call expectations.
3. Redaction policy for surfaced provider payloads/log tails.
4. Operational observability metrics (counts/labels) for provider_error outcomes.

10. Scope differences between spec and plan:
1. Expanded scope: exports internal parser/extractor helpers and adds dedicated unit matrix file (good expansion) ([plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:41), [plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:87)).
2. Narrowed scope: R3/R5 verification is weaker than spec intent because spawn handler cleanup is not concretely testable in current strategy ([spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md:16), [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1447)).
3. Narrowed specificity: R0 “bounded by retry layer + poll tick” is not turned into explicit measurable test thresholds in the verification plan ([spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md:13), [plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:116)).

**Simpler/Better Approach**
1. Keep Shape A, but add one minimal safety change: send-path scan starts at current EOF to avoid historical replay; spawn-path keeps full scan.
2. Extract classifier into a pure helper module now (instead of exporting internals from collab handler) to improve testability and reduce future ESM mocking constraints.

**What I Verified**
1. Reviewed spec requirements and acceptance criteria in [spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md:9) through [spec.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/spec.md:161).
2. Reviewed full plan and traceability in [plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:11) through [plan.md](/Users/dalecarman/dev/pi-messenger/specs/012-fast-fail-provider-errors/plan.md:129).
3. Verified classifier behavior in [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:151), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:163), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:189), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:279), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:439), [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:752).
4. Verified send-path handling and cleanup wiring in [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:460).
5. Counted current targeted coverage: `68` tests in `collab-blocking`, only `2` provider-focused test cases ([collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:200), [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1567)).
6. Verified known testability limitation for executeSpawn handler interception in [collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1447).

VERDICT: REVISE

## Round 1 — Revisions
- Added explicit stale-log replay mitigation: send-context poll scanning starts from current EOF, while spawn keeps full scan.
- Strengthened R3 verification: added stateful cleanup-invariant tests for spawn/send provider_error paths beyond mocked call checks.
- Added bounded-latency test contract for R0: once terminal line is observable, poll resolves provider_error within a measured bound in controlled tests.
- Expanded R1 verification to include provider/model assertions (in addition to status/type/message/request_id).
- Reworked classifier architecture: extracted parser to new pure module `crew/utils/provider-classification.ts` for direct testability.
- Added `error.code` fallback with explicit precedence (`type` wins when both present).
- Replaced substring terminal-class matching with exact normalized equality.
- Added normative policy table with explicit non-terminal exclusions and 429 retry-layer bounded-latency note.
- Added security policy: sanitize/redact sensitive token-like data from raw/logTail in surfaced outputs.
- Marked Pi-core retry behavior as external assumption/risk rather than repo-verified fact.

## Round 2 — Codex

**Assessment**
Plan quality is much stronger and now covers almost all spec requirements directly. The remaining blocker is one race-condition ambiguity in the stale-log replay mitigation that can reintroduce R0/R2 failures.

**Blocking Issue**
1. Send-context scan baseline is still ambiguous and currently unsafe as written.
The revised plan says “send-time” baseline, but then specifies setting offset at “poll start,” which can miss a real terminal line emitted between send write and poll initialization.
Evidence: plan wording conflict at [/tmp/claude-plan-651d4748.md:211](/tmp/claude-plan-651d4748.md:211) and [/tmp/claude-plan-651d4748.md:214](/tmp/claude-plan-651d4748.md:214). In current code, send writes to collaborator first, then later enters poll ([handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:403), [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:419)).
Action: make baseline explicit as “log size captured immediately before send write” and pass that into poll (not computed at poll start).

**Adversarial Gate**
7. Three riskiest assumptions and verification:
1. Assumption: poll-start EOF baseline won’t drop valid current-exchange provider errors.  
Verified against source: no; source ordering shows a real race window ([handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:403), [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:419)).
2. Assumption: cleanup invariants can be reliably proven for spawn/send despite ESM mocking constraints.  
Partially verified; constraints are real in existing tests ([collab-blocking.test.ts](/Users/dalecarman/dev/pi-messenger/tests/crew/collab-blocking.test.ts:1447)).
3. Assumption: external Pi retry behavior won’t silently shift semantics.  
Handled better now as external risk, not repo fact (good), and aligns with out-of-scope boundaries ([/tmp/claude-plan-651d4748.md:239](/tmp/claude-plan-651d4748.md:239)).

8. Skeptical senior engineer’s first objection:
“You still haven’t nailed the scan baseline timing; you may skip the exact error we care about and stall anyway.”

9. Production-system gaps still not fully addressed:
1. Explicit compatibility contract for redaction behavior on existing consumers (what fields are guaranteed stable).
2. Deterministic CI-safe latency threshold strategy (to avoid flaky <=1s tests under load).

10. Scope differences vs spec:
1. Expanded (good): classifier extraction, cleanup-invariant test layer, and payload sanitization.
2. Drift/ambiguity (needs fix): stale-log mitigation timing semantics (“send-time” vs “poll-start EOF”) can change behavior materially.

VERDICT: REVISE

## Round 2 — Revisions
- Removed stale-log replay ambiguity by defining a new `PollOptions.minLogOffset` contract.
- Specified send-path ordering precisely: capture `sendBaselineOffset` immediately before send write, then pass it into poll.
- Added scanner initialization rule `providerScanOffset = max(currentOffset, minLogOffset)` to prevent historical replay.
- Added explicit replay-guard proof test with preseeded historical terminal lines and post-baseline assertions.
- Added redaction compatibility contract with stable surfaced fields and debug-only sanitized raw/logTail behavior.
- Replaced brittle fixed latency expectation with CI-safe bounded threshold `max(1000ms, 6 * POLL_INTERVAL_MS)`.
- Kept external Pi retry behavior explicitly outside repo-verified correctness assumptions.

## Round 3 — Codex

**Findings**
1. No blocking issues found. The previous blocker (send-path baseline race ambiguity) is now explicitly resolved by `PollOptions.minLogOffset` plus strict ordering (capture baseline before write, then poll with that offset) in the updated plan ([/tmp/claude-plan-651d4748.md:200](/tmp/claude-plan-651d4748.md:200), [/tmp/claude-plan-651d4748.md:205](/tmp/claude-plan-651d4748.md:205), [/tmp/claude-plan-651d4748.md:207](/tmp/claude-plan-651d4748.md:207)).

2. No requirement-to-plan gaps detected across R0–R8. The plan now has explicit traceability and verification hooks for each requirement ([/tmp/claude-plan-651d4748.md:249](/tmp/claude-plan-651d4748.md:249), [/tmp/claude-plan-651d4748.md:261](/tmp/claude-plan-651d4748.md:261)).

**Adversarial Gate**
7. Three riskiest assumptions and verification status:
1. Assumption: send-path baseline capture truly eliminates stale replay without dropping current-exchange signals.  
Verified against plan: yes, ordering is explicit and unambiguous ([/tmp/claude-plan-651d4748.md:205](/tmp/claude-plan-651d4748.md:205), [/tmp/claude-plan-651d4748.md:206](/tmp/claude-plan-651d4748.md:206), [/tmp/claude-plan-651d4748.md:207](/tmp/claude-plan-651d4748.md:207)).  
Validated against current source risk context: yes, it directly addresses the current send-before-poll ordering ([/tmp/claude-plan-651d4748.md:295](/tmp/claude-plan-651d4748.md:295)).

2. Assumption: cleanup can be proven statefully despite ESM interception limits.  
Verified against plan: yes, dedicated cleanup-invariant tests are now part of the strategy ([/tmp/claude-plan-651d4748.md:211](/tmp/claude-plan-651d4748.md:211), [/tmp/claude-plan-651d4748.md:247](/tmp/claude-plan-651d4748.md:247)).

3. Assumption: Pi-core retry behavior is not a correctness dependency for this repo’s tests.  
Verified against plan: yes, now explicitly treated as external assumption/risk boundary ([/tmp/claude-plan-651d4748.md:234](/tmp/claude-plan-651d4748.md:234), [/tmp/claude-plan-651d4748.md:235](/tmp/claude-plan-651d4748.md:235)).

8. Skeptical senior engineer’s first objection:
“Are you still relying on ambiguous scan start timing?”  
This is now answered by explicit `minLogOffset` ordering and replay-guard proof case.

9. What the plan does not address that a production system might still want:
1. Rollout-level observability dashboards/alerts for provider_error rates.
2. Feature-flagged rollout strategy.  
These are reasonable, but not required by current spec scope.

10. Scope differences vs spec:
1. Expanded: classifier extraction, redaction contract, replay-guard mechanics, cleanup-invariant suite.  
2. Dropped: none of R0–R8; all are mapped and covered.

**What I Verified**
1. Re-read full updated spec+plan content in [/tmp/claude-plan-651d4748.md](/tmp/claude-plan-651d4748.md:1).
2. Checked current source ordering context that created the race risk in [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:403) and [handlers.ts](/Users/dalecarman/dev/pi-messenger/handlers.ts:419), and scanner initialization in [collab.ts](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:279).
3. Counted requirement coverage: 9/9 (R0–R8) have explicit traceability entries in the revised plan.
4. Counted verification scope: 3 targeted test files + 5 guard checks + dedicated replay-guard proof case.

VERDICT: APPROVED
