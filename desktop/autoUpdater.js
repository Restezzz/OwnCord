// Автообновление десктоп-клиента OwnCord.
//
// Поток:
//   1. Через 8 секунд после старта приложения и далее раз в 6 часов
//      опрашиваем feed (см. publish-конфиг в package.json).
//   2. electron-updater сам тащит latest.yml с сервера и сравнивает версии.
//   3. Если есть новее — качает diff (differentialPackages: true в NSIS-
//      конфиге) или полный installer в `%APPDATA%\OwnCord\__pending` в фоне.
//   4. Все события прокидываются в renderer через IPC 'update:event' →
//      preload превращает в DOM-event 'owncord:update' для React-тоста.
//   5. Юзер жмёт «Перезапустить и обновить» → renderer вызывает
//      ipc 'update:install' → autoUpdater.quitAndInstall() → silent NSIS
//      replace + рестарт.
//
// Что НЕ делаем:
//   - Не запускаем апдейтер в dev-режиме (`electron .`) — там
//     app.isPackaged = false. electron-updater всё равно бы упал на отсутствии
//     `app-update.yml`, который пишется только при packaging.
//   - Не блокируем UI на проверку. Если сервер недоступен — тихо
//     логируем и пробуем в следующий раз.

const { autoUpdater } = require('electron-updater');

// Нет авто-инсталла при quit'е — иначе юзер может неожиданно поймать
// рестарт при закрытии окна. Делаем явное действие через UI-кнопку.
autoUpdater.autoInstallOnAppQuit = false;
// Авто-скачивание оставляем включённым: пользователь увидит готовое
// обновление с минимальным ожиданием. Скачивание идёт в фоне и не
// блокирует UI; на медленном канале — viewing прогресс через тост.
autoUpdater.autoDownload = true;
// В логи main-процесса попадут стадии (полезно для дебага у юзера
// через DevTools → Console main-процесса не видно, но в stdout/stderr —
// да, плюс electron-updater умеет писать в файл, если подключить).
autoUpdater.logger = console;

const SIX_HOURS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY = 8000;

let setupDone = false;
let pollTimer = null;

function broadcast(window, kind, payload = {}) {
  if (!window || window.isDestroyed()) return;
  try {
    window.webContents.send('update:event', { kind, ...payload });
  } catch {
    // окно могло закрыться между проверкой и send
  }
}

/**
 * Подключает autoUpdater к окну. Вызывать один раз после createWindow.
 * Безопасен к повторному вызову (idempotent).
 */
function setup(window, { app, ipcMain }) {
  if (setupDone) return;
  // В dev электрон не упакован — пропускаем (electron-updater разнесёт
  // приложение, потому что app-update.yml кладётся только в asar).
  if (!app.isPackaged) return;

  autoUpdater.on('checking-for-update', () => broadcast(window, 'checking'));

  autoUpdater.on('update-available', (info) => {
    broadcast(window, 'available', {
      version: info?.version,
      releaseDate: info?.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', () => broadcast(window, 'none'));

  autoUpdater.on('error', (err) => {
    broadcast(window, 'error', { message: err?.message || String(err) });
  });

  autoUpdater.on('download-progress', (p) => {
    broadcast(window, 'progress', {
      percent: p?.percent ?? 0,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    broadcast(window, 'downloaded', {
      version: info?.version,
      releaseDate: info?.releaseDate,
    });
  });

  // IPC: рестарт с применением апдейта.
  // Параметры quitAndInstall:
  //   isSilent=true — installer NSIS работает без UI (юзер не видит мастер
  //     при обновлении, только сразу рестарт в новую версию).
  //   forceRunAfter=true — после установки сразу запустить обновлённое
  //     приложение, а не только закрыть текущее.
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(true, true);
    return true;
  });

  // IPC: ручная проверка по кнопке в настройках.
  ipcMain.handle('update:check', async () => {
    try {
      const res = await autoUpdater.checkForUpdates();
      return { ok: true, version: res?.updateInfo?.version };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Стартовая проверка с небольшой задержкой — пусть UI прогрузится,
  // window-listener'ы навесятся, потом начинаем шуметь сетью.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => { /* свалимся в error-event */ });
  }, STARTUP_DELAY);

  // Периодическая проверка. clearInterval не нужен — процесс завершится
  // вместе с окном; node таймеры не держат event loop при app.quit().
  pollTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => { /* swallow */ });
  }, SIX_HOURS);

  setupDone = true;
}

function teardown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = { setup, teardown };
