import { useEffect } from 'react';
import { applyShortcuts, isDesktop, isMouseAccelerator } from '../utils/desktop';
import type { Shortcuts, ShortcutAction } from '../utils/desktop';

/**
 * useKeybinds — синхронизация настроек keybinds с десктоп-обёрткой.
 *
 * Контракт:
 *   - На вебе (window.electronAPI отсутствует) клавиатурная часть — no-op.
 *     Поле settings.keybinds всё равно сохраняется в localStorage, но
 *     globalShortcut'ы вне фокуса работать не могут — UI вкладки
 *     «Горячие клавиши» прячется (см. SettingsPanel.desktopOnly).
 *   - В десктопе при ИЗМЕНЕНИИ settings.keybinds мы шлём свежую карту
 *     в main-процесс (preload → ipcRenderer.invoke 'shortcuts:set'),
 *     который перерегистрирует globalShortcut'ы. Сам main потом будет
 *     слать события 'shortcut:fired', которые preload превратит в
 *     DOM-event 'owncord:shortcut'. Подписаны на него useCall и
 *     useGroupCall.
 *
 * Мышь:
 *   Electron globalShortcut НЕ умеет ловить кнопки мыши на уровне ОС.
 *   Поэтому мышиные acc'ы (Mouse4/Mouse5/MouseMiddle и т.п.) мы НЕ
 *   передаём в applyShortcuts'у — он бы всё равно их отбраковал. Вместо
 *   этого вешаем window-level mousedown listener, который при совпадении
 *   кнопки + модификаторов сам диспатчит то же DOM-событие
 *   'owncord:shortcut'. Это значит:
 *     - мышь работает только когда окно OwnCord в фокусе (в отличие от
 *       клавиатуры, которая через globalShortcut работает реально
 *       глобально);
 *     - useCall/useGroupCall не должны отличать источник — обе ветки
 *       приходят им через один и тот же 'owncord:shortcut' event.
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

  // 1) Клавиатурная часть → Electron globalShortcut. Мышиные acc'ы
  //    отдельно отфильтруем (передавать их в setShortcuts бесполезно).
  useEffect(() => {
    if (!isDesktop()) return;
    const map: Shortcuts = {
      toggleMute: isMouseAccelerator(toggleMute) ? null : toggleMute,
      toggleDeafen: isMouseAccelerator(toggleDeafen) ? null : toggleDeafen,
    };
    void applyShortcuts(map);
  }, [toggleMute, toggleDeafen]);

  // 2) Мышиная часть → локальный window mousedown listener. Регистрируем
  //    только если хотя бы один из acc'ов реально мышиный. Иначе нет
  //    смысла висеть на каждом mousedown по странице.
  useEffect(() => {
    const mouseBinds: { acc: string; action: ShortcutAction }[] = [];
    if (isMouseAccelerator(toggleMute)) {
      mouseBinds.push({ acc: toggleMute as string, action: 'toggleMute' });
    }
    if (isMouseAccelerator(toggleDeafen)) {
      mouseBinds.push({ acc: toggleDeafen as string, action: 'toggleDeafen' });
    }
    if (mouseBinds.length === 0) return undefined;

    // mouseAccel совпадает целиком (включая модификаторы), а не «частично»,
    // чтобы Ctrl+Mouse4 не срабатывал на голый Mouse4 — и наоборот.
    const matches = (e: MouseEvent, acc: string): boolean => {
      const want = parseAccelerator(acc);
      const haveMods = {
        ctrl: e.ctrlKey || e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };
      if (want.ctrl !== haveMods.ctrl) return false;
      if (want.alt !== haveMods.alt) return false;
      if (want.shift !== haveMods.shift) return false;
      return mouseButtonToKey(e.button) === want.key;
    };

    const onMouseDown = (e: MouseEvent) => {
      // Не трогаем UI-клики: ЛКМ/ПКМ должны работать как обычно.
      if (e.button === 0 || e.button === 2) return;
      for (const { acc, action } of mouseBinds) {
        if (matches(e, acc)) {
          // preventDefault для X1/X2 нужен ещё и потому, что некоторые
          // браузеры по дефолту маппят их на «Назад/Вперёд» (history.back).
          // Без этого — toggleMute сработает, но и страница перейдёт.
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('owncord:shortcut', { detail: { action } }));
          return;
        }
      }
    };

    // capture=true и passive=false — чтобы мы первыми получили событие
    // и могли prevent'нуть навигацию back/forward по X1/X2.
    window.addEventListener('mousedown', onMouseDown, { capture: true, passive: false });
    return () => {
      window.removeEventListener('mousedown', onMouseDown, { capture: true } as any);
    };
  }, [toggleMute, toggleDeafen]);
}

// Внутренние утилиты. Парсер строки accelerator'а в нормализованный
// объект — нужен только тут (вне keybind matching смысла нет, поэтому
// в utils/desktop.ts не вытаскиваем).
function parseAccelerator(acc: string): {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
} {
  const parts = acc.split('+');
  const out = { ctrl: false, alt: false, shift: false, key: '' };
  for (const p of parts) {
    if (p === 'CommandOrControl' || p === 'Command' || p === 'Control') out.ctrl = true;
    else if (p === 'Alt') out.alt = true;
    else if (p === 'Shift') out.shift = true;
    else out.key = p;
  }
  return out;
}

function mouseButtonToKey(button: number): string | null {
  if (button === 1) return 'MouseMiddle';
  if (button >= 3) return `Mouse${button + 1}`;
  return null;
}
