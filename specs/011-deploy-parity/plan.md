---
title: "Deploy Parity — Implementation Plan"
date: 2026-03-25
bead: pi-messenger-3c6
---

<!-- plan:complete:v1 | restored-by: codex-review | harness: codex/gpt-5.3-codex | date: 2026-03-25T16:48:08Z -->

<!-- Codex Review: APPROVED after 4 rounds | model: gpt-5.3-codex | date: 2026-03-25 -->
<!-- Status: REVISED -->
<!-- Revisions: collision guard startsWith + three-way resolution, console.error for failures, fail-closed settings parse, pure bash health check, HOME-based test isolation, explicit fail on unresolvable entry, post-receive with health-check + marker, AC coverage complete -->

# Plan (Implementation) — All Revisions Incorporated

## Task 1+2: install.mjs Collision Guard Fix + Three-Way Resolution

**File:** `install.mjs`

### 1a. Match fix (line 244)
```js
// OLD
return name === "pi-messenger";
// NEW
return name === "pi-messenger" || name.startsWith("pi-messenger-");
```

### 1b. New function `resolveSettingsEntry(entry)` — insert after resolveBrewBinDir (~line 83)
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

### 1c. Restructure wrapper + collision guard (~lines 227-265)

**Critical changes:**
- Move `installCliWrapper()` INSIDE collision block (not before)
- On collision: resolve settings entry → pass to installCliWrapper
- Two-branch: wrapper success → exit(0), wrapper fail → exit(1)
- **All failure messages use `console.error`** (not console.log) — survives `>/dev/null` stdout suppression
- **Malformed settings.json → fail closed** (exit 1) unless --force
- Dedicated try/catch for resolveSettingsEntry (no fall-through)

```js
const isForce = args.includes("--force") || args.includes("-f");
const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");

if (!isForce && fs.existsSync(settingsPath)) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (e) {
    // Fail closed — malformed settings.json could hide a collision
    console.error(`⚠ Cannot parse ${settingsPath}: ${e.message}`);
    process.exit(1);
  }
  if (settings) {
    const packages = settings.packages ?? [];
    const collision = packages.find((entry) => {
      if (typeof entry !== "string") return false;
      const name = entry.startsWith("npm:") ? entry.slice(4) : path.basename(entry);
      return name === "pi-messenger" || name.startsWith("pi-messenger-");
    });
    if (collision) {
      let resolved;
      try { resolved = resolveSettingsEntry(collision); }
      catch (err) {
        console.error(`⚠ Cannot resolve "${collision}": ${err.message}`);
        console.error("Extension copy skipped. CLI wrapper not updated.");
        process.exit(1);
      }
      if (installCliWrapper(resolved)) {
        console.log(`⚠ Extension copy skipped (registered at ${collision}).`);
        console.log(`CLI:      pi-messenger-cli → ${CLI_WRAPPER_PATH}`);
        process.exit(0);
      }
      console.error(`⚠ Registered at ${collision} but CLI wrapper failed (jiti not found).`);
      console.error("Install pi first, then re-run: node install.mjs");
      process.exit(1);
    }
  }
}

// No collision — standard install path
const wrapperCreated = installCliWrapper(PACKAGE_DIR);
```

## Task 3: `scripts/health-check.sh` — Pure Bash (NO node dependency)

**New file.** All checks use bash builtins, grep, sed. No `node -e`.

