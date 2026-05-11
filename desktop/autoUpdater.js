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

// Сравнение semver-версий "X.Y.Z". Возвращает true, если remote строго
// новее, чем local. Простая поэлементная разбивка по точкам — suffix'ов
// типа "-rc1" у нас в релизах нет, городить semver-пакет не нужно.
function isVersionNewer(remote, local) {
  const r = String(remote || '')
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0);
  const l = String(local || '')
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const a = r[i] || 0;
    const b = l[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

// Обёртка над autoUpdater.checkForUpdates() с фиксом для случая, когда
// installer уже лежит в %LOCALAPPDATA%\@owncorddesktop-updater\pending от
// прошлой сессии (например, пользователь скачал апдейт, но не нажал
// «Перезапустить и обновить», а потом перезагрузил машину).
//
// В таком кейсе electron-updater при checkForUpdates():
//   1) эмитит 'checking-for-update' и 'update-available' как обычно,
//   2) видит файл в pending, возвращает result с downloadPromise = null,
//   3) НЕ эмитит повторного 'update-downloaded' event'а.
//
// UI в SettingsPanel завязан на event'ы: после 'available' ждёт 'progress'
// или 'downloaded'. Не получая ничего, через 60 сек срабатывает watchdog
// и показывает «Нет ответа от сервера обновлений (60 сек)» — хотя файл
// УЖЕ готов к установке.
//
// Здесь мы вручную эмитим 'downloaded' broadcast, если updateInfo.version
// новее текущей и downloadPromise null.
async function safeCheckForUpdates(updater, window, app) {
  const result = await updater.checkForUpdates();
  if (!result || !result.updateInfo) return result;
  const remoteVer = result.updateInfo.version;
  const localVer = app.getVersion();
  if (!result.downloadPromise && isVersionNewer(remoteVer, localVer)) {
    broadcast(window, 'downloaded', {
      version: remoteVer,
      releaseDate: result.updateInfo.releaseDate,
    });
  }
  return result;
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
    safeCheckForUpdates(autoUpdater, window, app).catch((e) => {
      log.warn('manual update:check failed:', e?.message || e);
    });
    return { ok: true };
  });

  // Стартовая проверка с небольшой задержкой — пусть UI прогрузится,
  // window-listener'ы навесятся, потом начинаем шуметь сетью.
  setTimeout(() => {
    safeCheckForUpdates(autoUpdater, window, app).catch(() => {
      /* свалимся в error-event */
    });
  }, STARTUP_DELAY);

  // Периодическая проверка. clearInterval не нужен — процесс завершится
  // вместе с окном; node таймеры не держат event loop при app.quit().
  pollTimer = setInterval(() => {
    safeCheckForUpdates(autoUpdater, window, app).catch(() => {
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
