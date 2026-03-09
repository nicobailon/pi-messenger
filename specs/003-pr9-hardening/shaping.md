---
shaping: true
---

# PR #9 Hardening — Shaping

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | PR reviewable by upstream maintainer — accurate stats, clean description | Core goal |
| R1 | No personal/environment data in any committed file | Must-have |
| R2 | Process artifacts (specs, transcripts, handoffs) excluded from PR diff | Must-have |
| R3 | Zero `as any` in cli/index.ts production code (6 casts) | Must-have |
| R4 | Stuck detection extracted to shared utility (not duplicated across spawn paths) | Must-have |
| R5 | Completion inference returns false when no reservedPaths + multiple active workers | Must-have |
| R6 | Nonce auth documented as defense-in-depth, not security boundary | Must-have |
| R7 | Commit history squashed to 5-7 logical, bisectable commits (each passes `npm test`) | Must-have |
| R8 | CodexAdapter validated against multi-turn real workloads | Nice-to-have (escalated to pre-push gate per Codex review) |

### Requirement Notes

- **R0** amended per SwiftStorm C1: spec originally said "5,600 insertions, 36 files" — actual is 5,728 insertions, 38 files.
- **R3** scope corrected per SwiftStorm C2: reservation-any in lobby.ts/work.ts already fixed (uses `{ pattern: string }` inline type). Only cli/index.ts `as any` remains (6 hits).
- **R4** promoted from nice-to-have per SwiftStorm C3: third runtime (Codex) means copy-paste would become 3-way duplication.
- **R5** AC clarified per SwiftStorm C4: function-level change in `inferTaskCompletion()`, not callsite. Add `activeWorkerCount` param to `InferenceContext`. Callers already handle `false` return.

---

## Shapes

### A: Fix-in-Place — Code changes on current branch, then interactive rebase

| Part | Mechanism |
|------|-----------|
| A1 | Delete claude-stream-format.jsonl (R1) |
| A2 | Remove specs/, thoughts/ during interactive rebase (R2) |
| A3 | Define MinimalContext, replace as-any (R3) |
| A4 | Extract stuck-timer.ts (R4) |
| A5 | Add activeWorkerCount to InferenceContext (R5) |
| A6 | Update nonce comment + PR description (R6) |
| A7 | Interactive rebase to squash (R7) |
| A8 | Codex validation (R8) |

### B: Fresh Branch — Cherry-pick clean code onto new branch

| Part | Mechanism |
|------|-----------|
| B1 | New branch from main, cherry-pick code commits only (R2, R7) |
| B2 | Apply R3/R4/R5 during cherry-pick |
| B3 | Exclude JSONL (R1) |
| B4 | PR description + nonce (R6) |
| B5 | Codex validation (R8) |

### C'': Soft Reset + Restage (selected)

| Part | Mechanism |
|------|-----------|
| C''1 | Apply R3 (MinimalContext), R4 (extract stuck-timer.ts), R5 (inference gate) on current branch. Run `npm test` (baseline verification). |
| C''2 | `git reset --mixed main` — working tree has all changes, index matches main |
| C''3 | Naturally exclude: specs/, thoughts/, .beads/, claude-stream-format.jsonl — never `git add` them (R1, R2) |
| C''4 | Add + commit in 7 groups, `npm test` after each: |
|      | 1. V1: RuntimeAdapter, PiAdapter, unified spawn engine, model.ts |
|      | 2. V2: pi-messenger-cli |
|      | 3. V3: ClaudeAdapter, prompt injection, pre-registration, nonce auth |
|      | 4. V4: completion inference, work.ts hardening, inference gate, pre-claim safety |
|      | 5. V5: CodexAdapter |
|      | 6. R4: Extract stuck detection to crew/utils/stuck-timer.ts (standalone refactor) |
|      | 7. docs: README changes |
| C''5 | Update PR description: accurate stats, nonce as defense-in-depth (R0, R6) |
| C''6 | Run Codex multi-turn validation before push (R8, escalated per Codex review) |
| C''7 | Force-push |

**Multi-evolution file rule:** Files touched across multiple commits (agents.ts, lobby.ts, work.ts) are assigned to their primary logical group (earliest touch). Exception: R4 refactor gets its own commit because `stuck-timer.ts` is a new file that creates import dependencies — placing it in V1/V3 would break bisectability.

---

## Fit Check

| Req | Requirement | A | B | C'' |
|-----|-------------|---|---|-----|
| R0 | PR reviewable by upstream maintainer | ✅ | ✅ | ✅ |
| R1 | No personal data in committed files | ✅ | ✅ | ✅ |
| R2 | Process artifacts excluded from PR diff | ❌ | ✅ | ✅ |
| R3 | Zero as-any in production code | ✅ | ✅ | ✅ |
| R4 | Stuck detection shared utility | ✅ | ✅ | ✅ |
| R5 | Inference multi-worker safe | ✅ | ✅ | ✅ |
| R6 | Nonce qualified as defense-in-depth | ✅ | ✅ | ✅ |
| R7 | Clean commit history, bisectable | ✅ | ❌ | ✅ |
| R8 | Codex validated (nice-to-have) | ✅ | ✅ | ✅ |

**Notes:**
- **A fails R2:** Removing specs/ mid-rebase of 23 commits requires rewriting early commits that introduced the specs directory. Complex multi-commit rebase with conflict risk. (ZenCastle ordering dependency observation)
- **B fails R7:** Cherry-picking 23 interdependent commits doesn't produce clean grouped commits — still needs squash afterward, making B = A with extra steps.

---

## Selected Shape: C''

**Rationale:**
1. Only shape that passes all requirements
2. `--mixed` reset (ZenCastle fix) avoids the `--soft` trap of accidentally deleting specs from disk
3. R1/R2 handled naturally by never staging excluded files — no explicit removal commands needed
4. R4 in standalone commit (ZenCastle fix) prevents bisectability break from import dependency
5. Test-after-each-commit (C''4) ensures R7 bisectability is verified, not assumed

**Risks addressed:**
- Force-push is destructive → only our fork, no other contributors
- JSONL file in old commits → file never in main, soft reset means it's never in new commits, GitHub GCs old refspecs
- `git add -p` hunk surgery → NOT needed. "Primary group" rule assigns whole files. Only R4 is special-cased.
