// Утилиты для WebRTC-медиа: placeholder-треки и обёртка getUserMedia.
//
// Главная цель — гарантировать, что у каждого RTCPeerConnection
// при создании ВСЕГДА есть реальный audio и video MediaStreamTrack,
// даже если пользователь не включил камеру. Это даёт SDP с msid+ssrc
// с первого offer/answer, а значит:
//   • track сразу появляется на стороне пира через ontrack;
//   • `replaceTrack` потом просто заменяет содержимое sender'а
//     (включение камеры / демонстрации экрана) без renegotiation
//     и без танцев с пере-fire'ингом ontrack.
//
// Без placeholder-ов пустой transceiver(`addTransceiver('video', sendrecv)`)
// в Chrome не даёт ontrack у пира при последующем replaceTrack — это и
// был корень бага «caller не видит экран callee».

let blackCanvasStreamCache = null;

function getBlackCanvasStream() {
  if (blackCanvasStreamCache) return blackCanvasStreamCache;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 320, 180);
  // Ключ: канва регулярно «перерисовывается» (хотя и тем же
  // чёрным цветом). Это держит captureStream-track в active state
  // и заставляет кодер регулярно генерировать keyframe-ы. Без
  // этого после replaceTrack(real) пир не получает кадры до
  // очередного PLI/keyframe — зритель видит чёрный экран.
  blackCanvasStreamCache = canvas.captureStream(15);
  setInterval(() => {
    ctx.fillRect(0, 0, 320, 180);
  }, 200);
  return blackCanvasStreamCache;
}

// Видео-плейсхолдер: чёрный кадр 320×180 @15fps. enabled=true,
// чтобы encoder pipeline был прогрет (для пира это «alive»-трек с
// keyframe-ами), и после replaceTrack на real screen/camera кадры
// начинают доходить до пира сразу, без ожидания keyframe.
export function createPlaceholderVideoTrack() {
  const stream = getBlackCanvasStream();
  // Клонируем, чтобы stop() на одном PC не убил track для других.
  const track = stream.getVideoTracks()[0].clone();
  return track;
}

// Аудио-плейсхолдер: тихий oscillator c gain=0. Track всегда disabled.
// AudioContext создаётся ленив только когда нужен, и обязательно после
// user gesture (мы вызываем эту функцию из обработчиков клика).
let placeholderAudioCtxCache = null;

function getPlaceholderAudioContext() {
  if (placeholderAudioCtxCache) return placeholderAudioCtxCache;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  placeholderAudioCtxCache = new Ctx();
  // Если контекст suspended — попытаемся возобновить, но молча.
  if (placeholderAudioCtxCache.state === 'suspended') {
    placeholderAudioCtxCache.resume().catch(() => {
      /* */
    });
  }
  return placeholderAudioCtxCache;
}

export function createPlaceholderAudioTrack() {
  const ctx = getPlaceholderAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const dst = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dst);
  try {
    osc.start();
  } catch {
    /* */
  }
  const t = dst.stream.getAudioTracks()[0];
  // enabled=true и gain=0: encoder отправляет тихие фреймы, RTP-пайплайн
  // жив, sender SSRC активен. После replaceTrack(real mic) пир сразу
  // начинает слышать, без паузы на переинициализацию.
  return t;
}

// Простой захват микрофона/камеры. Возвращает MediaStream без какой-либо
// дополнительной обработки. Раньше мы прогоняли аудио через AudioContext
// (gain), но это вызывало одностороннюю связь, когда контекст начинал
// жизнь в suspended-состоянии после async-цепочки accept(): пир получал
// трек, но без сэмплов. Теперь трек идёт сырым из getUserMedia.
//
// Если сохранённый deviceId больше не существует (другая машина,
// другой профиль браузера), Chrome бросает OverconstrainedError —
// отлавливаем и fallback'имся на «default»-источник, иначе юзер будет
// «немым» без видимых причин.
export async function captureLocalMedia({ wantVideo = false, audioDeviceId = null } = {}) {
  const baseAudio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  const video = wantVideo
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
    : false;

  const tryGet = (audio) => navigator.mediaDevices.getUserMedia({ audio, video });

  if (audioDeviceId && audioDeviceId !== 'default') {
    try {
      return await tryGet({ ...baseAudio, deviceId: { exact: audioDeviceId } });
    } catch (e) {
      // Устройство пропало — пробуем без deviceId.
      if (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError') {
        return tryGet(baseAudio);
      }
      throw e;
    }
  }
  return tryGet(baseAudio);
}

