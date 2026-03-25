---
title: "Deploy Parity — Tasks"
date: 2026-03-25
bead: pi-messenger-3c6
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T16:24:25Z -->
<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-25 -->
<!-- Status: RECONCILED -->
<!-- Revisions: console.error for failures, fail-closed settings parse, health check pure bash with fail-on-unresolvable, HOME-based test isolation, AC coverage complete -->

# 011 — Tasks

## Dependencies

```
Task 1+2 (install.mjs fix) — do together
Task 3 (health-check.sh) — independent
Task 4 (setup-machine.sh) — depends on Task 3
Task 5 (post-receive) — depends on Tasks 1-3 (collision guard must be in pushed code)
Task 6 (verify) — depends on all
```

## Tasks

- [x] **Task 1+2: Fix install.mjs collision guard + three-way resolution**
  - Match: `name === "pi-messenger" || name.startsWith("pi-messenger-")`
  - New `resolveSettingsEntry(entry)` function: npm/absolute/relative
  - Move `installCliWrapper()` inside collision block with resolved path
  - Preserve two-branch pattern: wrapper success → exit(0), wrapper fail → exit(1)
  - Dedicated try/catch for resolveSettingsEntry (no fall-through to extension copy)
  - File: `install.mjs`

- [x] **Task 3: Create `scripts/health-check.sh`**
  - Pure bash, no node dependency
  - Checks: which pi-messenger-cli, parse wrapper SOURCE_DIR + JITI_PATH, version comparison, settings.json entry
  - `--quiet` flag, exit 0/1
  - Grep pattern: `pi-messenger` (not bare "messenger")
  - File: `scripts/health-check.sh`

- [x] **Task 4: Create `scripts/setup-machine.sh`**
  - Takes `[path]` argument (CWD default), resolves to absolute
  - Validates package.json name === "pi-messenger"
  - Adds to settings.json via env vars (no shell→JS injection)
  - Runs install.mjs + health-check.sh as verification gate
  - File: `scripts/setup-machine.sh`

- [ ] **Task 5: Update mini-ts post-receive hook**
  - Add `node install.mjs >/dev/null` (keep stderr visible)
  - Add `bash scripts/health-check.sh --quiet` with marker file on failure
  - Remove marker on success
  - File: `mini-ts:~/dev/pi-messenger-fork/.git/hooks/post-receive`

- [ ] **Task 6: Verify on both machines**
  - Push after install.mjs fix → mini-ts CLI works
  - health-check.sh all green on laptop + mini-ts
  - No stale extensions copy on mini-ts
  - `scripts/test-deploy.sh` integration test passes