```bash
#!/usr/bin/env bash
set -euo pipefail
QUIET=false; [[ "${1:-}" == "--quiet" ]] && QUIET=true
FAIL=0
ok()   { $QUIET || echo -e "  ✓ $1"; }
fail() { echo -e "  ✗ $1" >&2; FAIL=1; }
$QUIET || echo "pi-messenger health check"

# 1. CLI reachable
if command -v pi-messenger-cli >/dev/null 2>&1; then
  ok "pi-messenger-cli in PATH"
else
  fail "pi-messenger-cli not found. Run: node install.mjs"
fi

# 2. Parse wrapper SOURCE_DIR + JITI_PATH
WRAPPER=$(command -v pi-messenger-cli 2>/dev/null || true)
SOURCE_DIR="" JITI_PATH=""
if [[ -n "$WRAPPER" ]]; then
  # Follow symlink to actual file
  WRAPPER=$(readlink -f "$WRAPPER" 2>/dev/null || realpath "$WRAPPER" 2>/dev/null || echo "$WRAPPER")
  SOURCE_DIR=$(grep '^SOURCE_DIR=' "$WRAPPER" 2>/dev/null | head -1 | sed 's/^SOURCE_DIR="//;s/"$//')
  JITI_PATH=$(grep '^JITI_PATH=' "$WRAPPER" 2>/dev/null | head -1 | sed 's/^JITI_PATH="//;s/"$//')
fi

# 3. SOURCE_DIR valid
if [[ -n "$SOURCE_DIR" && -d "$SOURCE_DIR" ]]; then
  ok "SOURCE_DIR exists: $SOURCE_DIR"
  if [[ -f "$SOURCE_DIR/cli/index.ts" ]]; then
    ok "cli/index.ts found"
  else
    fail "cli/index.ts missing at $SOURCE_DIR"
  fi
else
  [[ -n "$WRAPPER" ]] && fail "SOURCE_DIR missing or invalid: ${SOURCE_DIR:-<empty>}"
fi

# 4. JITI valid
if [[ -n "$JITI_PATH" && -f "$JITI_PATH" ]]; then
  ok "jiti exists: $JITI_PATH"
else
  [[ -n "$WRAPPER" ]] && fail "jiti missing: ${JITI_PATH:-<empty>}. Reinstall pi."
fi

# 5. Version comparison (wrapper SOURCE_DIR vs CWD)
if [[ -n "$SOURCE_DIR" && -f "$SOURCE_DIR/package.json" ]]; then
  WRAPPER_VER=$(grep '"version"' "$SOURCE_DIR/package.json" | head -1 | sed 's/.*: "//;s/".*//')
  CWD_VER=""
  [[ -f "$(pwd)/package.json" ]] && CWD_VER=$(grep '"version"' "$(pwd)/package.json" | head -1 | sed 's/.*: "//;s/".*//')
  if [[ -n "$CWD_VER" && "$WRAPPER_VER" != "$CWD_VER" ]]; then
    fail "Version mismatch: wrapper=$WRAPPER_VER cwd=$CWD_VER"
  elif [[ -n "$CWD_VER" ]]; then
    ok "Version match: $WRAPPER_VER"
  fi
fi

# 6. Settings.json entry + path resolution + SOURCE_DIR match
SETTINGS="$HOME/.pi/agent/settings.json"
if [[ -f "$SETTINGS" ]]; then
  # Extract pi-messenger entry using bash-only parsing (no node)
  PM_ENTRY=""
  while IFS= read -r line; do
    entry=$(echo "$line" | tr -d '"' | xargs)
    base="${entry##*/}"
    # Strip npm: prefix for matching
    [[ "$entry" == npm:* ]] && base="${entry#npm:}"
    if [[ "$base" == "pi-messenger" || "$base" == pi-messenger-* ]]; then
      PM_ENTRY="$entry"
      break
    fi
  done < <(grep -o '"[^"]*"' "$SETTINGS")

  if [[ -z "$PM_ENTRY" ]]; then
    fail "settings.json missing pi-messenger entry"
  else
    ok "settings.json entry: $PM_ENTRY"

    # Resolve entry to canonical path (three-way, pure bash)
    RESOLVED=""
    case "$PM_ENTRY" in
      npm:*)
        local_prefix=$(npm prefix -g 2>/dev/null || true)
        [[ -n "$local_prefix" ]] && RESOLVED="$local_prefix/lib/node_modules/${PM_ENTRY#npm:}"
        ;;
      /*)
        RESOLVED="$PM_ENTRY"
        ;;
      *)
        # Relative to settings.json directory
        RESOLVED="$(cd "$HOME/.pi/agent" 2>/dev/null && cd "$(dirname "$PM_ENTRY")" 2>/dev/null && echo "$(pwd)/$(basename "$PM_ENTRY")")"
        ;;
    esac

    if [[ -z "$RESOLVED" ]]; then
        fail "Cannot resolve settings entry: $PM_ENTRY"
      elif [[ -n "$SOURCE_DIR" ]]; then
      RESOLVED_REAL=$(cd "$RESOLVED" 2>/dev/null && pwd || echo "$RESOLVED")
      SOURCE_REAL=$(cd "$SOURCE_DIR" 2>/dev/null && pwd || echo "$SOURCE_DIR")
      if [[ "$RESOLVED_REAL" == "$SOURCE_REAL" ]]; then
        ok "Wrapper SOURCE_DIR matches settings.json path"
      else
        fail "Wrapper SOURCE_DIR ($SOURCE_DIR) != settings.json path ($RESOLVED)"
      fi
    fi
  fi
fi

exit $FAIL
```

