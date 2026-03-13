# Planning Transcript: Multi-Runtime Agent Support

**Participants:** BrightHawk/IronQuartz (pi/claude-sonnet-4), CalmEagle (pi/claude-opus-4-6)
**Date:** 2026-03-07
**Spec:** specs/002-multi-runtime-support/

---

## Round 1: BrightHawk → CalmEagle (Research Findings)

Codebase research on files identified in breadboard:

- **lobby.ts lines 70-210:** Arg construction (76-112) uses pure helpers from agents.ts. Spawn at line 112. Stdout parsing at 141-168. Close handler at 170-200.
- **store.ts register() lines 285-400:** Takes ExtensionContext, hardcodes process.pid/ctx.sessionManager/ctx.model. Needs overrides param.
- **prompt.ts buildWorkerPrompt() lines 14-20:** No runtime param. Adding as optional last param is backward compatible.
- **config.ts CrewConfig:** No runtime field. Adding as role-keyed object.
- **package.json:** bin field needs pi-messenger-cli entry.
- **agents.ts helpers:** pushModelArgs, resolveThinking etc already factored out — PiAdapter imports them directly.

Proposed plan structure: architecture → per-slice details → risks → tasks.md

---

## Round 2: CalmEagle → BrightHawk (Three Corrections)

1. **CLI instructions insertion point:** After buildCoordinationInstructions() (line ~112), before buildSkillsSection() (line ~114). Not after skills. Natural reading order.

2. **Runtime config shape:** Role-keyed object only, no union type. Follows existing models/thinking pattern. Deep-merge handles partial overrides naturally.

3. **Extension handling for non-pi:** ClaudeAdapter.supportsFeature("extension-loading") returns false. Extensions skipped with warning logged. Plan must call this out explicitly.

---

## Round 3: BrightHawk → CalmEagle (Plan Written)

All three corrections incorporated. plan.md and tasks.md written with:
- RuntimeAdapter TypeScript interface definition
- Per-slice implementation details with exact file changes and line references
- 30 tasks across 4 slices + post-implementation
- Risk mitigations and cross-cutting concerns

---

## Round 4: CalmEagle → BrightHawk (Review — Five Issues)

**Bug 1:** getChangedFiles() diffs against HEAD (shows uncommitted). Should diff against task.base_commit..HEAD to catch committed changes.

**Bug 2:** Close handler has unreachable branch — outer condition checks `status === "in_progress"`, inner then checks `status === "done"` (impossible). Fix: outer checks assigned_to only, inner branches on status.

**Dependency correction 1:** V2 (CLI) has no dependency on V1 (adapters). CLI calls handlers directly, doesn't use resolveRuntime. V1 and V2 are truly parallel.

**Dependency correction 2:** V3.4 spawn-before-registration race. Worker could call CLI before spawner finishes register(). Mitigation: CLI crew-spawned mode retries registry lookup (3x, 100ms delay).

**Missing task:** V3.0 spike — run actual `claude --print --output-format stream-json` to capture real output format before building parser. Prevents building against assumed formats.

---

## Round 5: BrightHawk → CalmEagle (All Fixes Applied)

All five fixes applied to plan.md and tasks.md:
1. getChangedFiles(cwd, baseCommit?) with task.base_commit
2. Close handler branch logic corrected
3. V2 prerequisites: none (parallel with V1)
4. V2.2 retry for spawn-registration race
5. V3.0 spike task added

Dependency graph updated. Plan locked. [PHASE:agree] from both sides.
