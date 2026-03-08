# Scout Report: session-row.ts Compile Error

## ANOMALY DETECTED

**File**: `src/monitor/ui/session-row.ts`  
**Function**: `attentionText(reason: AttentionReason)`  
**Error**: TypeScript narrowing `reason` to `never` in default branch, causing `.replace()` call to fail

## Root Cause Analysis

The `AttentionReason` type (defined in `src/monitor/types/attention.ts`) is a strict enum with exactly 7 values:

```typescript
export const AttentionReasonSchema = z.enum([
  "waiting_on_human",
  "stuck",
  "degraded",
  "high_error_rate",
  "repeated_retries",
  "failed_recoverable",
  "stale_running",
]);
```

The `attentionText` switch statement handles all 7 cases:
1. ✓ `"waiting_on_human"` → `"waiting on human"`
2. ✓ `"failed_recoverable"` → `"retryable"`
3. ✓ `"stuck"` → `"needs attention"`
4. ✓ `"degraded"` → `"needs attention"`
5. ✓ `"stale_running"` → `"needs attention"`
6. ✓ `"high_error_rate"` → `"high error rate"`
7. ✓ `"repeated_retries"` → `"retrying"`

**TypeScript's reasoning**: Since all possible values are explicitly handled, the default case is unreachable. Therefore, `reason` must be of type `never` in that branch, and calling `reason.replace()` is a type error.

## Minimal Fix Options

### Option 1: Remove Default Case (Recommended)

**Rationale**: The default case is provably unreachable. Removing it is the cleanest fix.

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
}
```

**Impact**: None. All valid inputs are handled. TypeScript will error if new enum values are added without updating the switch.

---

### Option 2: Exhaustive Check Pattern (Defensive)

**Rationale**: Preserves runtime safety for unexpected values while satisfying TypeScript.

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
      // Exhaustive check - should never execute
      const _exhaustive: never = reason;
      return String(_exhaustive).replace(/_/g, " ");
  }
}
```

**Impact**: Compiler enforces exhaustiveness. Runtime handles impossible cases gracefully (e.g., corrupted data).

---

### Option 3: Type Assertion (Quick Fix)

**Rationale**: Minimal change, bypasses type checking.

```typescript
default:
  return (reason as string).replace(/_/g, " ");
```

**Impact**: Preserves exact behavior but loses type safety.

---

## Recommendation

**Use Option 1** (remove default case).

**Reasoning**:
- The code is type-safe: `AttentionReason` is a closed enum
- TypeScript will catch if new enum values are added
- No runtime risk: all valid inputs are handled
- Cleaner code: no unreachable branches

**If defensive programming is preferred** (e.g., concerns about Zod validation bypasses or corrupted runtime data), **use Option 2**.

## Files to Modify

- ✏️ `src/monitor/ui/session-row.ts` (lines 92-107)

No other files need changes.

---

## Meta Analysis

<meta>
<architecture>
- Attention system uses Zod schema validation (`AttentionReasonSchema`)
- UI rendering layer (`session-row.ts`) consumes typed enums
- Type narrowing enforces exhaustive pattern matching
</architecture>

<patterns>
- Zod schemas define runtime validation + TypeScript types
- UI utility functions use switch statements for enum mapping
- ANSI color utilities for terminal rendering
</patterns>

<gotchas>
- **Type narrowing strictness**: TypeScript 5.x aggressively narrows exhaustive switches to `never`
- **Zod enum changes**: Adding new `AttentionReason` values will cause compile errors in switch statements (this is a feature, not a bug)
</gotcas>

<task_recommendations>
- This is a single-line fix (remove default case or add exhaustive check)
- No need for worker dispatch
- No tests to update (pure type fix)
- Consider linting rule to enforce exhaustive switches project-wide
</task_recommendations>
</meta>

---

✅ DONE: Identified TypeScript narrowing issue in `attentionText` switch statement. All enum cases already handled; default branch is unreachable. Recommended fix: remove default case (lines 104-105).
