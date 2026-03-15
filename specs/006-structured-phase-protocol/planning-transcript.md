# Planning Transcript — Spec 006

**Date:** 2026-03-15
**Participants:** VividArrow (driver, pi/claude-sonnet-4-20250514) + JadeGrove (crew-challenger, pi/claude-opus-4-6)
**Spec:** 006-structured-phase-protocol
**Bead:** pi-messenger-3t0

## Exchange Summary

### VividArrow → JadeGrove (spawn prompt)

Shared proposed implementation plan with 8 ordered changes across 7 files. Asked 5 specific challenge questions:
1. Should D5 threshold be configurable?
2. gracefulDismiss in D2 — await vs fire-and-forget?
3. Race condition in D4?
4. Two independent stall clocks — correct?
5. Error handling during D2 dismiss crash?

### JadeGrove [PHASE:review]

Confirmed understanding of spec, read all target files (collab.ts full, handlers.ts executeSend, registry.ts, store.ts, full 895-line test suite).

### JadeGrove [PHASE:challenge]

Raised 7 concerns, 2 marked as high severity:

**#2 (HIGH): Fire-and-forget dismiss has registry race window.** If gracefulDismiss runs async, `unregisterWorker` doesn't execute for up to 20s. During that window, `findCollaboratorByName` still returns the entry. A second send could hit the collaborator path again, causing double-dismiss. Fix: sync `unregisterWorker` before async `gracefulDismiss`.

**#3 (HIGH): peerTerminal lost when collaborator exits between messages.** `findCollaboratorByName` checks `proc.exitCode === null` — returns null for dead processes. The peerTerminal flag is on an entry that's no longer findable. D4 becomes dead letter. Fix: propagate `peerComplete` in PollResult directly — driver learns conversation is over from the response, not the next send.

**#1 (Medium):** D5 threshold hardcoded + misnamed. Should be configurable, renamed to `pollTimeoutMs`.

**#4 (Low):** Two stall types should be distinguishable. Add `stallType: "log" | "timeout"`.

**#5 (Low):** D2 crash edge case — collaborator already dead when phase:complete sent. Needs documentation test.

**#6 (Medium):** executeSpawn doesn't propagate phase. One-shot collaborators would be missed.

**#7 (Medium):** Missing test for D4-after-death scenario.

### VividArrow [PHASE:revise]

Accepted all 7 concerns. Updated plan to 10 changes (was 8). Key design changes:
- Sync unregister before async dismiss in D2 path
- peerComplete in PollResult as primary signal; peerTerminal as fallback
- pollTimeoutMs configurable via crew config
- stallType distinction in error results
- executeSpawn propagation

### JadeGrove [PHASE:agree]

Confirmed #2 and #3 resolved correctly:
- Sync unregister is idempotent and doesn't break gracefulDismiss internals
- peerComplete in PollResult is strictly better than relying on D4 alone
- executeSpawn propagation handles one-shot collaborators

No further concerns. Verdict: ship it.
