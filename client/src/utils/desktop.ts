// Тонкая обёртка над window.electronAPI, который выставляет preload.js
// десктоп-приложения. Назначение этого модуля — изолировать остальной
// клиент от прямой работы с Electron'ом и дать одну точку для проверки
// "мы в десктопе или в браузере".
//
// На вебе window.electronAPI === undefined, и все методы тут возвращают
// безопасные дефолты (null/false). UI, основанный на isDesktop(), должен
// сам прятать соответствующие элементы (например, вкладку «Горячие клавиши»).
//
// Действия (action) для shortcut'ов задаются строками. Когда добавляешь
// новый — обнови:
//   1) ShortcutAction-тип ниже,
//   2) DEFAULT_KEYBINDS в SettingsContext (имя поля = action),
//   3) UI с KeybindRecorder в settings/KeybindsTab,
//   4) Слушатель в useCall/useGroupCall (window.addEventListener
//      'owncord:shortcut').
//
// Мышь:
//   Electron globalShortcut НЕ умеет ловить кнопки мыши на уровне ОС
//   (это ограничение API — он принимает только клавиатурные acc'ы). Чтобы
//   юзер мог хоть как-то использовать боковые кнопки мыши, мы:
//   а) разрешаем записывать accelerator вида `Mouse3..Mouse5`/`MouseMiddle`
//      (с опц. модификаторами Ctrl/Alt/Shift) в KeybindsTab;
//   б) на стороне renderer'а (useKeybinds) подписываемся на window
//      mousedown и сами диспатчим 'owncord:shortcut'. Так мышь работает
//      ТОЛЬКО когда окно OwnCord в фокусе (в отличие от клавиатуры,
//      которая через globalShortcut работает реально глобально). UI
//      честно об этом сообщает.

export type ShortcutAction = 'toggleMute' | 'toggleDeafen';

// Карта имени → accelerator-строка Electron'а (или null/'' = unbind).
// Электроновские acc-строки: https://electronjs.org/docs/latest/api/accelerator
// Примеры: 'CommandOrControl+Shift+M', 'Alt+Space', 'F8'.
export type Shortcuts = Partial<Record<ShortcutAction, string | null>>;

// Жизненный цикл апдейта. Соответствует event'ам electron-updater'а
// в main-процессе (см. desktop/autoUpdater.js):
//   'checking'   — пошёл запрос за latest.yml
//   'available'  — есть новая версия, скачивается
//   'none'       — текущая версия актуальна
//   'progress'   — идёт скачивание (приходит много раз)
//   'downloaded' — апдейт готов, можно перезапускаться
//   'error'      — что-то пошло не так
export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version?: string; releaseDate?: string }
  | { kind: 'none' }
  | {
      kind: 'progress';
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  | { kind: 'downloaded'; version?: string; releaseDate?: string }
  | { kind: 'error'; message: string };

type ElectronApi = {
  isDesktop: true;
  getVersion?: () => Promise<string>;
  getConfig: () => Promise<any>;
  setConfig: (patch: any) => Promise<any>;
  getShortcuts: () => Promise<Shortcuts>;
  setShortcuts: (map: Shortcuts) => Promise<string[]>;
  onShortcut: (handler?: (action: ShortcutAction) => void) => () => void;
  onUpdateEvent?: (handler?: (e: UpdateEvent) => void) => () => void;
  installUpdate?: () => Promise<true>;
  checkForUpdates?: () => Promise<{ ok: boolean; version?: string; error?: string }>;
};

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.isDesktop;
}

/**
 * Версия десктоп-приложения (из desktop/package.json через app.getVersion()).
 * Возвращает null на вебе или если preload не выставил getVersion (старая
 * сборка десктопа — graceful-fallback). Кэшируется на уровне модуля, чтобы
 * не плодить IPC при каждом рендере.
 */
let _versionCache: string | null | undefined;
export async function getDesktopVersion(): Promise<string | null> {
  if (_versionCache !== undefined) return _versionCache;
  if (!isDesktop() || !window.electronAPI?.getVersion) {
    _versionCache = null;
    return null;
  }
  try {
    const v = await window.electronAPI.getVersion();
    _versionCache = typeof v === 'string' && v ? v : null;
    return _versionCache;
  } catch {
    _versionCache = null;
    return null;
  }
}

