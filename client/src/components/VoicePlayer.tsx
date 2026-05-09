import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { formatDuration } from '../utils/user';
import { useSettings } from '../context/SettingsContext';

/**
 * Проигрыватель голосовых сообщений в чате.
 * Использует outputDeviceId / outputVolume из настроек.
 */
export default function VoicePlayer({ src, durationMs, mine }) {
  const { settings } = useSettings();
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(durationMs ? durationMs / 1000 : 0);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = Math.max(0, Math.min(1, settings.outputVolume ?? 1));
  }, [settings.outputVolume]);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (settings.outputDeviceId && typeof a.setSinkId === 'function') {
      a.setSinkId(settings.outputDeviceId === 'default' ? '' : settings.outputDeviceId).catch(
        () => {
          /* unsupported */
        },
      );
    }
  }, [settings.outputDeviceId]);

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) {
      a.play().catch(() => {});
    } else {
      a.pause();
    }
  };

  const onLoaded = () => {
    const d = ref.current?.duration;
    if (d && Number.isFinite(d)) setTotal(d);
  };

  const onTime = () => {
    const c = ref.current?.currentTime || 0;
    setCurrent(c);
  };

  const onEnded = () => {
    setPlaying(false);
    setCurrent(0);
  };

  const percent = total ? Math.min(100, (current / total) * 100) : 0;

  const onSeek = (e) => {
    const a = ref.current;
    if (!a || !total) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const ratio = rect.width ? x / rect.width : 0;
    a.currentTime = ratio * total;
    setCurrent(a.currentTime);
  };

  return (
    <div className="flex items-center gap-3 min-w-[200px] max-w-[280px]">
      <button
        onClick={toggle}
        className={`btn-icon shrink-0 ${mine ? 'bg-white/20 hover:bg-white/30' : 'bg-bg-3 hover:bg-bg-1'}`}
        style={{ width: 36, height: 36 }}
        title={playing ? 'Пауза' : 'Воспроизвести'}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="flex-1 min-w-0">
        <div
          className={`h-2 rounded-full cursor-pointer ${mine ? 'bg-white/20' : 'bg-bg-3'}`}
          onClick={onSeek}
        >
          <div
            className={`h-full rounded-full ${mine ? 'bg-white' : 'bg-accent'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div
          className={`text-[11px] mt-1 tabular-nums ${mine ? 'text-white/80' : 'text-slate-400'}`}
        >
          {formatDuration(current * 1000)}
          {' / '}
          {formatDuration(total * 1000)}
        </div>
      </div>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoaded}
        onDurationChange={onLoaded}
        onTimeUpdate={onTime}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
      />
    </div>
  );
}
