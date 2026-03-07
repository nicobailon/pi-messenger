✅ **DONE: task-5 — Build session lifecycle manager**

Implemented the session lifecycle FSM with:

- **`src/monitor/lifecycle/transitions.ts`** — `isValidTransition(from, to)` backed by a complete transition table (idle→active, active→paused/ended/error, paused→active/ended, error→ended)
- **`src/monitor/lifecycle/manager.ts`** — `SessionLifecycleManager` class with `start()`, `pause()`, `resume()`, `end()`, `getState()`, emitting typed lifecycle events via `SessionEventEmitter`
- **`src/monitor/lifecycle/index.ts`** — barrel exports
- **38 tests passing** across `transitions.test.ts` (19) and `manager.test.ts` (19), covering valid/invalid transitions, event emission with payloads, error messages, sequence ordering, and state consistency