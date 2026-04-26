# OwnCord — гайд по развёртыванию

Это пошаговая инструкция для человека, который поднимает OwnCord на своём
сервере. Конечный результат: сайт `https://owncord.example.com`, доступный
другим людям, регистрация — только по приглашению.

---

## Что понадобится

- **VPS / домашний сервер** на Linux (тестировалось на Ubuntu 22.04 / 24.04
  и Debian 12). Минимум 1 vCPU, 1 GB RAM, 5 GB диска. Чем больше людей и
  больше файлов — тем больше нужно RAM/диска.
- **Белый IP** или белый IP роутера + проброс портов.
- **Домен** (например, `owncord.example.com`), у которого `A` / `AAAA`
  записи указывают на IP сервера. Без домена тоже можно (по IP), но
  WebRTC требует HTTPS, а получить TLS-сертификат на голый IP сложно.
- **Открытые порты на роутере / firewall**:
  - `80/tcp` — нужен только для получения TLS-сертификата (Let's Encrypt).
  - `443/tcp` — основной (HTTPS + WebSocket).
  - *(опционально)* `3478/udp+tcp` и `49152–65535/udp` — если поднимаешь
    свой TURN (см. раздел «TURN»).

---

## Шаг 1. Подготовить сервер

```bash
sudo apt update
sudo apt install -y git curl rsync nginx ufw

# (опционально) firewall — оставляем 80, 443, ssh
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

Node.js поставится автоматически из `install.sh`, но если предпочитаешь
руками:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs build-essential
```

---

## Шаг 2. Склонировать репозиторий и запустить инсталлятор

```bash
git clone https://github.com/<тут-владелец>/OwnCord.git
cd OwnCord
sudo bash deploy/install.sh
```

Скрипт:

- поставит зависимости и соберёт фронт,
- создаст системного пользователя `owncord`,
- разложит файлы в `/opt/owncord`,
- сгенерирует случайный `JWT_SECRET` в `/opt/owncord/server/.env`,
- зарегистрирует и запустит `systemd`-сервис `owncord`.

После завершения сервис уже слушает `127.0.0.1:3001`. Проверь:

```bash
sudo systemctl status owncord
curl http://127.0.0.1:3001/api/health
# {"ok":true}
```

---

## Шаг 3. Настроить регистрацию по приглашению

Открой `/opt/owncord/server/.env`:

```bash
sudo -u owncord nano /opt/owncord/server/.env
```

Найди закомментированную строку и впиши свой код:

```
REGISTRATION_CODE=ourSecretCode2025
```

Перезапусти сервис, чтобы подхватил настройки:

```bash
sudo systemctl restart owncord
```

Теперь форма регистрации потребует код. Раздавай его доверенным людям
лично (мессенджер/SMS/звонок). Если кого-то нужно «отозвать» — просто
смени `REGISTRATION_CODE` и снова перезапусти. Уже созданные аккаунты
продолжат работать.

Когда все нужные люди зарегистрировались, можно полностью закрыть
регистрацию:

```
REGISTRATION_DISABLED=1
```

### Одноразовые / multi-use коды через UI

Помимо общего `REGISTRATION_CODE`, админ может выпускать персональные
коды прямо из приложения — без правки `.env` и без рестарта сервиса.

1. Зайди под админ-аккаунтом (по умолчанию это пользователь с `id=1`,
   т.е. первый зарегистрированный; либо явно перечисли в env
   `ADMIN_USERNAMES=alice,bob`).
2. Открой **Настройки → Приглашения**.
3. Создай код: задай комментарий («для Васи»), число использований
   (`1` — одноразовый), срок жизни в днях, опционально — свой код вместо
   автогенерируемого.
4. Скопируй код кнопкой 📋 и отправь приглашаемому.
5. В любой момент можно отозвать код, нажав на корзину.

Эти коды работают параллельно с общим `REGISTRATION_CODE`: в форме
регистрации валидным считается любой из них.

---

## Шаг 4. Настроить домен и TLS

```bash
sudo cp /opt/owncord/deploy/nginx.conf.example /etc/nginx/sites-available/owncord
sudo nano /etc/nginx/sites-available/owncord
# замени owncord.example.com на свой домен в обоих server-блоках.

sudo ln -s /etc/nginx/sites-available/owncord /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Получи бесплатный сертификат от Let's Encrypt:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d owncord.example.com
```

Certbot сам пропишет `ssl_certificate` в конфиг и настроит автообновление.
Открой `https://owncord.example.com` — должна загрузиться страница входа.

> **Важно**: WebRTC (микрофон, камера, демонстрация экрана) работает
> только по HTTPS. По чистому HTTP браузер выдаст ошибку доступа к медиа.

---

## Шаг 5. Создать первого пользователя

Регистрация уже включена с инвайт-кодом. Зайди на сайт, нажми
«Регистрация», введи логин/пароль/код. Готово.

Дальше можно:

1. Раздать код знакомым.
2. После последней регистрации — выставить `REGISTRATION_DISABLED=1`.

---

## Web Push уведомления

OwnCord умеет слать системные push-уведомления о новых сообщениях и
входящих звонках, даже когда вкладка закрыта.

**Настройка не требуется**: при первом старте сервер автоматически
генерирует VAPID-пару и сохраняет её в `server/data/vapid.json`. Файл
важно бэкапить — если потеряете, все ранее подписанные клиенты придётся
переподписать заново.

Что нужно от пользователя:

1. Открыть приложение по HTTPS (push не работает по http).
2. Зайти в **Настройки → Уведомления**, включить тумблер «Системные
   уведомления».
3. Разрешить уведомления в браузере (попап появится автоматически).

На iOS Safari Web Push работает только в режиме PWA — нужно сначала
добавить сайт на главный экран.

Если хочется зафиксировать VAPID-ключи (например, при миграции на новый
сервер так, чтобы все ранее выданные подписки продолжили работать), их
можно прописать в `.env`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

Сгенерировать новую пару можно командой:
`node -e "console.log(require('web-push').generateVAPIDKeys())"`.

---

## TURN (опционально)

Если кто-то из пользователей сидит за корпоративным NAT или мобильным
оператором с CGNAT, голос/видео могут не подключиться (ICE не находит
прямой путь между пирами). Помогает свой TURN-сервер.

**Самый быстрый способ — docker-compose**: готовый шаблон лежит в
`deploy/turn/`, см. `deploy/turn/README.md`. Нужно только задать свой
пароль и публичный IP, потом `docker compose up -d`.

Если предпочитаешь нативный `coturn` из пакетного менеджера:

```bash
sudo apt install -y coturn
sudo nano /etc/turnserver.conf
```

Минимальный `turnserver.conf`:

```
listening-port=3478
fingerprint
lt-cred-mech
realm=owncord.example.com
user=owncord:STRONG_PASS_HERE
no-multicast-peers
no-cli
# Если есть TLS-серт от nginx — можно использовать его для tls-listener:
# cert=/etc/letsencrypt/live/owncord.example.com/fullchain.pem
# pkey=/etc/letsencrypt/live/owncord.example.com/privkey.pem
```

Запусти:

```bash
sudo systemctl enable --now coturn
```

И пропиши его в `/opt/owncord/server/.env`:

```
TURN_URL=turn:owncord.example.com:3478
TURN_USERNAME=owncord
TURN_PASSWORD=STRONG_PASS_HERE
```

`sudo systemctl restart owncord` — клиенты получат новый ICE-конфиг при
следующем коннекте.

Не забудь открыть на firewall/роутере UDP `3478` и пул `49152–65535/udp`.

---

## Обновления

При выкатке новой версии репозитория:

```bash
cd /tmp && git clone https://github.com/<owner>/OwnCord.git owncord-new
cd owncord-new
sudo bash deploy/install.sh
```

Скрипт `rsync` синхронизирует файлы поверх `/opt/owncord`, не трогая
`server/.env` и `server/uploads`. База данных (`server/data.sqlite`) тоже
не пересоздаётся; миграции схемы делаются на старте процесса.

---

## Бэкапы

Минимум, что нужно сохранять:

- `/opt/owncord/server/data.sqlite` — пользователи, сообщения, группы,
  мьюты.
- `/opt/owncord/server/uploads/` — аватары, голосовые, файлы и фото из
  чата.
- `/opt/owncord/server/.env` — секреты (`JWT_SECRET`, `REGISTRATION_CODE`,
  TURN-креды).

Простой ежедневный бэкап (cron):

```cron
15 4 * * * tar czf /var/backups/owncord-$(date +\%F).tar.gz \
  /opt/owncord/server/data.sqlite \
  /opt/owncord/server/uploads \
  /opt/owncord/server/.env \
  && find /var/backups -name 'owncord-*.tar.gz' -mtime +14 -delete
```

---

## Диагностика

| Симптом | Проверь |
|---------|---------|
| Страница не открывается | `sudo systemctl status owncord` и `sudo nginx -t`. Логи: `sudo journalctl -u owncord -f`. |
| `502 Bad Gateway` | OwnCord не слушает `127.0.0.1:3001`. Проверь `.env` (PORT) и логи. |
| Звонки идут, но без видео/звука | Скорее всего нужен TURN. Проверь, что HTTPS, а не HTTP. |
| «Регистрация закрыта» | В `.env` стоит `REGISTRATION_DISABLED=1`. Сбрось и перезапусти сервис. |
| Не загружается большой файл | Поправь `MAX_UPLOAD_MB` в `.env` **и** `client_max_body_size` в nginx, потом рестарт обоих. |
| Сертификат истёк | `sudo certbot renew --dry-run` — certbot сам прописывает таймер обновления при первой выдаче. |

---

## Откат к чистому состоянию

```bash
sudo systemctl disable --now owncord
sudo rm /etc/systemd/system/owncord.service
sudo rm /etc/nginx/sites-enabled/owncord /etc/nginx/sites-available/owncord
sudo systemctl daemon-reload
sudo systemctl reload nginx
sudo deluser --remove-home owncord
sudo rm -rf /opt/owncord
```
