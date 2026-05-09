// Таб «Биндинги» (только desktop): запись глобальных хоткеев для
// мьюта микрофона и глушения собеседников. Запись — простая state-машина:
//   1) idle: показываем текущий accelerator + кнопки «Записать» / «Очистить».
//   2) recording: поле ловит keydown'ы; считаем accelerator на каждом
//      нажатии (см. keyEventToAccelerator); как только key event приносит
//      основную клавишу (не только модификаторы) — записываем accelerator
//      в settings и выходим из recording.
//   3) Esc отменяет запись без изменений.
//
// settings.keybinds мутируется через update({ keybinds: { ... } }) —
// useKeybinds в Home.tsx видит новое значение и шлёт setShortcuts в main.
// Главное: keybinds — вложенный объект, а update делает Object.assign на
// верхнем уровне, поэтому мы СВОЕЙ рукой собираем полный объект и
// передаём его целиком (иначе случайно потеряем второй ключ).

import { useEffect, useRef, useState } from 'react';
import { Headphones, MicOff } from 'lucide-react';
import { useSettings } from '../../context/SettingsContext';
import { keyEventToAccelerator, formatAccelerator, type ShortcutAction } from '../../utils/desktop';

const KEYBIND_ACTIONS: { id: ShortcutAction; label: string; description: string; Icon: any }[] = [
  {
    id: 'toggleMute',
    label: 'Мьют микрофона',
    description: 'Переключить микрофон вкл/выкл (тогл).',
    Icon: MicOff,
  },
  {
    id: 'toggleDeafen',
    label: 'Глушить динамики',
    description: 'Переключить звук собеседников (тогл).',
    Icon: Headphones,
  },
];

function KeybindRow({
  action,
  label,
  description,
  Icon,
}: {
  action: ShortcutAction;
  label: string;
  description: string;
  Icon: any;
}) {
  const { settings, update } = useSettings();
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLDivElement>(null);
  const current = settings.keybinds?.[action] || null;

  useEffect(() => {
    // Авто-фокус на скрытое div'е во время записи — чтобы оно ловило
    // keydown'ы. Без этого фокус «уходит» на родительский <button>.
    if (recording) inputRef.current?.focus();
  }, [recording]);

  const writeKeybind = (acc: string | null) => {
    update({
      keybinds: {
        ...(settings.keybinds || {}),
        [action]: acc,
      },
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      // Esc — отмена записи, оставляем старое значение.
      setRecording(false);
      return;
    }
    const acc = keyEventToAccelerator(e.nativeEvent as unknown as KeyboardEvent);
    if (acc) {
      writeKeybind(acc);
      setRecording(false);
    }
    // Если пока нажаты только модификаторы — продолжаем слушать.
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="text-slate-400 shrink-0">
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-[11px] text-slate-500 leading-snug">{description}</div>
      </div>
      <div className="flex items-center gap-2">
        {recording ? (
          <div
            ref={inputRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onBlur={() => setRecording(false)}
            className="px-3 py-1.5 rounded-md text-xs bg-amber-500/15 border border-amber-500/40 text-amber-200 outline-none min-w-[160px] text-center font-mono"
          >
            Нажми комбинацию…
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRecording(true)}
            className="px-3 py-1.5 rounded-md text-xs bg-bg-3 hover:bg-bg-1 border border-border min-w-[160px] text-center font-mono"
            title="Записать новую комбинацию"
          >
            {current ? formatAccelerator(current) : 'Не назначено'}
          </button>
        )}
        <button
          type="button"
          onClick={() => writeKeybind(null)}
          disabled={!current && !recording}
          className="btn-ghost text-xs"
          title="Снять хоткей"
        >
          Сбросить
        </button>
      </div>
    </div>
  );
}

export function KeybindsTab() {
  return (
    <section className="space-y-4">
      <div className="text-xs text-slate-400 leading-snug">
        Глобальные горячие клавиши срабатывают, даже когда окно OwnCord не в фокусе. Используем
        формат Electron'а (<code className="text-[11px]">Ctrl+Shift+M</code>,{' '}
        <code className="text-[11px]">F8</code>, …). Если комбинация занята другим приложением —
        будет молча проигнорирована.
      </div>

      <div className="rounded-lg border border-border divide-y divide-border bg-bg-2">
        {KEYBIND_ACTIONS.map(({ id, label, description, Icon }) => (
          <KeybindRow key={id} action={id} label={label} description={description} Icon={Icon} />
        ))}
      </div>

      <div className="text-[11px] text-slate-500 leading-snug">
        Esc — отменить запись комбинации. «Сбросить» — снять привязку.
      </div>
    </section>
  );
}
