// Аудио-цепочка для исходящего микрофона: HighPass → Compressor → NoiseGate → MakeupGain.
//
// Зачем: «сырое» аудио из getUserMedia передаёт всё, что слышит микрофон —
// гул вентилятора, удары по клавиатуре, эхо комнаты, неровные пики голоса.
// Web Audio API даёт нам набор узлов, которыми можно построить тот же
// сценарий, что в OBS: HP отрезает низкочастотный шум, компрессор
// выравнивает громкость, шумовые ворота гасят паузы, makeup-gain
// возвращает потерянный уровень.
//
// Важно: AudioContext должен быть в running-состоянии. Если его
// создавать после async-цепочки (accept→getUserMedia), он может прийти
// suspended, и MediaStreamDestination отдаёт «немой» трек — это и был
// баг прошлой версии (см. комментарий в media.ts). Поэтому createMicPipeline
// явно вызывает ctx.resume() и ждёт, пока контекст реально стартует.

export type AudioFilterSettings = {
  // Сейчас не используется (резерв) — общий выключатель цепочки.
  enabled?: boolean;

  // Громкость на входе (до фильтров) — это inputVolume из настроек.
  inputVolume?: number; // 0..2

  // High-pass: вырезает низкочастотный шум (гул, вентилятор, бубнение).
  // 80–120 Hz — типовые значения; ниже 80 идёт основа мужского голоса.
  highPassEnabled?: boolean;
  highPassFrequency?: number; // Hz, 20..400

  // DynamicsCompressor: выравнивает разницу между громкими/тихими местами.
  // Параметры повторяют OBS-овский Compressor.
  compressorEnabled?: boolean;
  compressorThreshold?: number;  // dB, -100..0
  compressorRatio?: number;      // 1..20
  compressorAttack?: number;     // ms, 0..1000
  compressorRelease?: number;    // ms, 0..1000
  compressorKnee?: number;       // dB, 0..40

  // Шумовые ворота: ниже порога звук режется в ноль. Сделаны на GainNode
  // с RMS-детектором, опрашиваемым в rAF — для голосового чата хватает.
  noiseGateEnabled?: boolean;
  noiseGateThreshold?: number;   // dB, -100..0
  // Hangover: сколько держать ворота открытыми после падения сигнала ниже
  // порога. Без этого ворота моргают на согласных и паузах между словами.
  noiseGateHoldMs?: number;
  // Время плавного открытия/закрытия — анти-кликовое сглаживание.
  noiseGateAttackMs?: number;
  noiseGateReleaseMs?: number;

  // Make-up gain после компрессора (компенсация просадки уровня).
  makeupGainDb?: number; // dB
};

export type MicPipeline = {
  // Трек для отправки в RTCPeerConnection.
  outputTrack: MediaStreamTrack;
  // Стрим, из которого можно взять outputTrack для localStream.
  outputStream: MediaStream;
  // Сырой стрим (закрепляем, чтобы getUserMedia-источник не GC-ился пока
  // pipeline жив). Останавливать НЕ надо — это сделает pipeline.destroy().
  rawStream: MediaStream;
  // AudioContext, созданный для пайплайна (используется ещё и для метра).
  context: AudioContext;
  // Анализатор после всей цепочки — для UI-метра уровня.
  analyser: AnalyserNode;
  // Полностью разобрать пайплайн (дисконнект узлов, остановка треков, close ctx).
  destroy: () => void;
  // Применить новые настройки к работающей цепочке без её пересборки.
  updateSettings: (next: AudioFilterSettings) => void;
};

// Дефолты на случай отсутствия настроек. Подобраны под обычный голосовой
// чат: умеренный HP, компрессор «как в OBS» (ratio 4, threshold -24),
// мягкие ворота на -55 dB (ниже комнатного фона, но выше тишины).
export const DEFAULT_AUDIO_FILTERS: Required<Omit<AudioFilterSettings, 'enabled' | 'inputVolume'>> & {
  enabled: boolean;
  inputVolume: number;
} = {
  enabled: true,
  inputVolume: 1.0,
  highPassEnabled: true,
  highPassFrequency: 100,
  compressorEnabled: true,
  compressorThreshold: -24,
  compressorRatio: 4,
  compressorAttack: 5,
  compressorRelease: 50,
  compressorKnee: 30,
  noiseGateEnabled: true,
  noiseGateThreshold: -55,
  noiseGateHoldMs: 200,
  noiseGateAttackMs: 10,
  noiseGateReleaseMs: 80,
  makeupGainDb: 0,
};

