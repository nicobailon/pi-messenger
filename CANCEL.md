# Cancelling and Recovering Crew Work

## Stopping an Autonomous Wave

When `pi_messenger({ action: "work", autonomous: true })` is running, the current
wave finishes normally when you press **Ctrl+C** — in-progress workers are sent a
graceful shutdown signal and the loop stops before the next wave starts.

To stop immediately without waiting for the current wave to drain, kill the Pi
session (close the terminal or send SIGKILL). Workers that are mid-flight will be
left in `in_progress` status, but the **auto-recovery** described below handles this.

## Manually Resetting a Stuck Task

If a specific task is stuck in `in_progress` (e.g. you killed the worker mid-run),
reset it manually:

```js
pi_messenger({ action: "task.reset", id: "task-3" })
```

This sets the task back to `todo` so it will be picked up on the next `work` call.

To reset all tasks in a plan at once, reset them one by one or re-run the plan
action (which preserves done tasks but reschedules anything not yet complete).

## Auto-Recovery on Next `work` Call

Starting from the crew resilience fix, **every `work` invocation automatically
reconciles orphaned tasks** before dispatching new workers.

A task is considered orphaned when:
- Its status is `in_progress`, `starting`, or `assigned`, AND
- Its worker lease has expired (no heartbeat in the last 30 s), OR
- Its recorded PID is no longer alive on the OS.

Recovered tasks are reset to `todo` and a feed event is emitted:

```
[crew] reconciler reset 2 orphaned task(s): task-3, task-5
```

This means **killing the Pi session** or losing a worker mid-flight is safe —
the next `work` call (or the autonomous loop's `agent_end` handler) will
auto-recover the tasks and continue from where they left off.

## Real-Time Recovery (Health Monitor)

In addition to wave-boundary reconciliation, a **health monitor alert handler**
watches for critical-severity signals during a running wave. When a worker session
goes critical and its lease is stale or its PID is dead, the task is immediately
reset to `todo` without waiting for the current wave to finish.

This provides sub-wave recovery: if a worker dies partway through a long wave,
another worker slot can pick up its task before the wave ends.

## Worker Timeout

Workers are subject to a maximum runtime (default **15 minutes**). A worker that
exceeds this limit receives a SIGTERM. The task will be reset by the reconciler on
the next wave.

To adjust the timeout, set `workerTimeoutMs` in your crew config:

```json
{
  "work": {
    "workerTimeoutMs": 1800000
  }
}
```

Setting `workerTimeoutMs` to `0` or omitting it disables the timeout (default: 15 minutes).
