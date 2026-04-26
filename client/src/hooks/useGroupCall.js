import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * useGroupCall — активный групповой звонок (mesh WebRTC).
 *
 * Поддерживает несколько одновременных RTCPeerConnection — по одному на
 * каждого другого участника. Локальный стрим (audio/video) создаётся один раз
 * и прикрепляется ко всем соединениям.
 *
 * Состояния: 'idle' | 'joining' | 'in-call'
 *
 * Публичное API:
 *   state, group, callId,
 *   localStream, remotes: { userId -> MediaStream },
 *   muted, cameraOn,
 *   participants: number[],  — актуальный список (включая self)
 *   join(group, { withVideo })
 *   leave()
 *   toggleMute()
 *   toggleCamera()
 *
 * Сигналинг:
 *   socket.emit('groupcall:join', { groupId, withVideo }, ack)
 *   socket.emit('groupcall:leave', { groupId })
 *   socket.emit('rtc:offer'|'rtc:answer'|'rtc:ice', { to, callId, groupId, … })
 *   socket.on('groupcall:peer-joined', { groupId, callId, userId })
 *   socket.on('groupcall:peer-left',   { groupId, callId, userId })
 *   socket.on('groupcall:ended',       { groupId, callId })
 *   socket.on('rtc:offer'|'rtc:answer'|'rtc:ice', { from, callId, groupId, … })
 */
