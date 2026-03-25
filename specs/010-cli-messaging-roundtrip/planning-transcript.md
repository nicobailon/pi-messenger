<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T10:44:51Z -->

# 010 — Planning Transcript

**Participants:** PureStorm (pi/claude-opus-4-6, proposer) × MintCastle (crew-challenger, pi/claude-opus-4-6)
**Date:** 2026-03-25
**Rounds:** 3 (review → challenge → revise → challenge → revise → approved)

---

## Round 1: PureStorm presents implementation plan

Proposed 8 tasks covering all 7 shape parts (A1-A7) plus tests. Detailed exact insertion points, code patterns, dependencies, and blast radius across cli/index.ts, handlers.ts, and tests/crew/cli.test.ts.

## Round 2: MintCastle challenges (5 concerns, 2 blockers)

### 🔴 Concern 1: Model mismatch when CWD fallback fires

When `findSessionByCwd()` provides a session after `detectModel()` returned a different model string, the plan didn't specify which model gets used for `resolvedModel`. Using detectModel's result would break model stability while fixing name stability.

**Resolution:** Explicit rule — CWD fallback overrides `resolvedModel = session.model`. Both name AND model come from the session file.

### 🔴 Concern 2: handlers.ts contradiction

Plan said "handlers.ts — zero changes needed" but spec's File Impact table, Part A6, and root cause analysis all reference handlers.ts changes.

**Resolution:** `executeStatus()` gets 3-line anonymous guidance. Pi extension never creates anonymous state so it's CLI-only but lives in the shared handler. Plan and spec aligned.

### 🟡 Concern 3: Leave behavior change with findSessionByCwd

`findSessionByCwd()` throws on 2+ matches, but leave currently takes first match silently. Replacing inline scan with the shared function changes leave's behavior.

**Resolution:** Intentional improvement. If two sessions exist, user should choose which to leave. Documented as scope expansion.

### 🟡 Concern 4: send --wait unlinkSync not race-safe

Bare `unlinkSync` can throw ENOENT if another process (`receive` in another terminal) deletes the file between read and unlink.

**Resolution:** Wrap in `try { fs.unlinkSync(filePath); } catch {}` — same pattern used throughout codebase.

### 🟡 Concern 5: send --wait hot-loops malformed files

Malformed inbox file gets re-parsed every 100ms for up to 300 seconds (3,000 attempts).

**Resolution:** `failedFiles: Set<string>` tracks files that failed parsing. Warn once on stderr, skip on subsequent iterations.

## Round 3: MintCastle identifies missing path in leave refactor

### 🟡 Concern 6: Leave missing success-but-miss CWD fallback

Leave refactor only had CWD fallback in the detectModel-throws path, not the detectModel-succeeds-but-exact-key-misses path. This means leave would fail to find a session when detectModel returns a different model than was used at join time — the exact bug we're fixing in bootstrapExternal.

**Resolution:** Leave gets the same three-step chain as bootstrapExternal and read-only bootstrap. All three paths are now symmetric: exact key → CWD fallback → error/anonymous.

## Final Verdict

MintCastle approved after all 6 concerns were addressed. Plan is symmetric across all three bootstrap paths, model propagation is explicit, edge cases (race conditions, malformed files, ambiguity) all handled.
