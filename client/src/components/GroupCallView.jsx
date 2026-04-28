import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff, PhoneOff, Users as UsersIcon,
  ScreenShare, ScreenShareOff, Volume2, VolumeX,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { getAvatarUrl, getDisplayName } from '../utils/user.js';

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

function RemoteAudio({ stream, sinkId, volume, muted = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream || null;
    if (stream) el.play?.().catch(() => { /* autoplay policy */ });
  }, [stream]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, volume ?? 1));
  }, [volume]);
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

/**
 * Плитка одного участника. Показывает видео если есть активный video-трек,
 * иначе аватар + имя. В правом нижнем углу — индикатор микрофона.
 */
function Tile({ stream, user, self, muted, mirror, className = '' }) {
  const hasVideo = !!(stream && stream.getVideoTracks().some((t) => t.enabled && !t.muted && t.readyState === 'live'));
  const name = getDisplayName(user) || '?';
  return (
    <div className={`relative bg-bg-2 rounded-xl overflow-hidden border border-border ${className}`}>
      {hasVideo ? (
        <StreamVideo
          stream={stream}
          muted
          mirror={mirror}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <Avatar name={name} src={getAvatarUrl(user)} size={72} />
        </div>
      )}
      <div className="absolute bottom-2 left-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 backdrop-blur text-xs">
        <span className="truncate flex-1">
          {name}{self && <span className="text-slate-400"> (вы)</span>}
        </span>
        {muted && <MicOff size={12} className="text-amber-400 shrink-0" />}
      </div>
    </div>
  );
}

export default function GroupCallView({ call, usersById, selfId }) {
  const { settings } = useSettings();
  const {
    state, group, localStream, remotes, participants,
    muted, deafened, cameraOn, sharingScreen, withVideo,
    toggleMute, toggleDeafen, toggleCamera, toggleScreenShare, leave,
  } = call;

  if (state === 'idle') return null;

  const selfUser = usersById?.[selfId] || null;

  // Build tiles: self first, others — in order they joined.
  const tiles = useMemo(() => {
    const list = [{ kind: 'self' }];
    for (const uid of participants) {
      if (uid === selfId) continue;
      list.push({ kind: 'remote', userId: uid });
    }
    return list;
  }, [participants, selfId]);

  // Grid cols: адаптивно по количеству
  const cols = tiles.length <= 1 ? 1
    : tiles.length <= 4 ? 2
    : tiles.length <= 9 ? 3
    : 4;

  const peopleLabel = `${participants.length} участник${
    participants.length === 1 ? '' : participants.length < 5 ? 'а' : 'ов'
  }`;

  return (
    <div className="fixed inset-0 z-40 bg-bg-0 flex flex-col">
      <div className="flex-1 relative overflow-hidden p-3">
        <div
          className="grid gap-2 w-full h-full"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {tiles.map((t) => {
            if (t.kind === 'self') {
              return (
                <Tile
                  key="self"
                  stream={localStream}
                  user={selfUser || { displayName: 'Вы' }}
                  self
                  muted={muted}
                  mirror={cameraOn}
                />
              );
            }
            const u = usersById?.[t.userId]
              || group?.members?.find((m) => m.id === t.userId)
              || { id: t.userId, displayName: `#${t.userId}` };
            return (
              <Tile
                key={t.userId}
                stream={remotes[t.userId]}
                user={u}
              />
            );
          })}
        </div>

        {/* Невидимые аудио-элементы для каждого пира (кроме self) */}
        {participants
          .filter((id) => id !== selfId)
          .map((uid) => (
            <RemoteAudio
              key={`a-${uid}`}
              stream={remotes[uid]}
              sinkId={settings.outputDeviceId}
              volume={settings.outputVolume}
              muted={deafened}
            />
          ))}

        <div className="absolute top-4 left-4 flex items-center gap-2">
          <div className="px-3 py-1.5 text-xs rounded-full bg-black/60 backdrop-blur border border-white/10 flex items-center gap-1.5">
            <UsersIcon size={14} />
            <span>{group?.name || 'Группа'} · {peopleLabel}</span>
          </div>
        </div>
      </div>

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
          title={deafened ? 'Включить звук' : 'Заглушить звук (только у вас)'}
        >
          {deafened ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </ToolButton>
        {withVideo && (
          <ToolButton
            onClick={toggleCamera}
            active={cameraOn}
            title={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
          >
            {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
          </ToolButton>
        )}
        <ToolButton
          onClick={toggleScreenShare}
          active={sharingScreen}
          title={sharingScreen ? 'Остановить демонстрацию экрана' : 'Начать демонстрацию экрана'}
        >
          {sharingScreen ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
        </ToolButton>
        <button
          onClick={() => leave()}
          className="btn-icon bg-danger hover:bg-danger-hover text-white ml-2"
          style={{ width: 52, height: 52 }}
          title="Покинуть"
        >
          <PhoneOff size={22} />
        </button>
      </div>
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
