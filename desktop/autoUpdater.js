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
const log = require('electron-log');

// Файловый лог auto-update в %APPDATA%\OwnCord\logs\main.log (Windows),
// ~/Library/Logs/OwnCord/main.log (mac), ~/.config/OwnCord/logs/main.log
// (linux). Без этого у юзеров «слепое пятно»: NSIS-сборка не пишет
// stdout никуда (нет parent-консоли), и понять, почему «Проверяю…»
// висит — невозможно. Размер файла ограничиваем, чтобы не пухло.
log.transports.file.level = 'info';
log.transports.file.maxSize = 1024 * 1024; // 1 MB
log.transports.console.level = 'info';

// Нет авто-инсталла при quit'е — иначе юзер может неожиданно поймать
// рестарт при закрытии окна. Делаем явное действие через UI-кнопку.
autoUpdater.autoInstallOnAppQuit = false;
// Авто-скачивание оставляем включённым: пользователь увидит готовое
// обновление с минимальным ожиданием. Скачивание идёт в фоне и не
// блокирует UI; на медленном канале — viewing прогресс через тост.
autoUpdater.autoDownload = true;
// Все стадии auto-update идут в файл-лог. Поднять уровень логирования
// до 'debug' можно при необходимости (видно весь network-flow).
autoUpdater.logger = log;

// Интервал фоновой проверки. 1 час = достаточно шустро для юзера
// (увидит тост в течение часа после релиза, если окно открыто), и
// одновременно не спамит latest.yml с сотен клиентов. latest.yml весит
// ~350 байт + HTTP-оверхед, так что сеть не напрягается.
const ONE_HOUR = 60 * 60 * 1000;
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
  // В dev электрон не упакован — пропускаем сам auto-update flow
  // (electron-updater разнесёт приложение, потому что app-update.yml
  // кладётся только в asar). НО IPC-стабы регистрируем — иначе renderer
  // ловит "No handler registered for 'update:check'" каждый раз, когда
  // ScreenQualityModal/SettingsPanel дёргают checkForUpdates() при mount.
  if (!app.isPackaged) {
    setupDone = true;
    ipcMain.handle('update:check', () => ({
      ok: false,
      error: 'Auto-update недоступен в dev-режиме',
    }));
    ipcMain.handle('update:install', () => false);
    return;
  }

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
  //
  // НЕ ждём resolve самого checkForUpdates(): при autoDownload=true этот
  // promise висит ДО конца download'а полного installer'а (~100 MB), а
  // в редких кейсах (порвалась сеть, сервер не отвечает после headers)
  // не резолвится никогда. Раньше из-за этого UI «Проверяю…» висел до
  // победы — IPC просто не возвращал response.
  //
  // Сейчас стартуем проверку в фоне и сразу отдаём { ok: true }. Все
  // финальные стадии (available / progress / downloaded / none / error)
  // прилетают в renderer через broadcast 'update:event' — их и слушает
  // UI для перехода из 'checking' в терминальный стейт.
  ipcMain.handle('update:check', () => {
    autoUpdater.checkForUpdates().catch((e) => {
      log.warn('manual update:check failed:', e?.message || e);
    });
    return { ok: true };
  });

  // Стартовая проверка с небольшой задержкой — пусть UI прогрузится,
  // window-listener'ы навесятся, потом начинаем шуметь сетью.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      /* свалимся в error-event */
    });
  }, STARTUP_DELAY);

  // Периодическая проверка. clearInterval не нужен — процесс завершится
  // вместе с окном; node таймеры не держат event loop при app.quit().
  pollTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {
      /* swallow */
    });
  }, ONE_HOUR);

  setupDone = true;
}

function teardown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = { setup, teardown };