## Task 4: `scripts/setup-machine.sh [path]`

Uses env vars for JSON manipulation (no shell→JS injection):
```bash
SETTINGS="$SETTINGS" REPO_PATH="$REPO_PATH" node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync(process.env.SETTINGS, 'utf-8'));
  s.packages = s.packages || [];
  s.packages.push(process.env.REPO_PATH);
  fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2));
"
```

## Task 5: Post-receive hook — Full B3/B6

```bash
# Ensure CLI wrapper + Homebrew symlink are current
info "Running install.mjs..."
if node install.mjs >/dev/null; then  # stdout suppressed, stderr (console.error) visible
    ok "install.mjs complete"
else
    warn "install.mjs failed — see stderr above"
fi

# Health check (failures write to stderr + marker file)
if bash scripts/health-check.sh --quiet; then
    [ -f "$REPO_DIR/.pi-messenger-health-failed" ] && command rm -f "$REPO_DIR/.pi-messenger-health-failed" 2>/dev/null || true
else
    touch "$REPO_DIR/.pi-messenger-health-failed"
    warn "Health check failed — marker: $REPO_DIR/.pi-messenger-health-failed"
fi
```

## Task 6: Verification — test-deploy.sh

Uses `HOME` override (not PI_AGENT_HOME) for isolation. `os.homedir()` respects `HOME` on Node.js/macOS.

**AC3:** setup-machine.sh adds entry to settings.json
**AC4:** no extensions copy created (collision guard fires)
**AC5:** wrapper SOURCE_DIR matches repo path
**AC6:** Combined install.mjs + health-check.sh timed — must be <= 3s:
```bash
START=$(date +%s)
node "$REPO_DIR/install.mjs" >/dev/null 2>&1 || true
bash "$REPO_DIR/scripts/health-check.sh" --quiet >/dev/null 2>&1 || true
END=$(date +%s)
ELAPSED=$((END - START))
[[ $ELAPSED -le 3 ]] || { echo "FAIL: combined took ${ELAPSED}s (>3s)"; exit 1; }
```

**AC7:** Break jiti, run health-check, verify it fails + marker can be created:
```bash
sed -i '' 's|JITI_PATH=.*|JITI_PATH="/nonexistent/jiti.mjs"|' "$WRAPPER"
if bash "$REPO_DIR/scripts/health-check.sh" --quiet 2>/dev/null; then
  echo "FAIL: health check should have failed"
  exit 1
fi
# Run the actual marker branch logic (same as post-receive hook)
# Health check already failed above — simulate the post-receive conditional:
if ! bash "$REPO_DIR/scripts/health-check.sh" --quiet 2>/dev/null; then
  touch "$TMP/.pi-messenger-health-failed"
fi
[[ -f "$TMP/.pi-messenger-health-failed" ]] || { echo "FAIL: marker not created"; exit 1; }
```

## Requirement Traceability

| Requirement | Tasks | Tests |
|-------------|-------|-------|
| R0 | 5, 6 | AC1, AC2 |
| R1 | 5 | AC1 |
| R2 | 3 | AC2, AC5 |
| R3 | 4 | AC3 |
| R4 | 1a | AC4 |
| R5 | 1b, 1c | AC5 |
| R6 | 5 | AC1 |
| R7 | 5 | existing hook |
