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
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 2, 2);
  // 1 fps достаточно: трек жив, но почти не нагружает CPU/сеть.
  // Когда мы захотим реально отправлять видео, мы заменим
  // содержимое sender'а через replaceTrack(realTrack), и эта канва
  // больше никогда не будет использоваться.
  blackCanvasStreamCache = canvas.captureStream(1);
  return blackCanvasStreamCache;
}

// Видео-плейсхолдер: чёрный кадр 2×2, ставится disabled — пакетов в сеть
// почти нет, но sender имеет валидный track с msid/ssrc.
export function createPlaceholderVideoTrack() {
  const stream = getBlackCanvasStream();
  // Клонируем, чтобы остановка трека не убивала источник для других PC.
  const track = stream.getVideoTracks()[0].clone();
  track.enabled = false;
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
    placeholderAudioCtxCache.resume().catch(() => { /* */ });
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
  try { osc.start(); } catch { /* */ }
  const t = dst.stream.getAudioTracks()[0];
  t.enabled = false;
  return t;
}

// Простой захват микрофона/камеры. Возвращает MediaStream без какой-либо
// дополнительной обработки. Раньше мы прогоняли аудио через AudioContext
// (gain), но это вызывало одностороннюю связь, когда контекст начинал
// жизнь в suspended-состоянии после async-цепочки accept(): пир получал
// трек, но без сэмплов. Теперь трек идёт сырым из getUserMedia.
export async function captureLocalMedia({ wantVideo = false, audioDeviceId = null } = {}) {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (audioDeviceId && audioDeviceId !== 'default') {
    audio.deviceId = { exact: audioDeviceId };
  }
  const video = wantVideo
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
    : false;

  return navigator.mediaDevices.getUserMedia({ audio, video });
}
