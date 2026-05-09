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
});
