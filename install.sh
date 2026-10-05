#!/usr/bin/env bash
# Raven installer — works from a git clone (HTTPS or SSH):
#   git clone git@github.com:erfanhooman/raven.git && cd raven && ./install.sh
# or via npm (no clone needed):
#   npm install -g @erfanhooman/raven && raven setup
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Raven — Telegram bridge for opencode · Claude Code · Codex"
echo "repo: $REPO_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node (>=18) is required. Install from https://nodejs.org or brew install node." >&2
  exit 1
fi

# Prefer a global npm install; fall back to running from the clone.
# NOTE: `npm install -g <folder>` only symlinks the folder (breaks if the
# clone moves), so pack first and install the tarball for a real copy.
if command -v npm >/dev/null 2>&1; then
  echo "building bundles..."
  (cd "$REPO_DIR" && npm install --no-audit --no-fund --silent && npm run --silent build) || true
  echo "installing npm package globally (this also puts 'raven' on your PATH)..."
  TARBALL="$(cd "$REPO_DIR" && npm pack 2>/dev/null | tail -1)"
  if [[ -n "${TARBALL:-}" && -f "$REPO_DIR/$TARBALL" ]] && npm install -g "$REPO_DIR/$TARBALL" --silent; then
    rm -f "$REPO_DIR/$TARBALL"
    exec raven setup "$@"
  fi
  rm -f "$REPO_DIR"/*.tgz
  echo "global install failed — falling back to running from the clone"
fi

if [[ ! -f "$REPO_DIR/dist/raven-cli.js" ]]; then
  echo "building bundles..."
  (cd "$REPO_DIR" && npm install --no-audit --no-fund --silent && npm run --silent build)
fi
exec node "$REPO_DIR/dist/raven-cli.js" setup "$@"
