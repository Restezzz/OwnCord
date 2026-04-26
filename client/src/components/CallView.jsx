import { useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff, Monitor, MonitorOff, PhoneOff, Settings, Loader2,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import SettingsPanel from './SettingsPanel.jsx';
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
function RemoteAudio({ stream, sinkId, volume }) {
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
  const [, tick] = useState(0);

  const {
    state, peer, localStream, remoteStream,
    muted, cameraOn, sharingScreen, peerMedia,
    waitingUntil,
    toggleMute, toggleCamera, toggleScreenShare, hangup,
  } = call;

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
          <StreamVideo
            key={`${peerMedia?.camera ? 'c' : ''}${peerMedia?.screen ? 's' : ''}`}
            stream={remoteStream}
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className={waiting ? 'opacity-60' : ''}>
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
        />

        {/* Локальное превью */}
        {hasLocalVideo && (
          <div className="absolute bottom-4 right-4 w-40 sm:w-56 aspect-video rounded-xl overflow-hidden border border-border bg-bg-2 shadow-soft">
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
          onClick={toggleCamera}
          active={cameraOn}
          title={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
        >
          {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
        </ToolButton>
        <ToolButton
          onClick={toggleScreenShare}
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
