---
title: "Planning transcript — spec 007 CLI global install"
date: 2026-03-18
bead: pi-messenger-32a
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-18T20:26:17Z -->

# Planning Transcript: Spec 007

**Driver:** TrueBear (pi/claude-opus-4-6)
**Challenger:** PureZenith (crew-challenger, claude-opus-4-6)

## Driver's Research Findings

### Insertion points identified

1. **install.mjs** — 3 changes: constants (line ~24), --remove section (line ~108), end of file (after copyDir)
2. **crew/runtime-spawn.ts** — 1 change: after `validateCommandAvailable` (line ~49)
3. **Wrapper script** — shell script in `~/.pi/agent/bin/pi-messenger-cli`

### Jiti resolution chain verified
- `npm prefix -g` → `/opt/homebrew`
- `${prefix}/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/jiti/lib/jiti-cli.mjs` → exists, verified
- `node jiti-cli.mjs cli/index.ts --help` → works from any directory

### Worker PATH verified
- Pi's `getShellEnv()` prepends `~/.pi/agent/bin/` to PATH
- Workers inherit via `process.env` spread in `agents.ts:223`
- `~/.pi/agent/bin` confirmed in current PATH

## Challenger's Findings (PureZenith)

6 findings, 3 critical/moderate requiring changes:

### #1 (CRITICAL): `which pi` unreliable in install context
- install.mjs has zero existing dependency on pi being installed
- `which pi` can fail if terminal hasn't reloaded after pi install
- **Fix**: Use `npm prefix -g` instead — stable, always available

### #2 (MODERATE): --remove doesn't clean wrapper when extension dir missing
- Wrapper deletion was nested inside `existsSync(EXTENSION_DIR)` check
- **Fix**: Unconditional wrapper cleanup in --remove block

### #3 (MODERATE): Collision guard blocks wrapper creation
- Dev workflow (settings.json packages entry) triggers collision guard → exits before wrapper creation
- **Decision**: By design — dev workflow doesn't need wrapper, uses repo directly. Add code comment explaining why.

### #4 (MODERATE): runtime-spawn CLI validation needs skipCommandCheck + env verification
- Must respect `skipCommandCheck` option (for tests)
- Must happen after runtime check (more actionable error first)
- Worker PATH verified: inherits `~/.pi/agent/bin/` from process.env

### #5 (LOW): Wrapper ignores PI_MESSENGER_DIR
- Challenger misread: PI_MESSENGER_DIR controls messenger state dir, not extension source
- Out of scope — different concerns

### #6 (LOW): Missing graceful-failure test
- **Fix**: Add test that creates wrapper with non-existent jiti path, verifies exit 1 + error message

## Outcome

All 6 findings addressed. Challenger approved revised plan.
