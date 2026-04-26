import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * useCall — один активный звонок между двумя пользователями.
 * Состояния: 'idle' | 'calling' | 'incoming' | 'connecting' | 'in-call' | 'waiting'.
 *
 * 'waiting' — пир временно отключился (закрыл вкладку/нажал hangup),
 * но у нас 5 минут на то, чтобы он вернулся. Мы удерживаем CallView
 * и локальный стрим, тушим только PeerConnection и remote-поток.
 * Как только пир заходит обратно (новый invite), соединение поднимается
 * автоматически без лишних модалок.
 *
 * Сигналинг через Socket.IO. Медиа-состояние пира (микрофон/камера/экран)
 * транслируется отдельными событиями `media:state`, чтобы UI точно знал,
 * нужно показывать видео-плашку или аватарку.
 */
const WAIT_WINDOW_MS = 5 * 60 * 1000;

export function useCall({ socket, selfUser, settings, toast, sounds }) {
  const [state, setState] = useState('idle');
  const [peer, setPeer] = useState(null);
  const [withVideo, setWithVideo] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [waitingUntil, setWaitingUntil] = useState(null);

  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);

  // Что пир сейчас шлёт — для UI на нашей стороне.
  const [peerMedia, setPeerMedia] = useState({ mic: true, camera: false, screen: false });

  // state-ref для доступа из обработчиков сокета (closures).
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // pc и связанные
  const pcRef = useRef(null);
  const callIdRef = useRef(null);
  const peerRef = useRef(null);
  const iceQueueRef = useRef([]);
  const pendingOfferRef = useRef(null);
  const audioSenderRef = useRef(null);
  const videoSenderRef = useRef(null);
  const iceServersRef = useRef(null);

  // локальные треки / обработка
  const localStreamRef = useRef(null);
  const rawAudioTrackRef = useRef(null);     // микрофон до gain
  const processedAudioTrackRef = useRef(null); // после gain — идёт в pc
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);
  const audioCtxRef = useRef(null);
  const inputGainNodeRef = useRef(null);
  const inputSourceNodeRef = useRef(null);

  // отложенная громкость микрофона
  useEffect(() => {
    if (inputGainNodeRef.current) {
      inputGainNodeRef.current.gain.value = Math.max(0, Math.min(2, settings.inputVolume ?? 1));
    }
  }, [settings.inputVolume]);

  // Загрузка ICE-серверов один раз.
  useEffect(() => {
    let cancelled = false;
    api
      .iceServers()
      .then((cfg) => {
        if (!cancelled) iceServersRef.current = cfg.iceServers;
      })
      .catch(() => {
        if (!cancelled) iceServersRef.current = [{ urls: 'stun:stun.l.google.com:19302' }];
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Утилиты -----------------------------------------------------------
  const setLocal = useCallback((stream) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
  }, []);

  const emitMediaState = useCallback(() => {
    if (!peerRef.current || !callIdRef.current || !socket) return;
    socket.emit('media:state', {
      to: peerRef.current.id,
      callId: callIdRef.current,
      state: {
        mic: !muted,
        camera: !!cameraTrackRef.current && (videoSenderRef.current?.track === cameraTrackRef.current),
        screen: !!screenTrackRef.current && (videoSenderRef.current?.track === screenTrackRef.current),
      },
    });
  }, [muted, socket]);

  // Текущее состояние "моих" медиа (для emit) — считается на лету
  const getMyMediaState = () => ({
    mic: processedAudioTrackRef.current && !muted,
    camera:
      !!cameraTrackRef.current &&
      videoSenderRef.current?.track === cameraTrackRef.current,
    screen:
      !!screenTrackRef.current &&
      videoSenderRef.current?.track === screenTrackRef.current,
  });

  const emitMyMedia = useCallback(() => {
    if (!peerRef.current || !callIdRef.current || !socket) return;
    socket.emit('media:state', {
      to: peerRef.current.id,
      callId: callIdRef.current,
      state: getMyMediaState(),
    });
  }, [socket]);

  const cleanup = useCallback(
    (reason) => {
      if (reason) sounds?.playDisconnect?.();
      sounds?.stopIncoming?.();
      sounds?.stopOutgoing?.();

      try {
        if (pcRef.current) {
          pcRef.current.ontrack = null;
          pcRef.current.onicecandidate = null;
          pcRef.current.onconnectionstatechange = null;
          pcRef.current.close();
        }
      } catch { /* ignore */ }
      pcRef.current = null;
      iceQueueRef.current = [];
      audioSenderRef.current = null;
      videoSenderRef.current = null;
      callIdRef.current = null;
      peerRef.current = null;
      pendingOfferRef.current = null;

      const ls = localStreamRef.current;
      if (ls) ls.getTracks().forEach((t) => { try { t.stop(); } catch { /* */ } });
      localStreamRef.current = null;

      for (const ref of [cameraTrackRef, screenTrackRef, rawAudioTrackRef, processedAudioTrackRef]) {
        if (ref.current) {
          try { ref.current.stop(); } catch { /* */ }
          ref.current = null;
        }
      }

      try { inputSourceNodeRef.current?.disconnect(); } catch { /* */ }
      try { inputGainNodeRef.current?.disconnect(); } catch { /* */ }
      inputSourceNodeRef.current = null;
      inputGainNodeRef.current = null;
      // audioCtxRef оставляем живым, переиспользуем

      setLocalStream(null);
      setRemoteStream(null);
      setPeer(null);
      setMuted(false);
      setCameraOn(false);
      setSharingScreen(false);
      setWithVideo(false);
      setPeerMedia({ mic: true, camera: false, screen: false });
      setWaitingUntil(null);
      setState('idle');
    },
    [sounds],
  );

  // Перевод в состояние "ждём собеседника": пир ушёл, но у нас 5 минут,
  // чтобы он вернулся. Не трогаем локальные треки (микрофон/камера),
  // чтобы при возврате не перевыбирать устройства.
  const enterWaiting = useCallback(() => {
    try {
      if (pcRef.current) {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      }
    } catch { /* ignore */ }
    pcRef.current = null;
    iceQueueRef.current = [];
    audioSenderRef.current = null;
    videoSenderRef.current = null;
    pendingOfferRef.current = null;
    setRemoteStream(null);
    setPeerMedia({ mic: false, camera: false, screen: false });
    setWaitingUntil(Date.now() + WAIT_WINDOW_MS);
    setState('waiting');
    sounds?.playDisconnect?.();
  }, [sounds]);

  // --- PeerConnection ----------------------------------------------------
  const createPeerConnection = useCallback(
    (role) => {
      const pc = new RTCPeerConnection({
        iceServers: iceServersRef.current || [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pcRef.current = pc;

      if (role === 'caller') {
        // Инициатор: заранее задаём transceivers, чтобы replaceTrack не требовал renegotiation.
        const audioTr = pc.addTransceiver('audio', { direction: 'sendrecv' });
        const videoTr = pc.addTransceiver('video', { direction: 'sendrecv' });
        audioSenderRef.current = audioTr.sender;
        videoSenderRef.current = videoTr.sender;
      }
      // Для callee senders определим после setRemoteDescription (из SDP).

      pc.ontrack = (ev) => {
        // Каждый раз собираем ВСЕ актуальные треки и кладём в новый MediaStream,
        // чтобы React точно перерендерил.
        setRemoteStream((prev) => {
          const set = new Set(prev ? prev.getTracks() : []);
          if (ev.streams[0]) {
            for (const t of ev.streams[0].getTracks()) set.add(t);
          } else {
            set.add(ev.track);
          }
          return new MediaStream([...set]);
        });
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate && peerRef.current && callIdRef.current) {
          socket.emit('rtc:ice', {
            to: peerRef.current.id,
            callId: callIdRef.current,
            candidate: ev.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
          setState('in-call');
          sounds?.stopOutgoing?.();
          sounds?.stopIncoming?.();
          sounds?.playConnect?.();
          // Сразу сообщить пиру актуальное состояние медиа.
          emitMyMedia();
        }
        if (s === 'failed' || s === 'closed') {
          hangup('connection-failed');
        }
      };

      return pc;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [emitMyMedia, socket, sounds],
  );

  const findSendersFromTransceivers = useCallback((pc) => {
    for (const tr of pc.getTransceivers()) {
      const kind = tr.receiver?.track?.kind;
      if (kind === 'audio' && !audioSenderRef.current) audioSenderRef.current = tr.sender;
      if (kind === 'video' && !videoSenderRef.current) videoSenderRef.current = tr.sender;
    }
  }, []);

  // --- Локальный медиа-стрим --------------------------------------------
  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => { /* */ });
    }
    return audioCtxRef.current;
  }, []);

  const prepareInputAudio = useCallback(
    (rawTrack) => {
      const ctx = ensureAudioCtx();
      const src = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(2, settings.inputVolume ?? 1));
      const dst = ctx.createMediaStreamDestination();
      src.connect(gain).connect(dst);

      inputSourceNodeRef.current = src;
      inputGainNodeRef.current = gain;
      rawAudioTrackRef.current = rawTrack;
      const processed = dst.stream.getAudioTracks()[0];
      processedAudioTrackRef.current = processed;
      return processed;
    },
    [ensureAudioCtx, settings.inputVolume],
  );

  const getLocalMedia = useCallback(
    async (wantVideo) => {
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (settings.inputDeviceId && settings.inputDeviceId !== 'default') {
        audioConstraints.deviceId = { exact: settings.inputDeviceId };
      }

      const videoConstraints = wantVideo
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
        : false;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints,
      });

      // Отфильтруем raw audio → прогоняем через gain → processed
      const rawAudio = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0] || null;

      const processedAudio = rawAudio ? prepareInputAudio(rawAudio) : null;

      // Собираем локальный стрим для отображения (показываем raw-video, процессинг не нужен)
      const outStream = new MediaStream();
      if (processedAudio) outStream.addTrack(processedAudio);
      if (videoTrack) {
        cameraTrackRef.current = videoTrack;
        outStream.addTrack(videoTrack);
      }
      setLocal(outStream);
      if (videoTrack) setCameraOn(true);
      return { processedAudio, videoTrack };
    },
    [prepareInputAudio, setLocal, settings.inputDeviceId],
  );

  const applyLocalTracks = useCallback(async ({ processedAudio, videoTrack }) => {
    if (processedAudio && audioSenderRef.current) {
      try { await audioSenderRef.current.replaceTrack(processedAudio); } catch { /* */ }
    }
    if (videoTrack && videoSenderRef.current) {
      try { await videoSenderRef.current.replaceTrack(videoTrack); } catch { /* */ }
    }
  }, []);

  // --- Завершение --------------------------------------------------------
  const hangup = useCallback(
    (reason) => {
      const cid = callIdRef.current;
      const target = peerRef.current;
      const wasActive = !!cid && !!target;
      cleanup('hangup');
      if (wasActive && socket) {
        socket.emit('call:end', { to: target.id, callId: cid, reason });
      }
    },
    [cleanup, socket],
  );

  // --- Исходящий вызов ---------------------------------------------------
  const start = useCallback(
    async (targetUser, { withVideo: wantVideo = false } = {}) => {
      if (state !== 'idle') return;
      const callId = `${selfUser.id}-${targetUser.id}-${Date.now()}`;
      callIdRef.current = callId;
      peerRef.current = targetUser;
      setPeer(targetUser);
      setWithVideo(wantVideo);
      setState('calling');
      sounds?.startOutgoing?.();

      try {
        const pc = createPeerConnection('caller');
        const media = await getLocalMedia(wantVideo);
        await applyLocalTracks(media);

        socket.emit('call:invite', { to: targetUser.id, callId, withVideo: wantVideo });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtc:offer', { to: targetUser.id, callId, sdp: pc.localDescription });
      } catch (e) {
        toast?.error?.(prettyMediaError('Не удалось начать звонок', e));
        hangup('start-failed');
      }
    },
    [applyLocalTracks, createPeerConnection, getLocalMedia, hangup, selfUser, socket, sounds, state, toast],
  );

  // --- Реджойн из waiting в роли инициатора -----------------------------
  // Используется кнопкой «Подключиться» у того, кто остался ждать. Создаёт
  // новый callId и шлёт обычный invite + offer. На стороне пира, если он в
  // состоянии waiting к нам, onInvite авто-примет; если в idle — увидит
  // обычный входящий звонок. Локальные треки переиспользуем — мы их при
  // переходе в waiting не трогали.
  const rejoinAsCaller = useCallback(async () => {
    if (stateRef.current !== 'waiting') return;
    const target = peerRef.current;
    if (!target) return;
    const newCallId = `${selfUser.id}-${target.id}-${Date.now()}`;
    callIdRef.current = newCallId;
    setWaitingUntil(null);
    setState('calling');
    sounds?.startOutgoing?.();

    try {
      const pc = createPeerConnection('caller');
      const processedAudio = processedAudioTrackRef.current;
      const videoTrack = sharingScreen && screenTrackRef.current
        ? screenTrackRef.current
        : (cameraOn && cameraTrackRef.current ? cameraTrackRef.current : null);
      await applyLocalTracks({ processedAudio, videoTrack });

      socket.emit('call:invite', { to: target.id, callId: newCallId, withVideo });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('rtc:offer', { to: target.id, callId: newCallId, sdp: pc.localDescription });
    } catch (e) {
      toast?.error?.(prettyMediaError('Не удалось переподключиться', e));
      cleanup('rejoin-failed');
    }
  }, [
    applyLocalTracks, createPeerConnection, cleanup, selfUser, socket, sounds,
    toast, withVideo, sharingScreen, cameraOn,
  ]);

  // --- Входящий вызов — принять ------------------------------------------
  const accept = useCallback(async () => {
    if (state !== 'incoming') return;
    sounds?.stopIncoming?.();
    setState('connecting');
    try {
      const pc = createPeerConnection('callee');
      const media = await getLocalMedia(withVideo);

      socket.emit('call:accept', { to: peerRef.current.id, callId: callIdRef.current });

      const pending = pendingOfferRef.current;
      if (pending) {
        pendingOfferRef.current = null;
        await pc.setRemoteDescription(pending);
        findSendersFromTransceivers(pc);
        await applyLocalTracks(media);
        // flush ICE queue
        for (const c of iceQueueRef.current) {
          try { await pc.addIceCandidate(c); } catch { /* */ }
        }
        iceQueueRef.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:answer', {
          to: peerRef.current.id,
          callId: callIdRef.current,
          sdp: pc.localDescription,
        });
      } else {
        // Офера ещё нет — дождёмся в rtc:offer обработчике.
        // (на этом этапе у нас уже есть локальные треки, но нет transceivers/senders)
      }
    } catch (e) {
      toast?.error?.(prettyMediaError('Не удалось принять звонок', e));
      hangup('accept-failed');
    }
  }, [applyLocalTracks, createPeerConnection, findSendersFromTransceivers, getLocalMedia, hangup, socket, sounds, state, toast, withVideo]);

  const reject = useCallback(() => {
    if (state !== 'incoming') return;
    sounds?.stopIncoming?.();
    if (peerRef.current && callIdRef.current) {
      socket.emit('call:reject', { to: peerRef.current.id, callId: callIdRef.current });
    }
    cleanup();
  }, [cleanup, socket, sounds, state]);

  // --- Переключения медиа -----------------------------------------------
  const toggleMute = useCallback(() => {
    const track = processedAudioTrackRef.current;
    const raw = rawAudioTrackRef.current;
    if (!track) return;
    const nextEnabled = !track.enabled;
    track.enabled = nextEnabled;
    if (raw) raw.enabled = nextEnabled;
    setMuted(!nextEnabled);
    // emit отправим после setMuted
    setTimeout(emitMyMedia, 0);
  }, [emitMyMedia]);

  const turnOffVideoSender = useCallback(async () => {
    if (videoSenderRef.current) {
      try { await videoSenderRef.current.replaceTrack(null); } catch { /* */ }
    }
  }, []);

  const toggleCamera = useCallback(async () => {
    if (!pcRef.current || !videoSenderRef.current) return;

    // Если сейчас стримим экран — сначала выключим его
    if (sharingScreen && screenTrackRef.current) {
      try { screenTrackRef.current.stop(); } catch { /* */ }
      screenTrackRef.current = null;
      setSharingScreen(false);
    }

    if (cameraOn && cameraTrackRef.current) {
      // выключить камеру
      try { cameraTrackRef.current.stop(); } catch { /* */ }
      const s = localStreamRef.current;
      if (s) s.removeTrack(cameraTrackRef.current);
      cameraTrackRef.current = null;
      setLocal(new MediaStream(s ? s.getTracks() : []));
      await turnOffVideoSender();
      setCameraOn(false);
      setTimeout(emitMyMedia, 0);
      return;
    }

    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      });
      const track = cam.getVideoTracks()[0];
      cameraTrackRef.current = track;
      const s = localStreamRef.current || new MediaStream();
      s.addTrack(track);
      setLocal(new MediaStream(s.getTracks()));
      await videoSenderRef.current.replaceTrack(track);
      setCameraOn(true);
      setTimeout(emitMyMedia, 0);
    } catch (e) {
      const msg = prettyMediaError('Не удалось включить камеру', e);
      toast?.error?.(msg);
    }
  }, [cameraOn, emitMyMedia, setLocal, sharingScreen, toast, turnOffVideoSender]);

  const toggleScreenShare = useCallback(async () => {
    if (!pcRef.current || !videoSenderRef.current) return;

    if (sharingScreen && screenTrackRef.current) {
      // Выключаем шаринг экрана
      try { screenTrackRef.current.stop(); } catch { /* */ }
      const s = localStreamRef.current;
      if (s) s.removeTrack(screenTrackRef.current);
      screenTrackRef.current = null;
      setSharingScreen(false);
      // Если камера включена — возвращаемся на неё, иначе отключаем video-отправку
      if (cameraOn && cameraTrackRef.current) {
        await videoSenderRef.current.replaceTrack(cameraTrackRef.current);
      } else {
        await turnOffVideoSender();
      }
      setLocal(new MediaStream(s ? s.getTracks() : []));
      setTimeout(emitMyMedia, 0);
      return;
    }

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      const track = display.getVideoTracks()[0];
      if (!track) return;
      screenTrackRef.current = track;

      track.addEventListener('ended', () => {
        // Пользователь остановил шаринг через кнопку браузера
        if (screenTrackRef.current !== track) return;
        screenTrackRef.current = null;
        setSharingScreen(false);
        const s = localStreamRef.current;
        if (s) {
          try { s.removeTrack(track); } catch { /* */ }
          setLocal(new MediaStream(s.getTracks()));
        }
        if (videoSenderRef.current) {
          if (cameraOn && cameraTrackRef.current) {
            videoSenderRef.current.replaceTrack(cameraTrackRef.current);
          } else {
            videoSenderRef.current.replaceTrack(null);
          }
        }
        setTimeout(emitMyMedia, 0);
      });

      const s = localStreamRef.current || new MediaStream();
      // Убрать предыдущий видео (камера) из preview, чтобы было видно шаринг
      if (cameraTrackRef.current && s.getTracks().includes(cameraTrackRef.current)) {
        s.removeTrack(cameraTrackRef.current);
      }
      s.addTrack(track);
      setLocal(new MediaStream(s.getTracks()));

      await videoSenderRef.current.replaceTrack(track);
      setSharingScreen(true);
      setTimeout(emitMyMedia, 0);
    } catch (e) {
      if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
        toast?.error?.(prettyMediaError('Не удалось начать демонстрацию', e));
      }
    }
  }, [cameraOn, emitMyMedia, setLocal, sharingScreen, toast, turnOffVideoSender]);

  // --- Обработка сигналинга ---------------------------------------------
  useEffect(() => {
    if (!socket) return undefined;

    const onInvite = ({
      from, fromUsername, fromDisplayName, fromAvatarPath,
      callId, withVideo: wv,
    }) => {
      const curState = stateRef.current;

      // Автоматический реджойн: мы в waiting, тот же пир возвращается.
      if (curState === 'waiting' && peerRef.current?.id === from) {
        callIdRef.current = callId;
        setWithVideo(!!wv);
        setWaitingUntil(null);
        setState('connecting');
        // Как callee: создаём свежий PC, шлём accept и ждём offer.
        (async () => {
          try {
            const pc = createPeerConnection('callee');
            // Треки уже есть — достаточно повесить их, когда узнаем senders
            socket.emit('call:accept', { to: from, callId });
            // applyLocalTracks вызовется в onOffer после setRemoteDescription
            // (как в обычном принятии через accept()).
            void pc;
          } catch (e) {
            toast?.error?.(prettyMediaError('Не удалось переподключиться', e));
            cleanup('rejoin-failed');
          }
        })();
        return;
      }

      if (pcRef.current || curState !== 'idle') {
        socket.emit('call:reject', { to: from, callId, reason: 'busy' });
        return;
      }
      callIdRef.current = callId;
      const p = {
        id: from,
        username: fromUsername,
        displayName: fromDisplayName || fromUsername,
        avatarPath: fromAvatarPath || null,
      };
      peerRef.current = p;
      setPeer(p);
      setWithVideo(!!wv);
      setState('incoming');
      sounds?.startIncoming?.();
    };

    const onOffer = async ({ from, callId, sdp }) => {
      if (!peerRef.current || peerRef.current.id !== from || callIdRef.current !== callId) return;
      if (!pcRef.current) {
        // accept ещё не нажат — сохраним
        pendingOfferRef.current = sdp;
        return;
      }
      // Если accept уже нажат и pc создан, но offer пришёл позже
      try {
        await pcRef.current.setRemoteDescription(sdp);
        findSendersFromTransceivers(pcRef.current);
        // Применим локальные треки, если ещё не применили
        if (processedAudioTrackRef.current && audioSenderRef.current?.track == null) {
          try { await audioSenderRef.current.replaceTrack(processedAudioTrackRef.current); } catch { /* */ }
        }
        if (cameraTrackRef.current && videoSenderRef.current?.track == null) {
          try { await videoSenderRef.current.replaceTrack(cameraTrackRef.current); } catch { /* */ }
        }
        for (const c of iceQueueRef.current) {
          try { await pcRef.current.addIceCandidate(c); } catch { /* */ }
        }
        iceQueueRef.current = [];
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        socket.emit('rtc:answer', { to: from, callId, sdp: pcRef.current.localDescription });
      } catch (e) {
        toast?.error?.('Ошибка согласования соединения');
        hangup('offer-failed');
      }
    };

    const onAnswer = async ({ from, callId, sdp }) => {
      if (!peerRef.current || peerRef.current.id !== from || callIdRef.current !== callId) return;
      if (!pcRef.current) return;
      try {
        await pcRef.current.setRemoteDescription(sdp);
        setState((s) => (s === 'calling' ? 'connecting' : s));
        for (const c of iceQueueRef.current) {
          try { await pcRef.current.addIceCandidate(c); } catch { /* */ }
        }
        iceQueueRef.current = [];
      } catch (e) {
        toast?.error?.('Ошибка согласования соединения');
        hangup('answer-failed');
      }
    };

    const onIce = async ({ from, callId, candidate }) => {
      if (!peerRef.current || peerRef.current.id !== from || callIdRef.current !== callId) return;
      if (!pcRef.current || !pcRef.current.remoteDescription) {
        iceQueueRef.current.push(candidate);
        return;
      }
      try { await pcRef.current.addIceCandidate(candidate); } catch { /* */ }
    };

    const onAccept = () => {
      sounds?.stopOutgoing?.();
      setState((s) => (s === 'calling' ? 'connecting' : s));
    };

    const onReject = ({ reason }) => {
      sounds?.stopOutgoing?.();
      const msg =
        reason === 'busy' ? 'Пользователь занят' : 'Звонок отклонён';
      toast?.info?.(msg);
      cleanup();
    };

    const onCancel = () => {
      sounds?.stopIncoming?.();
      cleanup();
    };

    const onEnd = ({ reason }) => {
      const curState = stateRef.current;
      // "Временные" причины — пир ушёл, но может вернуться в окне 5 мин.
      const temporary = reason === 'peer-disconnected' || reason === 'peer-leaving';
      const wasTalking = curState === 'in-call' || curState === 'connecting';
      if (temporary && wasTalking) {
        toast?.info?.('Собеседник отключился — ждём возврата');
        enterWaiting();
        return;
      }
      if (reason === 'peer-disconnected') {
        toast?.info?.('Собеседник отключился');
      }
      cleanup('remote-end');
    };

    const onMediaState = ({ from, callId, state: st }) => {
      if (!peerRef.current || peerRef.current.id !== from || callIdRef.current !== callId) return;
      setPeerMedia({
        mic: !!st?.mic,
        camera: !!st?.camera,
        screen: !!st?.screen,
      });
    };

    socket.on('call:invite', onInvite);
    socket.on('call:accept', onAccept);
    socket.on('call:reject', onReject);
    socket.on('call:cancel', onCancel);
    socket.on('call:end', onEnd);
    socket.on('rtc:offer', onOffer);
    socket.on('rtc:answer', onAnswer);
    socket.on('rtc:ice', onIce);
    socket.on('media:state', onMediaState);

    return () => {
      socket.off('call:invite', onInvite);
      socket.off('call:accept', onAccept);
      socket.off('call:reject', onReject);
      socket.off('call:cancel', onCancel);
      socket.off('call:end', onEnd);
      socket.off('rtc:offer', onOffer);
      socket.off('rtc:answer', onAnswer);
      socket.off('rtc:ice', onIce);
      socket.off('media:state', onMediaState);
    };
  }, [cleanup, createPeerConnection, enterWaiting, findSendersFromTransceivers, hangup, socket, sounds, toast]);

  // Авто-выход из waiting по истечении окна реконнекта.
  useEffect(() => {
    if (state !== 'waiting' || !waitingUntil) return undefined;
    const ms = Math.max(0, waitingUntil - Date.now());
    const t = setTimeout(() => {
      // Если всё ещё waiting и пир не вернулся — полностью выходим.
      if (stateRef.current === 'waiting') cleanup('waiting-expired');
    }, ms);
    return () => clearTimeout(t);
  }, [state, waitingUntil, cleanup]);

  // --- beforeunload: корректно уведомляем пира --------------------------
  useEffect(() => {
    const onBeforeUnload = () => {
      if (callIdRef.current && peerRef.current && socket) {
        // emit в том же тике — socket.io отправит, если сможет
        socket.emit('call:end', {
          to: peerRef.current.id,
          callId: callIdRef.current,
          reason: 'peer-leaving',
        });
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [socket]);

  return {
    state,
    peer,
    withVideo,
    localStream,
    remoteStream,
    muted,
    cameraOn,
    sharingScreen,
    peerMedia,
    waitingUntil,
    start,
    accept,
    reject,
    hangup,
    rejoinAsCaller,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
  };
}

function prettyMediaError(prefix, e) {
  const name = e?.name || '';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return `${prefix}: устройство не найдено`;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return `${prefix}: доступ запрещён`;
  if (name === 'NotReadableError') return `${prefix}: устройство занято другим приложением`;
  if (name === 'OverconstrainedError') return `${prefix}: устройство не поддерживает параметры`;
  return `${prefix}: ${e?.message || e || 'неизвестная ошибка'}`;
}
