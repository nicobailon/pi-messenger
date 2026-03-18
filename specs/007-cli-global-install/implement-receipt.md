---
baseline_sha: 675a869fad27aeb5bf46a8f1e760501c42f4e8b0
end_sha: 34bc3fd2d5a2595ac56dad2f586a5b7e3f199851
test_command: "npx vitest run"
test_result: pass
test_count: 486
---

# Implementation Receipt

## Changed Files

```
crew/runtime-spawn.ts
install.mjs
tests/crew/adapters.test.ts
tests/crew/cli-wrapper.test.ts
```

## Commits (4)

1. `e9d9a8d` — feat(007): add jiti resolver + CLI wrapper function to install.mjs
2. `fcdbe79` — feat(007): unconditional CLI wrapper cleanup in --remove
3. `ec605ad` — feat(007): wire wrapper creation + collision guard exit 0
4. `2450d3a` — feat(007): CLI hard error in runtime-spawn for non-pi workers
5. `34bc3fd` — test(007): CLI wrapper + spawn validation + AC5 crew-spawned tests

## Test Output Summary

- 486 tests across 32 test files — all passed
- 9 new tests added:
  - 3 wrapper creation/removal (content, permissions, idempotent)
  - 2 graceful failure (stale jiti, missing source)
  - 3 spawn-time CLI validation (throws, skipCommandCheck, pi-skips)
  - 1 AC5 crew-spawned integration (pre-registration + status via wrapper)
- All 477 existing tests continue to pass

## Production Code Changes (~80 lines)

- `install.mjs`: Constants (BIN_DIR, CLI_WRAPPER_PATH), resolveJitiPath() via npm prefix -g,
  installCliWrapper() with bash wrapper + graceful failure, unconditional --remove cleanup,
  collision guard exits 0 when wrapper succeeds, post-copyDir wrapper update
- `crew/runtime-spawn.ts`: CLI validation as hard error in constructed worker env after
  adapter.buildEnv(), respects skipCommandCheck

## Manual Smoke Test Results

- `node install.mjs` → exit 0, wrapper created at ~/.pi/agent/bin/pi-messenger-cli
- `which pi-messenger-cli` → /Users/dalecarman/.pi/agent/bin/pi-messenger-cli
- `pi-messenger-cli --help` from /tmp → works
- `node install.mjs --remove` → wrapper + extension cleaned up
- Re-install → wrapper recreated
