import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * Генерация UI-звуков через WebAudio API (без файлов).
 *
 * Принимает объект настроек:
 *   { soundsEnabled, soundMessage, soundIncoming, soundOutgoing,
 *     soundConnect, soundDisconnect, uiVolume }
 *
 * Если soundsEnabled = false — все методы no-op.
 * Иначе уважаем гранулярные тумблеры.
 *
 * Методы:
 *   - playMessage         (новое сообщение)
 *   - playConnect         (звонок соединён)
 *   - playDisconnect      (звонок завершён)
 *   - startOutgoing/stop  (исходящие "гудки", цикл)
 *   - startIncoming/stop  (рингтон, цикл)
 */
export function useSounds(settings) {
  const ctxRef = useRef(null);
  const intervalsRef = useRef(new Map()); // id -> intervalHandle
  const settingsRef = useRef(settings);

  // Держим актуальные настройки в ref, чтобы циклы могли подцепить
  // новое значение без перезапуска.
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const ensureCtx = useCallback(() => {
    if (typeof window === 'undefined') return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!ctxRef.current) ctxRef.current = new Ctx();
    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume().catch(() => { /* ignore */ });
    }
    return ctxRef.current;
  }, []);

  const tone = useCallback(
    (freq, duration = 0.15, { type = 'sine', gain = 0.08, when = 0 } = {}) => {
      const ctx = ensureCtx();
      if (!ctx) return;
      const ui = settingsRef.current?.uiVolume ?? 0.8;
      const finalGain = Math.max(0, Math.min(1, gain * ui));
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const now = ctx.currentTime + when;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(finalGain, now + 0.01);
      g.gain.linearRampToValueAtTime(finalGain, now + Math.max(0.02, duration - 0.03));
      g.gain.linearRampToValueAtTime(0, now + duration);
      osc.connect(g).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.05);
    },
    [ensureCtx],
  );

  const stopLoop = useCallback((id) => {
    const h = intervalsRef.current.get(id);
    if (h) {
      clearInterval(h);
      intervalsRef.current.delete(id);
    }
  }, []);

  const loop = useCallback(
    (id, fn, periodMs) => {
      stopLoop(id);
      fn();
      intervalsRef.current.set(id, setInterval(fn, periodMs));
    },
    [stopLoop],
  );

  // Если мастер-выключатель сброшен — глушим все циклы.
  useEffect(() => {
    if (!settings?.soundsEnabled) {
      for (const id of Array.from(intervalsRef.current.keys())) stopLoop(id);
    }
  }, [settings?.soundsEnabled, stopLoop]);

  // Очистка при unmount
  useEffect(() => {
    return () => {
      for (const h of intervalsRef.current.values()) clearInterval(h);
      intervalsRef.current.clear();
    };
  }, []);

  const allowed = (flag) => {
    const s = settingsRef.current;
    if (!s?.soundsEnabled) return false;
    return s[flag] !== false;
  };

  const api = useMemo(
    () => ({
      playMessage: () => {
        if (!allowed('soundMessage')) return;
        tone(880, 0.1, { gain: 0.07 });
        tone(1175, 0.1, { gain: 0.06, when: 0.09 });
      },
      playConnect: () => {
        if (!allowed('soundConnect')) return;
        tone(660, 0.09, { gain: 0.1 });
        tone(880, 0.12, { gain: 0.1, when: 0.1 });
      },
      playDisconnect: () => {
        if (!allowed('soundDisconnect')) return;
        tone(520, 0.1, { gain: 0.08 });
        tone(330, 0.15, { gain: 0.08, when: 0.1 });
      },
      startOutgoing: () => {
        if (!allowed('soundOutgoing')) return;
        loop('outgoing', () => tone(440, 0.35, { gain: 0.05 }), 1500);
      },
      stopOutgoing: () => stopLoop('outgoing'),
      startIncoming: () => {
        if (!allowed('soundIncoming')) return;
        loop(
          'incoming',
          () => {
            tone(880, 0.18, { gain: 0.12 });
            tone(660, 0.18, { gain: 0.12, when: 0.2 });
          },
          1200,
        );
      },
      stopIncoming: () => stopLoop('incoming'),
      stopAll: () => {
        for (const id of Array.from(intervalsRef.current.keys())) stopLoop(id);
      },
      // Превью — игнорирует флаги (для проверки в настройках).
      preview: (which) => {
        const previews = {
          message: () => { tone(880, 0.1, { gain: 0.07 }); tone(1175, 0.1, { gain: 0.06, when: 0.09 }); },
          incoming: () => { tone(880, 0.18, { gain: 0.12 }); tone(660, 0.18, { gain: 0.12, when: 0.2 }); },
          outgoing: () => { tone(440, 0.35, { gain: 0.05 }); },
          connect: () => { tone(660, 0.09, { gain: 0.1 }); tone(880, 0.12, { gain: 0.1, when: 0.1 }); },
          disconnect: () => { tone(520, 0.1, { gain: 0.08 }); tone(330, 0.15, { gain: 0.08, when: 0.1 }); },
        };
        previews[which]?.();
      },
    }),
    [loop, stopLoop, tone],
  );

  return api;
}
