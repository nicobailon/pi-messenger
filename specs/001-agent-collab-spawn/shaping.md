---
shaping: true
---

# Agent-to-Agent Collaboration Spawn — Shaping

**Consumer spec:** `~/.agent-config/specs/008-agent-to-agent-collab/spec.md`
**Participants:** JadeRaven (pi-messenger), JadeGrove (agent-config)

## Source

> Four workflow commands (`/plan`, `/shape`, `/codex-review`, `/implement`) require two participants — a second perspective prevents corner-cutting. Today there is no mechanism for an agent to spawn a collaborator. The only path is manual: the user starts two pi sessions, joins both to the mesh, and hopes they coordinate.

> This breaks at scale. The user has 9+ projects where agents need to collaborate autonomously (Mode 2). An agent working alone hits a two-agent gate and has no way to launch a second agent with a specific role, exchange structured messages, know when collaboration is complete, or dismiss the collaborator when done.

> The plumbing is all there in Crew — subprocess spawning, mesh messaging with triggerTurn, graceful shutdown. The single missing piece is a tool action that exposes the existing runAgent() machinery to a running agent. (JadeRaven code trace, 2026-03-07)

---

## Problem

Agents hit two-participant gates in workflow commands and have no way to spawn a collaborator. They either fall back to the user (breaking autonomy) or skip the gate (breaking quality). This is a daily friction across 9+ projects.

## Outcome

An agent can programmatically spawn a collaborator, exchange structured messages through a protocol, produce artifacts, and dismiss the collaborator — all from a single `pi` session with no user involvement.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Agent can spawn a collaborator subprocess from within a pi session | Core goal |
| R1 | `spawn` blocks until collaborator is on the mesh and reachable — no consumer-side polling | Must-have |
| R2 | Spawning agent can gracefully dismiss collaborator (shutdown msg → grace → SIGTERM) | Must-have |
| R3 | Collaborators exempt from worker message budget (messages ARE the work) | Must-have |
| R4 | Orphan cleanup — collaborators dismissed automatically if spawning agent's session ends | Must-have |
| R5 | Works from CLI — single `pi "<task>"` triggers full collab flow, no manual multi-terminal setup | Must-have |
| R6 | Reuses existing Crew machinery (runAgent, spawn, progress, registry) — not a new system | Must-have |
| R7 | Protocol is convention in agent .md files, not enforced in code | Must-have |
| R7.1 | Challenger role is read-only (no write/edit tools) — only proposer writes artifacts | Must-have |
| R7.2 | Spawn prompt gives collaborator focused context (specific file paths), not "go ground yourself" | Must-have |
| R7.3 | Completion detection via protocol instruction, not code — proposer checks for [AGREE] | Must-have |
| R8 | Max exchange rounds (default 5) with user escalation to prevent infinite loops | Must-have |

---

## Shapes

### A: Thin spawn/dismiss actions wrapping runAgent ✅ SELECTED

Expose the existing `crew/agents.ts:runAgent()` as two new tool actions in the pi_messenger action router.

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **A1** | **`spawn` action** — calls `discoverCrewAgents()`, `generateMemorableName()`, spawns `pi --mode json` subprocess with `PI_AGENT_NAME` + `PI_CREW_COLLABORATOR=1`. **Blocks until collaborator appears in registry** (polls with 30s timeout). Returns `{ name, pid }`. | |
| **A2** | **`dismiss` action** — looks up collaborator by name in registry, sends `SHUTDOWN_MESSAGE` to inbox, waits `shutdownGracePeriodMs`, SIGTERM fallback, unregisters | |
| **A3** | **Budget exemption** — `executeSend()` skips budget check when `PI_CREW_COLLABORATOR=1` env is set | |
| **A4** | **Collaborator agent .md files** — `crew-challenger.md` (read-only tools: read, bash, pi_messenger) and `crew-proposer.md` (full tools). Protocol phases, completion signals, max-rounds guard in system prompt. | |
| **A5** | **Orphan cleanup** — `session_shutdown` hook dismisses all collaborators spawned by this session. Tracks spawned collaborators in module-level Set. | |
| **A6** | **Max rounds guard** — Convention in proposer .md: after N exchanges (configurable, default 5) without agreement, escalate to user with both positions. Not enforced in code. | |

