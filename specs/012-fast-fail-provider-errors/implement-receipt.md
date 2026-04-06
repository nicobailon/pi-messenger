---
baseline_sha: c46d13d61f168ea2909d1194dee22ebfbb431c16
end_sha: c7ab05cc7dedf06fbe372561f07cd972d3f5c41a
test_command: npm test -- tests/crew/stall.test.ts tests/crew/collab-blocking.test.ts tests/crew/provider-classification.test.ts tests/crew/provider-cleanup-invariants.test.ts
test_result: pass
test_count: 96
---

<!-- implement:complete:v1 | harness: pi/gpt-5.3-codex | date: 2026-04-06T01:03:44Z -->

# Implementation Receipt

## Changed Files
.beads/issues.jsonl
.claude/napkin.md
crew/handlers/collab.ts
crew/utils/provider-classification.ts
crew/utils/redaction.ts
handlers.ts
specs/012-fast-fail-provider-errors/codex-review.md
specs/012-fast-fail-provider-errors/log.md
specs/012-fast-fail-provider-errors/plan.md
specs/012-fast-fail-provider-errors/planning-transcript.md
specs/012-fast-fail-provider-errors/shaping-transcript.md
specs/012-fast-fail-provider-errors/spec.md
specs/012-fast-fail-provider-errors/tasks.md
specs/012-fast-fail-provider-errors/workflow-state.md
tests/crew/collab-blocking.test.ts
tests/crew/provider-classification.test.ts
tests/crew/provider-cleanup-invariants.test.ts

## Test Output Summary
- Ran: npm test -- tests/crew/stall.test.ts tests/crew/collab-blocking.test.ts tests/crew/provider-classification.test.ts tests/crew/provider-cleanup-invariants.test.ts
- Result: PASS
- Files: 4 test files
- Tests: 96 passed, 0 failed
- Key coverage: classifier matrix (type/code precedence + transient negatives), send replay-guard via minLogOffset/sendBaselineOffset, bounded provider-error latency assertion, spawn/send cleanup invariants, provider/model/request_id surfacing, debug payload redaction.
