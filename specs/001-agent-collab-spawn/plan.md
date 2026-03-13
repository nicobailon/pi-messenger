---
title: "Implementation Plan — spawn/dismiss for Agent Collaboration"
date: 2026-03-07
bead: pi-messenger-1
---

<!-- Codex Review: APPROVED after 2 rounds | model: gpt-5.3-codex | date: 2026-03-07 -->
<!-- Status: REVISED -->
<!-- Revisions: R1 — addressed 6 Codex findings: R8 gap, security allowlist, config types, orphan parity, test plan, budget scoping -->

# Implementation Plan — spawn/dismiss for Agent Collaboration

## Approach

Single new handler file (`crew/handlers/collab.ts`) plus surgical edits to 5 existing files. No changes to Crew's core work loop. Total estimated: ~250 lines new, ~30 lines modified.

Planned collaboratively with JadeGrove (agent-config repo, consumer perspective). Reviewed by Codex (gpt-5.3-codex).

Key decisions:

- **Isolation:** All spawn logic in `crew/handlers/collab.ts` — does not touch `runAgent()` or the wave execution path
- **New crewRole:** `"collaborator"` enables independent model/thinking config (`models.collaborator`, `thinking.collaborator`)
- **stdout handling:** Pipe to temp log file to avoid backpressure on long collaborations and provide debug trail
- **Reservations:** Challenger is read-only; spawning agent writes all artifacts after collaboration ends
- **Prompt composition:** Agent `.md` is system prompt (`--append-system-prompt`), spawn prompt is user message (`-p`)
- **Security:** `spawn` action restricted to agents with `crewRole: collaborator` — prevents spawning arbitrary agents with budget exemption
- **Graceful everywhere:** Both `dismiss` and `shutdownCollaborators` use the same SHUTDOWN_MESSAGE → grace → SIGTERM path

## Architecture

```
Spawning agent (pi session)
  │
  ├─ pi_messenger({ action: "spawn", agent: "crew-challenger", prompt: "..." })
  │   │
  │   ├─ discoverCrewAgents() → find crew-challenger.md
  │   ├─ VALIDATE: agentConfig.crewRole === "collaborator" (security gate)
  │   ├─ generateMemorableName() → "ZenPhoenix"
  │   ├─ spawn("pi", [...args], { env: { PI_AGENT_NAME, PI_CREW_COLLABORATOR } })
  │   ├─ poll registry until ZenPhoenix.json appears (100ms × 300 = 30s)
  │   └─ return { name: "ZenPhoenix", pid: 12345 }
  │
  ├─ pi_messenger({ action: "send", to: "ZenPhoenix", message: "[PHASE:research] ..." })
  │   └─ writes to inbox → FSWatcher → deliverMessage → triggerTurn
  │
  ├─ ... ping-pong exchange (max 5 rounds, then escalate to user) ...
  │
  └─ pi_messenger({ action: "dismiss", name: "ZenPhoenix" })
      ├─ write SHUTDOWN_MESSAGE to inbox
      ├─ wait shutdownGracePeriodMs
      ├─ SIGTERM if still alive
      └─ unregisterWorker()
```

## File Changes

### New Files

#### `crew/handlers/collab.ts` (~200 lines)

Core handler file. Contains:

- **`executeSpawn(params, state, dirs, ctx)`** — The spawn action handler
  1. Validate params: `agent` and `prompt` required
  2. `discoverCrewAgents(cwd)` → find agent config by name
  3. **Security gate:** Verify `agentConfig.crewRole === "collaborator"`. Reject with clear error if not. This prevents spawning arbitrary agents (e.g., crew-worker, crew-planner) with the collaborator budget exemption.
  4. `generateMemorableName()` → set as `PI_AGENT_NAME`
  5. Build pi args: `--mode json --no-session -p <prompt>`
  6. Apply model: config `models.collaborator` → agent frontmatter fallback
  7. Apply thinking: config `thinking.collaborator` → agent frontmatter fallback
  8. Tool restrictions from agent `.md` frontmatter
  9. `--extension EXTENSION_DIR` (derived from `import.meta.url`)
  10. `--append-system-prompt <tmpfile>` with agent's system prompt body
  11. Env: `PI_AGENT_NAME=<name>`, `PI_CREW_COLLABORATOR=1`, plus `config.work.env`
  12. `spawn("pi", args, { cwd, stdio: ["ignore", logFd, logFd] })` — stdout/stderr to temp log
  13. Register as `CollaboratorEntry` with `spawnedBy: process.pid`
  14. Poll `dirs.registry/<name>.json` at 100ms intervals, 30s timeout
  15. On timeout: kill proc, unregister, return error
  16. On success: return `{ name, pid }`

