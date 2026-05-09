# OwnCord Desktop (Electron)

Десктоп-обёртка над веб-клиентом OwnCord. Это **именно обёртка**: всё,
что есть на сайте (логин, чат, звонки, настройки аккаунта), работает
ровно так же — данные хранятся на том же сервере, к которому ходит
браузерная версия. Десктоп добавляет только то, что веб не умеет:

- Глобальные хоткеи на мьют микрофона / выкл звука собеседников
  (работают, даже когда окно OwnCord не в фокусе).
- Системную иконку и autostart (опционально).
- Окно без вкладок и без хрома браузера.

## Архитектура

```
desktop/
  main.js        — main-процесс Electron'а: BrowserWindow, IPC, glob.shortcuts
  preload.js     — мост contextBridge: window.electronAPI для рендерера
  config.js      — JSON-конфиг в userData (serverUrl, shortcuts)
  shortcuts.js   — register/unregister глобальных хоткеев
```

Клиент в `client/` НЕ модифицируется под десктоп: он сам детектит
наличие `window.electronAPI` и активирует UI-фичи (вкладка «Биндинги»),
а на вебе те же файлы работают без изменений.

## Запуск из исходников (dev)

```bash
# 1) Запустить серверную часть и client dev-сервер
npm run dev    # из корня репозитория

# 2) В отдельном терминале — десктоп, указав куда грузить клиент:
OWNCORD_SERVER_URL=http://localhost:5173 npm --workspace desktop run start
```

Если клиент запущен на другом хосте/порту — поправь `OWNCORD_SERVER_URL`
или оставь пустым (тогда при первом запуске покажется экран настройки).

## Сборка релизов

```bash
# Windows: распакованная папка (по умолчанию — самый дружелюбный target)
npm --workspace desktop run build:win
# → desktop/dist/win-unpacked/OwnCord.exe + ресурсы рядом

# Windows: NSIS-инсталлятор / portable-exe (нужны Developer Mode, см. ниже)
npm --workspace desktop run build:win:nsis
npm --workspace desktop run build:win:portable

# macOS / Linux
npm --workspace desktop run build:mac    # .dmg + .zip
npm --workspace desktop run build:linux  # AppImage + .deb
```

### Подводный камень Windows: Cannot create symbolic link

Electron-builder при первом запуске любой Windows-сборки распаковывает
кеш `winCodeSign.7z` в `%LOCALAPPDATA%\electron-builder\Cache\`. Внутри
архива лежат darwin-библиотеки (для подписи Windows-сборок с macOS),
и они подключены через **symlinks**. Создание symlink на Windows
требует прав администратора либо включённого Developer Mode.

Симптом:

```
ERROR: Cannot create symbolic link : Клиент не обладает требуемыми правами.
   ...\winCodeSign\<id>\darwin\10.12\lib\libcrypto.dylib
```

Три варианта обхода (выбери один, делается ОДИН РАЗ):

1. **Developer Mode** (рекомендуемый, не требует админа на каждый билд):
   `Settings → System → For developers → Developer Mode = On`
   После этого symlinks создаются без admin-прав.

2. **Однократный билд от админа**: запусти PowerShell «Run as Administrator»,
   выполни в нём `npm --workspace desktop run build:win:nsis`. Кеш
   распакуется, и все последующие билды (даже без админа) будут работать.

3. **Удалить и пересоздать кеш**:
   `rm -r $env:LOCALAPPDATA\electron-builder\Cache\winCodeSign` (один из
   двух вариантов выше всё равно нужен после этого).

Артефакты сборки — в `desktop/dist/`. Подпись приложения требует своих
сертификатов (CSC_LINK / WIN_CSC_LINK env-переменные); для приватного
self-host'а её можно пропустить — Windows покажет SmartScreen-warning,
который кликается через «Подробнее → Выполнить в любом случае».

## Файл конфигурации

`<userData>/owncord.config.json` — на Windows это
`%APPDATA%/OwnCord/owncord.config.json`, на macOS
`~/Library/Application Support/OwnCord/...`, на Linux
`~/.config/OwnCord/...`.

Поля:

```json
{
  "serverUrl": "https://owncord.example.com",
  "autoStart": false,
  "hotkeysEnabled": true,
  "shortcuts": {
    "toggleMute": "CommandOrControl+Shift+M",
    "toggleDeafen": "CommandOrControl+Shift+D"
  }
}
```

Менять руками не обязательно — есть UI на странице «Настройки → Биндинги».
