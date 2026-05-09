import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Download, RefreshCw, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { isDesktop, onUpdateEvent, installUpdate, type UpdateEvent } from '../utils/desktop';

// Внутреннее состояние тоста: один из стейтов жизненного цикла апдейта,
// плюс null когда нет ничего / юзер закрыл.
type State = UpdateEvent | null;

/**
 * Тост автообновления десктоп-клиента OwnCord.
 *
 * Поведение:
 *   - На вебе ничего не рендерит (isDesktop === false).
 *   - В dev-режиме (`electron .`) main-процесс не инициализирует
 *     autoUpdater, поэтому событий не будет — тост остаётся скрытым.
 *   - При 'available' показывает «качается».
 *   - При 'progress' рисует прогресс-бар.
 *   - При 'downloaded' меняется на «готово, перезапустить» с CTA-кнопкой.
 *   - При 'error' показывает причину; крестик закрывает.
 *   - 'none' / 'checking' игнорируются (silent — нечего сообщать).
 *
 * Дизайн: фикс. позиция bottom-right, не перекрывает чат, не блокирует
 * клики. Анимация через motion (та же библиотека, что в ToastContext).
 */
export default function UpdateToast() {
  const [state, setState] = useState<State>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    const off = onUpdateEvent((ev) => {
      // 'checking' и 'none' — silent. Если юзер уже закрыл крестиком тост
      // для конкретной версии, не показываем его снова до следующей.
      if (ev.kind === 'checking' || ev.kind === 'none') return;
      setState(ev);
    });
    return off;
  }, []);

  if (!isDesktop()) return null;
  if (!state) return null;

  const version =
    state.kind === 'available' || state.kind === 'downloaded'
      ? state.version
      : undefined;

  // Если эту версию уже закрыли — не показывать снова.
  if (version && dismissedVersion === version) return null;

  const dismiss = () => {
    setDismissedVersion(version || '__error__');
    setState(null);
  };

  return (
    <AnimatePresence>
      <motion.div
        key="update-toast"
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.96 }}
        transition={{ duration: 0.2 }}
        className="fixed bottom-4 right-4 z-[70] w-[min(92vw,360px)] rounded-xl border border-border bg-bg-2/95 backdrop-blur shadow-soft text-sm text-slate-100"
        role="status"
        aria-live="polite"
      >
        <div className="px-4 py-3 pr-9 relative">
          <button
            onClick={dismiss}
            className="absolute top-2 right-2 opacity-60 hover:opacity-100 transition-opacity rounded p-1 hover:bg-black/20"
            title="Скрыть"
            aria-label="Скрыть уведомление"
          >
            <X size={14} />
          </button>

          {state.kind === 'available' && (
            <AvailableBody version={state.version} />
          )}

          {state.kind === 'progress' && (
            <ProgressBody
              percent={state.percent}
              transferred={state.transferred}
              total={state.total}
              bytesPerSecond={state.bytesPerSecond}
            />
          )}

          {state.kind === 'downloaded' && (
            <DownloadedBody version={state.version} onInstall={() => installUpdate()} />
          )}

          {state.kind === 'error' && <ErrorBody message={state.message} />}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

// ---------------- Подпанели разных стейтов ----------------------------

function AvailableBody({ version }: { version?: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Download size={18} className="mt-0.5 text-accent flex-shrink-0" />
      <div className="min-w-0">
        <div className="font-medium leading-tight">
          {version ? `Доступно обновление ${version}` : 'Доступно обновление'}
        </div>
        <div className="text-xs text-slate-400 mt-0.5">Скачивается в фоне…</div>
      </div>
    </div>
  );
}

function ProgressBody({
  percent,
  transferred,
  total,
  bytesPerSecond,
}: {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Download size={18} className="text-accent flex-shrink-0 animate-pulse" />
        <div className="font-medium leading-tight">Скачивание обновления…</div>
      </div>

      <div className="h-1.5 rounded-full bg-bg-3 overflow-hidden">
        <div
          className="h-full bg-accent transition-all duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex justify-between text-[11px] text-slate-400 tabular-nums">
        <span>{pct}%</span>
        <span>
          {formatBytes(transferred)} / {formatBytes(total)} • {formatBytes(bytesPerSecond)}/с
        </span>
      </div>
    </div>
  );
}

function DownloadedBody({
  version,
  onInstall,
}: {
  version?: string;
  onInstall: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <CheckCircle2 size={18} className="mt-0.5 text-success flex-shrink-0" />
        <div className="min-w-0">
          <div className="font-medium leading-tight">
            {version ? `Обновление ${version} готово` : 'Обновление готово'}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            Перезапусти приложение, чтобы установить.
          </div>
        </div>
      </div>

      <button
        onClick={onInstall}
        className="self-end flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent hover:bg-accent-hover text-white text-xs font-medium transition-colors"
      >
        <RefreshCw size={13} />
        Перезапустить и обновить
      </button>
    </div>
  );
}

function ErrorBody({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <AlertCircle size={18} className="mt-0.5 text-danger flex-shrink-0" />
      <div className="min-w-0">
        <div className="font-medium leading-tight">Ошибка обновления</div>
        <div className="text-xs text-slate-400 mt-0.5 break-words">{message}</div>
      </div>
    </div>
  );
}

// ---------------- helpers --------------------------------------------

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
