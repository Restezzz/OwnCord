import { Server as IOServer } from 'socket.io';
import db from './db.js';
import { verifyToken } from './auth.js';
import { addUserSocket, removeUserSocket, getOnlineUserIds } from './presence.js';
import { setIO } from './ioHub.js';
import {
  registerInvite, markActive, markWaiting, finalize, getCall,
  findActiveCallsBetween, rebindForRejoin,
} from './callRegistry.js';
import {
  joinGroupCall, leaveGroupCall, getCall as getGroupCall,
  forceLeaveAll as forceLeaveAllGroupCalls, attachMessageId as attachGroupCallMessageId,
} from './groupCallRegistry.js';
import { pushToUser, pushToUsers } from './push.js';

export function attachSocket(httpServer) {
  const io = new IOServer(httpServer, {
    cors: { origin: true, credentials: true },
    maxHttpBufferSize: 1e6,
  });
  setIO(io);

  // Каждый юзер имеет персональную "комнату" user:<id>, чтобы легко адресовать
  // сообщения всем его подключениям сразу (ПК + телефон).
  const roomOf = (userId) => `user:${userId}`;

  // Параллельно держим карту "сокеты участников" — нужна для прокидывания
  // signaling и для определения "ушёл ли один из участников".
  // callId -> { caller: socketId|null, callee: socketId|null }
  const sockets = new Map();

  function setSocketFor(callId, role, socketId) {
    if (!sockets.has(callId)) sockets.set(callId, { caller: null, callee: null });
    sockets.get(callId)[role] = socketId;
  }
  function dropSockets(callId) { sockets.delete(callId); }

  // Быстрая сборка текстового сообщения в формате, которого ждёт клиент.
  function makeTextMessage({
    id, senderId, receiverId = null, groupId = null, content, createdAt,
  }) {
    return {
      id,
      senderId,
      receiverId,
      groupId,
      content,
      createdAt,
      editedAt: null,
      deleted: false,
      kind: 'text',
      attachmentPath: null,
      durationMs: null,
      attachmentName: null,
      attachmentSize: null,
      attachmentMime: null,
      payload: null,
    };
  }

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = token && verifyToken(token);
    if (!payload) return next(new Error('unauthorized'));
    socket.data.user = payload;
    next();
  });

  const groupRoomOf = (gid) => `group:${gid}`;

  // --- Системные сообщения о групповом звонке -----------------------------
  // payload.status: 'active' | 'ended'
  function insertGroupCallSystemMsg(groupId, actorId, callId, withVideo) {
    const now = Date.now();
    const payload = {
      type: 'groupcall',
      status: 'active',
      callId,
      startedBy: actorId,
      startedAt: now,
      withVideo: !!withVideo,
    };
    const info = db
      .prepare(
        `INSERT INTO messages (sender_id, group_id, content, created_at, kind, payload)
         VALUES (?, ?, '', ?, 'groupcall', ?)`,
      )
      .run(actorId, groupId, now, JSON.stringify(payload));
    db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, groupId);
    const msg = {
      id: info.lastInsertRowid,
      senderId: actorId,
      receiverId: null,
      groupId,
      content: '',
      createdAt: now,
      editedAt: null,
      deleted: false,
      kind: 'groupcall',
      attachmentPath: null,
      durationMs: null,
      attachmentName: null,
      attachmentSize: null,
      attachmentMime: null,
      payload,
    };
    io.to(groupRoomOf(groupId)).emit('dm:new', msg);
    return msg;
  }

  function endGroupCallSystemMsg(groupId, messageId) {
    if (!messageId) return;
    const row = db.prepare('SELECT payload FROM messages WHERE id = ?').get(messageId);
    if (!row) return;
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { /* */ }
    payload.status = 'ended';
    payload.endedAt = Date.now();
    db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(
      JSON.stringify(payload), messageId,
    );
    const fresh = db
      .prepare(
        `SELECT id, sender_id, receiver_id, group_id, content, created_at, edited_at,
                deleted, kind, attachment_path, duration_ms, attachment_name,
                attachment_size, attachment_mime, payload
           FROM messages WHERE id = ?`,
      )
      .get(messageId);
    if (!fresh) return;
    const msg = {
      id: fresh.id,
      senderId: fresh.sender_id,
      receiverId: fresh.receiver_id,
      groupId: fresh.group_id,
      content: fresh.content || '',
      createdAt: fresh.created_at,
      editedAt: fresh.edited_at,
      deleted: !!fresh.deleted,
      kind: fresh.kind,
      attachmentPath: fresh.attachment_path,
      durationMs: fresh.duration_ms,
      attachmentName: fresh.attachment_name,
      attachmentSize: fresh.attachment_size,
      attachmentMime: fresh.attachment_mime,
      payload,
    };
    io.to(groupRoomOf(groupId)).emit('dm:update', msg);
  }

  io.on('connection', (socket) => {
    const me = socket.data.user;
    socket.join(roomOf(me.id));

    // Автоматически подпишем сокет на все группы, где этот юзер участвует.
    const myGroupIds = db
      .prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(me.id)
      .map((r) => r.group_id);
    for (const gid of myGroupIds) socket.join(groupRoomOf(gid));

    const becameOnline = addUserSocket(me.id);
    if (becameOnline) io.emit('presence', { userId: me.id, online: true });

    // Отправляем клиенту начальный список онлайнов
    socket.emit('presence:list', { online: [...getOnlineUserIds()] });

    // Список текущих мьютов клиенту, чтобы UI отрисовался корректно при коннекте.
    const muteRows = db
      .prepare('SELECT target_id FROM mutes WHERE user_id = ?')
      .all(me.id)
      .map((r) => r.target_id);
    socket.emit('mutes:update', { ids: muteRows });

    // --- Direct/group сообщения ---------------------------------------------
    // to — peer-id (DM) ИЛИ groupId — один из двух должен быть указан.
    socket.on('dm:send', ({ to, groupId, content }, ack) => {
      if (typeof content !== 'string') return ack?.({ error: 'bad payload' });
      const trimmed = content.trim();
      if (!trimmed) return ack?.({ error: 'empty' });
      if (trimmed.length > 4000) return ack?.({ error: 'too long' });

      const toGroup = typeof groupId === 'number';
      const toUser = typeof to === 'number';
      if (toGroup === toUser) return ack?.({ error: 'need exactly one target' });

      const now = Date.now();

      if (toGroup) {
        const membership = db
          .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
          .get(groupId, me.id);
        if (!membership) return ack?.({ error: 'not a member' });
        const info = db
          .prepare(
            `INSERT INTO messages (sender_id, group_id, content, created_at, kind)
             VALUES (?, ?, ?, ?, 'text')`,
          )
          .run(me.id, groupId, trimmed, now);
        db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, groupId);
        const msg = makeTextMessage({
          id: info.lastInsertRowid,
          senderId: me.id,
          receiverId: null,
          groupId,
          content: trimmed,
          createdAt: now,
        });
        // Все участники подписаны на group:<id> при connect и при join,
        // поэтому одного emit достаточно. Дублирование в личные комнаты
        // приводило к тому, что у клиента счётчик непрочитанных рос на 2.
        io.to(groupRoomOf(groupId)).emit('dm:new', msg);

        // Web Push всем участникам группы, кроме отправителя.
        const groupRow = db
          .prepare('SELECT name FROM groups WHERE id = ?')
          .get(groupId);
        const memberIds = db
          .prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?')
          .all(groupId, me.id)
          .map((r) => r.user_id);
        if (memberIds.length) {
          pushToUsers(memberIds, {
            kind: 'group',
            title: groupRow?.name || 'Группа',
            body: `${me.username}: ${trimmed.slice(0, 120)}`,
            tag: `group:${groupId}`,
            url: `/?group=${groupId}`,
          }).catch(() => {});
        }
        return ack?.({ ok: true, message: msg });
      }

      // DM 1:1
      const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
      if (!peer) return ack?.({ error: 'no such user' });

      const info = db
        .prepare(
          `INSERT INTO messages (sender_id, receiver_id, content, created_at, kind)
           VALUES (?, ?, ?, ?, 'text')`,
        )
        .run(me.id, to, trimmed, now);
      const msg = makeTextMessage({
        id: info.lastInsertRowid,
        senderId: me.id,
        receiverId: to,
        groupId: null,
        content: trimmed,
        createdAt: now,
      });

      io.to(roomOf(to)).emit('dm:new', msg);
      io.to(roomOf(me.id)).emit('dm:new', msg);
      ack?.({ ok: true, message: msg });

      // Web Push получателю. Содержимое не несём в payload, только мета —
      // SW сам отрисует «N: текст». Это и приватнее, и проще.
      pushToUser(to, {
        kind: 'dm',
        title: me.username,
        body: trimmed.slice(0, 140),
        tag: `dm:${me.id}`,
        url: `/?dm=${me.id}`,
      }).catch(() => { /* logged inside */ });
    });

    // --- WebRTC сигналинг ---------------------------------------------------
    const forward = (event) => (payload) => {
      const to = payload?.to;
      if (typeof to !== 'number') return;
      io.to(roomOf(to)).emit(event, { ...payload, from: me.id, fromUsername: me.username });
    };

    // call:invite — обновлённая логика:
    // 1) пишем системное сообщение в чат у обеих сторон через registerInvite()
    // 2) если callee НЕ замутил каллера — поднимаем модалку (как раньше)
    socket.on('call:invite', (payload) => {
      const { callId, to, withVideo } = payload || {};
      if (typeof callId !== 'string' || typeof to !== 'number') return;
      const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
      if (!peer) return;

      // Между этими двумя может висеть незакрытый звонок:
      //   - waiting: был полноценный разговор, один ушёл, второй вернулся
      //              через кнопку «Подключиться» → это реджойн, НЕ новое
      //              сообщение. Переиспользуем messageId и сохраняем
      //              startedAt, чтобы в чате не было «завершён + новый»,
      //              и таймер не обнулялся.
      //   - pending/active: аномалия (дубликат invite, зависший звонок).
      //                     Тихо финалим без создания нового сообщения.
      const existing = findActiveCallsBetween(me.id, to);
      const waitingCall = existing.find((c) => c.status === 'waiting');

      let result;
      if (waitingCall) {
        // Забираем сокет-маппинг со старого callId и выкидываем остальных
        // «зависших» (не должны существовать, но на всякий случай).
        for (const c of existing) {
          if (c.callId === waitingCall.callId) continue;
          if (c.status !== 'ended') finalize(c.callId, c.startedAt ? 'completed' : 'cancelled');
          dropSockets(c.callId);
        }
        dropSockets(waitingCall.callId);

        const rebound = rebindForRejoin(waitingCall.callId, callId, !!withVideo);
        if (!rebound) return; // внезапно ended — игнор
        // Узнать, замучен ли callee, тут нужно локально (isMuted в registry
        // не экспортирован). db уже в scope.
        const mutedRow = db
          .prepare('SELECT 1 FROM mutes WHERE user_id = ? AND target_id = ?')
          .get(to, me.id);
        result = { call: rebound, calleeMuted: !!mutedRow, reused: true };
      } else {
        // Чистим мусор: pending/active без waiting — дубликат или баг.
        for (const c of existing) {
          if (c.status !== 'ended') finalize(c.callId, c.startedAt ? 'completed' : 'cancelled');
          dropSockets(c.callId);
        }
        result = registerInvite({
          callId, callerId: me.id, calleeId: to, withVideo: !!withVideo,
        });
        if (!result) return; // дубликат
      }

      setSocketFor(callId, 'caller', socket.id);

      if (!result.calleeMuted) {
        const row = db
          .prepare('SELECT display_name, avatar_path FROM users WHERE id = ?')
          .get(me.id);
        const callerName = row?.display_name || me.username;
        io.to(roomOf(to)).emit('call:invite', {
          callId,
          withVideo: !!withVideo,
          from: me.id,
          fromUsername: me.username,
          fromDisplayName: callerName,
          fromAvatarPath: row?.avatar_path || null,
        });

        // Web Push: входящий звонок. Tag единый, чтобы повторные invite
        // обновляли уведомление, а не плодили его. requireInteraction —
        // чтобы оставалось, пока юзер не отреагирует.
        pushToUser(to, {
          kind: 'call',
          title: `${callerName} звонит`,
          body: withVideo ? 'Видеозвонок' : 'Голосовой звонок',
          tag: `call:${me.id}`,
          url: `/?dm=${me.id}`,
          requireInteraction: true,
          renotify: true,
        }).catch(() => {});
      }
      // Подтверждение каллеру (для совместимости со state-машиной useCall)
      socket.emit('call:invite:sent', { callId, calleeMuted: !!result.calleeMuted });
    });

    socket.on('call:accept', (payload) => {
      const { callId } = payload || {};
      const c = getCall(callId);
      if (!c) return;
      if (c.calleeId !== me.id) return; // принять может только адресат
      setSocketFor(callId, 'callee', socket.id);
      markActive(callId);
      forward('call:accept')(payload);
    });

    socket.on('call:reject', (payload) => {
      const { callId } = payload || {};
      const c = getCall(callId);
      if (c) finalize(callId, 'rejected');
      dropSockets(callId);
      forward('call:reject')(payload);
    });

    socket.on('call:cancel', (payload) => {
      const { callId } = payload || {};
      const c = getCall(callId);
      if (c) finalize(callId, 'cancelled');
      dropSockets(callId);
      forward('call:cancel')(payload);
    });

    socket.on('call:end', (payload) => {
      const { callId, reason } = payload || {};
      const c = getCall(callId);
      let outboundReason = reason;
      if (c) {
        if (c.status === 'active' && reason !== 'completed') {
          // Один ушёл из активного звонка — даём 5 минут на возврат.
          markWaiting(callId);
          // Нормализуем причину для второй стороны: если клиент не указал
          // 'peer-disconnected' / 'peer-leaving' — это явный hangup, значит
          // для второй стороны это «пир ушёл, ждём» (peer-leaving).
          if (!outboundReason || outboundReason === 'hangup') {
            outboundReason = 'peer-leaving';
          }
        } else {
          // Если звонок был хоть раз активен (startedAt != null) —
          // это «completed», даже если текущий статус 'waiting'. Иначе
          // в истории появится «звонок отменён» после успешного разговора.
          finalize(callId, c.startedAt ? 'completed' : 'cancelled');
        }
      }
      // Форвардим оригинальный/нормализованный reason второй стороне.
      const out = { ...payload, reason: outboundReason };
      forward('call:end')(out);
    });

    // Полное завершение по обоюдному согласию (или таймауту)
    socket.on('call:terminate', (payload) => {
      const { callId } = payload || {};
      finalize(callId, 'completed');
      dropSockets(callId);
      forward('call:terminate')(payload);
    });

    // call:rejoin удалён — клиент теперь использует обычный call.start
    // (или эквивалентный rejoinAsCaller из waiting), а сервер автоматически
    // финализирует «висящие» звонки между той же парой при новом invite.

    socket.on('rtc:offer', forward('rtc:offer'));     // { to, callId, sdp }
    socket.on('rtc:answer', forward('rtc:answer'));   // { to, callId, sdp }
    socket.on('rtc:ice', forward('rtc:ice'));         // { to, callId, candidate }
    socket.on('media:state', forward('media:state')); // { to, callId, state }

    // --- Групповые звонки (mesh WebRTC) ------------------------------------
    //
    // Клиент инициирует / присоединяется:
    //   groupcall:join { groupId, withVideo? }
    // Сервер возвращает { callId, peers: [userId…] } — тех, кто уже внутри.
    // Плюс рассылает "groupcall:peer-joined" оставшимся участникам и
    // "groupcall:active" всем участникам группы (чтобы UI показал "звонок идёт").
    socket.on('groupcall:join', (payload, ack) => {
      const { groupId, withVideo } = payload || {};
      if (typeof groupId !== 'number') return ack?.({ error: 'bad groupId' });
      const isMember = !!db
        .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
        .get(groupId, me.id);
      if (!isMember) return ack?.({ error: 'not a member' });

      const { call, created, alreadyIn, peers } = joinGroupCall({
        groupId, userId: me.id, socketId: socket.id, withVideo: !!withVideo,
      });
      // Привяжем сокет к комнате звонка.
      const callRoom = `groupcall:${groupId}`;
      socket.join(callRoom);

      // Уведомляем группу, что звонок активен (или только что стартовал).
      if (created) {
        io.to(groupRoomOf(groupId)).emit('groupcall:active', {
          groupId, callId: call.callId, startedBy: me.id, withVideo: call.withVideo, startedAt: call.startedAt,
        });
        // Системное сообщение в чате — «X начал(а) групповой звонок» с
        // payload.status='active'. Кнопка «Подключиться» в UI работает,
        // пока звонок активен. Привязываем messageId к звонку для апдейта.
        const sysMsg = insertGroupCallSystemMsg(
          groupId, me.id, call.callId, call.withVideo,
        );
        attachGroupCallMessageId(groupId, sysMsg.id);

        // Web Push всем остальным участникам группы.
        const groupRow = db
          .prepare('SELECT name FROM groups WHERE id = ?')
          .get(groupId);
        const otherIds = db
          .prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?')
          .all(groupId, me.id)
          .map((r) => r.user_id);
        if (otherIds.length) {
          pushToUsers(otherIds, {
            kind: 'groupcall',
            title: `${groupRow?.name || 'Группа'} — звонок`,
            body: `${me.username} начал(а) ${call.withVideo ? 'видеозвонок' : 'звонок'}`,
            tag: `groupcall:${groupId}`,
            url: `/?group=${groupId}`,
            requireInteraction: true,
            renotify: true,
          }).catch(() => {});
        }
      }
      // Уведомляем уже присутствующих, что пришёл новый пир.
      if (!alreadyIn) {
        socket.to(callRoom).emit('groupcall:peer-joined', {
          groupId, callId: call.callId, userId: me.id,
        });
      }

      ack?.({
        ok: true,
        callId: call.callId,
        peers, // массив userId, которые уже внутри (до нас)
        withVideo: call.withVideo,
        startedBy: call.startedBy,
      });
    });

    socket.on('groupcall:leave', (payload, ack) => {
      const { groupId } = payload || {};
      if (typeof groupId !== 'number') return ack?.({ error: 'bad groupId' });
      const prev = getGroupCall(groupId);
      const { call, userLeft, callEnded } = leaveGroupCall({
        groupId, userId: me.id, socketId: socket.id,
      });
      const callRoom = `groupcall:${groupId}`;
      socket.leave(callRoom);

      if (userLeft && prev) {
        io.to(callRoom).emit('groupcall:peer-left', {
          groupId, callId: prev.callId, userId: me.id,
        });
      }
      if (callEnded && prev) {
        io.to(groupRoomOf(groupId)).emit('groupcall:ended', {
          groupId, callId: prev.callId,
        });
        // Закрываем системное сообщение — кнопка «Подключиться» уйдёт.
        endGroupCallSystemMsg(groupId, prev.messageId);
      }
      ack?.({ ok: true });
      // eslint-disable-next-line no-unused-vars
      void call;
    });

    // Запрос списка активных групповых звонков (при коннекте — для UI-индикации).
    socket.on('groupcall:state', (payload, ack) => {
      const { groupId } = payload || {};
      if (typeof groupId !== 'number') return ack?.({ error: 'bad groupId' });
      const c = getGroupCall(groupId);
      if (!c) return ack?.({ active: false });
      ack?.({
        active: true,
        callId: c.callId,
        withVideo: c.withVideo,
        startedAt: c.startedAt,
        startedBy: c.startedBy,
        participants: [...c.participants.keys()],
      });
    });

    // --- Отключение ---------------------------------------------------------
    socket.on('disconnect', () => {
      // Если этот сокет был участником активного звонка — переводим в waiting (5мин)
      // или финализируем (если другой стороны нет).
      for (const [callId, pair] of sockets.entries()) {
        if (pair.caller !== socket.id && pair.callee !== socket.id) continue;
        const isCaller = pair.caller === socket.id;
        const otherSocketId = isCaller ? pair.callee : pair.caller;
        const c = getCall(callId);
        if (!c) { sockets.delete(callId); continue; }
        if (c.status === 'active' && otherSocketId) {
          io.to(otherSocketId).emit('call:end', {
            from: me.id,
            fromUsername: me.username,
            callId,
            reason: 'peer-disconnected',
          });
          markWaiting(callId);
        } else {
          // Для звонков, которые уже были активны — итог 'completed'
          // (даже если сейчас 'waiting'). Без startedAt — cancelled.
          finalize(callId, c.startedAt ? 'completed' : 'cancelled');
          if (otherSocketId) {
            io.to(otherSocketId).emit('call:end', {
              from: me.id, fromUsername: me.username, callId, reason: 'peer-disconnected',
            });
          }
        }
        // Чистим только наш слот в pair, чтобы вторая сторона осталась
        if (isCaller) pair.caller = null; else pair.callee = null;
        if (!pair.caller && !pair.callee) sockets.delete(callId);
      }

      // Выведем этот сокет из всех групповых звонков и разошлём peer-left / ended.
      const removals = forceLeaveAllGroupCalls(socket.id, me.id);
      for (const r of removals) {
        const callRoom = `groupcall:${r.groupId}`;
        if (r.userLeft) {
          io.to(callRoom).emit('groupcall:peer-left', {
            groupId: r.groupId, callId: r.callId, userId: me.id,
          });
        }
        if (r.callEnded) {
          io.to(groupRoomOf(r.groupId)).emit('groupcall:ended', {
            groupId: r.groupId, callId: r.callId,
          });
          endGroupCallSystemMsg(r.groupId, r.messageId);
        }
      }

      const wentOffline = removeUserSocket(me.id);
      if (wentOffline) io.emit('presence', { userId: me.id, online: false });
    });
  });

  return io;
}
