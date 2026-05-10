# Авто-обновление десктоп-клиента OwnCord

Этот документ описывает **что нужно сделать на сервере** (`owncord.patgen.ru`),
чтобы заработало авто-обновление Windows-десктопа OwnCord. Сама сборка
артефактов происходит локально на машине того, кто делает релизы (см.
конец документа). Сервер только раздаёт статику.

## Архитектура (на пальцах)

```
[машина релизера]                          [сервер owncord.patgen.ru]
  npm run release:win  ──── scp/rsync ────▶ /var/www/owncord-updates/
                                                ├── latest.yml
                                                ├── OwnCord Setup 0.6.1.exe
                                                ├── OwnCord Setup 0.6.1.exe.blockmap
                                                └── (файлы прошлых версий)
                                                          │
                                                    nginx /updates/  (статика)
                                                          │
                          ┌───────────────────────────────┘
                          ▼
                   [десктоп-клиент юзера]
                  раз в 6 часов: GET /updates/latest.yml
                  если новее — скачивает .exe и предлагает рестарт
```

## Что делает сервер

1. Раздаёт статику из `/var/www/owncord-updates/` по адресу
   `https://owncord.patgen.ru/updates/`.
2. Принимает SSH-подключения от релизера (отдельный пользователь
   с ограниченными правами — см. ниже).

## Что НЕ нужно делать

- **Ничего не нужно дописывать в CI/CD GitLab.** Деплой кода (`owncord-deploy.sh`)
  как был — так и остался. Авто-обновление работает по отдельной дорожке:
  релизер сам триггерит сборку и заливку с локальной Windows-машины,
  потому что собирать NSIS-инсталлятор на Linux-runner-е требует Wine
  и заметно усложняет CI без видимого выигрыша.
- Не нужно билдить ничего на сервере. Сервер — это просто файло-помойка
  для бинарей.

---

# Что должен сделать друг (один раз)

Все команды из-под `sudo` на сервере. Подставь свои значения, где помечено.

## 1. Создать папку для релизов

```bash
sudo mkdir -p /var/www/owncord-updates
```

## 2. Завести отдельного SSH-пользователя для заливки релизов

Не использовать `root`/`owncord` для этого — отдельный юзер с минимальными
правами безопаснее (если ключ утечёт — никто не сможет ни залогиниться
в админский аккаунт, ни перезапустить service).

```bash
# Создаём юзера без shell-доступа кроме SCP/SFTP, без домашки.
sudo useradd --system --no-create-home --shell /usr/lib/openssh/sftp-server owncord-publish

# Делаем его владельцем папки релизов.
sudo chown owncord-publish:owncord-publish /var/www/owncord-updates
sudo chmod 755 /var/www/owncord-updates
```

> **Альтернатива попроще** (если не хочется отдельного юзера):
> положить релизы в папку, на которую есть права у уже существующего
> юзера (например, `owncord` из `owncord-deploy.sh` или твой личный
> SSH-аккаунт). Тогда шаг с `useradd` пропускаем, но в `release.ps1`
> у релизера надо переопределить `-RemoteUser` на этого юзера.

## 3. Положить публичный SSH-ключ релизера

Релизер пришлёт публичный ключ (`id_ed25519.pub` из `~/.ssh/`).

```bash
sudo mkdir -p /home/owncord-publish/.ssh
sudo touch /home/owncord-publish/.ssh/authorized_keys
# Вставить публичный ключ релизера (одна строка):
sudo nano /home/owncord-publish/.ssh/authorized_keys

sudo chown -R owncord-publish:owncord-publish /home/owncord-publish/.ssh
sudo chmod 700 /home/owncord-publish/.ssh
sudo chmod 600 /home/owncord-publish/.ssh/authorized_keys
```

> Если useradd выше не создал `/home/owncord-publish` (мы передавали
> `--no-create-home`), создай вручную:
>
> ```bash
> sudo mkdir -p /home/owncord-publish
> sudo chown owncord-publish:owncord-publish /home/owncord-publish
> ```

## 4. Ограничить SSH этого юзера через `Match` блок (важно для безопасности)