/**
 * Применяет map of shortcut'ов к main-процессу. На вебе — no-op, чтобы
 * вызывающий код мог звать этот метод безусловно при любом изменении
 * настроек, не плодя if'ов.
 */
export async function applyShortcuts(map: Shortcuts): Promise<void> {
  if (!isDesktop()) return;
  try {
    await window.electronAPI!.setShortcuts(map);
  } catch (e) {
    console.warn('applyShortcuts failed:', e);
  }
}

/**
 * Подписка на DOM-event 'owncord:shortcut', который preload.js шлёт в
 * ответ на срабатывание globalShortcut'а в main. Возвращает unsubscribe.
 */
export function onShortcutEvent(handler: (action: ShortcutAction) => void): () => void {
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent).detail;
    const action = detail?.action as ShortcutAction | undefined;
    if (!action) return;
    handler(action);
  };
  window.addEventListener('owncord:shortcut', listener as EventListener);
  return () => window.removeEventListener('owncord:shortcut', listener as EventListener);
}

/**
 * Подписка на события автообновления (см. UpdateEvent выше).
 * На вебе — no-op (вернёт пустой unsubscribe), что позволяет UI
 * звать его безусловно при mount'е.
 */
export function onUpdateEvent(handler: (e: UpdateEvent) => void): () => void {
  if (!isDesktop())
    return () => {
      /* noop */
    };
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent).detail as UpdateEvent | undefined;
    if (!detail?.kind) return;
    handler(detail);
  };
  window.addEventListener('owncord:update', listener as EventListener);
  return () => window.removeEventListener('owncord:update', listener as EventListener);
}

/**
 * Применить уже скачанный апдейт. Закрывает приложение, NSIS бесшумно
 * подменит файлы, новая версия запустится. Вызывать только после того,
 * как пришёл event { kind: 'downloaded' }.
 */
export async function installUpdate(): Promise<void> {
  if (!isDesktop()) return;
  try {
    await window.electronAPI!.installUpdate?.();
  } catch (e) {
    console.warn('installUpdate failed:', e);
  }
}

/**
 * Ручная проверка обновлений (для кнопки в настройках).
 * На вебе вернёт null. На десктопе — результат запроса.
 */
export async function checkForUpdates(): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
} | null> {
  if (!isDesktop()) return null;
  try {
    return (await window.electronAPI!.checkForUpdates?.()) || null;
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) };
  }
}

/**
 * Утилита: берёт DOM KeyboardEvent и собирает Electron-совместимый
 * accelerator-string. Используется в UI-рекордере хоткея.
 *
 * Возвращает null, если нажата только модификаторная клавиша (Shift/
 * Alt/...) без основной — это даёт возможность пользователю набрать
 * комбо постепенно (зажал Ctrl, потом Shift, потом 'M').
 *
 * Преобразуем код клавиш в формат, который понимает globalShortcut:
 *   - буквы → 'A'..'Z' (без локали — globalShortcut работает по физкодам)
 *   - цифры верхнего ряда → '0'..'9'
 *   - F-клавиши → 'F1'..'F24'
 *   - стрелки → 'Up'/'Down'/'Left'/'Right'
 *   - спец → 'Space', 'Tab', 'Enter', 'Backspace', 'Escape', 'Delete'
 */