- **`gracefulDismiss(entry, dirs)`** — Shared graceful shutdown helper (used by both dismiss and orphan cleanup)
  1. Write `SHUTDOWN_MESSAGE` (imported from agents.ts) to collaborator inbox
  2. Poll `proc.exitCode` at 500ms intervals for `shutdownGracePeriodMs`
  3. If still alive: `proc.kill("SIGTERM")`, 5s SIGKILL fallback
  4. Unregister, clean up temp files (promptTmpDir, logFile)

- **`executeDismiss(params, state, dirs, ctx)`** — The dismiss action handler
  1. Validate: `name` param required
  2. `findCollaboratorByName(name)` from registry
  3. If not found: return error
  4. Call `gracefulDismiss(entry, dirs)`
  5. Return `{ dismissed: name }`

- **`shutdownCollaborators(pid, dirs)`** — Called from session_shutdown
  1. `getCollaboratorsBySpawner(pid)` from registry
  2. Call `gracefulDismiss()` for each (parallel with Promise.all)
  3. Returns when all are cleaned up

#### `crew/agents/crew-challenger.md` (~100 lines)

Agent definition for the challenger collaboration role.

```yaml
---
name: crew-challenger
description: Challenges proposals, finds gaps, raises risks in collaborative sessions
tools: read, bash, pi_messenger
model: anthropic/claude-sonnet-4-6
crewRole: collaborator
---
```

- Tools: read, bash, pi_messenger only — **no write/edit** (read-only enforcement)
- Protocol phases with explicit message format:
  - `[PHASE:review]` — reading context, gathering understanding
  - `[PHASE:challenge]` — raising concerns, finding gaps, demanding evidence
  - `[PHASE:agree]` — satisfied, signaling approval
  - `[PHASE:block]` — specific objections that prevent agreement
- Max rounds guard: after 5 exchanges, must [AGREE] or [BLOCK] with specific objections
- Shutdown handling: same as crew-worker

### Modified Files

#### `crew/index.ts` — Route new actions (+10 lines)

Add two cases to the action switch:

```typescript
case 'spawn': {
  const collabHandler = await import("./handlers/collab.js");
  return collabHandler.executeSpawn(params, state, dirs, ctx);
}

case 'dismiss': {
  const collabHandler = await import("./handlers/collab.js");
  return collabHandler.executeDismiss(params, state, dirs, ctx);
}
```

#### `crew/registry.ts` — Add collaborator type (+20 lines)

Add `CollaboratorEntry` to the union, plus `findCollaboratorByName()` and `getCollaboratorsBySpawner()`.

#### `crew/utils/discover.ts` — Add collaborator to CrewRole (+1 line)

```typescript
export type CrewRole = "planner" | "worker" | "reviewer" | "analyst" | "collaborator";
```

#### `crew/utils/config.ts` — Add collaborator to models/thinking types (+2 lines)

```typescript
models?: {
  planner?: string;
  worker?: string;
  reviewer?: string;
  analyst?: string;
  collaborator?: string;  // NEW
};
thinking?: {
  planner?: string;
  worker?: string;
  reviewer?: string;
  analyst?: string;
  collaborator?: string;  // NEW
};
```

#### `handlers.ts` — Budget exemption (~8 lines)

The `budget` variable is referenced downstream at lines 294 and 373 for remaining-count display. The exemption must keep `budget` in scope while skipping only the rejection:

```typescript
const crewDir = crewStore.getCrewDir(cwd);
const crewConfig = loadCrewConfig(crewDir);
const isCollaborator = process.env.PI_CREW_COLLABORATOR === "1";
const budget = isCollaborator ? Infinity : (crewConfig.messageBudgets?.[crewConfig.coordination] ?? 10);
if (messagesSentThisSession >= budget) {
  return result(
    `Message budget reached (${messagesSentThisSession}/${budget} for ${crewConfig.coordination} level). Focus on your task.`,
    { mode: "send", error: "budget_exceeded" }
  );
}
```