Дай юзеру только право scp/sftp в `/var/www/owncord-updates`, не давая
никакого shell. Открой `/etc/ssh/sshd_config` и допиши **в самый конец**:

```
Match User owncord-publish
    ChrootDirectory /var/www
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PasswordAuthentication no
```

Сохранить и перечитать sshd:

```bash
sudo sshd -t   # проверить что конфиг валиден
sudo systemctl reload ssh
```

После этого `owncord-publish` может только закидывать файлы по SFTP/SCP
в `/var/www/owncord-updates/`, никаких команд выполнить не сможет.

> **Важно (chroot меняет путь)**: внутри chroot-сессии юзер видит `/var/www`
> как свой роот (`/`). Это значит, что с клиентской стороны (`scp`/`sftp`)
> нужно указывать путь **`/owncord-updates/`** (НЕ `/var/www/owncord-updates/`).
> Именно этот путь использует `desktop/scripts/release.ps1` по умолчанию.
> Если отключишь chroot — переопредели с релизера:
> `release.ps1 -RemoteDir /var/www/owncord-updates`.
>
> **Важно**: для `ChrootDirectory` папка-родитель (`/var/www`) должна
> принадлежать `root` и иметь права не более 755. Это обычно так и есть
> по умолчанию — проверь `ls -ld /var/www`.
>
> Если в `/var/www` лежит что-то ещё (например фронтенд OwnCord), это
> ОК — пользователь увидит другие папки, но не сможет в них писать.

## 5. Добавить nginx-локацию для `/updates/`

В **уже существующем** конфиге OwnCord (обычно `/etc/nginx/sites-available/owncord`),
**внутри блока `server { ... }` для HTTPS** (порт 443), вставить:

```nginx
# --- Авто-обновление десктоп-клиента ------------------------------
location /updates/ {
    alias /var/www/owncord-updates/;
    autoindex off;
    add_header X-Content-Type-Options "nosniff" always;

    # latest.yml НЕ кешируем — иначе апдейты лагают.
    location ~* \.ya?ml$ {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

    # .exe + .blockmap immutable (имя содержит версию).
    location ~* \.(exe|blockmap)$ {
        expires 1d;
        add_header Cache-Control "public, max-age=86400, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
}
```

Полная версия с контекстом — в `deploy/nginx.conf.example` репо.

Применить:

```bash
sudo nginx -t          # проверить валидность
sudo systemctl reload nginx
```

## 6. Проверить что всё ОК

С любой машины:

```bash
# Должна быть 404 (пока релизов нет, но location работает) — НЕ 502 и
# НЕ "Connection refused":
curl -I https://owncord.patgen.ru/updates/

# После того как релизер положит файлы:
curl https://owncord.patgen.ru/updates/latest.yml
# Должен вернуть YAML с version, files[], sha512.
```

---

# Что делает релизер (для контекста)

На своей Windows-машине:

```powershell
# Один раз:
ssh-keygen -t ed25519 -f ~/.ssh/owncord-publish
# Отправить ~/.ssh/owncord-publish.pub другу, чтобы он положил в
# authorized_keys (см. шаг 3 выше).

# Каждый релиз:
cd C:\Users\Restez\Desktop\OwnCord
# Поднять версию в desktop/package.json (например 0.6.0 → 0.6.1)
npm --workspace desktop run release:win
# Скрипт сам соберёт NSIS-инсталлятор и зальёт его на сервер.
```

После этого у всех запущенных десктопов в течение 6 часов (или сразу
при следующем старте) появится тост «Доступно обновление 0.6.1». Они
скачают diff (~5-15 MB вместо 80) и предложат рестарт.

---

# Размер папки и обслуживание

## Сколько весит

- 1 версия = 80 MB (.exe) + 200-400 KB (.blockmap) + 2 KB (latest.yml).
- 10 версий ≈ 800 MB. Для дельта-апдейтов нужны blockmap-ы старых версий —
  иначе клиент с 0.5.0 не сможет дельтой обновиться до 0.7.0 (придётся
  качать полный installer).

## Чистка старых версий

Раз в полгода можно вручную удалить файлы версий старше N:

