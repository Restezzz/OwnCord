// Регистрация глобальных хоткеев в main-процессе.
//
// Контракт:
//   register(map, win) — снимает старые регистрации и ставит новые.
//     `map` — { actionName: acceleratorString | null }; null/'' = не регать.
//     `win` — BrowserWindow, куда отправляем 'shortcut:fired' через webContents.send.
//   unregisterAll()    — снимает всё (вызываем при quit / blur'ом-выкл'е).
//
// Поведение:
//   - При нажатии хоткея main-процесс шлёт IPC 'shortcut:fired' с именем
//     action в renderer. Renderer (через preload) превращает в DOM-event
//     'owncord:shortcut', на который подписаны useCall/useGroupCall.
//   - Если accelerator невалидный (Electron бросает) — логируем, но
//     приложение НЕ падает; остальные shortcut'ы регистрируются.
//   - Конфликт с другими приложениями: globalShortcut.register может
//     вернуть false — тогда мы это просто фиксируем в логах.

const { globalShortcut } = require('electron');

let registered = []; // массив accelerator'ов, которые мы реально повесили

function unregisterAll() {
  for (const acc of registered) {
    try { globalShortcut.unregister(acc); } catch { /* */ }
  }
  registered = [];
}

function register(map, win) {
  unregisterAll();
  for (const [action, accelerator] of Object.entries(map || {})) {
    const acc = (accelerator || '').trim();
    if (!acc) continue;
    try {
      const ok = globalShortcut.register(acc, () => {
        if (!win || win.isDestroyed()) return;
        try {
          win.webContents.send('shortcut:fired', { action });
        } catch (e) {
          console.warn('shortcut send failed:', e);
        }
      });
      if (ok) {
        registered.push(acc);
      } else {
        console.warn(`globalShortcut.register("${acc}") returned false (busy by another app?)`);
      }
    } catch (e) {
      console.warn(`globalShortcut.register("${acc}") threw:`, e?.message || e);
    }
  }
  return registered.slice();
}

module.exports = { register, unregisterAll };
