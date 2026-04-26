import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Video, ArrowLeft, Send, Mic, Check, X, Pencil, Trash2, Paperclip,
  Users as UsersIcon, Settings as SettingsIcon,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import ContextMenu from './ContextMenu.jsx';
import VoiceRecorder from './VoiceRecorder.jsx';
import VoicePlayer from './VoicePlayer.jsx';
import CallMessage from './CallMessage.jsx';
import SystemMessage from './SystemMessage.jsx';
import GroupCallMessage from './GroupCallMessage.jsx';
import AttachmentMessage from './AttachmentMessage.jsx';
import { getAvatarUrl, getDisplayName, hasCustomDisplayName } from '../utils/user.js';
import { renderMarkdown } from '../utils/markdown.jsx';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'long', year: 'numeric' });
}

function formatLimit(bytes) {
  const mb = Math.round(bytes / 1024 / 1024);
  if (mb < 1024) return `${mb} МБ`;
  return `${(mb / 1024).toFixed(1)} ГБ`;
}

export default function ChatPanel({
  peer,
  group,
  messages,
  selfId,
  loading,
  onSend,
  onSendVoice,
  onSendFile,
  onEditMessage,
  onDeleteMessage,
  onRejoinCall,
  onCallAudio,
  onCallVideo,
  onBack,
  onShowProfile,
  onShowGroupSettings,
  onShowGroupMemberProfile,
  onStartGroupCall,
  onJoinGroupCall,
  groupCallActive = false,
  inGroupCall = false,
  firstUnreadId,
  maxFileBytes = 500 * 1024 * 1024,
  usersById,
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [menu, setMenu] = useState(null); // { messageId, x, y }
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  const isGroup = !!group;
  const target = isGroup ? group : peer;

  // Карта отправителей для отображения аватарки/имени рядом с сообщением
  // в групповом чате. Строится из members + глобального usersById.
  const sendersById = useMemo(() => {
    const map = new Map();
    if (usersById) {
      for (const u of Object.values(usersById)) map.set(u.id, u);
    }
    if (isGroup && Array.isArray(group?.members)) {
      for (const m of group.members) map.set(m.id, m);
    }
    return map;
  }, [group, isGroup, usersById]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, target?.id]);

  // При смене собеседника сбрасываем редактирование/запись
  useEffect(() => {
    setEditingId(null);
    setEditDraft('');
    setRecording(false);
    setMenu(null);
  }, [target?.id, isGroup]);

  if (!target) {
    return (
      <div className="h-full grid place-items-center text-slate-500 p-8 text-center">
        <div>
          <div className="text-lg mb-1">Выбери собеседника или группу слева</div>
          <div className="text-sm">Можно писать или звонить любому пользователю.</div>
        </div>
      </div>
    );
  }

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText('');
    } finally {
      setSending(false);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const startEdit = (m) => {
    setEditingId(m.id);
    setEditDraft(m.content);
  };

  const commitEdit = async () => {
    const id = editingId;
    const next = editDraft.trim();
    if (!id || !next) { cancelEdit(); return; }
    const existing = messages.find((m) => m.id === id);
    if (existing && next === existing.content) { cancelEdit(); return; }
    try {
      await onEditMessage?.(id, next);
    } finally {
      cancelEdit();
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft('');
  };

  const onMessageContext = (e, m) => {
    if (m.deleted || m.kind === 'call') return;
    if (m.senderId !== selfId) return;
    e.preventDefault();
    setMenu({ messageId: m.id, x: e.clientX, y: e.clientY });
  };

  const onPickFile = () => {
    if (!onSendFile || uploading) return;
    fileInputRef.current?.click();
  };

  const onFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > maxFileBytes) {
      // ChatPanel не имеет toast — отдадим в callback с ошибкой через throw
      onSendFile?.(null, { error: 'too-large', limit: maxFileBytes });
      return;
    }
    setUploading(true);
    try {
      await onSendFile?.(file, { caption: text.trim() });
      setText('');
    } finally {
      setUploading(false);
    }
  };

  const menuMessage = menu ? messages.find((m) => m.id === menu.messageId) : null;

  const displayName = isGroup ? (group.name || 'Группа') : getDisplayName(peer);
  const avatarUrl = isGroup ? (group.avatarPath || null) : getAvatarUrl(peer);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-2 p-3 border-b border-border">
        {onBack && (
          <button className="btn-ghost md:hidden" onClick={onBack} aria-label="Назад">
            <ArrowLeft size={18} />
          </button>
        )}
        {/* Блок профиля/группы компактный, чтобы кнопки звонка были рядом с именем,
            а не улетали в самый правый край. */}
        <button
          className="flex items-center gap-3 min-w-0 max-w-[60%] text-left hover:opacity-90 shrink"
          onClick={() => {
            if (isGroup) onShowGroupSettings?.(group.id);
            else onShowProfile?.(peer.id);
          }}
          title={isGroup ? 'Настройки группы' : 'Открыть профиль'}
        >
          {isGroup && !avatarUrl ? (
            <div
              className="avatar grid place-items-center bg-bg-3 text-slate-200 shrink-0"
              style={{ width: 38, height: 38 }}
              aria-hidden
            >
              <UsersIcon size={18} />
            </div>
          ) : (
            <Avatar
              name={displayName}
              src={avatarUrl}
              size={38}
              online={isGroup ? undefined : peer.online}
              showStatus={!isGroup}
            />
          )}
          <div className="min-w-0">
            <div className="truncate font-semibold">{displayName}</div>
            <div className="text-xs text-slate-500 truncate">
              {isGroup
                ? `${group.members?.length || 0} участ.`
                : (hasCustomDisplayName(peer) ? `@${peer.username} • ` : '') + (peer.online ? 'в сети' : 'не в сети')
              }
            </div>
          </div>
        </button>
        {/* Кнопки звонка / настроек — сразу за именем, а не у края */}
        <div className="flex items-center gap-1 shrink-0">
          {isGroup ? (
            <>
              <button
                className="btn-icon bg-bg-3 hover:bg-bg-2 text-slate-100 disabled:opacity-40"
                style={{ width: 36, height: 36 }}
                onClick={() => onStartGroupCall?.(group, { withVideo: false })}
                disabled={!onStartGroupCall}
                title="Голосовая встреча"
                type="button"
              >
                <Phone size={16} />
              </button>
              <button
                className="btn-icon bg-bg-3 hover:bg-bg-2 text-slate-100 disabled:opacity-40"
                style={{ width: 36, height: 36 }}
                onClick={() => onStartGroupCall?.(group, { withVideo: true })}
                disabled={!onStartGroupCall}
                title="Видео-встреча"
                type="button"
              >
                <Video size={16} />
              </button>
              <button
                className="btn-icon bg-bg-3 hover:bg-bg-2 text-slate-100"
                style={{ width: 36, height: 36 }}
                onClick={() => onShowGroupSettings?.(group.id)}
                title="Настройки группы"
                type="button"
              >
                <SettingsIcon size={16} />
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-icon bg-bg-3 hover:bg-bg-2 text-slate-100 disabled:opacity-40"
                style={{ width: 36, height: 36 }}
                onClick={onCallAudio}
                disabled={!peer.online}
                title={peer.online ? 'Голосовой звонок' : 'Пользователь не в сети'}
                type="button"
              >
                <Phone size={16} />
              </button>
              <button
                className="btn-icon bg-bg-3 hover:bg-bg-2 text-slate-100 disabled:opacity-40"
                style={{ width: 36, height: 36 }}
                onClick={onCallVideo}
                disabled={!peer.online}
                title={peer.online ? 'Видео-звонок' : 'Пользователь не в сети'}
                type="button"
              >
                <Video size={16} />
              </button>
            </>
          )}
        </div>
        {/* Пустой spacer — чтобы header по ширине ощущался ровно, но кнопки всё равно у имени */}
        <div className="flex-1" />
      </header>

      {/* Баннер активного группового звонка — виден всем, кроме тех, кто уже внутри */}
      {isGroup && groupCallActive && !inGroupCall && (
        <div className="px-4 py-2 bg-emerald-500/15 border-b border-emerald-500/30 flex items-center gap-3">
          <Phone size={14} className="text-emerald-300 shrink-0" />
          <div className="flex-1 text-sm text-emerald-200 truncate">
            В этой группе сейчас идёт звонок
          </div>
          <button
            type="button"
            className="btn-primary h-7 px-3 text-xs"
            onClick={() => onJoinGroupCall?.(group)}
          >
            Подключиться
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {loading && <div className="text-center text-slate-500 text-sm">Загрузка…</div>}
        {!loading && messages.length === 0 && (
          <div className="text-center text-slate-500 text-sm">
            Ещё нет сообщений. Напиши первым!
          </div>
        )}
        {renderMessages({
          messages,
          selfId,
          firstUnreadId,
          editingId,
          editDraft,
          setEditDraft,
          commitEdit,
          cancelEdit,
          onMessageContext,
          onRejoinCall,
          onJoinGroupCall,
          inGroupCall,
          isGroup,
          group,
          sendersById,
          onShowGroupMemberProfile,
        })}
      </div>

      <div className="p-3 border-t border-border">
        {recording ? (
          <VoiceRecorder
            onSend={async (blob, durationMs) => {
              await onSendVoice?.(blob, durationMs);
              setRecording(false);
            }}
            onCancel={() => setRecording(false)}
            onError={() => setRecording(false)}
          />
        ) : (
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={onFileChange}
            />
            <button
              onClick={onPickFile}
              disabled={uploading}
              className="btn-icon bg-bg-3 hover:bg-bg-2 text-slate-100"
              style={{ height: 40, width: 40 }}
              title={`Прикрепить файл (до ${formatLimit(maxFileBytes)})`}
              type="button"
            >
              <Paperclip size={16} />
            </button>
            <textarea
              className="input resize-none max-h-40"
              placeholder={
                uploading
                  ? 'Загрузка файла…'
                  : isGroup
                    ? `Сообщение в «${group.name}»`
                    : `Сообщение для @${peer.username}`
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              disabled={uploading}
            />
            <button
              onClick={() => setRecording(true)}
              disabled={uploading}
              className="btn-icon bg-bg-3 hover:bg-bg-2 text-slate-100"
              style={{ height: 40, width: 40 }}
              title="Записать голосовое"
              type="button"
            >
              <Mic size={16} />
            </button>
            <button
              onClick={send}
              disabled={!text.trim() || sending || uploading}
              className="btn-primary h-10"
              title="Отправить"
              type="button"
            >
              <Send size={16} />
            </button>
          </div>
        )}
      </div>

      {menu && menuMessage && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={[
            ...(menuMessage.kind === 'text'
              ? [{
                  label: 'Редактировать',
                  icon: <Pencil size={14} />,
                  onClick: () => startEdit(menuMessage),
                }]
              : []),
            {
              label: 'Удалить',
              icon: <Trash2 size={14} />,
              danger: true,
              onClick: () => onDeleteMessage?.(menuMessage.id),
            },
          ]}
        />
      )}
    </div>
  );
}