Setting `budget = Infinity` for collaborators means: the check never fires, but `remaining = budget - messagesSentThisSession` produces `Infinity` which displays as "Infinity remaining" — acceptable for collaborators (they'll see "Message sent to X. (Infinity messages remaining)"). If cleaner display is wanted, add a ternary at the remaining-count lines.

#### `crew/agents.ts` — Export SHUTDOWN_MESSAGE (+1 line)

Change `const SHUTDOWN_MESSAGE` to `export const SHUTDOWN_MESSAGE`.

#### `index.ts` — Orphan cleanup in session_shutdown (+5 lines)

```typescript
import { shutdownCollaborators } from "./crew/handlers/collab.js";
// In session_shutdown handler, before stopWatcher/unregister:
await shutdownCollaborators(process.pid, dirs);
```

Uses the same `gracefulDismiss()` path as explicit `dismiss` — parity with R2 semantics.

### NOT Modified

- `crew/agents.ts:runAgent()` — untouched, the wave execution path is not affected
- `crew/lobby.ts` — untouched, lobby worker lifecycle unchanged
- `crew/store.ts` — untouched, no task/plan state changes
- `crew/state.ts` — untouched, autonomous mode unaffected
- `overlay.ts` / `overlay-render.ts` — untouched, no overlay changes (v2)

## Design Notes

**No crew-proposer.md (conscious decision):** The spawning agent IS the proposer — its behavior is controlled by the `/plan` or `/shape` command that triggered the collaboration. Only the challenger needs a dedicated agent `.md` because it's the spawned subprocess.

**R8 (max rounds) implementation:** Since there's no crew-proposer.md, the max-rounds escalation is handled in TWO places: (1) The challenger's .md says "after 5 exchanges, you MUST [AGREE] or [BLOCK]" — this guarantees the challenger side terminates. (2) The workflow commands (`/plan`, `/shape`) that spawn collaborators will include "if you've exchanged 5+ messages without [AGREE], stop and escalate to the user." This is convention on both sides, not code enforcement.

**Phase markers in challenger .md:** The crew-challenger.md system prompt includes the `[PHASE:*]` message format convention so both agents use a consistent format.

**Security model:** The `spawn` action verifies `crewRole === "collaborator"` on the agent definition. This means only agents explicitly marked as collaborators get the budget exemption. A caller can't spawn `crew-worker` or `crew-planner` with unlimited messaging. The tool restriction (read-only for challenger) is enforced by pi's `--tools` flag, not by convention.

## Testing Strategy

- **Unit tests** for `collab.ts`:
  - Mock `spawn()` and `discoverCrewAgents()`, verify args building matches runAgent pattern
  - Verify security gate rejects non-collaborator agents
  - Verify registry operations (register, find, cleanup)
  - Verify poll logic (success path, timeout path)
  - Verify gracefulDismiss sends SHUTDOWN_MESSAGE before SIGTERM
- **Unit test** for budget exemption:
  - Verify `executeSend()` does NOT reject when `PI_CREW_COLLABORATOR=1` and count > budget
  - Verify budget still enforced when env var is absent (regression)
- **Integration smoke test** (`tests/crew/collab-integration.test.ts`):
  - Spawn a real `pi --mode json` process with a minimal prompt
  - Verify it registers in the registry directory within timeout
  - Send a message to its inbox, verify the file is written
  - Call dismiss, verify the process exits and registry is cleaned up
  - This covers R1, R2, R4 end-to-end without requiring full LLM interaction

## Risk Assessment

**Low risk:** Budget exemption (uses `Infinity` to keep `budget` in scope), SHUTDOWN_MESSAGE export, action routing, type additions. All trivially correct.

**Low risk:** Registry type addition. Existing functions handle the union via duck typing.

**Medium risk:** Spawn lifecycle — poll-until-mesh-ready loop. Mitigations: 30s timeout with cleanup on failure, `PI_AGENT_NAME` prevents name collision, `ensureDirSync` before polling.

**Low risk:** Orphan cleanup now uses same `gracefulDismiss()` path as explicit dismiss — no asymmetry.

## Open Decisions (resolved)

1. ✅ collab.ts (isolated handler, not in agents.ts)
2. ✅ Export SHUTDOWN_MESSAGE (don't duplicate)
3. ✅ New `crewRole: collaborator` (independent config)
4. ✅ Security gate: spawn restricted to `crewRole === "collaborator"` agents (Codex R1-finding)
5. ✅ Graceful dismiss shared helper for both dismiss and orphan cleanup (Codex R1-finding)
6. ✅ Budget uses `Infinity` to keep variable in scope (Codex R1-finding)
7. ✅ Config types updated for collaborator role (Codex R1-finding)
8. ✅ Integration smoke test added to test plan (Codex R1-finding)