// Пресеты для getDisplayMedia + setParameters на video sender'е.
// max-bitrate подобран так, чтобы картинка оставалась читабельной
// (текст не «разъезжался» при движении), но не забивал канал.
export const SCREEN_PRESETS = {
  '480p': { width: 854, height: 480, frameRate: 30, maxBitrate: 1_500_000, label: '480p · 30fps' },
  '720p': { width: 1280, height: 720, frameRate: 30, maxBitrate: 3_000_000, label: '720p · 30fps' },
  '1080p': {
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 6_000_000,
    label: '1080p · 30fps',
  },
  '1440p': {
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 12_000_000,
    label: '1440p · 30fps (2K)',
  },
};

export const SCREEN_PRESET_KEYS = ['480p', '720p', '1080p', '1440p'];

export function getScreenPreset(key) {
  return SCREEN_PRESETS[key] || SCREEN_PRESETS['720p'];
}

// Захватить экран с выбранным пресетом. Chrome обычно отдаёт
// разрешение источника «как есть», но ideal-поля подсказывают браузеру
// верхнюю планку (иначе браузер может скипалировать вниз).
//
// Про звук — важная деталь, из-за которой пользователи спрашивают
// «почему стрим из браузера передаёт звук другого браузера на одном ПК»:
//
//   • При выборе «Окно» (Window) или «Весь экран» (Screen) Chromium на
//     Windows захватывает системный аудио-микшер. Изолировать звук
//     одного приложения от другого через getDisplayMedia невозможно —
//     это ограничение ОС/браузера, не наше.
//   • Чтобы захватить звук ТОЛЬКО одной вкладки/приложения, юзер должен
//     в системном диалоге выбрать «Вкладка» (Tab) и поставить галочку
//     «Поделиться звуком вкладки». Тогда система отдаёт только её аудио.
//
// Мы выставляем максимально качественные ограничения (48k stereo, без AEC),
// чтобы музыка/игры передавались без артефактов, и подсказку
// `systemAudio: 'include'` для Chromium.
export async function captureDisplay(presetKey, includeAudio = false) {
  const preset = getScreenPreset(presetKey);
  // Если просим аудио — задаём «studio»-настройки. Применять
  // echoCancellation/noiseSuppression к системному звуку нельзя, иначе
  // музыка и эффекты будут «жёванные».
  const audio = includeAudio
    ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
      }
    : false;

  /** @type {any} */
  const constraints = {
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
    },
    audio,
    // Подсказки Chromium 107+: разрешаем юзеру выбрать любую поверхность
    // (вкладку/окно/экран) и переключаться между вкладками во время стрима.
    selfBrowserSurface: 'include',
    surfaceSwitching: 'include',
    // 'include' — намекаем, что хотим системный звук (если пользователь
    // выбирает Tab — это её звук, если Screen — весь системный микшер).
    // Без этого Chromium <115 в части сборок выключает аудио-чекбокс.
    systemAudio: includeAudio ? 'include' : 'exclude',
    // Опциональный флаг (Chrome 109+): не глушит звук в локальных колонках,
    // когда стримим вкладку. Поведение по умолчанию `true` — звук падает
    // только в стрим, и юзер сам себя не слышит. Оставляем дефолт.
  };
  return navigator.mediaDevices.getDisplayMedia(constraints);
}

// Применить maxBitrate к video sender'у. Без этого WebRTC берёт
// дефолтные ~2–4 Mbps — для 1080p и 1440p это мыло.
export async function applyVideoSenderQuality(sender, presetKey) {
  if (!sender) return;
  const preset = getScreenPreset(presetKey);
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) {
      params.encodings = [{}];
    }
    for (const enc of params.encodings) {
      enc.maxBitrate = preset.maxBitrate;
      enc.maxFramerate = preset.frameRate;
    }
    if ('degradationPreference' in params) {
      params.degradationPreference = 'maintain-resolution';
    }
    await sender.setParameters(params);
  } catch {
    /* не критично */
  }
}