export function useGroupCall({ socket, selfUser, toast, sounds }) {
  const [state, setState] = useState('idle');      // 'idle' | 'joining' | 'in-call'
  const [group, setGroup] = useState(null);
  const [callId, setCallId] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remotes, setRemotes] = useState({});      // userId -> MediaStream
  const [participants, setParticipants] = useState([]);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [withVideo, setWithVideo] = useState(false);

  const pcsRef = useRef(new Map());           // userId -> RTCPeerConnection
  const iceQueueRef = useRef(new Map());      // userId -> RTCIceCandidate[]
  const localStreamRef = useRef(null);
  const audioTrackRef = useRef(null);
  const videoTrackRef = useRef(null);   // камера
  const screenTrackRef = useRef(null);  // демонстрация экрана (приоритет над камерой)
  const callIdRef = useRef(null);
  const groupRef = useRef(null);
  const stateRef = useRef(state);
  const participantsRef = useRef([]);
  const iceServersRef = useRef(null);

  // Какой трек сейчас должен идти на video-сендер (экран приоритетнее камеры).
  const currentVideoTrack = () => screenTrackRef.current || videoTrackRef.current;

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { participantsRef.current = participants; }, [participants]);

  // Загрузка ICE-серверов.
  useEffect(() => {
    let cancelled = false;
    api.iceServers()
      .then((cfg) => { if (!cancelled) iceServersRef.current = cfg.iceServers; })
      .catch(() => {
        if (!cancelled) iceServersRef.current = [{ urls: 'stun:stun.l.google.com:19302' }];
      });
    return () => { cancelled = true; };
  }, []);

  // --- helpers -----------------------------------------------------------
  const addParticipant = useCallback((userId) => {
    setParticipants((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
  }, []);

  const removeParticipant = useCallback((userId) => {
    setParticipants((prev) => prev.filter((id) => id !== userId));
  }, []);

  const setRemoteForPeer = useCallback((userId, stream) => {
    setRemotes((prev) => ({ ...prev, [userId]: stream }));
  }, []);

  const clearRemoteForPeer = useCallback((userId) => {
    setRemotes((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }, []);

  const closePeer = useCallback((userId) => {
    const pc = pcsRef.current.get(userId);
    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch { /* ignore */ }
      pcsRef.current.delete(userId);
    }
    iceQueueRef.current.delete(userId);
    clearRemoteForPeer(userId);
  }, [clearRemoteForPeer]);

  const cleanup = useCallback(() => {
    // закрыть все pcs
    for (const [userId] of pcsRef.current) closePeer(userId);
    pcsRef.current.clear();
    iceQueueRef.current.clear();

    // остановить треки
    const ls = localStreamRef.current;
    if (ls) ls.getTracks().forEach((t) => { try { t.stop(); } catch { /* */ } });
    localStreamRef.current = null;
    audioTrackRef.current = null;
    videoTrackRef.current = null;
    if (screenTrackRef.current) {
      try { screenTrackRef.current.stop(); } catch { /* */ }
    }
    screenTrackRef.current = null;
    setSharingScreen(false);

    callIdRef.current = null;
    groupRef.current = null;

    setLocalStream(null);
    setRemotes({});
    setParticipants([]);
    setMuted(false);
    setCameraOn(false);
    setWithVideo(false);
    setGroup(null);
    setCallId(null);
    setState('idle');
  }, [closePeer]);

  // Применить актуальные локальные треки на все sender'ы pc.
  // Используется и при создании (для callee — после setRemoteDescription),
  // и при toggleScreenShare/toggleCamera, чтобы не делать addTrack/renegotiate.
  const applyLocalTracksToPc = useCallback((pc) => {
    const want = {
      audio: audioTrackRef.current,
      video: currentVideoTrack(),
    };
    for (const tr of pc.getTransceivers()) {
      const kind = tr.receiver?.track?.kind || tr.sender?.track?.kind;
      if (!kind) continue;
      const target = want[kind] ?? null;
      if (tr.sender.track !== target) {
        try { tr.sender.replaceTrack(target); } catch { /* */ }
      }
    }
  }, []);

  const createPeerConnection = useCallback((peerId, isInitiator) => {
    const pc = new RTCPeerConnection({
      iceServers: iceServersRef.current || [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pcsRef.current.set(peerId, pc);

    // Инициатор всегда заводит audio+video transceivers, чтобы:
    //   1) обе стороны имели video-сендер (для будущей демонстрации экрана);
    //   2) replaceTrack не требовал renegotiation.
    // Отвечающая сторона создаст соответствующие транссиверы автоматически
    // при setRemoteDescription, и мы прицепим к ним треки в onOffer.
    if (isInitiator) {
      const audioTr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      const videoTr = pc.addTransceiver('video', { direction: 'sendrecv' });
      if (audioTrackRef.current) {
        try { audioTr.sender.replaceTrack(audioTrackRef.current); } catch { /* */ }
      }
      const v = currentVideoTrack();
      if (v) {
        try { videoTr.sender.replaceTrack(v); } catch { /* */ }
      }
    }

    pc.ontrack = (ev) => {
      // Собираем все актуальные треки пира в один stream
      setRemotes((prev) => {
        const prevStream = prev[peerId];
        const set = new Set(prevStream ? prevStream.getTracks() : []);
        if (ev.streams[0]) {
          for (const t of ev.streams[0].getTracks()) set.add(t);
        } else {
          set.add(ev.track);
        }
        return { ...prev, [peerId]: new MediaStream([...set]) };
      });
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      if (!groupRef.current || !callIdRef.current) return;
      socket.emit('rtc:ice', {
        to: peerId,
        callId: callIdRef.current,
        groupId: groupRef.current.id,
        candidate: ev.candidate,
      });
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') {
        closePeer(peerId);
      }
    };

    // Стартовый offer инициирует тот, чей id меньше (детерминированно).
    if (isInitiator) {
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (!groupRef.current || !callIdRef.current) return;
          socket.emit('rtc:offer', {
            to: peerId,
            callId: callIdRef.current,
            groupId: groupRef.current.id,
            sdp: pc.localDescription,
          });
        } catch (e) {
          console.warn('groupcall offer error', e);
        }
      })();
    }

    return pc;
  }, [closePeer, socket]);

  // --- public API --------------------------------------------------------
  const join = useCallback(
    async (targetGroup, { withVideo: wantVideo = false } = {}) => {
      if (stateRef.current !== 'idle') return;
      setState('joining');
      setGroup(targetGroup);
      groupRef.current = targetGroup;
      setWithVideo(!!wantVideo);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        });
        localStreamRef.current = stream;
        audioTrackRef.current = stream.getAudioTracks()[0] || null;
        videoTrackRef.current = stream.getVideoTracks()[0] || null;
        if (videoTrackRef.current) setCameraOn(true);
        setLocalStream(stream);

        // Отправляем серверу запрос на присоединение
        const ack = await new Promise((resolve) => {
          socket.emit('groupcall:join', { groupId: targetGroup.id, withVideo: !!wantVideo }, resolve);
        });
        if (ack?.error) throw new Error(ack.error);

        callIdRef.current = ack.callId;
        setCallId(ack.callId);
        setState('in-call');
        sounds?.playConnect?.();

        // Добавим себя в список участников
        setParticipants([selfUser.id, ...(ack.peers || [])]);

        // Для каждого уже присутствующего пира: инициируем, если my_id < peer_id
        for (const peerId of (ack.peers || [])) {
          const iAmInitiator = selfUser.id < peerId;
          createPeerConnection(peerId, iAmInitiator);
        }
      } catch (e) {
        toast?.error?.(`Не удалось присоединиться: ${e.message || e}`);
        cleanup();
      }
    },
    [cleanup, createPeerConnection, selfUser.id, socket, sounds, toast],
  );

  const leave = useCallback(() => {
    if (stateRef.current === 'idle') return;
    const gid = groupRef.current?.id;
    if (socket && gid) socket.emit('groupcall:leave', { groupId: gid });
    sounds?.playDisconnect?.();
    cleanup();
  }, [cleanup, socket, sounds]);

  const toggleMute = useCallback(() => {
    const t = audioTrackRef.current;
    if (!t) return;
    t.enabled = !t.enabled;
    setMuted(!t.enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const t = videoTrackRef.current;
    if (!t) return;
    t.enabled = !t.enabled;
    setCameraOn(t.enabled);
  }, []);

  // Демонстрация экрана для группового звонка. Без renegotiation: video-сендер
  // у каждого pc уже есть (создан addTransceiver на стороне инициатора),
  // делаем replaceTrack на screenTrack/cameraTrack.
  const toggleScreenShare = useCallback(async () => {
    if (stateRef.current !== 'in-call') return;

    if (sharingScreen && screenTrackRef.current) {
      // Выключаем демку — возвращаем камеру (если была) или null.
      try { screenTrackRef.current.stop(); } catch { /* */ }
      screenTrackRef.current = null;
      setSharingScreen(false);
      // Локальное превью: убрать screen, вернуть camera (если есть).
      const ls = localStreamRef.current || new MediaStream();
      const tracks = ls.getTracks().filter((t) => t.kind !== 'video');
      if (videoTrackRef.current) tracks.push(videoTrackRef.current);
      const next = new MediaStream(tracks);
      localStreamRef.current = next;
      setLocalStream(next);
      // Прокинуть на все pcs.
      for (const [, pc] of pcsRef.current) applyLocalTracksToPc(pc);
      return;
    }

    // Включаем демку — берём поток рабочего стола.
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
    } catch (e) {
      if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
        toast?.error?.(`Не удалось начать демонстрацию: ${e.message || e}`);
      }
      return;
    }
    const track = display.getVideoTracks()[0];
    if (!track) return;
    screenTrackRef.current = track;
    setSharingScreen(true);

    track.addEventListener('ended', () => {
      // Пользователь остановил шаринг кнопкой браузера.
      if (screenTrackRef.current !== track) return;
      screenTrackRef.current = null;
      setSharingScreen(false);
      const ls2 = localStreamRef.current || new MediaStream();
      const tracks = ls2.getTracks().filter((t) => t.kind !== 'video');
      if (videoTrackRef.current) tracks.push(videoTrackRef.current);
      const next = new MediaStream(tracks);
      localStreamRef.current = next;
      setLocalStream(next);
      for (const [, pc] of pcsRef.current) applyLocalTracksToPc(pc);
    });

    // Локальное превью: заменить камеру на screen.
    const ls = localStreamRef.current || new MediaStream();
    const others = ls.getTracks().filter((t) => t.kind !== 'video');
    const next = new MediaStream([...others, track]);
    localStreamRef.current = next;
    setLocalStream(next);

    for (const [, pc] of pcsRef.current) applyLocalTracksToPc(pc);
  }, [applyLocalTracksToPc, sharingScreen, toast]);

  // --- signaling handlers -----------------------------------------------
  useEffect(() => {
    if (!socket) return undefined;

    const isMyCall = (payload) => {
      const gid = groupRef.current?.id;
      const cid = callIdRef.current;
      if (!gid || !cid) return false;
      if (payload.groupId !== gid) return false;
      // callId строгой проверки пока не делаем — сервер может прислать r2 при рестарте
      return true;
    };

    const onPeerJoined = ({ groupId, userId }) => {
      if (!groupRef.current || groupRef.current.id !== groupId) return;
      if (userId === selfUser.id) return;
      addParticipant(userId);
      // Инициируем соединение, если my_id < peer_id
      if (selfUser.id < userId) {
        createPeerConnection(userId, true);
      } else {
        // Дождёмся offer от пира.
      }
    };

    const onPeerLeft = ({ groupId, userId }) => {
      if (!groupRef.current || groupRef.current.id !== groupId) return;
      if (userId === selfUser.id) return;
      closePeer(userId);
      removeParticipant(userId);
    };

    const onEnded = ({ groupId }) => {
      if (!groupRef.current || groupRef.current.id !== groupId) return;
      sounds?.playDisconnect?.();
      cleanup();
    };

    const onOffer = async ({ from, sdp, groupId }) => {
      if (!isMyCall({ groupId })) return;
      if (from === selfUser.id) return;
      let pc = pcsRef.current.get(from);
      if (!pc) pc = createPeerConnection(from, false);
      try {
        await pc.setRemoteDescription(sdp);
        // На стороне отвечающего sender'ы создаются автоматически из offer'а —
        // прицепим к ним наши локальные треки (или null, если их нет).
        applyLocalTracksToPc(pc);
        // flush ICE queue
        const q = iceQueueRef.current.get(from) || [];
        for (const c of q) {
          try { await pc.addIceCandidate(c); } catch { /* */ }
        }
        iceQueueRef.current.delete(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:answer', {
          to: from,
          callId: callIdRef.current,
          groupId,
          sdp: pc.localDescription,
        });
        addParticipant(from);
      } catch (e) {
        console.warn('groupcall onOffer error', e);
      }
    };

    const onAnswer = async ({ from, sdp, groupId }) => {
      if (!isMyCall({ groupId })) return;
      if (from === selfUser.id) return;
      const pc = pcsRef.current.get(from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(sdp);
        const q = iceQueueRef.current.get(from) || [];
        for (const c of q) {
          try { await pc.addIceCandidate(c); } catch { /* */ }
        }
        iceQueueRef.current.delete(from);
      } catch (e) {
        console.warn('groupcall onAnswer error', e);
      }
    };

    const onIce = async ({ from, candidate, groupId }) => {
      if (!isMyCall({ groupId })) return;
      if (from === selfUser.id) return;
      const pc = pcsRef.current.get(from);
      if (!pc || !pc.remoteDescription) {
        const arr = iceQueueRef.current.get(from) || [];
        arr.push(candidate);
        iceQueueRef.current.set(from, arr);
        return;
      }
      try { await pc.addIceCandidate(candidate); } catch { /* */ }
    };

    socket.on('groupcall:peer-joined', onPeerJoined);
    socket.on('groupcall:peer-left', onPeerLeft);
    socket.on('groupcall:ended', onEnded);
    socket.on('rtc:offer', onOffer);
    socket.on('rtc:answer', onAnswer);
    socket.on('rtc:ice', onIce);

    return () => {
      socket.off('groupcall:peer-joined', onPeerJoined);
      socket.off('groupcall:peer-left', onPeerLeft);
      socket.off('groupcall:ended', onEnded);
      socket.off('rtc:offer', onOffer);
      socket.off('rtc:answer', onAnswer);
      socket.off('rtc:ice', onIce);
    };
  }, [addParticipant, applyLocalTracksToPc, cleanup, closePeer, createPeerConnection, removeParticipant, selfUser.id, socket, sounds]);

  // Корректно уведомляем сервер при закрытии вкладки.
  useEffect(() => {
    const onBeforeUnload = () => {
      const gid = groupRef.current?.id;
      if (gid && socket) socket.emit('groupcall:leave', { groupId: gid });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [socket]);

  return {
    state,
    group,
    callId,
    localStream,
    remotes,
    participants,
    muted,
    cameraOn,
    sharingScreen,
    withVideo,
    join,
    leave,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
  };
}
