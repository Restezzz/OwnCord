// Тонкая обёртка над window.electronAPI, который выставляет preload.js
// десктоп-приложения. Назначение этого модуля — изолировать остальной
// клиент от прямой работы с Electron'ом и дать одну точку для проверки
// "мы в десктопе или в браузере".
//
// На вебе window.electronAPI === undefined, и все методы тут возвращают
// безопасные дефолты (null/false). UI, основанный на isDesktop(), должен
// сам прятать соответствующие элементы (например, вкладку «Биндинги»).
//
// Действия (action) для shortcut'ов задаются строками. Когда добавляешь
// новый — обнови:
//   1) ShortcutAction-тип ниже,
//   2) DEFAULT_KEYBINDS в SettingsContext (имя поля = action),
//   3) UI с KeybindRecorder в SettingsPanel,
//   4) Слушатель в useCall/useGroupCall (window.addEventListener
//      'owncord:shortcut').

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
      return p;
    })
    .join(isMac ? '' : '+');
}
