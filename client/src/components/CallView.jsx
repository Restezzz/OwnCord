import { useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff, Monitor, MonitorOff, PhoneOff, Settings, Loader2,
  Volume2, VolumeX,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import ScreenQualityModal from './ScreenQualityModal.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { formatDuration, getAvatarUrl, getDisplayName } from '../utils/user.js';

function StreamVideo({ stream, muted = false, className = '', mirror = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream || null;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={className}
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
}

/**
 * Отдельный невидимый audio-элемент для удалённого звука.
 * Нужен, т.к. без видео звука у `<video>` может не быть, а также
 * чтобы применять outputDeviceId через setSinkId и управлять громкостью.
 */
function RemoteAudio({ stream, sinkId, volume, muted = false }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream || null;
    if (stream) {
      el.play?.().catch(() => { /* autoplay policy — пользователь ещё кликнет */ });
    }
  }, [stream]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, volume ?? 1));
  }, [volume]);

  // Локальный deafen: глушим <audio> на нашей стороне, не трогая сам
  // WebRTC-трек — микрофон продолжает идти собеседнику.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = !!muted;
  }, [muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !sinkId || typeof el.setSinkId !== 'function') return;
    el.setSinkId(sinkId === 'default' ? '' : sinkId).catch(() => { /* not supported */ });
  }, [sinkId]);

  return <audio ref={ref} autoPlay />;
}

