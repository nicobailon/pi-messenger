# TypeScript Fix Analysis: session-row.ts

## Issue Location
**File:** `src/monitor/ui/session-row.ts`  
**Function:** `attentionText()` (lines 87-100)

## Problem
The `attentionText` function has a switch statement without a default case. TypeScript's control flow analysis doesn't guarantee all code paths return a value, even though the switch appears exhaustive. This can cause compilation errors depending on TypeScript strict mode settings.

```typescript
function attentionText(reason: AttentionReason): string {
  switch (reason) {
    case "waiting_on_human":
      return "waiting on human";
    case "failed_recoverable":
      return "retryable";
    case "stuck":
    case "degraded":
    case "stale_running":
      return "needs attention";
    case "high_error_rate":
      return "high error rate";
    case "repeated_retries":
      return "retrying";
  }
  // No explicit default case - TypeScript may complain
}
```

## Root Cause
When TypeScript's strict mode is enabled with `--noImplicitReturns`, it requires all code paths to explicitly return a value. Without a default case, TypeScript cannot statically verify that the function always returns.

## Minimal Safe Fix

Add a default case that handles the theoretically impossible `never` type:

```typescript
function attentionText(reason: AttentionReason): string {
  switch (reason) {
    case "waiting_on_human":
      return "waiting on human";
    case "failed_recoverable":
      return "retryable";
    case "stuck":
    case "degraded":
    case "stale_running":
      return "needs attention";
    case "high_error_rate":
      return "high error rate";
    case "repeated_retries":
      return "retrying";
    default:
      return reason; // TypeScript infers 'never' here, satisfies return requirement
  }
}
```

## Why This Works
1. **Type Safety:** At the default case, TypeScript narrows `reason` to `never` (no possible values)
2. **Runtime Safety:** If a new `AttentionReason` is added but not handled, it will fall through and return the raw value (degraded but functional)
3. **Minimal Change:** Single line addition, preserves all existing behavior
4. **No Side Effects:** Doesn't throw errors or change control flow

## Alternative (More Explicit)
If you want to make the exhaustiveness check explicit:

```typescript
default: {
  const _exhaustive: never = reason;
  return _exhaustive;
}
```

This makes it clear to future maintainers that this case should never execute.

## Recommended Change
**Location:** Line 100 (after the last case, before the closing brace)

```diff
 function attentionText(reason: AttentionReason): string {
   switch (reason) {
     case "waiting_on_human":
       return "waiting on human";
     case "failed_recoverable":
       return "retryable";
     case "stuck":
     case "degraded":
     case "stale_running":
       return "needs attention";
     case "high_error_rate":
       return "high error rate";
     case "repeated_retries":
       return "retrying";
+    default:
+      return reason;
   }
 }
```

## Verification
After applying the fix:
1. TypeScript compilation should succeed without errors
2. All existing tests should pass unchanged
3. Runtime behavior is identical for all currently defined `AttentionReason` values

✅ **DONE:** Minimal safe fix identified and documented
