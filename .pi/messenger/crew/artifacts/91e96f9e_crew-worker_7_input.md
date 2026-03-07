# Task for crew-worker

# Task Assignment

**Task ID:** task-8
**Task Title:** Implement session metrics aggregation
**PRD:** Build a Pi-native session monitor with exactly 14 tasks o...



## Your Mission

Implement this task following the crew-worker protocol:
1. Join the mesh
2. Read task spec to understand requirements
3. Start task and reserve files
4. Implement the feature
5. Commit your changes
6. Release reservations and mark complete

## Progress from Prior Attempts

[2026-03-07T21:23:30.555Z] (system) Assigned to BrightHawk via crew-worker (attempt 1)

## Dependency Status

Your task has dependencies on other tasks. Some may not be complete yet — this is expected. Use the coordination system to work through it.

- ⟳ task-3 (Implement session state store) — in progress, worker: BrightCastle
- ⟳ task-4 (Implement session event emitter) — in progress, worker: SwiftIce

**Working with pending dependencies:**
- Check if the dependency's output files exist. If yes, import and use them.
- If not, define what you need locally based on your task spec. Your spec describes the interfaces.
- DM in-progress workers for API details they're building.
- Reserve your files before editing to prevent conflicts.
- Do NOT block yourself because a dependency isn't done. Work around it.
- Log any local definitions in your progress for later reconciliation.

## Concurrent Tasks

These tasks are being worked on by other workers in this wave. Discover their agent names after joining the mesh via `pi_messenger({ action: "list" })`.

- task-1: Define canonical session and operator state model
- task-2: Define pi-native session stream and structured event schema
- task-3: Implement session state store
- task-4: Implement session event emitter
- task-5: Build session lifecycle manager
- task-6: Define operator action types and command schema
- task-7: Build real-time session feed subscriber
- task-9: Build operator command handler
- task-10: Session health monitor and alerting
- task-11: Build session monitor UI component (pi TUI panel)
- task-12: Implement session replay from event log
- task-13: Session export and reporting
- task-14: End-to-end integration tests

## Task Specification

# Implement session metrics aggregation

Compute real-time metrics from session event stream and state store.

Files to create:
- src/monitor/metrics/aggregator.ts — Class SessionMetricsAggregator with methods: computeMetrics(sessionId), getErrorRate(sessionId), getEventCounts(sessionId), getActiveDuration(sessionId), subscribe(sessionId, handler): () => void. Subscribes to event emitter and state store.
- src/monitor/metrics/index.ts — Barrel export.
- tests/monitor/metrics/aggregator.test.ts — Metric computation, error rate calculation, duration tracking (excludes pauses), real-time subscription updates.

Exported symbols: SessionMetricsAggregator, createSessionMetricsAggregator.

Acceptance criteria:
- npx vitest run tests/monitor/metrics/ passes with ≥10 test cases
- Duration excludes paused intervals
- Error rate = error events / total events
- Metrics update in real-time on new events


## Plan Context

Now I have a thorough understanding of the codebase. Let me produce the task breakdown following the exact section order requested.

---

## 1. PRD Understanding Summary

The request asks for a **Pi-native session monitor** — a new module at `src/monitor/` that provides structured session lifecycle management, real-time event streaming, operator control, health monitoring, and a TUI panel. The feature is organized into exactly **14 tasks across 4 dependency layers** (Layer 0–3), forming a DAG that maximizes parallelism within each wave. The `src/monitor/` directory is entirely greenfield — no existing code exists there. The project currently uses TypeBox for schema validation (in `index.ts`), but the request specifies **Zod schemas**, which would be a new dependency. The existing codebase has established patterns: file-backed JSON stores (`crew/store.ts`, `store.ts`), typed event feeds (`feed.ts` with JSONL), EventEmitter wrappers in tests, TUI overlay components (`overlay.ts`, `overlay-render.ts`), and vitest for testing. The 14 tasks cover: schema definitions (L0), core infrastructure (L1), aggregation & command handling (L2), and UI/replay/export/integration (L3).

## 2. Relevant Code/Docs/Resources Reviewed

| Resource | Key Finding |
|----------|-------------|
| `package.json` | Project uses vitest, ES2022 target, `"type": "module"`. No zod dependency — must be added. |
| `tsconfig.json` | `moduleResolution: "NodeNext"`, `noEmit: true`, `strict: false`. Paths alias pi-coding-agent and pi-tui. `include` only covers `*.ts` at root — must extend to `src/**/*.ts`. |
| `index.ts:14` | Uses `@sinclair/typebox` for schema validation (StringEnum helper). Zod would be a new pattern. |
| `crew/types.ts` | Existing type pattern: plain TypeScript interfaces (`Plan`, `Task`, `TaskStatus`). No runtime validation. |
| `crew/store.ts` | File-backed JSON store with `readJson`/`writeJson` helpers, temp-file atomic writes, directory helpers. Pattern to follow. |
| `store.ts` | Ag

[Spec truncated - read full spec from .pi/messenger/crew/plan.md]
## Coordination

**Message budget: 10 messages this session.** The system enforces this — sends are rejected after the limit.

**Broadcasts go to the team feed — only the user sees them live.** Other workers see your broadcasts in their initial context only. Use DMs for time-sensitive peer coordination.

### Announce yourself
After joining the mesh and starting your task, announce what you're working on:

```typescript
pi_messenger({ action: "broadcast", message: "Starting <task-id> (<title>) — will create <files>" })
```

### Coordinate with peers
If a concurrent task involves files or interfaces related to yours, send a brief DM. Only message when there's a concrete coordination need — shared files, interfaces, or blocking questions.

```typescript
pi_messenger({ action: "send", to: "<peer-name>", message: "I'm exporting FormatOptions from types.ts — will you need it?" })
```

### Responding to messages
If a peer asks you a direct question, reply briefly. Ignore messages that don't require a response. Do NOT start casual conversations.

### On completion
Announce what you built:

```typescript
pi_messenger({ action: "broadcast", message: "Completed <task-id>: <file> exports <symbols>" })
```

### Reservations
Before editing files, check if another worker has reserved them via `pi_messenger({ action: "list" })`. If a file you need is reserved, message the owner to coordinate. Do NOT edit reserved files without coordinating first.

### Questions about dependencies
If your task depends on a completed task and something about its implementation is unclear, read the code and the task's progress log at `.pi/messenger/crew/tasks/<task-id>.progress.md`. Dependency authors are from previous waves and are no longer in the mesh.

### Claim next task
After completing your assigned task, check if there are ready tasks you can pick up:

```typescript
pi_messenger({ action: "task.ready" })
```

If a task is ready, claim and implement it. If `task.start` fails (another worker claimed it first), check for other ready tasks. Only claim if your current task completed cleanly and quickly.

