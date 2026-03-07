---
title: "spawn/dismiss Actions for Agent-to-Agent Collaboration"
date: 2026-03-07
bead: pi-messenger-1
consumer-spec: "~/.agent-config/specs/008-agent-to-agent-collab/spec.md"
---

# spawn/dismiss Actions for Agent-to-Agent Collaboration

## Problem

Agents hit two-participant gates in workflow commands (`/plan`, `/shape`, `/codex-review`, `/implement`) and have no way to spawn a collaborator. They either fall back to the user (breaking autonomy) or skip the gate (breaking quality). This is daily friction across 9+ projects.

## Outcome

An agent can programmatically spawn a collaborator, exchange structured messages through a protocol, produce artifacts, and dismiss the collaborator — all from a single `pi` session with no user involvement.

## Selected Shape: A — Thin spawn/dismiss wrapping runAgent

(From shaping session with JadeGrove — see `shaping.md` for full analysis, fit check, and rejected alternatives B and C.)

| Part | Mechanism |
|------|-----------|
| **A1** | `spawn` action — wraps `crew/agents.ts:runAgent()`. Calls `discoverCrewAgents()`, `generateMemorableName()`, spawns `pi --mode json` subprocess with `PI_AGENT_NAME` + `PI_CREW_COLLABORATOR=1`. **Blocks until collaborator appears in registry** (poll with 30s timeout). Returns `{ name, pid }`. |
| **A2** | `dismiss` action — looks up collaborator by name in registry, sends `SHUTDOWN_MESSAGE` to inbox, waits `shutdownGracePeriodMs`, SIGTERM fallback, unregisters. |
| **A3** | Budget exemption — `executeSend()` skips budget check when `PI_CREW_COLLABORATOR=1` env is set. |
| **A4** | Collaborator agent `.md` files — `crew-challenger.md` (read-only: read, bash, pi_messenger) and `crew-proposer.md` (full tools). Protocol phases, completion signals, max-rounds guard. |
| **A5** | Orphan cleanup — `session_shutdown` hook dismisses all collaborators spawned by this session. Tracks in module-level Set. |
| **A6** | Max rounds guard — Convention in proposer .md: after 5 exchanges without agreement, escalate to user. |

## Requirements

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Agent can spawn a collaborator subprocess from within a pi session | Core goal |
| R1 | `spawn` blocks until collaborator is on the mesh and reachable — no consumer-side polling | Must-have |
| R2 | Spawning agent can gracefully dismiss collaborator (shutdown msg → grace → SIGTERM) | Must-have |
| R3 | Collaborators exempt from worker message budget (messages ARE the work) | Must-have |
| R4 | Orphan cleanup — collaborators dismissed automatically if spawning agent's session ends | Must-have |
| R5 | Works from CLI — single `pi "<task>"` triggers full collab flow | Must-have |
| R6 | Reuses existing Crew machinery (runAgent, spawn, progress, registry) | Must-have |
| R7 | Protocol is convention in agent .md files, not enforced in code | Must-have |
| R7.1 | Challenger role is read-only (no write/edit tools) | Must-have |
| R7.2 | Spawn prompt gives focused context (specific file paths), not "go ground yourself" | Must-have |
| R7.3 | Completion detection via protocol instruction, not code | Must-have |
| R8 | Max exchange rounds (default 5) with user escalation | Must-have |

## Acceptance Criteria

- [ ] `pi_messenger({ action: "spawn", agent: "crew-challenger", prompt: "..." })` returns `{ name, pid }` with collaborator on the mesh
- [ ] Spawned collaborator receives messages via `send` and responds with `triggerTurn` steering
- [ ] `pi_messenger({ action: "dismiss", name: "..." })` gracefully shuts down collaborator
- [ ] Collaborators are not blocked by message budget (`PI_CREW_COLLABORATOR=1` exemption)
- [ ] Spawning agent's `session_shutdown` auto-dismisses any live collaborators
- [ ] `crew-challenger.md` exists with read-only tool restrictions and protocol
- [ ] `crew-proposer.md` exists with full tools and protocol (or challenger-only ships first since proposer IS the spawning agent)
- [ ] Protocol convention documented with phase markers and completion signals

## Scope Boundary

**In scope:** spawn/dismiss action handlers, budget exemption, agent `.md` files, orphan cleanup, protocol convention.

**Out of scope:** Multiple simultaneous collaborators (v2), progress visibility in overlay (v2), cross-repo collaboration, changes to Crew task orchestration, role negotiation/registry.

## Where code changes live

All in **pi-messenger** repo:
- `crew/index.ts` — route `spawn`/`dismiss` actions
- New handler file (e.g., `crew/handlers/collab.ts`) — spawn/dismiss implementation
- `handlers.ts` — budget exemption in `executeSend()`
- `index.ts` — orphan cleanup in `session_shutdown` hook
- `crew/agents/crew-challenger.md` — new agent definition