export function keyEventToAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  // CommandOrControl — кросс-платформенный модификатор. На macOS = Cmd,
  // на Windows/Linux = Ctrl. Ставим его раньше Alt/Shift по конвенции.
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const code = e.code;
  let key: string | null = null;

  if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3); // 'KeyA' → 'A'
  } else if (/^Digit\d$/.test(code)) {
    key = code.slice(5); // 'Digit3' → '3'
  } else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) {
    key = code; // 'F1'..'F24'
  } else if (code === 'ArrowUp') key = 'Up';
  else if (code === 'ArrowDown') key = 'Down';
  else if (code === 'ArrowLeft') key = 'Left';
  else if (code === 'ArrowRight') key = 'Right';
  else if (code === 'Space') key = 'Space';
  else if (code === 'Tab') key = 'Tab';
  else if (code === 'Enter') key = 'Return';
  else if (code === 'Backspace') key = 'Backspace';
  else if (code === 'Escape') key = 'Esc';
  else if (code === 'Delete') key = 'Delete';
  else if (code === 'Home') key = 'Home';
  else if (code === 'End') key = 'End';
  else if (code === 'PageUp') key = 'PageUp';
  else if (code === 'PageDown') key = 'PageDown';
  else if (code === 'Comma') key = ',';
  else if (code === 'Period') key = '.';
  else if (code === 'Slash') key = '/';
  else if (code === 'Backslash') key = '\\';
  else if (code === 'Semicolon') key = ';';
  else if (code === 'Quote') key = "'";
  else if (code === 'BracketLeft') key = '[';
  else if (code === 'BracketRight') key = ']';
  else if (code === 'Minus') key = '-';
  else if (code === 'Equal') key = '=';
  else if (code === 'Backquote') key = '`';

  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

/**
 * Утилита: берёт DOM MouseEvent и собирает наш «псевдо-accelerator» вида
 * `Mouse4`/`Ctrl+Mouse5`. Это НЕ настоящий Electron-accelerator —
 * globalShortcut такие не принимает; мы их обрабатываем сами в
 * useKeybinds через window-listener (см. подробный комментарий в шапке
 * файла, секция «Мышь»).
 *
 * Маппинг кнопок (DOM MouseEvent.button):
 *   0 = ЛКМ      — пропускаем, это нормальный клик по UI
 *   1 = Wheel    — `MouseMiddle`
 *   2 = ПКМ      — пропускаем, контекстное меню
 *   3 = Side1/X1 — `Mouse4` (исторически «Назад»)
 *   4 = Side2/X2 — `Mouse5` (исторически «Вперёд»)
 *   ≥5           — `MouseN` (некоторые игровые мыши умеют)
 *
 * Возвращает null для ЛКМ/ПКМ — их перехватывать в keybind-рекордере не
 * стоит, иначе UI станет неюзабельным (любой клик по странице запишется
 * как хоткей).
 */
export function mouseEventToAccelerator(e: MouseEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key: string | null = null;
  if (e.button === 0 || e.button === 2) {
    // ЛКМ и ПКМ занимать нельзя — это базовая навигация по UI.
    return null;
  }
  if (e.button === 1) key = 'MouseMiddle';
  else if (e.button >= 3) key = `Mouse${e.button + 1}`; // 3 → Mouse4, 4 → Mouse5

  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

/**
 * true, если accelerator завершается на «мышиную» клавишу. Такие
 * accelerator'ы Electron globalShortcut НЕ может зарегистрировать —
 * useKeybinds обрабатывает их сам, слушая window mousedown.
 */
export function isMouseAccelerator(acc: string | null | undefined): boolean {
  if (!acc) return false;
  const last = acc.split('+').pop() || '';
  return /^Mouse(Middle|[3-9]|\d{2})$/.test(last);
}

/**
 * Человеко-читаемое представление accelerator-строки для UI.
 * 'CommandOrControl+Shift+M' → 'Ctrl+Shift+M' (на macOS будет '⌘+Shift+M').
 */
export function formatAccelerator(acc: string | null | undefined): string {
  if (!acc) return '';
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || '');
  return acc
    .split('+')
    .map((p) => {
      if (p === 'CommandOrControl') return isMac ? '⌘' : 'Ctrl';
      if (p === 'Command') return '⌘';
      if (p === 'Control') return 'Ctrl';
      if (p === 'Alt') return isMac ? '⌥' : 'Alt';
      if (p === 'Shift') return isMac ? '⇧' : 'Shift';
      if (p === 'Esc') return 'Esc';
      if (p === 'Return') return 'Enter';
      if (p === 'MouseMiddle') return 'СКМ';
      if (p === 'Mouse4') return 'Mouse 4';
      if (p === 'Mouse5') return 'Mouse 5';
      if (/^Mouse\d+$/.test(p)) return p.replace('Mouse', 'Mouse ');
      return p;
    })
    .join(isMac ? '' : '+');
}
