# Scout Progress: session-row.ts Compile Error

**Task**: Inspect compile error in `src/monitor/ui/session-row.ts`  
**Scout**: Arline  
**Status**: ✅ Complete

## Investigation Steps

1. ✅ Read `src/monitor/ui/session-row.ts` (110 lines)
2. ✅ Identified `attentionText()` function with type narrowing issue
3. ✅ Read `src/monitor/types/attention.ts` to understand `AttentionReason` enum
4. ✅ Analyzed exhaustive switch coverage
5. ✅ Formulated minimal fix options

## Findings Summary

**Root Cause**: All 7 `AttentionReason` enum values are explicitly handled in the switch statement, so TypeScript narrows the `default` branch parameter to `never`, making `reason.replace()` a type error.

**Recommended Fix**: Remove the unreachable default case (lines 104-105).

**Alternative**: Use exhaustive check pattern if defensive runtime handling is required.

## Files Analyzed

- `src/monitor/ui/session-row.ts` (110 lines)
- `src/monitor/types/attention.ts` (24 lines)

## Output

- ✅ Detailed analysis written to `context.md`
- ✅ Three fix options provided with impact analysis
- ✅ Recommendation: Option 1 (remove default case)

## Token Budget

- Files read: 2
- Lines analyzed: ~134
- Output: ~4.7KB (context.md)
- Tool calls: 3
- Estimated tokens: ~6K

**Status**: Well within budget, no overflow needed.

---

**Next Step**: Worker can apply recommended fix (delete lines 104-105 in `session-row.ts`).
