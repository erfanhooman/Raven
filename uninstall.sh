#!/usr/bin/env bash
# Raven uninstaller — removes the launchd service, the opencode plugin, and (optionally) the config.
set -euo pipefail
if command -v raven >/dev/null 2>&1; then
  exec raven uninstall "$@"
fi
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$REPO_DIR/dist/raven-cli.js" uninstall "$@"
