#!/usr/bin/env bash
# =====================================================================
# OwnCord — установка/обновление на сервере (Debian/Ubuntu).
# Запускать из корня репозитория, например:
#   sudo bash deploy/install.sh
#
# Скрипт:
#   1) Проверит, что Node 20+ установлен.
#   2) Установит зависимости и соберёт клиент.
#   3) Создаст системного пользователя owncord (если ещё нет).
#   4) Скопирует репозиторий в /opt/owncord (или обновит).
#   5) Создаст server/.env из примера, если его ещё нет.
#   6) Положит и активирует systemd-юнит.
#
# После установки нужно:
#   - отредактировать /opt/owncord/server/.env
#   - sudo systemctl restart owncord
#   - настроить nginx (см. deploy/nginx.conf.example)
# =====================================================================

set -euo pipefail

INSTALL_DIR="${OWNCORD_DIR:-/opt/owncord}"
SERVICE_USER="owncord"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Этот скрипт нужно запускать через sudo (требуются права на /opt и systemd)." >&2
  exit 1
fi

echo "==> Source: $SRC_DIR"
echo "==> Target: $INSTALL_DIR"

# 1) Node ------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Устанавливаю Node 20 LTS из NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs build-essential
fi

NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+)\..*/\1/')
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Нужен Node 20 или новее (сейчас $(node -v))." >&2
  exit 1
fi

# 2) Системный пользователь ------------------------------------------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> Создаю пользователя $SERVICE_USER"
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# 3) Каталог установки -----------------------------------------------
mkdir -p "$INSTALL_DIR"
echo "==> Синхронизирую файлы в $INSTALL_DIR"
# rsync, чтобы не перетереть .env и uploads/.
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'server/.env' \
  --exclude 'server/uploads' \
  --exclude 'server/data.sqlite*' \
  "$SRC_DIR/" "$INSTALL_DIR/"

# 4) Зависимости + сборка клиента -----------------------------------
echo "==> npm install:all"
cd "$INSTALL_DIR"
npm run install:all
echo "==> npm run build (клиент)"
npm run build

# 5) .env -------------------------------------------------------------
if [[ ! -f "$INSTALL_DIR/server/.env" ]]; then
  cp "$INSTALL_DIR/server/.env.example" "$INSTALL_DIR/server/.env"
  # Сгенерируем сильный JWT_SECRET автоматически, чтобы юзер точно не оставил дефолт.
  RAND_SECRET=$(openssl rand -hex 48)
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$RAND_SECRET|" "$INSTALL_DIR/server/.env"
  echo
  echo "!!! Создан $INSTALL_DIR/server/.env — обязательно проверь его и"
  echo "!!! при необходимости задай REGISTRATION_CODE."
  echo
fi

# 6) Права ------------------------------------------------------------
mkdir -p "$INSTALL_DIR/server/uploads"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# 7) systemd ----------------------------------------------------------
SYSTEMD_DST="/etc/systemd/system/owncord.service"
if [[ ! -f "$SYSTEMD_DST" ]] || ! cmp -s "$INSTALL_DIR/deploy/owncord.service" "$SYSTEMD_DST"; then
  echo "==> Обновляю $SYSTEMD_DST"
  cp "$INSTALL_DIR/deploy/owncord.service" "$SYSTEMD_DST"
  systemctl daemon-reload
fi

systemctl enable owncord
systemctl restart owncord

echo
echo "==> Готово."
echo "    Логи:    sudo journalctl -u owncord -f"
echo "    Статус:  sudo systemctl status owncord"
echo "    .env:    sudo -u $SERVICE_USER \$EDITOR $INSTALL_DIR/server/.env"
