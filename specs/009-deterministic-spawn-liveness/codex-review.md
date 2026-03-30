<!-- codex-review:approved:v1 | harness: pi/claude-sonnet-4-6 | date: 2026-03-30T17:43:16Z | rounds: 2 -->

Re-review complete. The 5 previously blocking issues are now addressed:

1. **CLI crash cleanup scope is now consistent with spec R2.**  
`R2c` now includes FIFO + registry cleanup, and out-of-scope removal is explicit ([`/tmp plan`](/tmp/claude-plan-c3172b2e.md:30), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:127), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:436)).

2. **`gracefulDismiss` early-return hole is closed in the plan.**  
Heartbeat unlink is now in both early-return and normal paths ([`/tmp plan`](/tmp/claude-plan-c3172b2e.md:106), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:362), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:378)). This directly addresses current source behavior ([`collab.ts`](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:625)).

3. **Type-model inconsistency is fixed.**  
`LivenessType` vs `PollStallType` split is coherent and includes `"timeout"` at poll boundary ([`/tmp plan`](/tmp/claude-plan-c3172b2e.md:90), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:93), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:318)).

4. **Test strategy now covers the previously missing high-risk area.**  
You added dedicated CLI cleanup tests plus gracefulDismiss branch coverage ([`/tmp plan`](/tmp/claude-plan-c3172b2e.md:414), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:424)). This directly addresses existing unit-gap notes in source tests ([`cli.test.ts`](/Users/dalecarman/dev/pi-messenger/tests/crew/cli.test.ts:1167)).

5. **Degraded-mode compatibility is now explicitly preserved.**  
No-log scenarios are planned as non-stalling, with ceiling handling max wait ([`/tmp plan`](/tmp/claude-plan-c3172b2e.md:65), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:220), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:240)), aligning with current behavior ([`collab.ts`](/Users/dalecarman/dev/pi-messenger/crew/handlers/collab.ts:246)).

Non-blocking note: there’s a small naming mismatch in snippets (`stallResult.livenessType` vs `StallResult.type`) that should be normalized during implementation ([`/tmp plan`](/tmp/claude-plan-c3172b2e.md:72), [`/tmp plan`](/tmp/claude-plan-c3172b2e.md:197)).

VERDICT: APPROVED