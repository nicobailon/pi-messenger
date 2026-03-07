---
title: "Tasks — spawn/dismiss for Agent Collaboration"
date: 2026-03-07
bead: pi-messenger-1
---

<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.3-codex | date: 2026-03-07 -->
<!-- Status: REVISED -->
<!-- Revisions: Added config type updates (Task 1), security gate (Task 2), gracefulDismiss shared helper (Task 3), integration smoke test (Task 6), budget Infinity approach (Task 4) -->

# Tasks

## Task 1: Foundation — registry type, config types, SHUTDOWN_MESSAGE export

No dependencies. Enables Tasks 2 and 3.

- [ ] Add `CollaboratorEntry` interface to `crew/registry.ts` (type, spawnedBy, startedAt, promptTmpDir, logFile)
- [ ] Add `CollaboratorEntry` to `WorkerEntry` union type
- [ ] Add `findCollaboratorByName(name): CollaboratorEntry | null` function
- [ ] Add `getCollaboratorsBySpawner(pid): CollaboratorEntry[]` function
- [ ] Add `"collaborator"` to `CrewRole` type in `crew/utils/discover.ts`
- [ ] Add `collaborator?: string` to `models` and `thinking` in `CrewConfig` interface in `crew/utils/config.ts`
- [ ] Export `SHUTDOWN_MESSAGE` from `crew/agents.ts` (change `const` → `export const`)
- [ ] Run tests: verify no regressions

**Files:** `crew/registry.ts`, `crew/agents.ts`, `crew/utils/discover.ts`, `crew/utils/config.ts`

## Task 2: spawn action handler

Depends on: Task 1

- [ ] Create `crew/handlers/collab.ts`
- [ ] Implement `executeSpawn(params, state, dirs, ctx)`:
  - Validate: `agent` and `prompt` params required
  - `discoverCrewAgents(cwd)` to find agent config
  - **Security gate:** verify `agentConfig.crewRole === "collaborator"`, reject otherwise
  - `generateMemorableName()` for collaborator name
  - Build pi args: `--mode json --no-session -p <prompt>`
  - Apply model: config `models.collaborator` → agent frontmatter fallback
  - Apply thinking: config `thinking.collaborator` → agent frontmatter fallback
  - Tool restrictions from agent `.md` frontmatter
  - `--extension EXTENSION_DIR` (derive from `import.meta.url`)
  - `--append-system-prompt <tmpfile>` with agent system prompt
  - Env: `PI_AGENT_NAME=<name>`, `PI_CREW_COLLABORATOR=1`
  - `spawn("pi", args, { cwd, stdio: pipe stdout/stderr to temp log })`
  - Register as `CollaboratorEntry` with `spawnedBy: process.pid`
  - Poll `dirs.registry/<name>.json` at 100ms intervals, 30s timeout
  - On timeout: kill, unregister, return error
  - On success: return `{ name, pid }`
- [ ] Add `spawn` case to action router in `crew/index.ts`
- [ ] Write unit tests: args building, security gate rejection, registry ops, poll logic

**Files:** `crew/handlers/collab.ts` (new), `crew/index.ts`, `tests/crew/collab.test.ts` (new)

## Task 3: dismiss action + orphan cleanup

Depends on: Task 1

- [ ] Implement `gracefulDismiss(entry, dirs)` in `crew/handlers/collab.ts`:
  - Write `SHUTDOWN_MESSAGE` (imported from agents.ts) to collaborator inbox
  - Poll `proc.exitCode` at 500ms intervals for `shutdownGracePeriodMs`
  - If still alive: `proc.kill("SIGTERM")`, 5s SIGKILL fallback
  - Unregister, clean up temp files (promptTmpDir, logFile)
- [ ] Implement `executeDismiss(params, state, dirs, ctx)`:
  - Validate: `name` param required
  - `findCollaboratorByName(name)` from registry
  - If not found: return error
  - Call `gracefulDismiss(entry, dirs)`
  - Return `{ dismissed: name }`
