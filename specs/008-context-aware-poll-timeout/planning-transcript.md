---
title: "Planning transcript — spec 008 context-aware poll timeout"
date: 2026-03-18
bead: pi-messenger-26f
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-18T18:18:33Z -->

# Planning Transcript: Spec 008

**Driver:** TrueBear (pi/claude-opus-4-6)
**Challenger:** SwiftCastle (crew-challenger, claude-opus-4-6)

## Driver's Research Findings

Before spawning the challenger, TrueBear completed codebase research:

### Code Analysis

1. **PollOptions interface** (`crew/handlers/collab.ts:60-73`): Has `stallThresholdMs` and `pollTimeoutMs` but no context awareness.
2. **pollForCollaboratorMessage** (`crew/handlers/collab.ts:88`): Single function for both spawn and send.
3. **D5 absolute timeout** (`crew/handlers/collab.ts:253-265`): `if (now - startTime >= resolvedPollTimeoutMs)` — fires unconditionally.
4. **Log-based stall detection** (`crew/handlers/collab.ts:228-250`): Correctly handles spawn (active log growth resets timer). Gated on `if (entry.logFile)`.
5. **executeSpawn poll call** (`crew/handlers/collab.ts:495-503`): Passes `pollTimeoutMs` from config.
6. **executeSend poll call** (`handlers.ts:403-414`): Same config path, same default.
7. **Config type** (`crew/utils/config.ts:90`): `collaboration: { stallThresholdMs: number; pollTimeoutMs: number }` — defaults to `{ 120_000, 300_000 }`.
8. **Existing tests** (`tests/crew/collab-blocking.test.ts`): 39 tests, 23 direct `pollForCollaboratorMessage` calls. D5 tests at line 603-687.
9. **logFile can be null** (`crew/handlers/collab.ts:413-420`): `fs.openSync` is in a try/catch with silent fallthrough.

### Original Proposed Fix

Add `context: "spawn" | "send"` to PollOptions, gate D5 with `if (opts.context !== "spawn" && ...)`.

## Challenger's Response (SwiftCastle)

Four concerns raised:

### Concern 1: Unbounded spawn risk
Fully disabling D5 for spawn creates a new failure mode — a collaborator producing log output but never sending a message (infinite retry loop with logging) would run forever. Recommended a spawn-specific ceiling (15 min) instead of full D5 exemption.

### Concern 2: 23 existing test call sites need updating
Making `context` required means all 23 existing poll calls in tests need a `context` field added. This was omitted from the implementation estimate.

### Concern 3: Dead parameter
After gating D5, `pollTimeoutMs` passed from executeSpawn would be silently ignored — misleading to future developers.

### Concern 4: Spawn with no log file
If logFile is null (fs.openSync failure), spawn would have zero timeout protection — no log-stall detection AND no D5.

## Driver's Revision

Realized the fix is simpler than originally proposed:

**No new `context` field needed.** `pollTimeoutMs` is already a per-call parameter. executeSpawn just needs to pass a LARGER value. The mechanism already supports differentiated timeouts — we're just using the same default for both callers.

Revised approach:
1. Add `spawnPollTimeoutMs` to config (default 900_000 = 15 min)
2. executeSpawn reads `spawnPollTimeoutMs` instead of `pollTimeoutMs`
3. executeSend continues reading `pollTimeoutMs` (unchanged, 300s)
4. No D5 gating, no context field, no type changes to PollOptions

This resolves all 4 concerns:
- Concern 1: Spawn has a 900s ceiling — generous but bounded
- Concern 2: No PollOptions change → 0 existing test modifications
- Concern 3: pollTimeoutMs is not dead — it's 900s for spawn, fires eventually
- Concern 4: Spawn with no logFile has D5 at 900s — not worse than today's 300s

## Challenger's Verification (SwiftCastle)

Built a scenario table covering all 5 key cases:

| Scenario | Log-stall (120s) | D5 | Outcome |
|---|---|---|---|
| Spawn, active log growth, 400s | Never fires | Doesn't fire (< 900s) | ✅ |
| Spawn, log stops at 200s | Fires at 320s | Doesn't fire | ✅ |
| Spawn, heartbeat drip | Never fires | Fires at 900s | ✅ |
| Send, heartbeat drip | Never fires | Fires at 300s | ✅ |
| Spawn, no log file | Skipped | Fires at 900s | ✅ |

**Approved with 2 minor notes:**
1. Config type needs `spawnPollTimeoutMs` added
2. Spec R0 wording needs updating (D5 still applies to spawn, just with larger timeout)

## Outcome

Original fix: add `context` field + gate D5 logic.
Revised fix: pass different `pollTimeoutMs` values per caller. Simpler, no new types, backward compatible.
