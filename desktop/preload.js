// Preload: единственный мост между main и renderer'ом.
//
// contextBridge экспонирует ровно тот набор функций, который нужен
// клиенту OwnCord. Любая попытка из renderer'а дотянуться до Node API
// в обход этого моста = отказ; так и должно быть (contextIsolation).
//
// Обработка 'shortcut:fired':
//   Main шлёт IPC при срабатывании глобального хоткея, мы превращаем
//   событие в DOM-event 'owncord:shortcut' с detail.action = 'toggleMute'
//   и т.п. На него подписаны useCall/useGroupCall, которые вызывают
//   соответствующий toggle. Так renderer-код не зависит от Electron'а:
//   на вебе DOM-событие никто не пошлёт — фича просто не работает.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Метка, по которой клиент детектит, что он в десктоп-обёртке.
  isDesktop: true,

  // Версия desktop-приложения (из desktop/package.json через app.getVersion()).
  // Используется в SettingsPanel для отображения "OwnCord X.Y.Z" в сайдбаре.
  // Возвращает Promise<string>.
  getVersion: () => ipcRenderer.invoke('app:version'),

  // --- Конфиг (server URL, autostart, hotkeysEnabled) ---
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // --- Глобальные хоткеи ---
  // map: { toggleMute: 'CommandOrControl+Shift+M', toggleDeafen: '...' }
  // null/'' в значении = снять хоткей для этого действия.
  setShortcuts: (map) => ipcRenderer.invoke('shortcuts:set', map),
  getShortcuts: () => ipcRenderer.invoke('shortcuts:get'),

  // Подписка на срабатывания хоткеев. Возвращает unsubscribe.
  onShortcut: (handler) => {
    const listener = (_e, payload) => {
      try {
        const action = payload?.action;
        if (!action) return;
        // Проксируем в DOM-событие. detail.action — имя действия
        // ('toggleMute' | 'toggleDeafen' | ...).
        window.dispatchEvent(new CustomEvent('owncord:shortcut', { detail: { action } }));
        if (typeof handler === 'function') handler(action);
      } catch (err) {
        console.warn('shortcut handler failed:', err);
      }
    };
    ipcRenderer.on('shortcut:fired', listener);
    return () => ipcRenderer.removeListener('shortcut:fired', listener);
  },

  // --- Автообновление -------------------------------------------------
  // Подписка на жизненный цикл апдейта. payload.kind:
  //   'checking' | 'available' | 'none' | 'progress' | 'downloaded' | 'error'
  // Возвращает unsubscribe.
  onUpdateEvent: (handler) => {
    const listener = (_e, payload) => {
      try {
        // DOM-событие — для компонентов, которые не могут вызвать preload
        // напрямую (хук в одном месте, listener'ы в другом).
        window.dispatchEvent(new CustomEvent('owncord:update', { detail: payload }));
        if (typeof handler === 'function') handler(payload);
      } catch (err) {
        console.warn('update handler failed:', err);
      }
    };
    ipcRenderer.on('update:event', listener);
    return () => ipcRenderer.removeListener('update:event', listener);
  },

  // Применить скачанный апдейт прямо сейчас. Под капотом
  // autoUpdater.quitAndInstall(silent=true, runAfter=true) — приложение
  // закроется, NSIS бесшумно подменит файлы, новая версия запустится.
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Ручная проверка обновлений (например, кнопка в настройках).
  // Возвращает { ok: boolean, version?: string, error?: string }.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
});