function renderMessages({
  messages,
  selfId,
  firstUnreadId,
  editingId,
  editDraft,
  setEditDraft,
  commitEdit,
  cancelEdit,
  onMessageContext,
  onRejoinCall,
  onJoinGroupCall,
  inGroupCall = false,
  isGroup = false,
  group,
  sendersById,
  onShowGroupMemberProfile,
}) {
  const out = [];
  let lastDay = null;
  let unreadShown = false;
  let lastSenderId = null; // для группировки соседних сообщений одного автора
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    // Разделитель даты
    const day = new Date(m.createdAt).toDateString();
    const dayChanged = day !== lastDay;
    if (dayChanged) {
      out.push(
        <div key={`d-${m.id}`} className="text-center text-xs text-slate-500 my-3">
          {formatDay(m.createdAt)}
        </div>,
      );
      lastDay = day;
      lastSenderId = null;
    }

    // Разделитель "новые сообщения"
    if (
      !unreadShown
      && firstUnreadId
      && m.id === firstUnreadId
      && m.senderId !== selfId
    ) {
      out.push(
        <div key={`unread-${m.id}`} className="flex items-center gap-2 my-2 select-none">
          <div className="flex-1 h-px bg-red-500/60" />
          <span className="text-[11px] uppercase tracking-wider text-red-400 font-semibold">
            новые сообщения
          </span>
          <div className="flex-1 h-px bg-red-500/60" />
        </div>,
      );
      unreadShown = true;
      lastSenderId = null;
    }

    // Системное сообщение о звонке
    if (m.kind === 'call') {
      out.push(
        <CallMessage key={m.id} message={m} selfId={selfId} onRejoin={onRejoinCall} />,
      );
      lastSenderId = null;
      continue;
    }

    // Системное сообщение о составе группы (создание/добавление/удаление/выход)
    if (m.kind === 'system') {
      out.push(
        <SystemMessage key={m.id} message={m} sendersById={sendersById} />,
      );
      lastSenderId = null;
      continue;
    }

    // Системное сообщение о групповом звонке (старт/конец)
    if (m.kind === 'groupcall') {
      out.push(
        <GroupCallMessage
          key={m.id}
          message={m}
          sendersById={sendersById}
          isJoined={inGroupCall}
          onJoin={() => onJoinGroupCall?.(group)}
        />,
      );
      lastSenderId = null;
      continue;
    }

    const mine = m.senderId === selfId;
    const isEditing = editingId === m.id;
    const isAttachment = (m.kind === 'image' || m.kind === 'video' || m.kind === 'file') && m.attachmentPath;
    const sender = !mine && sendersById ? sendersById.get(m.senderId) : null;
    const showSenderHeader = isGroup && !mine && m.senderId !== lastSenderId;

    const senderName = sender
      ? getDisplayName(sender)
      : (isGroup && !mine ? `Пользователь #${m.senderId}` : '');

    out.push(
      <div
        key={m.id}
        className={`flex ${mine ? 'justify-end' : 'justify-start'} ${showSenderHeader ? 'mt-2' : ''}`}
        onContextMenu={(e) => onMessageContext(e, m)}
      >
        {/* В групповом чате: аватар слева у чужих сообщений, только у первого в серии */}
        {isGroup && !mine && (
          <div className="w-8 mr-2 shrink-0 flex items-end">
            {showSenderHeader ? (
              <button
                type="button"
                onClick={() => onShowGroupMemberProfile?.(m.senderId)}
                title={senderName}
              >
                <Avatar
                  name={senderName || '?'}
                  src={sender?.avatarPath || null}
                  size={32}
                />
              </button>
            ) : null}
          </div>
        )}
        <div className={`max-w-[75%] ${showSenderHeader ? '' : ''}`}>
          {showSenderHeader && (
            <div className="text-[11px] text-slate-400 mb-0.5 ml-1">
              {senderName}
            </div>
          )}
          <div
            className={`px-3 py-2 text-sm whitespace-pre-wrap break-words rounded-2xl
              ${m.deleted
                ? 'bg-bg-2 text-slate-500 italic'
                : mine ? 'bg-accent text-white' : 'bg-bg-2 text-slate-100'}
            `}
            title={new Date(m.createdAt).toLocaleString()}
          >
            {m.deleted ? (
              <span>сообщение удалено</span>
            ) : isEditing ? (
              <EditBox
                value={editDraft}
                onChange={setEditDraft}
                onSubmit={commitEdit}
                onCancel={cancelEdit}
              />
            ) : m.kind === 'voice' && m.attachmentPath ? (
              <VoicePlayer src={m.attachmentPath} durationMs={m.durationMs} mine={mine} />
            ) : isAttachment ? (
              <div className="space-y-1">
                <AttachmentMessage message={m} mine={mine} />
                {m.content && (
                  <div className={`text-sm ${mine ? 'text-white' : 'text-slate-100'}`}>
                    {renderMarkdown(m.content)}
                  </div>
                )}
              </div>
            ) : (
              <div>{renderMarkdown(m.content)}</div>
            )}
            {!m.deleted && !isEditing && (
              <div
                className={`text-[10px] mt-0.5 text-right flex items-center justify-end gap-1 ${
                  mine ? 'text-white/70' : 'text-slate-500'
                }`}
              >
                {m.editedAt && <span className="italic">изменено</span>}
                <span>{formatTime(m.createdAt)}</span>
              </div>
            )}
          </div>
        </div>
      </div>,
    );
    lastSenderId = m.senderId;
  }
  return out;
}

function EditBox({ value, onChange, onSubmit, onCancel }) {
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="flex flex-col gap-1.5 min-w-[220px]">
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        rows={Math.min(6, Math.max(1, value.split('\n').length))}
        className="bg-black/30 text-white rounded-md px-2 py-1 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-white/40"
      />
      <div className="flex items-center justify-end gap-1">
        <button
          onClick={onCancel}
          className="btn-icon bg-white/10 hover:bg-white/20 text-white"
          style={{ width: 28, height: 28 }}
          title="Отменить (Esc)"
          type="button"
        >
          <X size={14} />
        </button>
        <button
          onClick={onSubmit}
          className="btn-icon bg-white/25 hover:bg-white/40 text-white"
          style={{ width: 28, height: 28 }}
          title="Сохранить (Enter)"
          type="button"
        >
          <Check size={14} />
        </button>
      </div>
    </div>
  );
}
