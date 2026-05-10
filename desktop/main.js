// Main-процесс OwnCord Desktop.
//
// Что делает:
//   1) Открывает BrowserWindow и грузит туда веб-клиент по `serverUrl`
//      из конфига. По логике приложения это полностью тот же клиент,
//      что и в браузере, поэтому вся работа с БД (сообщения, звонки,
//      настройки аккаунта) идёт через те же сетевые запросы и socket.io
//      с сервером — десктоп ничего не дублирует локально.
//   2) Поднимает IPC API для renderer-стороны (preload контролирует
//      белый список через contextBridge).
//   3) Регистрирует глобальные хоткеи (см. shortcuts.js) и пробрасывает
//      их в renderer событием 'shortcut:fired'.
//
// Что НЕ делает:
//   - Не хранит сообщения/настройки чата локально. Это всё в БД сервера.
//   - Не парсит/не патчит DOM клиента. Десктоп — это «нативная обёртка»,
//     никаких хирургических вмешательств в страницу.
//
// Безопасность:
//   - contextIsolation: true, nodeIntegration: false — стандартные best-
//     practices Electron'а. Renderer не получает прямого доступа к Node.
//   - Только preload-bridged IPC: getConfig/setConfig, getShortcuts/
//     setShortcuts, recordShortcut(toggle), onShortcutFired.

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const config = require('./config');
const shortcuts = require('./shortcuts');
const mouseHook = require('./mouseHook');
const autoUpdater = require('./autoUpdater');

// Закрепляем имя приложения ДО любых обращений к app.getPath('userData').
// Иначе в dev (`electron .` из desktop/) Electron берёт name из package.json
// — там `@owncord/desktop` — и кладёт пользовательские данные в
// `%APPDATA%\@owncord\desktop`, а в собранном NSIS-приложении —
// в `%APPDATA%\OwnCord` (productName из electron-builder). Из-за
// разных userData renderer'у достаются РАЗНЫЕ localStorage между
// dev и прод-сборкой, и юзер видит «разлогин на каждом запуске».
// setName('OwnCord') синхронизирует обе ветки.
app.setName('OwnCord');

// Путь к иконке окна. На Windows electron-builder подставляет .ico из
// сборки автоматически, но для dev-режима указываем вручную, иначе в
// taskbar светится иконка Electron'а.
const WINDOW_ICON = path.join(__dirname, 'assets', 'icon.png');

