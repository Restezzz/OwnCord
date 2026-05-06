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
  // Индивидуальные громкости сохраняются между звонками.
  // Ключ — userId, значение — проценты 0..100.
  userVolumes: {},
  streamVolumes: {},
  // Настройки исходящей аудио-цепочки (примерно как в OBS).
  // Цепочка: HighPass → Compressor → NoiseGate → MakeupGain. Применяется
  // как в звонке (useCall/useGroupCall), так и в тесте микрофона.
  noiseSuppression: true,      // включить шумовые ворота (gate)
  noiseThreshold: -55,         // порог ворот в дБ (-100..0)
  noiseGateHoldMs: 200,        // hangover после падения ниже порога, мс
  noiseGateAttackMs: 10,       // плавное открытие, мс (анти-щелчок)
  noiseGateReleaseMs: 80,      // плавное закрытие, мс
  highPassFilter: true,        // вырезать низкочастотный гул (вентилятор и т.п.)
  highPassFrequency: 100,      // частота среза HP, Гц (20..400)
  compressorEnabled: true,     // компрессор: выравнивает пики и тихие места
  compressorThreshold: -24,    // порог срабатывания, дБ (как в OBS)
  compressorRatio: 4,          // степень сжатия (1 — без эффекта)
  compressorAttack: 5,         // атака, мс
  compressorRelease: 50,       // спад, мс
  compressorKnee: 30,          // мягкий перегиб, дБ
  makeupGainDb: 0,             // добавочное усиление после компрессора, дБ
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
