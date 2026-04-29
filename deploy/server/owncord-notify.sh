#!/usr/bin/env bash
# Sends a Telegram notification about owncord service state.
# Usage: owncord-notify.sh <event> (start|stop|fail)
#
# Reads secrets from /etc/owncord-notify.env (see owncord-notify.env.example).
# Silently no-ops if the env file or required vars are missing — never blocks
# systemd hooks.
set -u

event="${1:-unknown}"
case "$event" in
  start) icon="🟢"; text="OwnCord *запущен*" ;;
  stop)  icon="🔴"; text="OwnCord *остановлен*" ;;
  fail)  icon="⚠️"; text="OwnCord *упал*" ;;
  *)     icon="ℹ️"; text="OwnCord: $event" ;;
esac
host=$(hostname)
ts=$(date '+%Y-%m-%d %H:%M:%S %Z')
msg="$icon $text
host: \`$host\`
url: https://owncord.patgen.ru
time: \`$ts\`"

env_file="${OWNCORD_NOTIFY_ENV:-/etc/owncord-notify.env}"
[[ -r "$env_file" ]] || exit 0
# shellcheck disable=SC1090
. "$env_file"
[[ -n "${TG_BOT_TOKEN:-}" && -n "${TG_CHAT_ID:-}" ]] || exit 0

curl -fsS --max-time 10 ${TG_PROXY:+--proxy "$TG_PROXY"} \
  -d "chat_id=$TG_CHAT_ID" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=$msg" \
  "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" >/dev/null || true
