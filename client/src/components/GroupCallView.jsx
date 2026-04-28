import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff, PhoneOff, Users as UsersIcon,
  ScreenShare, ScreenShareOff, Volume2, VolumeX, Settings,
  Pin, PinOff,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import ScreenQualityModal from './ScreenQualityModal.jsx';
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
// Проверяем, есть ли в стриме живое видео. placeholder-канва 320×180
// идёт как track.muted=false и readyState='live', но разрешение
// выдаёт себя — фильтруем по размеру кадра.
function hasRealVideo(stream) {
  if (!stream) return false;
  return stream.getVideoTracks().some((t) => {
    if (t.readyState !== 'live' || t.muted || !t.enabled) return false;
    const s = t.getSettings?.() || {};
    // placeholder ровно 320×180 — считаем его «не видео».
  if (s.width && s.height && s.width === 320 && s.height === 180) return false;
    return true;
  });
}

function Tile({
  stream, user, self, muted, mirror, className = '',
  onClick, pinned, pinnable,
}) {
  const hasVideo = hasRealVideo(stream);
  const name = getDisplayName(user) || '?';
  return (
    <div
      onClick={onClick}
      className={`relative bg-bg-2 rounded-xl overflow-hidden border border-border ${
        pinnable ? 'cursor-pointer hover:border-accent transition-colors' : ''
      } ${className}`}
    >
      {hasVideo ? (
        <StreamVideo
          stream={stream}
          muted
          mirror={mirror}
          className="w-full h-full object-contain bg-black"
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
        {pinned && <Pin size={12} className="text-accent shrink-0" />}
      </div>
    </div>
  );
}

export default function GroupCallView({ call, usersById, selfId }) {
  const { settings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  // pinnedKey: 'self' | userId | null. Когда запинен участник —
  // его плитка растягивается на всё основное поле, остальные
  // уходят в верхний стрип.
  const [pinnedKey, setPinnedKey] = useState(null);
  const {
    state, group, localStream, remotes, participants,
    muted, deafened, cameraOn, sharingScreen, withVideo,
    toggleMute, toggleDeafen, toggleCamera, toggleScreenShare, leave,
  } = call;

  // ВСЕ хуки должны вызываться ДО любого early return — иначе React
  // ругается «Rendered more/fewer hooks than during the previous render»
  // и весь оверлей уходит в чёрный экран при первом переходе из idle.
  const tiles = useMemo(() => {
    const list = [{ kind: 'self', key: 'self' }];
    for (const uid of (participants || [])) {
      if (uid === selfId) continue;
      list.push({ kind: 'remote', userId: uid, key: uid });
    }
    return list;
  }, [participants, selfId]);

  // Если пиннутый участник ушёл — сбрасываем пин.
  useEffect(() => {
    if (pinnedKey === null || pinnedKey === 'self') return;
    if (!participants.includes(pinnedKey)) setPinnedKey(null);
  }, [participants, pinnedKey]);

  if (state === 'idle') return null;

  const selfUser = usersById?.[selfId] || null;

  const peopleLabel = `${participants.length} участник${
    participants.length === 1 ? '' : participants.length < 5 ? 'а' : 'ов'
  }`;

  const renderTile = (t, opts = {}) => {
    const isPinned = pinnedKey === t.key;
    const onTileClick = () => {
      setPinnedKey((cur) => (cur === t.key ? null : t.key));
    };
    if (t.kind === 'self') {
      return (
        <Tile
          key={`tile-self${opts.suffix || ''}`}
          stream={localStream}
          user={selfUser || { displayName: 'Вы' }}
          self
          muted={muted}
          mirror={cameraOn}
          onClick={onTileClick}
          pinned={isPinned}
          pinnable
          className={opts.className}
        />
      );
    }
    const u = usersById?.[t.userId]
      || group?.members?.find((m) => m.id === t.userId)
      || { id: t.userId, displayName: `#${t.userId}` };
    return (
      <Tile
        key={`tile-${t.userId}${opts.suffix || ''}`}
        stream={remotes[t.userId]}
        user={u}
        onClick={onTileClick}
        pinned={isPinned}
        pinnable
        className={opts.className}
      />
    );
  };

  const pinnedTile = pinnedKey ? tiles.find((t) => t.key === pinnedKey) : null;
  const otherTiles = pinnedTile ? tiles.filter((t) => t.key !== pinnedKey) : tiles;

  // Grid cols для «не пин-режима» — адаптивно по количеству.
  const gridCols = tiles.length <= 1 ? 1
    : tiles.length <= 4 ? 2
    : tiles.length <= 9 ? 3
    : 4;

  return (
    <div className="fixed inset-0 z-40 bg-bg-0 flex flex-col">
      <div className="flex-1 relative overflow-hidden p-3">
        {pinnedTile ? (
          <div className="w-full h-full flex flex-col gap-2">
            <div className="flex-1 min-h-0">
              {renderTile(pinnedTile, { suffix: '-pin', className: 'w-full h-full' })}
            </div>
            {otherTiles.length > 0 && (
              <div className="flex gap-2 overflow-x-auto py-1" style={{ height: 120 }}>
                {otherTiles.map((t) => (
                  <div key={`strip-${t.key}`} className="shrink-0" style={{ width: 180, height: '100%' }}>
                    {renderTile(t, { suffix: '-strip', className: 'w-full h-full' })}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className="grid gap-2 w-full h-full"
            style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
          >
            {tiles.map((t) => renderTile(t))}
          </div>
        )}

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
          {pinnedKey && (
            <button
              onClick={() => setPinnedKey(null)}
              className="px-3 py-1.5 text-xs rounded-full bg-black/60 backdrop-blur border border-white/10 flex items-center gap-1.5 hover:bg-black/80"
              title="Открепить и вернуть сетку"
            >
              <PinOff size={14} />
              <span>Открепить</span>
            </button>
          )}
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
          onClick={() => {
            if (sharingScreen) toggleScreenShare();
            else setQualityOpen(true);
          }}
          active={sharingScreen}
          title={sharingScreen ? 'Остановить демонстрацию экрана' : 'Начать демонстрацию экрана'}
        >
          {sharingScreen ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
        </ToolButton>
        <ToolButton
          onClick={() => setSettingsOpen(true)}
          title="Настройки"
        >
          <Settings size={20} />
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