function clampNumber(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function mergeSettings(s: AudioFilterSettings | undefined): typeof DEFAULT_AUDIO_FILTERS {
  const d = DEFAULT_AUDIO_FILTERS;
  if (!s) return { ...d };
  return {
    enabled: s.enabled !== false,
    inputVolume: clampNumber(s.inputVolume, 0, 2, d.inputVolume),
    highPassEnabled: s.highPassEnabled !== false,
    highPassFrequency: clampNumber(s.highPassFrequency, 20, 400, d.highPassFrequency),
    compressorEnabled: s.compressorEnabled !== false,
    compressorThreshold: clampNumber(s.compressorThreshold, -100, 0, d.compressorThreshold),
    compressorRatio: clampNumber(s.compressorRatio, 1, 20, d.compressorRatio),
    compressorAttack: clampNumber(s.compressorAttack, 0, 1000, d.compressorAttack),
    compressorRelease: clampNumber(s.compressorRelease, 0, 1000, d.compressorRelease),
    compressorKnee: clampNumber(s.compressorKnee, 0, 40, d.compressorKnee),
    noiseGateEnabled: s.noiseGateEnabled !== false,
    noiseGateThreshold: clampNumber(s.noiseGateThreshold, -100, 0, d.noiseGateThreshold),
    noiseGateHoldMs: clampNumber(s.noiseGateHoldMs, 0, 2000, d.noiseGateHoldMs),
    noiseGateAttackMs: clampNumber(s.noiseGateAttackMs, 0, 500, d.noiseGateAttackMs),
    noiseGateReleaseMs: clampNumber(s.noiseGateReleaseMs, 0, 1000, d.noiseGateReleaseMs),
    makeupGainDb: clampNumber(s.makeupGainDb, -20, 20, d.makeupGainDb),
  };
}

/**
 * Построить pipeline обработки исходящего микрофона.
 *
 * Цепочка:
 *   sourceNode → inputGain → highPass → compressor → gateGain → makeupGain → analyser → destination
 *                                                       ▲
 *                                       gateAnalyser (siphon до gateGain'а)
 *                                       └── rAF-цикл считает RMS и
 *                                           двигает gateGain.gain (0/1
 *                                           с плавными переходами).
 *
 * @param rawStream  результат getUserMedia (содержит хотя бы 1 audio-track).
 * @param settings   текущие настройки фильтров (берутся из контекста настроек).
 *
 * Возвращает MicPipeline. Если в браузере нет AudioContext или нет
 * аудио-трека — кидает Error: вызывающий код должен fallback'нуться на
 * сырой track (см. captureLocalMedia).
 */
export async function createMicPipeline(
  rawStream: MediaStream,
  settings?: AudioFilterSettings,
): Promise<MicPipeline> {
  const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) throw new Error('AudioContext not supported');

  const audioTracks = rawStream.getAudioTracks();
  if (!audioTracks.length) throw new Error('No audio tracks in source stream');

  // Создаём контекст и СРАЗУ резюмируем — иначе MediaStreamDestination
  // может отдать «немой» track. resume() в click-цепочке (start/accept/join)
  // подхватывает sticky activation страницы и завершается успешно.
  const ctx: AudioContext = new Ctx({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // Не критично: продолжим, но возможно с задержкой старта семплов.
    }
  }

  let s = mergeSettings(settings);

  // Узлы цепочки -------------------------------------------------------
  const source = ctx.createMediaStreamSource(rawStream);

  const inputGain = ctx.createGain();
  inputGain.gain.value = s.inputVolume;

  const highPass = ctx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.Q.value = 0.7; // Butterworth-подобная характеристика, без всплеска
  highPass.frequency.value = s.highPassEnabled ? s.highPassFrequency : 20;

  const compressor = ctx.createDynamicsCompressor();
  if (s.compressorEnabled) {
    compressor.threshold.value = s.compressorThreshold;
    compressor.ratio.value = s.compressorRatio;
    compressor.attack.value = s.compressorAttack / 1000;
    compressor.release.value = s.compressorRelease / 1000;
    compressor.knee.value = s.compressorKnee;
  } else {
    // Прозрачный compressor: высокий threshold + ratio=1 = нет эффекта.
    compressor.threshold.value = 0;
    compressor.ratio.value = 1;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.05;
    compressor.knee.value = 0;
  }

  // Шумовые ворота: GainNode, целевое значение которого выставляется
  // RMS-детектором (gateAnalyser). Плавные переходы через linearRamp,
  // чтобы не было щелчков на открытии/закрытии.
  const gateGain = ctx.createGain();
  gateGain.gain.value = 1;

  // Отдельный analyser ДО gateGain — измеряем уровень после компрессора,
  // чтобы порог ворот соответствовал уровню, который услышит собеседник.
  const gateAnalyser = ctx.createAnalyser();
  gateAnalyser.fftSize = 1024;
  gateAnalyser.smoothingTimeConstant = 0.6;

  const makeupGain = ctx.createGain();
  makeupGain.gain.value = dbToLinear(s.makeupGainDb);

  // Финальный analyser после всей цепочки — для UI-метра.
  const finalAnalyser = ctx.createAnalyser();
  finalAnalyser.fftSize = 1024;
  finalAnalyser.smoothingTimeConstant = 0.4;

  const destination = ctx.createMediaStreamDestination();

  // Соединяем -------------------------------------------------------
  source.connect(inputGain);
  inputGain.connect(highPass);
  highPass.connect(compressor);
  compressor.connect(gateGain);
  compressor.connect(gateAnalyser); // siphon для детектора уровня
  gateGain.connect(makeupGain);
  makeupGain.connect(finalAnalyser);
  finalAnalyser.connect(destination);

  // Носитель «текущих» настроек, мутируется через updateSettings; rAF-цикл
  // читает оттуда без замыкания на старые значения.
  const live = { s };

  // RMS-детектор для ворот (rAF). Если ворота выключены — gainTarget=1 всегда.
  const buf = new Float32Array(gateAnalyser.fftSize);
  let lastAboveTs = 0;
  let rafId = 0;
  let cancelled = false;

  const tick = () => {
    if (cancelled) return;
    const cs = live.s;
    if (cs.noiseGateEnabled) {
      gateAnalyser.getFloatTimeDomainData(buf as any);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      const now = performance.now();
      if (db >= cs.noiseGateThreshold) {
        lastAboveTs = now;
      }
      const open = (now - lastAboveTs) <= cs.noiseGateHoldMs;
      const targetGain = open ? 1 : 0;
      const currentGain = gateGain.gain.value;
      // Плавный переход — без него на открытии/закрытии слышен щелчок.
      if (currentGain !== targetGain) {
        const rampMs = open ? cs.noiseGateAttackMs : cs.noiseGateReleaseMs;
        const t = ctx.currentTime + Math.max(0.001, rampMs / 1000);
        try {
          gateGain.gain.cancelScheduledValues(ctx.currentTime);
          gateGain.gain.setValueAtTime(currentGain, ctx.currentTime);
          gateGain.gain.linearRampToValueAtTime(targetGain, t);
        } catch { /* */ }
      }
    } else {
      // Ворота выключены — держим gain=1 без ramp'ов.
      const v = gateGain.gain.value;
      if (v !== 1) {
        try {
          gateGain.gain.cancelScheduledValues(ctx.currentTime);
          gateGain.gain.setValueAtTime(1, ctx.currentTime);
        } catch { /* */ }
      }
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  const outputStream = destination.stream;
  // Берём ссылку на трек один раз — она стабильна.
  const outputTrack = outputStream.getAudioTracks()[0];
  if (!outputTrack) {
    // Ультра-редкий случай (сразу остановили браузер?) — fallback.
    cancelled = true;
    cancelAnimationFrame(rafId);
    try { ctx.close(); } catch { /* */ }
    throw new Error('Failed to create processed audio track');
  }

  // Если raw mic-трек закончится (юзер выдернул USB-микрофон, sleep'нулась
  // вкладка), нам надо аккуратно «погасить» processed-трек, иначе пир будет
  // получать тишину «навсегда». Для звонка это всё равно конец — оставим
  // решение вызывающему коду (он услышит ended на raw track).
  // Здесь только страхуемся, чтобы pipeline не упал.

  const updateSettings: MicPipeline['updateSettings'] = (next) => {
    const merged = mergeSettings({ ...live.s, ...next });
    live.s = merged;
    // Аккуратно применяем — некоторые AudioParam требуют setValueAtTime.
    try {
      const now = ctx.currentTime;
      inputGain.gain.setValueAtTime(merged.inputVolume, now);
      highPass.frequency.setValueAtTime(
        merged.highPassEnabled ? merged.highPassFrequency : 20,
        now,
      );
      if (merged.compressorEnabled) {
        compressor.threshold.setValueAtTime(merged.compressorThreshold, now);
        compressor.ratio.setValueAtTime(merged.compressorRatio, now);
        compressor.attack.setValueAtTime(merged.compressorAttack / 1000, now);
        compressor.release.setValueAtTime(merged.compressorRelease / 1000, now);
        compressor.knee.setValueAtTime(merged.compressorKnee, now);
      } else {
        compressor.threshold.setValueAtTime(0, now);
        compressor.ratio.setValueAtTime(1, now);
      }
      makeupGain.gain.setValueAtTime(dbToLinear(merged.makeupGainDb), now);
    } catch { /* AudioParam validation — игнор, попробуем на след. тике */ }
  };

  const destroy: MicPipeline['destroy'] = () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
    try { source.disconnect(); } catch { /* */ }
    try { inputGain.disconnect(); } catch { /* */ }
    try { highPass.disconnect(); } catch { /* */ }
    try { compressor.disconnect(); } catch { /* */ }
    try { gateAnalyser.disconnect(); } catch { /* */ }
    try { gateGain.disconnect(); } catch { /* */ }
    try { makeupGain.disconnect(); } catch { /* */ }
    try { finalAnalyser.disconnect(); } catch { /* */ }
    try { destination.disconnect(); } catch { /* */ }
    // Сам outputTrack останавливать не нужно — он закончится при close().
    try { outputTrack.stop(); } catch { /* */ }
    // Останавливаем raw-треки, чтобы освободить микрофон.
    for (const t of rawStream.getTracks()) {
      try { t.stop(); } catch { /* */ }
    }
    try { ctx.close(); } catch { /* */ }
  };

  return {
    outputTrack,
    outputStream,
    rawStream,
    context: ctx,
    analyser: finalAnalyser,
    destroy,
    updateSettings,
  };
}

/**
 * Извлечь срез настроек фильтров из общего объекта settings. Полезно,
 * чтобы в одном месте знать «какие ключи относятся к аудио-цепочке».
 */
export function pickAudioFilterSettings(settings: any): AudioFilterSettings {
  if (!settings || typeof settings !== 'object') return {};
  return {
    enabled: settings.audioFiltersEnabled,
    inputVolume: settings.inputVolume,
    highPassEnabled: settings.highPassFilter,
    highPassFrequency: settings.highPassFrequency,
    compressorEnabled: settings.compressorEnabled,
    compressorThreshold: settings.compressorThreshold,
    compressorRatio: settings.compressorRatio,
    compressorAttack: settings.compressorAttack,
    compressorRelease: settings.compressorRelease,
    compressorKnee: settings.compressorKnee,
    noiseGateEnabled: settings.noiseSuppression,
    noiseGateThreshold: settings.noiseThreshold,
    noiseGateHoldMs: settings.noiseGateHoldMs,
    noiseGateAttackMs: settings.noiseGateAttackMs,
    noiseGateReleaseMs: settings.noiseGateReleaseMs,
    makeupGainDb: settings.makeupGainDb,
  };
}
