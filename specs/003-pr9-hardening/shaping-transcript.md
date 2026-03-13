# Shaping Transcript — Spec 003 PR #9 Hardening

**Date:** 2026-03-08
**Participants:** OakEagle (pi/claude-opus-4-6, proposer), SwiftStorm (crew-challenger/claude-sonnet-4-6, requirements phase), ZenCastle (crew-challenger/claude-sonnet-4-6, shapes phase)

---

## Phase 1: Requirements (OakEagle ↔ SwiftStorm)

### OakEagle → SwiftStorm [PHASE:requirements]

Proposed R0-R8 with R4 and R8 as nice-to-have. Asked for challenges on scoping, completeness, and priority.

### SwiftStorm → OakEagle [PHASE:challenge]

Four challenges with evidence:

1. **C1: Spec's own numbers are wrong.** Spec says 5,600 insertions/36 files. Actual: `git diff --stat` shows 5,728/38. Credibility problem.
2. **C2: R3 scope is stale.** Spec claims `r: any` in lobby.ts/work.ts. Verified: both already use `{ pattern: string }`. The `as any` problem is only in cli/index.ts (6 hits).
3. **C3: R4 should be must-have.** Stuck detection is structurally identical (diffed the blocks). Third runtime makes copy-paste unacceptable.
4. **C4: R5 AC has a logical gap.** Code marks task "done" before returning true. AC says "resets to todo" but doesn't specify WHO resets it. Missing: `activeWorkerCount` parameter and function-level branch change.

Proposed R9 (test personal paths) — investigated, not needed (grep returns zero hits).

### OakEagle → SwiftStorm [PHASE:revise]

All 4 challenges accepted with evidence:
- C1: Numbers corrected
- C2: R3 AC updated (reservation-any already fixed)
- C3: R4 promoted to must-have
- C4: R5 AC clarified — function change with `activeWorkerCount` param, callers already handle `false`

R set locked at R0-R8 (8 requirements, under cap of 9).

*[SwiftStorm went idle after first exchange. Dismissed and ZenCastle spawned for shapes phase.]*

---

## Phase 2: Shapes (OakEagle ↔ ZenCastle)

### ZenCastle → OakEagle [PHASE:review]

Confirmed R0-R8 against live code. Raised two pre-shape observations:
1. **Ordering dependency (R2 → R7):** Near-certainty, not just a risk. Shapes must address sequencing.
2. **R1 severity:** JSONL file may need `git filter-repo` to purge from history.

### OakEagle → ZenCastle [PHASE:shapes]

Proposed three shapes:

- **A: Fix-in-Place** — Individual fixes then interactive rebase
- **B: Fresh Branch** — Cherry-pick clean code onto new branch  
- **C: Soft Reset + Restage** — `git reset --soft main`, selective restaging

Initial fit check: A and C pass all R's, B fails R7. Leaned C.

Addressed ZenCastle's pre-shape concerns:
- Ordering: C handles naturally (never stage specs/)
- filter-repo: Not needed — JSONL only on feature branch, never in main. Verified with `git show main:...` → fatal.

### ZenCastle → OakEagle [PHASE:challenge]

Three concrete problems with Shape C:

1. **C2 command is wrong.** `git checkout HEAD -- specs/` after reset to main would DELETE specs from disk (main doesn't have them). Correct: `git restore --staged` or use `--mixed` reset.
2. **Multi-evolution files need hunk surgery.** agents.ts has 6 hunks across 5 commits. After soft reset, all changes are merged — can't split by logical group without `git add -p`. Shape doesn't name this complexity.
3. **Bisectability unaddressed.** No checkpoint/test step between commits. No rollback safety net after soft reset.

Proposed fix: use `--mixed` not `--soft`.

### OakEagle → ZenCastle [PHASE:revise]

All three accepted. Proposed C' with amendments:
- `--mixed` reset (Problem 1)
- "Primary group" rule — assign whole files to earliest logical commit, no hunk surgery (Problem 2)
- `npm test` after each commit (Problem 3)

### ZenCastle → OakEagle [PHASE:challenge]

Problems 1 and 3 resolved. One bisectability break remains:

**R4 import dependency.** `stuck-timer.ts` is a NEW file created by R4. After `--mixed` reset, agents.ts (V1 group) would import `./utils/stuck-timer.js` — but that file doesn't exist until R4 is committed. V1 commit fails `npm test`.

Fix: R4 gets its own standalone commit (pure refactor, last in sequence).

Also: C'1 "safety checkpoint" label is misleading — commit becomes orphan after reset. Rename to "baseline verification."

### OakEagle → ZenCastle [PHASE:agree]

R4 import dependency verified. Shape C'' finalized with:
- R4 as standalone commit 6 of 7
- C''1 renamed to "baseline verification"
- All R0-R8 pass fit check

Shape C'' selected.

---

## Summary

- **Requirements:** R0-R8 locked (8 items). R4 promoted from nice-to-have. R3/R5 ACs corrected.
- **Shapes explored:** A (fix-in-place), B (cherry-pick), C/C'/C'' (reset + restage)
- **Shape selected:** C'' — `git reset --mixed main` with 7 logical commits, test-after-each, R4 as standalone refactor
- **Key decisions:**
  - `--mixed` not `--soft` (avoids deleting specs from disk)
  - No hunk-level surgery (primary group rule for multi-evolution files)
  - R4 in standalone commit (import dependency prevents folding into V1/V3)
  - JSONL purge via natural exclusion (never in main, never restaged)
