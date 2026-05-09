import { useEffect } from 'react';
import { applyShortcuts, isDesktop } from '../utils/desktop';
import type { Shortcuts, ShortcutAction } from '../utils/desktop';

/**
 * useKeybinds — синхронизация настроек keybinds с десктоп-обёрткой.
 *
 * Контракт:
 *   - На вебе (window.electronAPI отсутствует) хук — no-op. Поле
 *     settings.keybinds всё равно сохраняется в localStorage, но
 *     никем не считывается, и UI вкладки «Биндинги» прячется.
 *   - В десктопе при ИЗМЕНЕНИИ settings.keybinds мы шлём свежую карту
 *     в main-процесс (preload → ipcRenderer.invoke 'shortcuts:set'),
 *     который перерегистрирует globalShortcut'ы. Сам main потом будет
 *     слать события 'shortcut:fired', которые preload превратит в
 *     DOM-event 'owncord:shortcut'. Подписаны на него useCall и
 *     useGroupCall.
 *
 * Поле deps — плоский набор значений keybinds. Если добавляешь новое
 * действие, не забудь:
 *   1) расширить ShortcutAction в utils/desktop.ts;
 *   2) добавить ключ в DEFAULTS.keybinds в SettingsContext;
 *   3) расширить deps ниже;
 *   4) добавить слушателя в useCall.ts/useGroupCall.ts.
 */
export function useKeybinds(keybinds: Partial<Record<ShortcutAction, string | null>> | undefined) {
  const toggleMute = keybinds?.toggleMute ?? null;
  const toggleDeafen = keybinds?.toggleDeafen ?? null;

  useEffect(() => {
    if (!isDesktop()) return;
    const map: Shortcuts = { toggleMute, toggleDeafen };
    void applyShortcuts(map);
  }, [toggleMute, toggleDeafen]);
}
