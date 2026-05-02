import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Video, ArrowLeft, Send, Mic, Pencil, Trash2, Paperclip,
  Users as UsersIcon, Settings as SettingsIcon, X, File as FileIcon, Smile,
} from 'lucide-react';
import Avatar from './Avatar';
import ContextMenu from './ContextMenu';
import ReactionPicker from './ReactionPicker';
import VoiceRecorder from './VoiceRecorder';
import MessageList from './MessageList';
import { getDisplayName, getAvatarUrl, hasCustomDisplayName, formatDuration, isDeletedUser } from '../utils/user';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

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
  const [reactionPicker, setReactionPicker] = useState(null); // { messageId, x, y }
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [previewZoom, setPreviewZoom] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const dropZoneRef = useRef(null);

  const isGroup = !!group;
  const target = isGroup ? group : peer;
  const { auth } = useAuth();

  // Карта отправителей для отображения аватарки/имени рядом с сообщением
  // в групповом чате. Строится из members + глобального usersById.
  const sendersById = useMemo(() => {
    const map = new Map();
    if (usersById) {
      for (const u of Object.values(usersById) as any[]) map.set(u.id, u);
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

  // При смене собеседника сбрасываем редактирование/запись и pending attachments
  useEffect(() => {
    setEditingId(null);
    setEditDraft('');
    setRecording(false);
    setMenu(null);
    setPendingAttachments([]);
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
    const hasAttachments = pendingAttachments.length > 0;
    if ((!trimmed && !hasAttachments) || sending) return;
    setSending(true);
    try {
      if (hasAttachments) {
        // Отправляем все attachment'ы в одном сообщении
        await onSendFile?.(pendingAttachments, { caption: trimmed });
        setPendingAttachments([]);
      } else {
        await onSend(trimmed);
      }
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
    e.preventDefault();
    if (m.senderId === selfId) {
      // Свое сообщение - показать редактирование/удаление
      setMenu({ messageId: m.id, x: e.clientX, y: e.clientY });
    } else {
      // Чужое сообщение - показать реакции
      setReactionPicker({ messageId: m.id, x: e.clientX, y: e.clientY });
    }
  };

  const onPickFile = () => {
    if (!onSendFile || uploading) return;
    fileInputRef.current?.click();
  };

  const addPendingAttachment = (file) => {
    if (file.size > maxFileBytes) {
      onSendFile?.(null, { error: 'too-large', limit: maxFileBytes });
      return;
    }
    setPendingAttachments(prev => [...prev, file]);
  };

  const removePendingAttachment = (index) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const onFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    addPendingAttachment(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f: File) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    for (const file of files) {
      addPendingAttachment(file);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handlePaste = (e) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          addPendingAttachment(file);
          e.preventDefault();
        }
      }
    }
  };

  const onAddReaction = async (emoji) => {
    if (!reactionPicker) return;
    const messageId = reactionPicker.messageId;
    const groupId = isGroup ? group.id : undefined;
    
    try {
      await api.addReaction(auth?.token, messageId, emoji, groupId);
    } catch (err) {
      console.error('Failed to add reaction:', err);
    }
    
    setReactionPicker(null);
  };

  const onReactionClick = async (messageId, emoji, hasReacted) => {
    const groupId = isGroup ? group.id : undefined;
    try {
      await api.addReaction(auth?.token, messageId, emoji, groupId);
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
    }
  };

  const menuMessage = menu ? messages.find((m) => m.id === menu.messageId) : null;
  const reactionMessage = reactionPicker ? messages.find((m) => m.id === reactionPicker.messageId) : null;

  const displayName = isGroup ? (group.name || 'Группа') : getDisplayName(peer);
  const avatarUrl = isGroup ? (group.avatarPath || null) : getAvatarUrl(peer);
  // Удалённому аккаунту нельзя звонить и писать — история остаётся
  // read-only. Сами кнопки скрываем, а поле ввода делаем disabled.
  const peerDeleted = !isGroup && isDeletedUser(peer);

  return (
    <div 
      className={`flex flex-col h-full ${isDragging ? 'ring-2 ring-accent ring-inset' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
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
                : peerDeleted
                  ? 'аккаунт удалён'
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
          ) : peerDeleted ? null : (
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
        <MessageList
          messages={messages}
          selfId={selfId}
          firstUnreadId={firstUnreadId}
          editingId={editingId}
          editDraft={editDraft}
          setEditDraft={setEditDraft}
          commitEdit={commitEdit}
          cancelEdit={cancelEdit}
          onMessageContext={onMessageContext}
          onReactionClick={onReactionClick}
          onRejoinCall={onRejoinCall}
          onJoinGroupCall={onJoinGroupCall}
          inGroupCall={inGroupCall}
          isGroup={isGroup}
          group={group}
          sendersById={sendersById}
          onShowGroupMemberProfile={onShowGroupMemberProfile}
        />
      </div>

      <div className="p-3 border-t border-border">
        {peerDeleted ? (
          <div className="px-3 py-2 rounded-lg bg-bg-3 text-slate-400 text-sm text-center">
            Этот аккаунт был удалён. Написать или позвонить уже не получится — история остаётся только для чтения.
          </div>
        ) : recording ? (
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
                  : pendingAttachments.length > 0
                    ? 'Добавьте текст или отправьте…'
                    : isGroup
                      ? `Сообщение в «${group.name}»`
                      : `Сообщение для @${peer.username}`
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              onPaste={handlePaste}
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
              disabled={(!text.trim() && pendingAttachments.length === 0) || sending || uploading}
              className="btn-primary h-10"
              title="Отправить"
              type="button"
            >
              <Send size={16} />
            </button>
          </div>
        )}
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {pendingAttachments.map((file, index) => {
              const isImage = file.type.startsWith('image/');
              const isVideo = file.type.startsWith('video/');
              const previewUrl = (isImage || isVideo) ? URL.createObjectURL(file) : null;
              return (
                <div key={index} className="relative group">
                  {isImage ? (
                    <button
                      type="button"
                      onClick={() => setPreviewZoom(previewUrl)}
                      className="w-16 h-16 object-cover rounded-lg border border-border overflow-hidden"
                    >
                      <img
                        src={previewUrl}
                        alt={file.name}
                        className="w-16 h-16 object-cover"
                      />
                    </button>
                  ) : isVideo ? (
                    <div className="w-16 h-16 rounded-lg border border-border bg-bg-3 grid place-items-center overflow-hidden">
                      <video
                        src={previewUrl}
                        className="w-16 h-16 object-cover"
                        muted
                      />
                    </div>
                  ) : (
                    <div className="w-16 h-16 rounded-lg border border-border bg-bg-3 grid place-items-center flex-col gap-0.5 p-1">
                      <FileIcon size={16} className="text-slate-400 shrink-0" />
                      <div className="text-[9px] text-slate-400 truncate w-full text-center leading-tight">
                        {file.name.slice(0, 12)}{file.name.length > 12 ? '...' : ''}
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removePendingAttachment(index)}
                    className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Удалить"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {previewZoom && (
          <div
            className="fixed inset-0 z-[90] bg-black/85 grid place-items-center p-4 cursor-zoom-out"
            onClick={() => setPreviewZoom(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPreviewZoom(null);
            }}
            role="dialog"
            tabIndex={-1}
          >
            <img
              src={previewZoom}
              alt="Preview"
              className="max-h-[90vh] max-w-[95vw] object-contain"
            />
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
      {reactionPicker && reactionMessage && (
        <ReactionPicker
          anchor={{ x: reactionPicker.x, y: reactionPicker.y }}
          onSelect={onAddReaction}
          onClose={() => setReactionPicker(null)}
        />
      )}
    </div>
  );
}