- [ ] Implement `shutdownCollaborators(pid, dirs)`:
  - `getCollaboratorsBySpawner(pid)` from registry
  - Call `gracefulDismiss()` for each (parallel with Promise.all)
- [ ] Add `dismiss` case to action router in `crew/index.ts`
- [ ] Call `shutdownCollaborators(process.pid, dirs)` in `session_shutdown` handler in `index.ts`
- [ ] Write unit tests: gracefulDismiss sends SHUTDOWN_MESSAGE before SIGTERM, dismiss handler, orphan cleanup

**Files:** `crew/handlers/collab.ts`, `crew/index.ts`, `index.ts`, `tests/crew/collab.test.ts`

## Task 4: Budget exemption

No dependencies. Independent of Tasks 2-3.

- [ ] In `handlers.ts:executeSend()`, replace budget initialization:
  ```typescript
  const isCollaborator = process.env.PI_CREW_COLLABORATOR === "1";
  const budget = isCollaborator ? Infinity : (crewConfig.messageBudgets?.[crewConfig.coordination] ?? 10);
  ```
  Keep the existing `if (messagesSentThisSession >= budget)` check — it never fires for Infinity.
  Downstream `remaining = budget - messagesSentThisSession` produces Infinity — acceptable.
- [ ] Write unit test: `executeSend()` does NOT reject when `PI_CREW_COLLABORATOR=1` and count exceeds normal budget
- [ ] Write unit test: budget still enforced when env var is absent (regression)

**Files:** `handlers.ts`, `tests/crew/worker-coordination.test.ts`

## Task 5: crew-challenger agent definition

No dependencies. Independent of Tasks 2-4.

- [ ] Create `crew/agents/crew-challenger.md` with frontmatter:
  - `name: crew-challenger`
  - `description: Challenges proposals, finds gaps, raises risks in collaborative sessions`
  - `tools: read, bash, pi_messenger` (NO write/edit — read-only)
  - `model: anthropic/claude-sonnet-4-6`
  - `crewRole: collaborator`
- [ ] Write system prompt body:
  - Phase 1: Join mesh (`pi_messenger({ action: "join" })`)
  - Phase 2: Read context files listed in the prompt
  - Phase 3: Challenge — find gaps, raise risks, demand evidence
  - Phase 4: Signal `[PHASE:agree]` when satisfied or `[PHASE:block]` with specifics
  - **Include explicit message format convention:**
    - `[PHASE:review]` — reading and gathering understanding
    - `[PHASE:challenge]` — raising concerns
    - `[PHASE:agree]` — approval signal
    - `[PHASE:block]` — specific objections
  - Max rounds guard: after 5 exchanges, MUST [PHASE:agree] or [PHASE:block]
  - Shutdown handling: same as crew-worker
- [ ] Verify agent is discovered by `discoverCrewAgents()` (manual or unit test)

**Files:** `crew/agents/crew-challenger.md` (new)

## Task 6: Integration verification + smoke test

Depends on: Tasks 1-5

- [ ] Write integration smoke test (`tests/crew/collab-integration.test.ts`):
  - Spawn a real `pi --mode json` process with minimal prompt (or mock if pi unavailable in CI)
  - Verify registration file appears in registry directory within timeout
  - Write a message file to its inbox directory
  - Call dismiss, verify process exits and registry is cleaned
  - Covers R1 (mesh-ready), R2 (dismiss), R4 (cleanup) end-to-end
- [ ] Run full test suite: `npx vitest run`
- [ ] Manual smoke test (if pi is available):
  - Join mesh, spawn crew-challenger, verify list shows it, send message, dismiss
- [ ] Update CHANGELOG.md with new feature

**Files:** `tests/crew/collab-integration.test.ts` (new), `CHANGELOG.md`
