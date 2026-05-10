import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import {
  LogOut,
  Menu,
  Settings as SettingsIcon,
  User as UserIcon,
  BellOff,
  Bell,
  Phone,
  Video,
  Pencil,
  Trash2,
  LogOut as LeaveIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';
import { useMutes } from '../context/MutesContext';
import { useConfig } from '../context/ConfigContext';
import { useGroups } from '../context/GroupsContext';
import { api } from '../api';
import { getSocket } from '../socket';
import UserList from '../components/UserList';
import ChatPanel from '../components/ChatPanel';
import CallView from '../components/CallView';
import IncomingCallModal from '../components/IncomingCallModal';
import ContextMenu from '../components/ContextMenu';
import Avatar from '../components/Avatar';
import GroupCallView from '../components/GroupCallView';
import { useCall } from '../hooks/useCall';
import { useGroupCall } from '../hooks/useGroupCall';
import { useSounds } from '../hooks/useSounds';
import { useKeybinds } from '../hooks/useKeybinds';
import { getAvatarUrl, getDisplayName, isDeletedUser } from '../utils/user';

const SettingsPanel = lazy(() => import('../components/SettingsPanel'));
const ProfileModal = lazy(() => import('../components/ProfileModal'));
const GroupModal = lazy(() => import('../components/GroupModal'));
const ConfirmModal = lazy(() => import('../components/ConfirmModal'));

// --- helpers ------------------------------------------------------------
// Ключ чата в хеш-словарях (сообщения, unread и т.п.).
function chatKey(sel) {
  if (!sel) return null;
  return sel.kind === 'group' ? `g:${sel.id}` : `u:${sel.id}`;
}

function keyForMessage(msg, selfId) {
  if (msg.groupId) return `g:${msg.groupId}`;
  const peer = msg.senderId === selfId ? msg.receiverId : msg.senderId;
  return `u:${peer}`;
}

const TYPING_TTL_MS = 4000;
const TYPING_PRUNE_MS = 1000;

function latestCreatedAt(messages) {
  let latest = 0;
  for (const msg of messages || []) {
    if (typeof msg.createdAt === 'number' && msg.createdAt > latest) latest = msg.createdAt;
  }
  return latest;
}

function setActivity(prev, key, ts) {
  if (!key || typeof ts !== 'number' || !Number.isFinite(ts)) return prev;
  if ((prev[key] || 0) >= ts) return prev;
  return { ...prev, [key]: ts };
}

function removeTypingUser(prev, key, userId) {
  const byUser = prev[key];
  if (!byUser?.[userId]) return prev;
  const nextByUser = { ...byUser };
  delete nextByUser[userId];
  const next = { ...prev };
  if (Object.keys(nextByUser).length > 0) next[key] = nextByUser;
  else delete next[key];
  return next;
}

function removeTypingChat(prev, key) {
  if (!key || !prev[key]) return prev;
  const next = { ...prev };
  delete next[key];
  return next;
}

function pruneTyping(prev, now) {
  let changed = false;
  const next = {};
  for (const [key, byUser] of Object.entries(prev)) {
    const kept = {};
    for (const [userId, expiresAt] of Object.entries(byUser as Record<string, number>)) {
      if (expiresAt > now) kept[userId] = expiresAt;
      else changed = true;
    }
    if (Object.keys(kept).length > 0) next[key] = kept;
    else changed = true;
  }
  return changed ? next : prev;
}

export default function Home() {
  const { auth, logout, updateUser } = useAuth();
  const { settings } = useSettings();
  const toast = useToast();
  const { mutes, isMuted, toggle: toggleMute } = useMutes();
  const { maxUploadBytes } = useConfig();
  const { groups, deleteGroup } = useGroups();
  const selfUser = auth.user;
  const token = auth.token;

  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(null); // { kind: 'user'|'group', id }
  const [messagesByChat, setMessagesByChat] = useState({}); // chatKey -> msgs
  const [lastActivityByChat, setLastActivityByChat] = useState({}); // chatKey -> timestamp
  const [typingByChat, setTypingByChat] = useState({}); // chatKey -> { userId -> expiresAt }
  const [unread, setUnread] = useState({}); // chatKey -> count
  const [firstUnreadByChat, setFirstUnreadByChat] = useState({}); // chatKey -> messageId
  const [pendingUnread, setPendingUnread] = useState({}); // chatKey -> count
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileId, setProfileId] = useState(null); // ProfileModal
  const [userMenu, setUserMenu] = useState(null); // { user, x, y }
  const [groupMenu, setGroupMenu] = useState(null); // { group, x, y }
  const [groupModal, setGroupModal] = useState(null); // { mode: 'create'|'edit', groupId? }
  // Окно подтверждения logout. Случайный клик по иконке двери в углу
  // сайдбара не должен мгновенно вышвыривать юзера: попросим подтверждение.
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);
  // Set<groupId> — в каких группах сейчас активный звонок (по событиям сервера).
  const [activeGroupCalls, setActiveGroupCalls] = useState(() => new Set());

  const socket = getSocket();
  const sounds = useSounds(settings);
  const call = useCall({ socket, selfUser, settings, toast, sounds });
  const groupCall = useGroupCall({ socket, selfUser, settings, toast, sounds });
  // Регистрация глобальных хоткеев в десктоп-обёртке. На вебе хук
  // — no-op (подробности в utils/desktop.ts и hooks/useKeybinds.ts).
  useKeybinds(settings.keybinds);

  const selectedUser = useMemo(() => {
    if (!selected || selected.kind !== 'user') return null;
    return users.find((u) => u.id === selected.id) || null;
  }, [users, selected]);

  const selectedGroup = useMemo(() => {
    if (!selected || selected.kind !== 'group') return null;
    return groups.find((g) => g.id === selected.id) || null;
  }, [groups, selected]);

  // Если выбранной группы больше нет (удалили/исключили) — сбросить выделение.
  useEffect(() => {
    if (selected?.kind === 'group' && !selectedGroup) {
      setTypingByChat((prev) => removeTypingChat(prev, chatKey(selected)));
      setSelected(null);
      setSidebarOpen(true);
    }
  }, [selected, selectedGroup]);

  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const mutesRef = useRef(mutes);
  useEffect(() => {
    mutesRef.current = mutes;
  }, [mutes]);

  const fetchedHistoryFor = useRef(new Set());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTypingByChat((prev) => pruneTyping(prev, Date.now()));
    }, TYPING_PRUNE_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Построим карту usersById для поиска отправителей в групповых сообщениях.
  const usersById = useMemo(() => {
    const map = {};
    for (const u of users) map[u.id] = u;
    return map;
  }, [users]);

  // Загрузка списка пользователей
  useEffect(() => {
    let cancelled = false;
    api
      .users(token)
      .then(({ users: list }) => {
        if (!cancelled) setUsers(list);
      })
      .catch(() => {
        /* silent */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Presence + новые сообщения + правки/удаления + свой профиль
  useEffect(() => {
    if (!socket) return undefined;

    const onPresenceList = ({ online }) => {
      const set = new Set(online);
      setUsers((prev) =>
        prev.map((u) => ({ ...u, online: set.has(u.id) || u.id === selfUser.id })),
      );
    };

    const onPresence = ({ userId, online }) => {
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, online } : u)));
    };

    const onConnect = () => {
      api
        .users(token)
        .then(({ users: list }) => setUsers(list))
        .catch(() => {});
    };

    const onDm = (msg) => {
      const key = keyForMessage(msg, selfUser.id);
      setLastActivityByChat((prev) => setActivity(prev, key, msg.createdAt));
      if (msg.senderId !== selfUser.id) {
        setTypingByChat((prev) => removeTypingUser(prev, key, msg.senderId));
      }
      setMessagesByChat((prev) => {
        const cur = prev[key] || [];
        if (cur.some((m) => m.id === msg.id)) return prev;
        return { ...prev, [key]: [...cur, msg] };
      });

      // Системные сообщения (создание группы, добавление/удаление участника
      // и т.п.) не должны бить по счётчику непрочитанных и звуку.
      const isSystemic = msg.kind === 'system' || msg.kind === 'call' || msg.kind === 'groupcall';
      if (msg.senderId !== selfUser.id && !isSystemic) {
        const docHidden = typeof document !== 'undefined' && document.hidden;
        const curSel = selectedRef.current;
        const isOpenHere = curSel && chatKey(curSel) === key && !docHidden;
        // Мьют: для DM — по id собеседника, для группы — по id группы.
        const muteId = msg.groupId ? msg.groupId : msg.senderId;
        const muted = !!mutesRef.current[muteId];
        if (!isOpenHere) {
          setUnread((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
          if (!muted) sounds.playMessage();
        }
      }
    };

    const onDmUpdate = (msg) => {
      const key = keyForMessage(msg, selfUser.id);
      setMessagesByChat((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        return { ...prev, [key]: cur.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)) };
      });
    };

    const onDmDelete = ({ id, senderId, receiverId, groupId }) => {
      const key = groupId
        ? `g:${groupId}`
        : `u:${senderId === selfUser.id ? receiverId : senderId}`;
      setMessagesByChat((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        return {
          ...prev,
          [key]: cur.map((m) =>
            m.id === id
              ? { ...m, deleted: true, content: '', attachmentPath: null, durationMs: null }
              : m,
          ),
        };
      });
    };

    const onDmReaction = ({ messageId, reactions }) => {
      setMessagesByChat((prev) => {
        const updated = { ...prev };
        for (const key of Object.keys(updated)) {
          const messages = updated[key];
          const msgIndex = messages.findIndex((m) => m.id === messageId);
          if (msgIndex !== -1) {
            updated[key] = [
              ...messages.slice(0, msgIndex),
              { ...messages[msgIndex], reactions },
              ...messages.slice(msgIndex + 1),
            ];
          }
        }
        return updated;
      });
    };

    const onDmRemove = ({ id, senderId, receiverId, groupId }) => {
      const key = groupId
        ? `g:${groupId}`
        : `u:${senderId === selfUser.id ? receiverId : senderId}`;
      setMessagesByChat((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        return { ...prev, [key]: cur.filter((m) => m.id !== id) };
      });
    };

    const onProfileSelf = (user) => {
      updateUser(user);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, ...user } : u)));
    };

    const onChatTyping = ({ from, groupId, typing }) => {
      if (from === selfUser.id) return;
      const key = typeof groupId === 'number' ? `g:${groupId}` : `u:${from}`;
      setTypingByChat((prev) => {
        if (!typing) return removeTypingUser(prev, key, from);
        return {
          ...prev,
          [key]: {
            ...(prev[key] || {}),
            [from]: Date.now() + TYPING_TTL_MS,
          },
        };
      });
    };

    // Активные групповые звонки: глобальный индикатор по событиям сервера.
    const onGroupcallActive = ({ groupId }) => {
      setActiveGroupCalls((prev) => {
        if (prev.has(groupId)) return prev;
        const next = new Set(prev);
        next.add(groupId);
        return next;
      });
    };
    const onGroupcallEnded = ({ groupId }) => {
      setActiveGroupCalls((prev) => {
        if (!prev.has(groupId)) return prev;
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
    };

    socket.on('connect', onConnect);
    socket.on('presence:list', onPresenceList);
    socket.on('presence', onPresence);
    socket.on('dm:new', onDm);
    socket.on('dm:update', onDmUpdate);
    socket.on('dm:delete', onDmDelete);
    socket.on('dm:remove', onDmRemove);
    socket.on('dm:reaction', onDmReaction);
    socket.on('chat:typing', onChatTyping);
    socket.on('profile:self', onProfileSelf);
    socket.on('groupcall:active', onGroupcallActive);
    socket.on('groupcall:ended', onGroupcallEnded);

    return () => {
      socket.off('connect', onConnect);
      socket.off('presence:list', onPresenceList);
      socket.off('presence', onPresence);
      socket.off('dm:new', onDm);
      socket.off('dm:update', onDmUpdate);
      socket.off('dm:delete', onDmDelete);
      socket.off('dm:remove', onDmRemove);
      socket.off('dm:reaction', onDmReaction);
      socket.off('chat:typing', onChatTyping);
      socket.off('profile:self', onProfileSelf);
      socket.off('groupcall:active', onGroupcallActive);
      socket.off('groupcall:ended', onGroupcallEnded);
    };
  }, [selfUser.id, socket, sounds, token, updateUser]);

  // Подтягиваем актуальные активные звонки в группах: при коннекте и
  // при изменении списка групп. groupcall:active/ended обновляют состояние
  // в реальном времени, но только пока юзер уже онлайн — этот эффект
  // закрывает кейс «зашёл, а звонок уже идёт».
  useEffect(() => {
    if (!socket) return undefined;
    const sync = () => {
      for (const g of groups) {
        socket.emit('groupcall:state', { groupId: g.id }, (ack) => {
          if (!ack || 'error' in ack || !('active' in ack)) return;
          setActiveGroupCalls((prev) => {
            const has = prev.has(g.id);
            if (ack.active && !has) {
              const next = new Set(prev);
              next.add(g.id);
              return next;
            }
            if (!ack.active && has) {
              const next = new Set(prev);
              next.delete(g.id);
              return next;
            }
            return prev;
          });
        });
      }
    };
    if (socket.connected) sync();
    socket.on('connect', sync);
    return () => {
      socket.off('connect', sync);
    };
  }, [socket, groups]);

  // Загрузка истории при выборе чата
  useEffect(() => {
    if (!selected) return;
    const key = chatKey(selected);
    if (fetchedHistoryFor.current.has(key)) return;
    fetchedHistoryFor.current.add(key);
    setLoadingMessages(true);
    const promise =
      selected.kind === 'group'
        ? api.groupHistory(token, selected.id)
        : api.history(token, selected.id);
    promise
      .then(({ messages }) => {
        setMessagesByChat((prev) => ({ ...prev, [key]: messages }));
        setLastActivityByChat((prev) => setActivity(prev, key, latestCreatedAt(messages)));
      })
      .catch(() => {
        fetchedHistoryFor.current.delete(key);
      })
      .finally(() => setLoadingMessages(false));
  }, [selected, token]);

  // Вычисление id первого непрочитанного сообщения на основе count входящих.
  // Для групп "чужой" — любой sender, кроме self; для DM — peer.
  const computeFirstUnread = useCallback(
    (sel, count, msgs) => {
      if (!count || count <= 0) return null;
      let incoming;
      if (sel.kind === 'group') {
        incoming = (msgs || []).filter((m) => m.senderId !== selfUser.id);
      } else {
        incoming = (msgs || []).filter((m) => m.senderId === sel.id);
      }
      if (incoming.length === 0) return null;
      const idx = Math.max(0, incoming.length - count);
      return incoming[idx].id;
    },
    [selfUser.id],
  );

  const selectChat = useCallback(
    (sel) => {
      const prevSel = selectedRef.current;
      const prevKey = prevSel ? chatKey(prevSel) : null;
      const newKey = chatKey(sel);
      if (prevKey && prevKey !== newKey) {
        setTypingByChat((prev) => removeTypingChat(prev, prevKey));
      }
      // Уходя из предыдущего чата — убираем разделитель "новые"
      setFirstUnreadByChat((fu) => {
        if (!prevKey || prevKey === newKey) return fu;
        if (!fu[prevKey]) return fu;
        const next = { ...fu };
        delete next[prevKey];
        return next;
      });
      setSelected(sel);
      setSidebarOpen(false);

      setUnread((prev) => {
        const count = prev[newKey] || 0;
        if (count > 0) {
          const msgs = messagesByChat[newKey];
          if (msgs && msgs.length > 0) {
            const firstId = computeFirstUnread(sel, count, msgs);
            if (firstId) {
              setFirstUnreadByChat((fu) => ({ ...fu, [newKey]: firstId }));
            }
          } else {
            setPendingUnread((pu) => ({ ...pu, [newKey]: count }));
          }
        }
        if (!prev[newKey]) return prev;
        const next = { ...prev };
        delete next[newKey];
        return next;
      });
    },
    [computeFirstUnread, messagesByChat],
  );

  const handleSelectUser = useCallback((u) => selectChat({ kind: 'user', id: u.id }), [selectChat]);
  const handleSelectGroup = useCallback(
    (g) => selectChat({ kind: 'group', id: g.id }),
    [selectChat],
  );

  // Открытие чата по клику на push-уведомление (см. utils/push.js).
  useEffect(() => {
    const onOpenChat = (e) => {
      const { dm, group } = e.detail || {};
      if (group) {
        selectChat({ kind: 'group', id: group });
        setSidebarOpen(false);
      } else if (dm) {
        selectChat({ kind: 'user', id: dm });
        setSidebarOpen(false);
      }
    };
    window.addEventListener('owncord:open-chat', onOpenChat);
    return () => window.removeEventListener('owncord:open-chat', onOpenChat);
  }, [selectChat]);

  // Как только история для чата с pendingUnread появилась — фиксируем разделитель.
  useEffect(() => {
    const keys = Object.keys(pendingUnread);
    if (keys.length === 0) return;
    const resolved = [];
    for (const key of keys) {
      const msgs = messagesByChat[key];
      if (!msgs || msgs.length === 0) continue;
      const [kind, idStr] = key.split(':');
      const sel = { kind, id: Number(idStr) };
      const firstId = computeFirstUnread(sel, pendingUnread[key], msgs);
      if (firstId) setFirstUnreadByChat((fu) => ({ ...fu, [key]: firstId }));
      resolved.push(key);
    }
    if (resolved.length > 0) {
      setPendingUnread((pu) => {
        const next = { ...pu };
        for (const k of resolved) delete next[k];
        return next;
      });
    }
  }, [messagesByChat, pendingUnread, computeFirstUnread]);

  // --- send actions -------------------------------------------------------
  const handleSend = useCallback(
    async (content) => {
      if (!socket || !selected) return;
      await new Promise((resolve) => {
        const payload =
          selected.kind === 'group'
            ? { groupId: selected.id, content }
            : { to: selected.id, content };
        socket.emit('dm:send', payload, (ack) => {
          if (ack && 'error' in ack) toast.error(`Не удалось отправить: ${ack.error}`);
          resolve(ack);
        });
      });
    },
    [socket, selected, toast],
  );

  const handleSendVoice = useCallback(
    async (blob, durationMs) => {
      if (!selected) return;
      try {
        if (selected.kind === 'group') {
          await api.sendGroupVoice(token, selected.id, blob, durationMs);
        } else {
          await api.sendVoice(token, selected.id, blob, durationMs);
        }
      } catch (e) {
        toast.error(e.message || 'Не удалось отправить голосовое');
        throw e;
      }
    },
    [selected, toast, token],
  );

  const handleEditMessage = useCallback(
    async (id, content) => {
      try {
        await api.editMessage(token, id, content);
      } catch (e) {
        toast.error(e.message || 'Не удалось сохранить изменения');
      }
    },
    [token, toast],
  );

  const handleDeleteMessage = useCallback(
    async (id) => {
      try {
        await api.deleteMessage(token, id);
      } catch (e) {
        toast.error(e.message || 'Не удалось удалить');
      }
    },
    [token, toast],
  );

  const handleSendFile = useCallback(
    async (
      files: File | File[] | null,
      opts: { error?: string; limit?: number; caption?: string } = {},
    ) => {
      if (!selected) return;
      if (!files) {
        if (opts.error === 'too-large') {
          const mb = Math.round((opts.limit || maxUploadBytes) / 1024 / 1024);
          const pretty = mb < 1024 ? `${mb} МБ` : `${(mb / 1024).toFixed(1)} ГБ`;
          toast.error(`Файл больше ${pretty}`);
        }
        return;
      }
      try {
        if (selected.kind === 'group') {
          await api.sendGroupFile(token, selected.id, files, opts.caption || '');
        } else {
          await api.sendFile(token, selected.id, files, opts.caption || '');
        }
      } catch (e) {
        toast.error(e.message || 'Не удалось отправить файл');
      }
    },
    [maxUploadBytes, selected, toast, token],
  );

  // Кнопка «Подключиться» в системной плашке звонка.
  // Раньше шёл call:rejoin на сервер, который слал invite только пиру —
  // у инициатора экран не появлялся. Теперь в зависимости от состояния
  // мы либо стартуем обычный звонок (idle), либо превращаем waiting
  // обратно в активную исходящую попытку (rejoinAsCaller). Сервер
  // при invite автоматически финализирует «висящий» waiting между парой.
  const handleRejoinCall = useCallback(
    (_callId, message) => {
      if (!message) return;
      const peerId = message.senderId === selfUser?.id ? message.receiverId : message.senderId;
      if (typeof peerId !== 'number') return;
      const peerUser = users.find((u) => u.id === peerId);
      if (!peerUser) {
        toast?.error?.('Не удалось переподключиться: пользователь не найден');
        return;
      }
      const wantVideo = !!message.payload?.withVideo;
      if (call.state === 'idle') {
        call.start(peerUser, { withVideo: wantVideo });
      } else if (call.state === 'waiting' && call.peer?.id === peerId) {
        // start() сам корректно обработает waiting-вход (видит state и
        // не играет исходящий звонок, идёт сразу в connecting + getMedia).
        // rejoinAsCaller предполагал, что локальные треки живы (он
        // создавался для in-app waiting), а после F5 они null. Поэтому
        // унифицируем вход через start().
        call.start(peerUser, { withVideo: wantVideo });
      } else {
        // Звонок с другим пиром или иное состояние — игнор.
        toast?.info?.('Сначала завершите текущий звонок');
      }
    },
    [call, selfUser?.id, users, toast],
  );

  const handleCallAudio = useCallback(
    (userOverride = null) => {
      const target = userOverride || selectedUser;
      if (target) call.start(target, { withVideo: false });
    },
    [call, selectedUser],
  );

  const handleCallVideo = useCallback(
    (userOverride = null) => {
      const target = userOverride || selectedUser;
      if (target) call.start(target, { withVideo: true });
    },
    [call, selectedUser],
  );

  // Групповой звонок — join через useGroupCall.
  const handleStartGroupCall = useCallback(
    (g, { withVideo }: { withVideo?: boolean } = {}) => {
      if (!g) return;
      if (groupCall.state !== 'idle' && groupCall.group?.id === g.id) return;
      if (groupCall.state !== 'idle') {
        toast.info('Сначала покиньте текущий звонок');
        return;
      }
      if (call.state !== 'idle') {
        toast.info('Вы в другом звонке — сначала завершите его');
        return;
      }
      groupCall.join(g, { withVideo: !!withVideo });
    },
    [call.state, groupCall, toast],
  );

  const handleTypingChange = useCallback(
    (typing) => {
      if (!socket || !selected) return;
      const payload =
        selected.kind === 'group' ? { groupId: selected.id, typing } : { to: selected.id, typing };
      socket.emit('chat:typing', payload);
    },
    [socket, selected],
  );

  const onUserContextMenu = useCallback((e, user) => {
    setUserMenu({ user, x: e.clientX, y: e.clientY });
  }, []);

  const onGroupContextMenu = useCallback((e, group) => {
    setGroupMenu({ group, x: e.clientX, y: e.clientY });
  }, []);

  const openCreateGroup = useCallback(() => {
    setGroupModal({ mode: 'create' });
  }, []);

  const openEditGroup = useCallback((groupId) => {
    setGroupModal({ mode: 'edit', groupId });
  }, []);

  const groupModalGroup = useMemo(() => {
    if (groupModal?.mode !== 'edit') return null;
    return groups.find((g) => g.id === groupModal.groupId) || null;
  }, [groupModal, groups]);

  // Видим ли встроенный звонок внутри main? incoming-стадия отдельная —
  // это модалка (IncomingCallModal), а не блок в чате.
  const embeddedCallVisible = call.state !== 'idle' && call.state !== 'incoming';
  const embeddedGroupCallVisible = groupCall.state !== 'idle';

  // Авто-переключение чата на пира звонка ровно в момент его «оживления»
  // (idle/incoming → calling/connecting/in-call/waiting). Это нужно из-за
  // того, что окно звонка по фидбеку показывается ТОЛЬКО в чате с пиром
  // звонка (см. callInThisChat ниже). Иначе пользователь, инициирующий
  // звонок из контекстного меню сайдбара или принимающий входящий
  // через модалку, не увидел бы окно звонка вообще, пока вручную не
  // зайдёт в чат с пиром. Дальнейшие переходы (calling → connecting →
  // in-call) уже не дёргают select — пользователь может спокойно уйти
  // в другой чат, и звонок остаётся жить в фоне.
  const lastCallStateRef = useRef('idle');
  useEffect(() => {
    const prev = lastCallStateRef.current;
    const cur = call.state;
    lastCallStateRef.current = cur;
    const wasOff = prev === 'idle' || prev === 'incoming';
    const wasActive = cur !== 'idle' && cur !== 'incoming';
    if (wasOff && wasActive && call.peer?.id) {
      setSelected({ kind: 'user', id: call.peer.id });
      setSidebarOpen(false);
    }
  }, [call.state, call.peer?.id]);
  const lastGroupCallStateRef = useRef('idle');
  useEffect(() => {
    const prev = lastGroupCallStateRef.current;
    const cur = groupCall.state;
    lastGroupCallStateRef.current = cur;
    if (prev === 'idle' && cur !== 'idle' && groupCall.group?.id) {
      setSelected({ kind: 'group', id: groupCall.group.id });
      setSidebarOpen(false);
    }
  }, [groupCall.state, groupCall.group?.id]);

  // По фидбеку: окно звонка показываем ТОЛЬКО в чате с тем, с кем
  // сейчас разговариваешь. Сам звонок при этом продолжается (audio/
  // video идут как обычно), просто UI прячется когда листаешь другие
  // чаты — и снова появляется при возвращении в нужный.
  const callInThisChat =
    embeddedCallVisible &&
    selected?.kind === 'user' &&
    selectedUser &&
    call.peer?.id === selectedUser.id;
  const groupCallInThisChat =
    embeddedGroupCallVisible &&
    selected?.kind === 'group' &&
    selectedGroup &&
    groupCall.group?.id === selectedGroup.id;

  const key = selected ? chatKey(selected) : null;
  const messages = (key && messagesByChat[key]) || [];
  const firstUnreadId = key ? firstUnreadByChat[key] : null;
  const selfName = getDisplayName(selfUser);
  const typingUsers = useMemo(() => {
    if (!selected || !key) return [];
    const now = Date.now();
    const byUser = typingByChat[key] || {};
    if (selected.kind === 'user') {
      return selectedUser && !isDeletedUser(selectedUser) && byUser[selectedUser.id] > now
        ? [selectedUser]
        : [];
    }

    return Object.entries(byUser)
      .filter(([uid, expiresAt]) => Number(uid) !== selfUser.id && (expiresAt as number) > now)
      .map(([uid]) => {
        const id = Number(uid);
        return (
          usersById[id] ||
          selectedGroup?.members?.find((m) => m.id === id) || { id, displayName: `#${id}` }
        );
      })
      .filter((user) => !isDeletedUser(user));
  }, [key, selected, selectedGroup, selectedUser, selfUser.id, typingByChat, usersById]);

  // Групповой unread — выделяем отдельно для UserList (по id группы)
  const userUnread = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(unread)) {
      if (k.startsWith('u:')) out[Number(k.slice(2))] = v;
    }
    return out;
  }, [unread]);
  const groupUnread = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(unread)) {
      if (k.startsWith('g:')) out[Number(k.slice(2))] = v;
    }
    return out;
  }, [unread]);

  return (
    <div className="app-shell h-full w-full flex text-slate-100 overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`
          ${sidebarOpen ? 'flex' : 'hidden'}
          md:flex flex-col w-full md:w-80 lg:w-96
          surface-panel border-r border-white/10
        `}
      >
        <div className="flex items-center gap-2 p-3 border-b border-white/10 bg-white/[0.02]">
          <button
            onClick={() => setProfileId(selfUser.id)}
            className="interactive-scale flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg p-1 -m-1"
            title="Мой профиль"
          >
            <Avatar name={selfName} src={getAvatarUrl(selfUser)} size={36} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{selfName}</div>
              <div className="text-xs text-success">в сети</div>
            </div>
          </button>
          <button className="btn-ghost" onClick={() => setSettingsOpen(true)} title="Настройки">
            <SettingsIcon size={18} />
          </button>
          <button className="btn-ghost" onClick={() => setConfirmLogoutOpen(true)} title="Выйти">
            <LogOut size={18} />
          </button>
        </div>
        <UserList
          users={users}
          groups={groups}
          selected={selected}
          selfId={selfUser.id}
          unread={userUnread}
          groupUnread={groupUnread}
          lastActivityByChat={lastActivityByChat}
          mutedIds={mutes}
          activeGroupCalls={activeGroupCalls}
          onSelectUser={handleSelectUser}
          onSelectGroup={handleSelectGroup}
          onUserContextMenu={onUserContextMenu}
          onGroupContextMenu={onGroupContextMenu}
          onCreateGroup={openCreateGroup}
        />
      </aside>

      {/* Main */}
      <main
        className={`
          ${sidebarOpen ? 'hidden' : 'flex'}
          md:flex flex-col flex-1 min-w-0 relative
        `}
      >
        {!selected && (
          <div className="chat-header p-3 border-b border-white/10 md:hidden flex items-center gap-2">
            <button className="btn-ghost" onClick={() => setSidebarOpen(true)}>
              <Menu size={18} />
            </button>
            <div className="text-sm text-slate-400">Выбери собеседника или группу</div>
          </div>
        )}

        {/* Активный звонок (1:1 или групповой) передаётся в ChatPanel
            как callSlot — он рендерится СРАЗУ ПОД хедером (имя+кнопки),
            ВЫШЕ списка сообщений. Это и есть «дискорд-стайл» из
            фидбека: ник наверху, звонок под ним, чат ещё ниже. */}
        <ChatPanel
          peer={selectedUser}
          group={selectedGroup}
          messages={messages}
          selfId={selfUser.id}
          loading={loadingMessages && messages.length === 0}
          onSend={handleSend}
          onSendVoice={handleSendVoice}
          onSendFile={handleSendFile}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteMessage}
          onRejoinCall={handleRejoinCall}
          onCallAudio={() => handleCallAudio()}
          onCallVideo={() => handleCallVideo()}
          onStartGroupCall={handleStartGroupCall}
          onJoinGroupCall={handleStartGroupCall}
          onTypingChange={handleTypingChange}
          typingUsers={typingUsers}
          groupCallActive={selectedGroup ? activeGroupCalls.has(selectedGroup.id) : false}
          inGroupCall={
            groupCall.state !== 'idle' && selectedGroup && groupCall.group?.id === selectedGroup.id
          }
          onBack={() => setSidebarOpen(true)}
          onShowProfile={(id) => setProfileId(id)}
          onShowGroupSettings={openEditGroup}
          onShowGroupMemberProfile={(id) => setProfileId(id)}
          firstUnreadId={firstUnreadId}
          maxFileBytes={maxUploadBytes}
          usersById={usersById}
          callSlot={
            callInThisChat ? (
              <CallView call={call} embedded selfUser={selfUser} />
            ) : groupCallInThisChat ? (
              <GroupCallView call={groupCall} usersById={usersById} selfId={selfUser.id} embedded />
            ) : null
          }
        />
      </main>

      {/* Контекстное меню юзера в сайдбаре */}
      {userMenu && (
        <ContextMenu
          anchor={{ x: userMenu.x, y: userMenu.y }}
          onClose={() => setUserMenu(null)}
          items={[
            {
              label: 'Показать профиль',
              icon: <UserIcon size={14} />,
              onClick: () => setProfileId(userMenu.user.id),
            },
            {
              label: 'Позвонить',
              icon: <Phone size={14} />,
              disabled: !userMenu.user.online,
              onClick: () => handleCallAudio(userMenu.user),
            },
            {
              label: 'Видеозвонок',
              icon: <Video size={14} />,
              disabled: !userMenu.user.online,
              onClick: () => handleCallVideo(userMenu.user),
            },
            { divider: true },
            {
              label: isMuted(userMenu.user.id) ? 'Размутить' : 'Замутить',
              icon: isMuted(userMenu.user.id) ? <Bell size={14} /> : <BellOff size={14} />,
              onClick: () => toggleMute(userMenu.user.id),
            },
          ]}
        />
      )}

      {/* Контекстное меню группы в сайдбаре */}
      {groupMenu && (
        <ContextMenu
          anchor={{ x: groupMenu.x, y: groupMenu.y }}
          onClose={() => setGroupMenu(null)}
          items={[
            {
              label:
                groupMenu.group.ownerId === selfUser.id ? 'Редактировать' : 'Сведения о группе',
              icon: <Pencil size={14} />,
              onClick: () => openEditGroup(groupMenu.group.id),
            },
            { divider: true },
            {
              label: isMuted(groupMenu.group.id) ? 'Размутить' : 'Замутить',
              icon: isMuted(groupMenu.group.id) ? <Bell size={14} /> : <BellOff size={14} />,
              onClick: () => toggleMute(groupMenu.group.id),
            },
            { divider: true },
            groupMenu.group.ownerId === selfUser.id
              ? {
                  label: 'Удалить',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onClick: async () => {
                    if (!confirm('Удалить группу для всех участников?')) return;
                    try {
                      await deleteGroup(groupMenu.group.id);
                      if (selected?.kind === 'group' && selected.id === groupMenu.group.id) {
                        setSelected(null);
                      }
                    } catch (e) {
                      toast.error(e.message || 'Не удалось удалить');
                    }
                  },
                }
              : {
                  label: 'Выйти из группы',
                  icon: <LeaveIcon size={14} />,
                  danger: true,
                  onClick: async () => {
                    if (!confirm('Выйти из группы?')) return;
                    try {
                      await deleteGroup(groupMenu.group.id);
                    } catch (e) {
                      toast.error(e.message || 'Не удалось выйти');
                    }
                  },
                },
          ]}
        />
      )}

      {/* Модалка профиля */}
      <Suspense fallback={null}>
        <AnimatePresence>
          {profileId && (
            <ProfileModal
              userId={profileId}
              onClose={() => setProfileId(null)}
              onCallAudio={() => {
                const u = users.find((x) => x.id === profileId);
                if (u) {
                  handleCallAudio(u);
                  setProfileId(null);
                }
              }}
              onCallVideo={() => {
                const u = users.find((x) => x.id === profileId);
                if (u) {
                  handleCallVideo(u);
                  setProfileId(null);
                }
              }}
            />
          )}
        </AnimatePresence>
      </Suspense>

      {/* Модалка создания / редактирования группы */}
      <Suspense fallback={null}>
        <AnimatePresence>
          {groupModal && (
            <GroupModal
              mode={groupModal.mode}
              group={groupModalGroup}
              users={users}
              onClose={() => setGroupModal(null)}
              onCreated={(g) => {
                setSelected({ kind: 'group', id: g.id });
                setSidebarOpen(false);
              }}
            />
          )}
        </AnimatePresence>
      </Suspense>

      {/* Входящий звонок — это всё ещё модалка-оверлей: чтобы пользователь
          гарантированно увидел приглашение, даже если у него открыт другой
          чат и сайдбар свернут. Сам активный звонок встроен в main выше. */}
      <IncomingCallModal call={call} />

      {/* Настройки */}
      <Suspense fallback={null}>
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </Suspense>

      {/* Подтверждение logout. Используется один общий ConfirmModal —
          он же может пригодиться для других «опасных» действий. */}
      <Suspense fallback={null}>
        <ConfirmModal
          open={confirmLogoutOpen}
          title="Выйти из аккаунта?"
          description="Текущая сессия будет завершена. Чтобы вернуться, потребуется ввести логин и пароль."
          icon={<LogOut size={20} />}
          confirmLabel="Выйти"
          cancelLabel="Остаться"
          danger
          onConfirm={() => {
            setConfirmLogoutOpen(false);
            logout();
          }}
          onClose={() => setConfirmLogoutOpen(false)}
        />
      </Suspense>
    </div>
  );
}
