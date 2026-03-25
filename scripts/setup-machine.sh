#!/usr/bin/env bash
#==============================================================================
# setup-machine.sh — First-time pi-messenger setup
#
# Adds the repo to settings.json, runs install.mjs (creates CLI wrapper),
# and verifies the install with health-check.sh.
#
# Usage:
#   scripts/setup-machine.sh              # Use CWD as repo path
#   scripts/setup-machine.sh /path/to/repo  # Explicit repo path
#
# Idempotent — safe to run multiple times.
#==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_PATH="${1:-$(pwd)}"
REPO_PATH="$(cd "$REPO_PATH" && pwd)"  # resolve to absolute

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1" >&2; }

# ── Validate repo ────────────────────────────────────────────────────────────
if [[ ! -f "$REPO_PATH/package.json" ]]; then
  err "No package.json at $REPO_PATH"
  exit 1
fi

PKG_NAME=$(grep '"name"' "$REPO_PATH/package.json" | head -1 | sed 's/.*: "//;s/".*//')
if [[ "$PKG_NAME" != "pi-messenger" ]]; then
  err "Not a pi-messenger repo (package name: $PKG_NAME)"
  exit 1
fi

ok "Validated repo: $REPO_PATH (v$(grep '"version"' "$REPO_PATH/package.json" | head -1 | sed 's/.*: "//;s/".*//'))"

# ── Check settings.json ──────────────────────────────────────────────────────
SETTINGS="$HOME/.pi/agent/settings.json"

if [[ ! -f "$SETTINGS" ]]; then
  err "$SETTINGS not found. Is pi installed?"
  exit 1
fi

# Check if pi-messenger is already in settings.json
PM_EXISTS=false
while IFS= read -r line; do
  entry=$(echo "$line" | tr -d '"' | xargs 2>/dev/null || true)
  [[ -z "$entry" ]] && continue
  base="${entry##*/}"
  [[ "$entry" == npm:* ]] && base="${entry#npm:}"
  if [[ "$base" == "pi-messenger" || "$base" == pi-messenger-* ]]; then
    PM_EXISTS=true
    break
  fi
done < <(grep -o '"[^"]*"' "$SETTINGS" 2>/dev/null || true)

if $PM_EXISTS; then
  ok "settings.json already has pi-messenger entry"
else
  # Add to settings.json using env vars (no shell→JS injection)
  SETTINGS="$SETTINGS" REPO_PATH="$REPO_PATH" node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync(process.env.SETTINGS, 'utf-8'));
    s.packages = s.packages || [];
    s.packages.push(process.env.REPO_PATH);
    fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2));
  "
  ok "Added $REPO_PATH to settings.json packages"
fi

# ── Run install.mjs ──────────────────────────────────────────────────────────
echo ""
echo "Running install.mjs..."
cd "$REPO_PATH"
node install.mjs

# ── Health check ─────────────────────────────────────────────────────────────
echo ""
echo "Verifying setup..."
bash "$REPO_PATH/scripts/health-check.sh"