```bash
# Сохранить только последние 5 версий .exe:
cd /var/www/owncord-updates
ls -t *.exe | tail -n +6 | xargs -r rm
ls -t *.blockmap | tail -n +6 | xargs -r rm
```

Не удаляй `latest.yml` — это указатель на текущую версию.

---

# Если что-то сломалось

## «У меня тост говорит "Ошибка обновления"»

Открой DevTools в десктопе (F12) → вкладка Console. electron-updater
пишет туда детали. Самое частое:

- **404 на `/updates/latest.yml`** → не залит файл или nginx-локация
  не работает. Проверь `curl https://owncord.patgen.ru/updates/latest.yml`.
- **403 Forbidden** → права на `/var/www/owncord-updates`. `chmod 755`
  на папку, `chmod 644` на файлы внутри.
- **SHA512 mismatch** → файл повреждён при заливке (редко, но бывает
  при разрыве scp). Залей повторно: `npm run release:win -- -SkipBuild`.

## «Залил файл, но клиент не видит обновления»

- Проверь что версия в `latest.yml` на сервере БОЛЬШЕ, чем у клиента.
  electron-updater сравнивает по semver.
- Принудительная проверка на стороне клиента: рестарт приложения
  (стартовая проверка через 8 секунд) или закрыть/открыть.

## «scp пишет Permission denied»

- Проверь, что публичный ключ релизера именно в
  `/home/owncord-publish/.ssh/authorized_keys`.
- Проверь права: `.ssh` должна быть `700`, `authorized_keys` — `600`.
- В `/var/log/auth.log` будет точная причина отказа.

## «scp пишет "No such file or directory" при заливке»

Скорее всего релизер указывает путь `/var/www/owncord-updates/`, но SSH-сессия
юзера идёт внутри chroot в `/var/www`. Внутри chroot этот путь
выглядит как `/owncord-updates/`. Проверь, что `release.ps1` использует
дефолт `-RemoteDir /owncord-updates` (в версии 0.7.2+ это уже так). Если
`-RemoteDir` был переопределён вручную — убери `/var/www` из начала.

## «scp зависает на запросе passphrase»

Причина: OpenSSH пытается все ключи из `~/.ssh/` перед тем, как использовать
переданный `-i`. Если какой-то из них зашифрован паролем — сессия висит
на промпте. Решение: в версии 0.7.2+ `release.ps1` автоматически добавляет
`-o IdentitiesOnly=yes` при переданном `-SshKey` — пробоваться будет только
указанный ключ. Если пользуешся scp вручную — добавляй также.

## «scp пишет sftp-server: command not found»

В `useradd` выше шелл — `sftp-server`. Если бинарь лежит в другом месте
на твоём дистрибутиве, найди его: `which sftp-server` или
`find /usr -name sftp-server`. Обычно `/usr/lib/openssh/sftp-server`
(Debian/Ubuntu) или `/usr/libexec/openssh/sftp-server` (RHEL/Fedora).
Поправь в `/etc/passwd` строку юзера или пересоздай через `usermod`.

---

# Безопасность

- **Скачиваемый installer не подписан** — Windows SmartScreen может
  ругаться при первой установке у новых юзеров. Авто-обновление работает
  без проблем (silent NSIS обходит SmartScreen для уже установленного
  приложения). Подпись стоит ~$200/год сертификата OV/EV.
- **HTTPS обязателен**. Если раздавать `latest.yml` по HTTP — кто-нибудь
  на пути может подменить версию и заставить юзера скачать чужой .exe.
  electron-updater по умолчанию проверяет SHA512, но без HTTPS атакующий
  может подменить и хеш. У тебя HTTPS уже есть — просто не открывай
  `/updates/` по 80-му порту.
- **owncord-publish юзер не имеет shell** — даже если ключ релизера
  утечёт, максимум что атакующий сделает — зальёт левый .exe в
  `/var/www/owncord-updates`. Клиенты его НЕ скачают, потому что
  `latest.yml` содержит SHA512, и подмена .exe не пройдёт без
  одновременной подмены `latest.yml`.
- **JWT_SECRET и owncord-deploy роли никак не пересекаются с
  owncord-publish** — они в разных юзерах, на разных папках. Если
  скомпрометирован один — второй не страдает.
