import { useState } from 'react';
import { X, Monitor } from 'lucide-react';
import { SCREEN_PRESETS, SCREEN_PRESET_KEYS } from '../utils/media.js';

// Модалка выбора качества демонстрации экрана. Открывается по клику на
// кнопку «Демонстрация», после подтверждения вызывает onConfirm(presetKey)
// и сразу закрывается — потом уже срабатывает системный диалог браузера
// для выбора окна/экрана.
export default function ScreenQualityModal({
  open, defaultPreset = '720p', onConfirm, onClose,
}) {
  const [preset, setPreset] = useState(defaultPreset);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-bg-1 border border-border rounded-2xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Monitor size={18} className="text-accent" />
            <h2 className="text-base font-semibold">Качество демонстрации</h2>
          </div>
          <button
            onClick={onClose}
            className="btn-icon hover:bg-bg-2"
            title="Закрыть"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-2">
          <p className="text-sm text-text-2 mb-3">
            Выберите разрешение и битрейт. Чем выше — тем чётче картинка,
            но и нагрузка на канал больше.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {SCREEN_PRESET_KEYS.map((key) => {
              const p = SCREEN_PRESETS[key];
              const active = preset === key;
              return (
                <button
                  key={key}
                  onClick={() => setPreset(key)}
                  className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                    active
                      ? 'border-accent bg-accent/10'
                      : 'border-border bg-bg-2 hover:bg-bg-3'
                  }`}
                >
                  <div className="font-medium text-sm">{p.label}</div>
                  <div className="text-xs text-text-2 mt-0.5">
                    до {Math.round(p.maxBitrate / 1_000_000)} Мбит/с
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg hover:bg-bg-2 text-sm"
          >
            Отмена
          </button>
          <button
            onClick={() => { onConfirm(preset); }}
            className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium"
          >
            Продолжить
          </button>
        </div>
      </div>
    </div>
  );
}