export default function CallView({ call }) {
  const { settings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [, tick] = useState(0);

  const {
    state, peer, localStream, remoteStream,
    muted, deafened, cameraOn, sharingScreen, peerMedia,
    waitingUntil,
    speakingUserIds, selfId,
    toggleMute, toggleDeafen, toggleCamera, toggleScreenShare, hangup,
  } = call;

  // Зелёная подсветка вокруг плитки/превью, когда участник реально говорит.
  // Self подсвечиваем только если микрофон включён — иначе сбивает с толку
  // (трек выключен, но AnalyserNode иногда ловит остаточный шум).
  const peerSpeaking = speakingUserIds?.has?.(peer?.id) === true;
  const selfSpeaking = !muted && speakingUserIds?.has?.(selfId) === true;

  // Тикалка для обновления countdown в waiting.
  useEffect(() => {
    if (state !== 'waiting') return undefined;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [state]);

  if (state === 'idle' || state === 'incoming') return null;

  const waiting = state === 'waiting';
  // Показываем удалённое видео ТОЛЬКО если пир явно включил камеру/экран.
  // Без этого `<video>` будет чёрным квадратом, т.к. receiver-трек всегда есть.
  const showRemoteVideo = !waiting && !!(peerMedia?.camera || peerMedia?.screen);
  const hasLocalVideo = cameraOn || sharingScreen;

  const waitLeft = waiting && waitingUntil
    ? Math.max(0, waitingUntil - Date.now())
    : 0;

  const label =
    state === 'calling' ? 'Исходящий вызов…'
    : state === 'connecting' ? 'Соединение…'
    : state === 'waiting' ? `Ждём собеседника · ${formatDuration(waitLeft)}`
    : 'В разговоре';

  return (
    <div className="fixed inset-0 z-40 bg-bg-0 flex flex-col">
      {/* Поток */}
      <div className="flex-1 relative overflow-hidden">
        {showRemoteVideo ? (
          <div className="absolute inset-0">
            <StreamVideo
              key={`${peerMedia?.camera ? 'c' : ''}${peerMedia?.screen ? 's' : ''}`}
              stream={remoteStream}
              className="absolute inset-0 w-full h-full object-contain bg-black"
            />
            {/* Внутренняя рамка-overlay поверх видео — рисуем через ring
                на абсолютном слое, чтобы не сдвигать саму картинку. */}
            <div
              aria-hidden
              className={`absolute inset-0 pointer-events-none transition-shadow duration-150 ${
                peerSpeaking
                  ? 'shadow-[inset_0_0_0_3px_rgba(16,185,129,0.85),inset_0_0_22px_2px_rgba(16,185,129,0.45)]'
                  : 'shadow-none'
              }`}
            />
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-4 text-center">
              <div
                className={`rounded-full p-1 transition-shadow duration-150 ${
                  waiting ? 'opacity-60' : ''
                } ${
                  peerSpeaking
                    ? 'shadow-[0_0_0_3px_rgba(16,185,129,0.9),0_0_22px_4px_rgba(16,185,129,0.45)]'
                    : ''
                }`}
              >
                <Avatar name={getDisplayName(peer) || '?'} src={getAvatarUrl(peer)} size={128} />
              </div>
              <div>
                <div className="text-xl font-semibold">{getDisplayName(peer)}</div>
                <div className={`text-sm mt-1 flex items-center justify-center gap-1.5 ${
                  waiting ? 'text-amber-300' : 'text-slate-400'
                }`}
                >
                  {waiting && <Loader2 size={14} className="animate-spin" />}
                  <span>{label}</span>
                </div>
                {state === 'in-call' && peerMedia && !peerMedia.mic && (
                  <div className="mt-3 text-xs text-amber-400 flex items-center justify-center gap-1">
                    <MicOff size={12} /> у собеседника выключен микрофон
                  </div>
                )}
                {waiting && (
                  <div className="mt-3 text-xs text-slate-500 max-w-xs">
                    Если собеседник вернётся в течение этого времени — соединение восстановится автоматически.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Remote audio (воспроизводится всегда, когда есть stream) */}
        <RemoteAudio
          stream={remoteStream}
          sinkId={settings.outputDeviceId}
          volume={settings.outputVolume}
          muted={deafened}
        />

        {/* Локальное превью */}
        {hasLocalVideo && (
          <div
            className={`absolute bottom-4 right-4 w-40 sm:w-56 aspect-video rounded-xl overflow-hidden border-2 bg-bg-2 shadow-soft transition-colors duration-100 ${
              selfSpeaking
                ? 'border-emerald-400 shadow-[0_0_0_2px_rgba(16,185,129,0.45),0_0_18px_2px_rgba(16,185,129,0.35)]'
                : 'border-border'
            }`}
          >
            <StreamVideo
              stream={localStream}
              muted
              mirror={cameraOn && !sharingScreen}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        {/* Плашка-статус */}
        <div className="absolute top-4 left-4 flex items-center gap-2">
          <div className="px-3 py-1.5 text-xs rounded-full bg-black/60 backdrop-blur border border-white/10">
            {label}
          </div>
          {showRemoteVideo && (
            <div className="px-3 py-1.5 text-xs rounded-full bg-black/60 backdrop-blur border border-white/10 flex items-center gap-2">
              <Avatar name={getDisplayName(peer) || '?'} src={getAvatarUrl(peer)} size={20} />
              <span>{getDisplayName(peer)}</span>
              {!peerMedia?.mic && <MicOff size={12} className="text-amber-400" />}
            </div>
          )}
        </div>
      </div>

      {/* Контролы */}
      <div className="p-4 flex items-center justify-center gap-3 bg-bg-1 border-t border-border">
        <ToolButton
          onClick={toggleMute}
          active={muted}
          activeDanger
          title={muted ? 'Включить микрофон' : 'Выключить микрофон'}
        >
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
        </ToolButton>
        <ToolButton
          onClick={toggleDeafen}
          active={deafened}
          activeDanger
          title={deafened ? 'Включить звук собеседника' : 'Заглушить собеседника (только у вас)'}
        >
          {deafened ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </ToolButton>
        <ToolButton
          onClick={toggleCamera}
          active={cameraOn}
          title={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
        >
          {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
        </ToolButton>
        <ToolButton
          onClick={() => {
            if (sharingScreen) toggleScreenShare();
            else setQualityOpen(true);
          }}
          active={sharingScreen}
          title={sharingScreen ? 'Остановить демонстрацию' : 'Показать экран / окно'}
        >
          {sharingScreen ? <MonitorOff size={20} /> : <Monitor size={20} />}
        </ToolButton>
        <ToolButton
          onClick={() => setSettingsOpen(true)}
          title="Настройки звука"
        >
          <Settings size={20} />
        </ToolButton>
        <button
          onClick={() => hangup()}
          className="btn-icon bg-danger hover:bg-danger-hover text-white ml-2"
          style={{ width: 52, height: 52 }}
          title="Завершить"
        >
          <PhoneOff size={22} />
        </button>
      </div>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ScreenQualityModal
        open={qualityOpen}
        defaultPreset={settings.screenQuality || '720p'}
        onClose={() => setQualityOpen(false)}
        onConfirm={(preset) => {
          setQualityOpen(false);
          toggleScreenShare(preset);
        }}
      />
    </div>
  );
}

function ToolButton({ onClick, active, activeDanger, title, children }) {
  const base = 'btn-icon transition-colors';
  const style = active
    ? activeDanger
      ? 'bg-danger hover:bg-danger-hover text-white'
      : 'bg-accent hover:bg-accent-hover text-white'
    : 'bg-bg-3 hover:bg-bg-2 text-slate-100';
  return (
    <button
      onClick={onClick}
      title={title}
      className={`${base} ${style}`}
      style={{ width: 48, height: 48 }}
    >
      {children}
    </button>
  );
}
