#!/usr/bin/env bash
# Idempotently installs the server-side helpers needed for OwnCord:
#   - /usr/local/bin/owncord-deploy.sh   (deploy script, used by CI)
#   - /usr/local/bin/owncord-notify.sh   (Telegram alerts)
#   - /etc/sudoers.d/owncord-deploy      (NOPASSWD entry for gitlab-runner)
#   - /etc/systemd/system/owncord.service (systemd unit with start/stop hooks)
#
# Telegram secrets live in /etc/owncord-notify.env (NOT in this repo).
# See owncord-notify.env.example for the format.
#
# Run as root from inside this directory:
#   sudo bash install-server-tools.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> installing /usr/local/bin/owncord-deploy.sh"
install -m 0750 -o root -g gitlab-runner "$HERE/owncord-deploy.sh" /usr/local/bin/owncord-deploy.sh

echo "==> installing /usr/local/bin/owncord-notify.sh"
install -m 0755 -o root -g root "$HERE/owncord-notify.sh" /usr/local/bin/owncord-notify.sh

echo "==> installing /etc/sudoers.d/owncord-deploy"
install -m 0440 -o root -g root "$HERE/sudoers.d-owncord-deploy" /etc/sudoers.d/owncord-deploy
visudo -cf /etc/sudoers.d/owncord-deploy

echo "==> installing /etc/systemd/system/owncord.service"
install -m 0644 -o root -g root "$HERE/owncord.service" /etc/systemd/system/owncord.service
systemctl daemon-reload

if [[ ! -f /etc/owncord-notify.env ]]; then
  echo
  echo "!!! /etc/owncord-notify.env is missing — Telegram alerts will be silent."
  echo "!!! Copy owncord-notify.env.example there and fill in TG_BOT_TOKEN / TG_CHAT_ID."
fi

echo "==> done"
