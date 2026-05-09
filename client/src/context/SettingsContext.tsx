import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const SettingsContext = createContext(null);

const STORAGE_KEY = 'owncord.settings';

const DEFAULTS = {
  inputDeviceId: 'default', // микрофон
  outputDeviceId: 'default', // динамик (speaker)
  inputVolume: 1.0, // 0..1.5 (gain)
  outputVolume: 1.0, // 0..1
  soundsEnabled: true, // мастер-выключатель UI-звуков
  // Гранулярные тумблеры — действуют только если soundsEnabled = true.
  soundMessage: true, // звук нового сообщения
  soundIncoming: true, // рингтон входящего звонка
  soundOutgoing: true, // гудки исходящего вызова
  soundConnect: true, // короткий "ап" при соединении
  soundDisconnect: true, // короткий "даун" при завершении
  soundMicMute: true, // пип при мьюте/размьюте микрофона
  soundDeafen: true, // пип при выкл/вкл звука собеседников
  // Глобальная громкость UI-звуков (помимо outputVolume).
  uiVolume: 0.8, // 0..1
  // Индивидуальные громкости сохраняются между звонками.
  // Ключ — userId, значение — проценты 0..100.
  userVolumes: {},
  streamVolumes: {},
  // Настройки исходящей аудио-цепочки (примерно как в OBS).
  // Цепочка: HighPass → Compressor → NoiseGate → MakeupGain. Применяется
  // как в звонке (useCall/useGroupCall), так и в тесте микрофона.
  //
  // Пресет выбирает набор значений ниже одним кликом — «Выкл» / «Стандарт» /
  // «Агрессивный». 'custom' = юзер полез в экспертные настройки и покрутил
  // отдельные ползунки; дропдаун показывает «(Пользовательский)», и при
  // следующем выборе пресета все значения перезапишутся.
  micFilterPreset: 'standard', // 'off' | 'standard' | 'aggressive' | 'custom'
  noiseSuppression: true, // включить шумовые ворота (gate)
  noiseThreshold: -55, // порог ворот в дБ (-100..0)
  noiseGateHoldMs: 200, // hangover после падения ниже порога, мс
  noiseGateAttackMs: 10, // плавное открытие, мс (анти-щелчок)
  noiseGateReleaseMs: 80, // плавное закрытие, мс
  highPassFilter: true, // вырезать низкочастотный гул (вентилятор и т.п.)
  highPassFrequency: 100, // частота среза HP, Гц (20..400)
  compressorEnabled: true, // компрессор: выравнивает пики и тихие места
  compressorThreshold: -24, // порог срабатывания, дБ (как в OBS)
  compressorRatio: 4, // степень сжатия (1 — без эффекта)
  compressorAttack: 5, // атака, мс
  compressorRelease: 50, // спад, мс
  compressorKnee: 30, // мягкий перегиб, дБ
  makeupGainDb: 0, // добавочное усиление после компрессора, дБ
  // RNNoise-шумодав. Включается только в пресете «Агрессивный»; тащит
  // ~150 КБ WASM (lazy-load при первом запуске пайплайна) и узел
  // AudioWorklet. Если что-то пойдёт не так с загрузкой — пайплайн
  // автоматически fallback'нется на классическую цепочку без AI.
  aiNoiseSuppression: false,
  // Клавиатурные биндинги. Применяются ТОЛЬКО в десктоп-версии
  // (Electron'овский globalShortcut). На вебе значения сохраняются
  // в localStorage, но никем не считываются — UI вкладки «Биндинги»
  // тоже спрятан (см. utils/desktop.ts). Формат значений — accelerator-
  // строка Electron'а (https://electronjs.org/docs/latest/api/accelerator)
  // или null, если хоткей не назначен.
  keybinds: {
    toggleMute: null, // мьют микрофона / размьют
    toggleDeafen: null, // выкл / вкл звука собеседников
  },
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...parsed };
    // Миграция: у существующих юзеров может быть сохранён micFilterPreset,
    // но не быть aiNoiseSuppression (поле добавили позже). Авто-заполняем
    // флаг по имени пресета — иначе UI покажет «Пользовательский» сразу
    // после апгрейда, хотя по факту юзер на «Агрессивном».
    if (parsed && parsed.aiNoiseSuppression === undefined) {
      if (parsed.micFilterPreset === 'aggressive') merged.aiNoiseSuppression = true;
      else merged.aiNoiseSuppression = false;
    }
    // Дополняем поле keybinds недостающими ключами — иначе будущие
    // действия (PTT, фокус-окно, ...) не появятся у юзеров со старыми
    // сохранёнными настройками. ...DEFAULTS не делает deep-merge для
    // вложенных объектов — приходится руками.
    merged.keybinds = { ...DEFAULTS.keybinds, ...(parsed?.keybinds || {}) };
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
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
