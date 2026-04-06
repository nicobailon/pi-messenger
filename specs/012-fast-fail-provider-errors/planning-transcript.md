---
title: "Planning Transcript — spec 012 fast-fail provider errors"
date: 2026-04-05
bead: pi-messenger-3jf
participants:
  - BrightWolf (pi/gpt-5.3-codex)
  - OakTiger (crew-challenger, claude-opus-4-6)
---

<!-- plan:complete:v1 | harness: pi/gpt-5.3-codex | date: 2026-04-05T23:20:02Z -->

## Context
Planning target: `specs/012-fast-fail-provider-errors/`

Inputs reviewed before collaboration:
- `specs/012-fast-fail-provider-errors/spec.md`
- `crew/handlers/collab.ts`
- `handlers.ts`
- `tests/crew/collab-blocking.test.ts`
- `/Users/dalecarman/.agents/skills/workflows/workflows-plan/SKILL.md`

## Driver → Collaborator (initial challenge)
Driver asked collaborator to challenge research findings and return:
- top 5 risks with file anchors,
- implementation slices with dependency order,
- verification checklist with concrete grep/count checks,
- block/approve verdict.

## Collaborator response (Phase: challenge)
OakTiger returned **BLOCK** with three primary blockers:
1. `error.code` handling absent in parser (`crew/handlers/collab.ts` only reads `parsed.error.type`).
2. Parser boundary functions were not directly unit-testable and matrix coverage was too sparse.
3. No normative policy table + test linkage for classification (R8 gap).

Concrete verifications included:
- `rg -n "error\.code" crew/handlers/collab.ts` → no matches
- sparse `provider_error` references in `tests/crew/collab-blocking.test.ts`
- anchor at matching logic using substring includes.

## Driver revision (Phase: revise)
Driver proposed a 6-point corrected baseline:
1. Export parser boundary functions for direct testing.
2. Add `error.code` fallback with explicit precedence.
3. Replace substring matching with exact match.
4. Add normative policy table + explicit exclusions + bounded-latency note.
5. Build positive/negative test matrix (status + class + transient exclusions).
6. Keep spawn/send lifecycle behavior stable aside from classification precision.

## Collaborator verdict (Phase: approved)
OakTiger returned **APPROVED** with two non-blocking notes:
- document exact-match semantics vs namespaced variants,
- include a both-fields precedence test when type and code differ.

No further blockers.

## Completion signal
Driver sent `[COMPLETE]` with `phase: "complete"`; collaborator auto-dismissed.

## Planning outcome
Plan artifacts generated from this exchange:
- `plan.md`
- `tasks.md`

The plan explicitly incorporates OakTiger’s blockers and approval conditions.
