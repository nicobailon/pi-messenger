#!/usr/bin/env bash
#==============================================================================
# health-check.sh — Verify pi-messenger install is healthy
#
# Pure bash — no node dependency. Can run even when node/jiti is broken.
# Exit 0 = all checks pass. Exit 1 = problems found.
#
# Usage:
#   scripts/health-check.sh           # Human-readable output
#   scripts/health-check.sh --quiet   # Only show failures (for post-receive)
#==============================================================================

set -euo pipefail

QUIET=false
[[ "${1:-}" == "--quiet" ]] && QUIET=true

FAIL=0
ok()   { $QUIET || echo -e "  ✓ $1"; }
fail() { echo -e "  ✗ $1" >&2; FAIL=1; }

$QUIET || echo "pi-messenger health check"

# ── 1. CLI reachable ─────────────────────────────────────────────────────────
if command -v pi-messenger-cli >/dev/null 2>&1; then
  ok "pi-messenger-cli in PATH"
else
  fail "pi-messenger-cli not found. Run: node install.mjs"
fi

# ── 2. Parse wrapper SOURCE_DIR + JITI_PATH ──────────────────────────────────
WRAPPER=$(command -v pi-messenger-cli 2>/dev/null || true)
SOURCE_DIR=""
JITI_PATH=""

if [[ -n "$WRAPPER" ]]; then
  # Follow symlink to actual file
  WRAPPER=$(readlink -f "$WRAPPER" 2>/dev/null || realpath "$WRAPPER" 2>/dev/null || echo "$WRAPPER")
  SOURCE_DIR=$(grep '^SOURCE_DIR=' "$WRAPPER" 2>/dev/null | head -1 | sed 's/^SOURCE_DIR="//;s/"$//')
  JITI_PATH=$(grep '^JITI_PATH=' "$WRAPPER" 2>/dev/null | head -1 | sed 's/^JITI_PATH="//;s/"$//')
fi

# ── 3. SOURCE_DIR valid ──────────────────────────────────────────────────────
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

# ── 4. JITI valid ────────────────────────────────────────────────────────────
if [[ -n "$JITI_PATH" && -f "$JITI_PATH" ]]; then
  ok "jiti exists: $JITI_PATH"
else
  [[ -n "$WRAPPER" ]] && fail "jiti missing: ${JITI_PATH:-<empty>}. Reinstall pi."
fi

# ── 5. Version comparison (wrapper SOURCE_DIR vs CWD) ────────────────────────
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

# ── 6. Settings.json entry + path resolution + SOURCE_DIR match ──────────────
SETTINGS="$HOME/.pi/agent/settings.json"

if [[ -f "$SETTINGS" ]]; then
  # Extract pi-messenger entry using bash-only parsing
  PM_ENTRY=""
  while IFS= read -r line; do
    entry=$(echo "$line" | tr -d '"' | xargs 2>/dev/null || true)
    [[ -z "$entry" ]] && continue
    base="${entry##*/}"
    # Strip npm: prefix for matching
    [[ "$entry" == npm:* ]] && base="${entry#npm:}"
    if [[ "$base" == "pi-messenger" || "$base" == pi-messenger-* ]]; then
      PM_ENTRY="$entry"
      break
    fi
  done < <(grep -o '"[^"]*"' "$SETTINGS" 2>/dev/null || true)

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
        # Relative to settings.json directory (~/.pi/agent/)
        if [[ -d "$HOME/.pi/agent" ]]; then
          RESOLVED="$(cd "$HOME/.pi/agent" 2>/dev/null && cd "$(dirname "$PM_ENTRY")" 2>/dev/null && echo "$(pwd)/$(basename "$PM_ENTRY")")" || true
        fi
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
