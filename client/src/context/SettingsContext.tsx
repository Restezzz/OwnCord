import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const SettingsContext = createContext(null);

const STORAGE_KEY = 'owncord.settings';

const DEFAULTS = {
  inputDeviceId: 'default',    // микрофон
  outputDeviceId: 'default',   // динамик (speaker)
  inputVolume: 1.0,            // 0..1.5 (gain)
  outputVolume: 1.0,           // 0..1
  soundsEnabled: true,         // мастер-выключатель UI-звуков
  // Гранулярные тумблеры — действуют только если soundsEnabled = true.
  soundMessage: true,          // звук нового сообщения
  soundIncoming: true,         // рингтон входящего звонка
  soundOutgoing: true,         // гудки исходящего вызова
  soundConnect: true,          // короткий "ап" при соединении
  soundDisconnect: true,       // короткий "даун" при завершении
  // Глобальная громкость UI-звуков (помимо outputVolume).
  uiVolume: 0.8,               // 0..1
  // Настройки шумодавки
  noiseSuppression: true,      // автоматическое подавление шума
  noiseThreshold: -50,         // порог чувствительности в дБ (-100..0)
  highPassFilter: true,        // высокочастотный фильтр для удаления низкочастотного шума
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => load());

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch { /* ignore */ }
  }, [settings]);

  const update = useCallback((patch) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);

  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
