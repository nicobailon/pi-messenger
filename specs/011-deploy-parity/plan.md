---
title: "Deploy Parity — Implementation Plan"
date: 2026-03-25
bead: pi-messenger-3c6
---

<!-- plan:complete:v1 | harness: pi/claude-opus-4-6 | date: 2026-03-25T16:24:25Z -->

# 011 — Implementation Plan

## Task 1+2: install.mjs Collision Guard Fix + Three-Way Resolution

**File:** `install.mjs`

### 1a. Match fix (line 244)

```js
// OLD
return name === "pi-messenger";
// NEW
return name === "pi-messenger" || name.startsWith("pi-messenger-");
```

### 1b. New function: `resolveSettingsEntry(entry)`

Insert after `resolveBrewBinDir()` (~line 83):

```js
function resolveSettingsEntry(entry) {
  if (entry.startsWith("npm:")) {
    const npmPrefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf-8" }).trim();
    return path.join(npmPrefix, "lib", "node_modules", entry.slice(4));
  }
  if (path.isAbsolute(entry)) return entry;
  const settingsDir = path.join(os.homedir(), ".pi", "agent");
  return path.resolve(settingsDir, entry);
}
```

### 1c. Restructure wrapper creation + collision guard (~lines 227-265)

**Critical change:** Move `installCliWrapper()` inside collision block. Preserve two-branch pattern for wrapper failure. Add dedicated try/catch for resolveSettingsEntry.

```js
// ─── Collision guard ─────────────────────────────────────
const isForce = args.includes("--force") || args.includes("-f");
const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");

if (!isForce && fs.existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const packages = settings.packages ?? [];
    const collision = packages.find((entry) => {
      if (typeof entry !== "string") return false;
      const name = entry.startsWith("npm:") ? entry.slice(4) : path.basename(entry);
      return name === "pi-messenger" || name.startsWith("pi-messenger-");
    });
    if (collision) {
      let resolved;
      try {
        resolved = resolveSettingsEntry(collision);
      } catch (err) {
        console.error(`⚠ Cannot resolve settings.json entry "${collision}": ${err.message}`);
        console.error("Extension copy skipped to avoid collision. CLI wrapper not updated.");
        process.exit(1);
      }
      if (installCliWrapper(resolved)) {
        console.log(`⚠ Extension copy skipped (already registered at ${collision}).`);
        console.log(`CLI:      pi-messenger-cli → ${CLI_WRAPPER_PATH}`);
        process.exit(0);
      }
      console.log(`⚠ pi-messenger registered at ${collision} but CLI wrapper failed (jiti not found).`);
      console.log("Install pi first, then re-run: node install.mjs");
      process.exit(1);
    }
  } catch { /* settings.json parse error — proceed with install */ }
}

// No collision — standard install path
const wrapperCreated = installCliWrapper(PACKAGE_DIR);
```

## Task 3: `scripts/health-check.sh`

**New file.** Pure bash, no node dependency. Checks all R2 items:
- `which pi-messenger-cli` — CLI reachable
- Parse wrapper SOURCE_DIR — path exists, cli/index.ts exists
- Parse wrapper JITI_PATH — file exists
- Version comparison: wrapper SOURCE_DIR package.json vs CWD package.json
- Settings.json contains `pi-messenger` entry

`--quiet` flag suppresses pass messages. Exit 0 = healthy, exit 1 = problems.

**Grep pattern:** `grep -q 'pi-messenger'` (not bare "messenger").

## Task 4: `scripts/setup-machine.sh [path]`

**New file.** Takes optional repo path (CWD default).
- Validates package.json name === "pi-messenger"
- Adds absolute path to settings.json if missing (via `SETTINGS=... REPO_PATH=... node -e` with env vars, not shell interpolation)
- Runs `node install.mjs`
- Runs `scripts/health-check.sh` as verification gate

## Task 5: Update mini-ts post-receive hook

**Remote file:** `mini-ts:~/dev/pi-messenger-fork/.git/hooks/post-receive`

Add after npm install block:

```bash
# Ensure CLI wrapper + Homebrew symlink are current
info "Running install.mjs..."
if node install.mjs >/dev/null; then  # stdout suppressed, stderr visible
    ok "install.mjs complete"
else
    warn "install.mjs failed — see above"
fi

# Health check (failures write to stderr + marker file)
if bash scripts/health-check.sh --quiet; then
    rm -f "$REPO_DIR/.pi-messenger-health-failed"
else
    touch "$REPO_DIR/.pi-messenger-health-failed"
    warn "Health check failed — marker: $REPO_DIR/.pi-messenger-health-failed"
fi
```

**Stderr preserved:** `>/dev/null` suppresses stdout only. install.mjs diagnostic messages go to stderr and are piped back to the pusher's terminal by git.

## Task 6: Verification

### 6a. Manual verification
- Push after collision guard fix → verify mini-ts CLI works
- Run health-check.sh on both machines → all green
- Verify no extensions copy on mini-ts

### 6b. `scripts/test-deploy.sh` — automated integration test
- Creates temp dir with mock settings.json containing `pi-messenger-fork` entry
- Runs install.mjs with PI_AGENT_HOME override → verifies collision detected, no extensions copy
- Runs health-check.sh → verifies exit 0
- Cleans up

## Requirement Traceability

| Requirement | Tasks |
|-------------|-------|
| R0 (identical after push) | 5 |
| R1 (post-receive runs install.mjs) | 5 |
| R2 (standalone health check) | 3 |
| R3 (first-time setup) | 4 |
| R4 (collision guard variants) | 1a |
| R5 (wrapper → settings.json path) | 1b, 1c |
| R6 (zero manual steps) | 5 |
| R7 (post-receive from worktree) | 5 (existing hook already handles) |