let mainWindow = null;
let cfg = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    title: 'OwnCord',
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Разрешаем WebRTC + getUserMedia без отдельных пермишенов:
      // системный браузер сам выкатит OS-popup для микрофона.
      sandbox: false,
    },
  });

  // Внешние ссылки уводим в системный браузер — чтобы пользователь не
  // случайно «застрял» в десктопе на http://google.com и т.п.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {
        /* ignore */
      });
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Скрываем стандартное меню (File/Edit/...) — у нас своё UI.
  // Контекстное меню (правая кнопка) и DevTools (F12) остаются доступны.
  Menu.setApplicationMenu(null);

  loadServerUrl();

  // Перерегистрируем shortcut'ы после готовности окна — иначе webContents
  // может оказаться не готов к send(). Регистрируем И клавиатурные
  // (через Electron globalShortcut), И мышиные (через uiohook-napi) —
  // оба модуля сами фильтруют свой тип acc'а из общей карты.
  mainWindow.webContents.once('did-finish-load', () => {
    if (cfg.hotkeysEnabled) {
      shortcuts.register(cfg.shortcuts || {}, mainWindow);
      mouseHook.register(cfg.shortcuts || {}, mainWindow);
    }
    // Автообновление: настраиваем после готовности webContents,
    // чтобы первые события (checking/available) долетели до renderer'а.
    // В dev (app.isPackaged === false) сам модуль no-op'ит.
    autoUpdater.setup(mainWindow, { app, ipcMain });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function loadServerUrl() {
  const url = (cfg?.serverUrl || '').trim();
  if (!url) {
    // Пустой URL — рисуем встроенную страницу-настройщик. Простой HTML
    // прямо здесь, чтобы не тащить отдельный билд под него. После того
    // как юзер нажмёт «Сохранить», main процесс перезагрузит окно.
    const html = setupHtml();
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return;
  }
  mainWindow.loadURL(url).catch((e) => {
    console.error('Failed to load', url, e);
    // Падение загрузки — показываем тот же экран настроек, чтобы юзер
    // мог исправить URL без удаления конфига руками.
    mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(setupHtml(`Не удалось открыть ${url}: ${e?.message || e}`))}`,
    );
  });
}

function setupHtml(error) {
  // Inline-стиль и скрипт. Связь с main через window.electronAPI (preload).
  const errBlock = error
    ? `<div style="background:#3a1212;color:#ffb4b4;padding:10px 14px;border-radius:8px;margin-bottom:12px;">${escapeHtml(error)}</div>`
    : '';
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>OwnCord — настройка</title>
<style>
  body{margin:0;background:#0b0d10;color:#e2e8f0;font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;display:grid;place-items:center;min-height:100vh}
  .card{background:#13171c;border:1px solid #232830;border-radius:12px;padding:24px 28px;width:min(420px,90vw)}
  h1{font-size:18px;margin:0 0 14px}
  label{display:block;font-size:12px;color:#94a3b8;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;background:#0b0d10;border:1px solid #232830;border-radius:8px;color:#e2e8f0;font-size:14px}
  button{margin-top:14px;width:100%;padding:10px 12px;background:#1f6feb;border:0;border-radius:8px;color:white;font-weight:600;cursor:pointer}
  button:hover{background:#3a85ff}
  small{display:block;color:#64748b;font-size:11px;margin-top:8px}
</style>
</head><body>
<div class="card">
  <h1>Адрес сервера OwnCord</h1>
  ${errBlock}
  <label>URL (например, https://owncord.example.com)</label>
  <input id="url" placeholder="http://localhost:3000" />
  <button id="save">Сохранить и подключиться</button>
  <small>Этот адрес можно изменить позже в настройках приложения. Конфиг хранится в папке профиля пользователя.</small>
</div>
<script>
  const input = document.getElementById('url');
  const btn = document.getElementById('save');
  // electronAPI здесь доступен потому, что preload подключается ВСЕГДА —
  // даже для inline data:URL, который мы открыли через loadURL.
  window.electronAPI?.getConfig?.().then((c) => { input.value = c?.serverUrl || ''; });
  btn.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) return;
    await window.electronAPI?.setConfig?.({ serverUrl: url });
    location.reload(); // main перехватит next-load и грузит уже сервер
  });
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// --- IPC ---------------------------------------------------------

ipcMain.handle('config:get', () => cfg);

ipcMain.handle('config:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return cfg;
  cfg = { ...cfg, ...patch, shortcuts: { ...(cfg?.shortcuts || {}), ...(patch.shortcuts || {}) } };
  config.save(cfg);
  // serverUrl изменился — перезагрузим окно.
  if ('serverUrl' in patch && mainWindow) {
    setTimeout(() => loadServerUrl(), 50);
  }
  // shortcuts изменились — перерегистрируем оба слоя (клавиатурный
  // globalShortcut и мышиный uIOhook). Каждый сам отфильтрует свой тип.
  if ('shortcuts' in patch || 'hotkeysEnabled' in patch) {
    if (cfg.hotkeysEnabled) {
      shortcuts.register(cfg.shortcuts || {}, mainWindow);
      mouseHook.register(cfg.shortcuts || {}, mainWindow);
    } else {
      shortcuts.unregisterAll();
      mouseHook.unregisterAll();
    }
  }
  return cfg;
});

ipcMain.handle('shortcuts:set', (_e, map) => {
  cfg.shortcuts = { ...(cfg.shortcuts || {}), ...(map || {}) };
  config.save(cfg);
  if (cfg.hotkeysEnabled && mainWindow) {
    // Сначала клавиатура (быстрее регится), потом мышь (запускает
    // фоновый поток uIOhook при необходимости). Возвращаем объединённый
    // список реально зарегистрированных acc'ов — UI это игнорирует, но
    // полезно для отладки.
    const kb = shortcuts.register(cfg.shortcuts, mainWindow);
    const mouse = mouseHook.register(cfg.shortcuts, mainWindow);
    return [...kb, ...mouse];
  }
  return [];
});

ipcMain.handle('shortcuts:get', () => cfg?.shortcuts || {});

// Версия приложения. Источник правды — app.getVersion(), который читает
// version из desktop/package.json при запаковке. Renderer показывает её
// в сайдбаре настроек, чтобы пользователь видел, какой билд у него стоит
// (особенно полезно при автообновлениях).
ipcMain.handle('app:version', () => app.getVersion());

// --- Lifecycle ---------------------------------------------------

app.whenReady().then(() => {
  cfg = config.load();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  shortcuts.unregisterAll();
  mouseHook.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  shortcuts.unregisterAll();
  mouseHook.unregisterAll();
});
