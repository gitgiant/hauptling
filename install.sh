#!/usr/bin/env bash
# Hauptling installer for a Linux host (Ubuntu, or WSL on Windows via install.cmd). Safe to rerun.
#   ./install.sh [--slots 3] [--vendors claude,codex,agy] [--no-login]
set -euo pipefail
cd "$(dirname "$0")"
need_node() { ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; }
if need_node; then
  echo "Installing Node 22 (needs sudo)…"
  sudo apt-get update -qq && sudo apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
  hash -r
fi
exec node bin/hauptling.mjs setup "$@"
