#!/usr/bin/env bash
# Worker provisioning for `hauptling setup` on a Linux host (Ubuntu, or WSL on Windows). Run via sudo:
#   setup-linux-workers.sh <slots> <hauptling checkout> <user who runs the broker>
# Installs git, tmux, gh, the vendor CLIs and hauptling system-wide, creates worker users
# hl-w1..hl-wN and hl-test, and lets the broker user act as them (sudoers). Idempotent.
set -euo pipefail
SLOTS="${1:-3}"
SRC="$(cd "${2:?hauptling checkout}" && pwd)"
OWNER="${3:-${SUDO_USER:-}}"
[ -n "$OWNER" ] && [ "$OWNER" != root ] || { echo "run via sudo as the user who runs the broker"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 22 ]; then
  echo "installing Node 22"
  apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
apt-get install -y -qq git tmux curl >/dev/null
if ! command -v gh >/dev/null; then
  echo "installing gh"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi

# Vendor CLIs, system-wide so every worker user shares one install.
npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex >/dev/null
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)
if ! command -v agy >/dev/null || [ "$(command -v agy)" = "$OWNER_HOME/.local/bin/agy" ]; then
  if [ -x "$OWNER_HOME/.local/bin/agy" ]; then install -m 0755 "$(readlink -f "$OWNER_HOME/.local/bin/agy")" /usr/local/bin/agy
  else echo "note: agy not found; install the Antigravity CLI to use agy workers"; fi
fi

# Worker users.
for u in $(seq 1 "$SLOTS" | sed 's/^/hl-w/') hl-test; do
  id "$u" >/dev/null 2>&1 || { useradd -m -s /bin/bash "$u"; echo "created $u"; }
  chmod 0700 "/home/$u"
  su - "$u" -c 'git config --global user.name "hauptling $(whoami)"; git config --global user.email "$(whoami)@hauptling.local"' </dev/null
done
# Clones push into your local repos, owned by another uid.
git config --system --replace-all safe.directory '*'

# The broker user may act as the worker users, and only them.
users=$( (seq 1 "$SLOTS" | sed 's/^/hl-w/'; echo hl-test) | paste -sd, -)
rule="$OWNER ALL=($users) NOPASSWD: ALL"
echo "$rule" > /tmp/hauptling.sudoers
visudo -cf /tmp/hauptling.sudoers >/dev/null && install -m 0440 /tmp/hauptling.sudoers /etc/sudoers.d/hauptling
rm -f /tmp/hauptling.sudoers

# hauptling for everyone, copied: vendor sandboxes (agy) can't read checkouts under /mnt/c or your home.
rm -rf /opt/hauptling && mkdir -p /opt/hauptling
cp -r "$SRC"/bin "$SRC"/src "$SRC"/skills "$SRC"/scripts "$SRC"/models.json "$SRC"/package.json /opt/hauptling/
chmod -R a+rX /opt/hauptling
how="copied to /opt/hauptling (rerun setup after updating hauptling)"
chmod 0755 "$SRC/bin/hauptling.mjs" 2>/dev/null || true
ln -sf /opt/hauptling/bin/hauptling.mjs /usr/local/bin/hauptling

# Left over from the earlier Windows-broker design: SSH relay for the tunnel.
if id hl-relay >/dev/null 2>&1; then
  userdel -r hl-relay 2>/dev/null || true
  rm -f /etc/ssh/sshd_config.d/hauptling.conf
  service ssh status >/dev/null 2>&1 && service ssh restart >/dev/null 2>&1 || true
  echo "removed old hl-relay tunnel user and sshd config"
fi
echo "workers ready: node $(node -v), $(tmux -V), slots: $SLOTS, hauptling $how"
