#!/usr/bin/env bash
# Host provisioning for `hauptling setup` (Ubuntu, or WSL on Windows). Run via sudo:
#   setup-host.sh <hauptling checkout> <user who runs hauptling> <hauptling home> [gpu|nogpu]
# Installs git, gh and Docker Engine (plus the NVIDIA Container Toolkit when the host has an NVIDIA GPU), starts Docker at boot, puts hauptling on PATH, and migrates
# phase 1 worker users (hl-w*, hl-test) into per-slot credential dirs. Idempotent.
set -euo pipefail
SRC="$(cd "${1:?hauptling checkout}" && pwd)"
OWNER="${2:?user}"
HL_HOME="${3:?hauptling home}"
GPU="${4:-gpu}"
export DEBIAN_FRONTEND=noninteractive

# /etc/init.d/docker sets `ulimit -Hn 524288`, which fails (and aborts the start) when the caller's soft
# limit is higher, e.g. 1048576 in a WSL terminal. Lower the soft limit for the init script only.
docker_service() { (ulimit -Sn 1024 && service docker "$1" >/dev/null); }
. /etc/os-release
arch=$(dpkg --print-architecture)

apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git >/dev/null
install -d -m 0755 /etc/apt/keyrings

if ! command -v gh >/dev/null; then
  echo "installing gh"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$arch signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi

if ! command -v dockerd >/dev/null; then
  echo "installing Docker Engine"
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin >/dev/null
fi
usermod -aG docker "$OWNER"

# Start Docker at boot. WSL without systemd: /etc/wsl.conf [boot] command. Otherwise systemd.
if grep -qi microsoft /proc/version && [ "$(ps -p 1 -o comm=)" != systemd ]; then
  touch /etc/wsl.conf
  if ! grep -q 'service docker start' /etc/wsl.conf; then
    if grep -q '^\[boot\]' /etc/wsl.conf; then sed -i '/^\[boot\]/a command = service docker start' /etc/wsl.conf
    else printf '\n[boot]\ncommand = service docker start\n' >> /etc/wsl.conf; fi
  fi
  service docker status >/dev/null 2>&1 || docker_service start
else
  systemctl enable --now docker >/dev/null
fi

# GPU test jobs (phase 3): containers get the GPU via the NVIDIA Container Toolkit (`docker run --gpus all`).
smi=$(command -v nvidia-smi || { [ -x /usr/lib/wsl/lib/nvidia-smi ] && echo /usr/lib/wsl/lib/nvidia-smi; } || true)
if [ "$GPU" = gpu ] && [ -n "$smi" ] && "$smi" -L >/dev/null 2>&1; then
  if ! command -v nvidia-ctk >/dev/null; then
    echo "installing NVIDIA Container Toolkit"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /etc/apt/keyrings/nvidia-container-toolkit.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit.gpg] https://#' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -qq && apt-get install -y -qq nvidia-container-toolkit >/dev/null
  fi
  if ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
    nvidia-ctk runtime configure --runtime=docker >/dev/null
    if command -v systemctl >/dev/null && [ "$(ps -p 1 -o comm=)" = systemd ]; then systemctl restart docker; else docker_service restart; fi
  fi
  echo "GPU: $("$smi" -L | head -1)"
else
  echo "GPU: none or disabled (GPU tests off)"
fi

# hauptling on PATH: a link to this checkout, so edits apply at once (containers get their own copy in the image).
rm -rf /opt/hauptling && ln -sfn "$SRC" /opt/hauptling
chmod 0755 "$SRC/bin/hauptling.mjs" 2>/dev/null || true
ln -sf /opt/hauptling/bin/hauptling.mjs /usr/local/bin/hauptling

# Phase 1 → 2: move each worker user's sign-ins into ~/.hauptling/slots/<slot>/, then remove the users.
for home in /home/hl-w* ; do
  [ -d "$home" ] || continue
  slot=$(basename "$home"); dest="$HL_HOME/slots/$slot"
  mkdir -p "$dest"
  [ -d "$home/.claude" ] && [ ! -e "$dest/claude" ] && cp -a "$home/.claude" "$dest/claude"
  [ -f "$home/.claude.json" ] && [ ! -e "$dest/claude/.claude.json" ] && mkdir -p "$dest/claude" && cp -a "$home/.claude.json" "$dest/claude/.claude.json"
  [ -d "$home/.codex" ] && [ ! -e "$dest/codex" ] && cp -a "$home/.codex" "$dest/codex"
  [ -d "$home/.gemini" ] && [ ! -e "$dest/gemini" ] && cp -a "$home/.gemini" "$dest/gemini"
  chown -R "$OWNER:$OWNER" "$dest"
  echo "migrated $slot sign-ins to $dest"
done
for u in $(getent passwd | cut -d: -f1 | grep -E '^hl-(w[0-9]+|test|relay)$' || true); do
  pkill -u "$u" 2>/dev/null || true
  userdel -r "$u" 2>/dev/null || userdel "$u" || true
  echo "removed user $u"
done
rm -f /etc/sudoers.d/hauptling /etc/ssh/sshd_config.d/hauptling.conf
echo "host ready: $(docker --version), $(gh --version | head -1)"