### B: Lobby-based collaborator (reuse lobby pre-warming) ❌ REJECTED

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **B1** | Extend lobby to accept "collaborator" type workers alongside task workers | ⚠️ |
| **B2** | `spawn` sends role-assignment to idle lobby collaborator instead of spawning new process | ⚠️ |
| **B3** | Same dismiss, budget, cleanup as Shape A (A2, A3, A5) | |
| **B4** | Lobby collaborator agent .md with dual-mode protocol (idle → assigned) | ⚠️ |

**Rejected:** Three flagged unknowns. Lobby is designed for task workers — extending it to collaborators requires significant refactoring of lobby lifecycle. Fails R6 (reuses existing machinery).

### C: Message-only protocol (no spawn primitive) ❌ REJECTED

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **C1** | Agent uses `bash({ command: "pi --mode json ... &" })` to spawn collaborator | |
| **C2** | Convention in workflow commands tells agent how to construct the spawn command | |
| **C3** | No progress tracking, no registry, no graceful shutdown — raw subprocess | |
| **C4** | Agent must poll `list` until collaborator appears on mesh | |

**Rejected:** Fails R1 (no name control, must poll), R2 (no graceful shutdown), R3 (no budget exemption), R4 (no orphan tracking). Fragile, unreliable.

---

## Fit Check

| Req | Requirement | Status | A | B | C |
|-----|-------------|--------|---|---|---|
| R0 | Agent can spawn a collaborator from within a pi session | Core goal | ✅ | ✅ | ✅ |
| R1 | `spawn` blocks until collaborator is mesh-ready — no consumer polling | Must-have | ✅ | ✅ | ❌ |
| R2 | Spawning agent can gracefully dismiss collaborator | Must-have | ✅ | ✅ | ❌ |
| R3 | Collaborators exempt from worker message budget | Must-have | ✅ | ✅ | ❌ |
| R4 | Orphan cleanup on spawning agent crash/exit | Must-have | ✅ | ✅ | ❌ |
| R5 | Works from CLI — single `pi "<task>"` triggers full flow | Must-have | ✅ | ✅ | ✅ |
| R6 | Reuses existing Crew machinery, not a new system | Must-have | ✅ | ❌ | ❌ |
| R7 | Protocol is convention in agent .md, not enforced in code | Must-have | ✅ | ✅ | ✅ |
| R7.1 | Challenger is read-only — no write/edit tools | Must-have | ✅ | ✅ | ❌ |
| R7.2 | Collaborator gets focused context (file paths), not full grounding | Must-have | ✅ | ✅ | ✅ |
| R7.3 | Completion detection via protocol instruction | Must-have | ✅ | ✅ | ✅ |
| R8 | Max rounds with user escalation | Must-have | ✅ | ✅ | ✅ |

**Notes:**
- C fails R1: `bash` spawn can't set `PI_AGENT_NAME`; must poll `list` and guess
- C fails R2: No registry → no graceful shutdown → only raw `kill`
- C fails R3: No `PI_CREW_COLLABORATOR` → standard budget applies
- C fails R4: No registry → no orphan detection
- C fails R7.1: No tool restrictions possible via raw `bash` spawn
- B fails R6: Lobby refactoring is building a new system, not reusing existing

---

## Selection Rationale

**Shape A selected.** Passes all 12 requirements. Maps directly to existing Crew code paths. Estimated ~150 lines of new handler code (A1 + A2 + A3 + A5), plus two agent .md files (A4) and protocol convention (A6).

Challenged and confirmed by JadeGrove (consumer perspective). Key refinements from challenge:
- **R1 strengthened:** spawn blocks until mesh-ready (JadeGrove: "consumer shouldn't think about boot timing")
- **R7.1 added:** Challenger read-only to prevent write conflicts (JadeGrove: "if both write to plan.md you get conflicts")
- **R7.2 added:** Focused context over full grounding (JadeGrove: "include exact file paths, not 'go figure out the codebase'")
- **R8 added:** Max rounds with escalation (JadeGrove: "don't let them loop forever")

---

## Open Decisions (for /plan phase)

1. **Spawn parameter design:** Should `spawn` accept a raw prompt string, or structured params like `{ agent, role, context_files, prompt }`?
2. **Multiple collaborators:** Should we support spawning >1 collaborator? (Probably not for v1 — start with exactly one.)
3. **Progress visibility:** Should the spawning agent's overlay show the collaborator's progress? (Nice-to-have, not v1.)
