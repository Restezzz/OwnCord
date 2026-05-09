import { memo } from 'react';
import {
  Check,
  X,
  Heart,
  Zap,
  Trophy,
  Flame,
  ThumbsUp,
  ThumbsDown,
  Laugh,
  Smile,
} from 'lucide-react';
import Avatar from './Avatar';
import VoicePlayer from './VoicePlayer';
import CallMessage from './CallMessage';
import SystemMessage from './SystemMessage';
import GroupCallMessage from './GroupCallMessage';
import AttachmentMessage from './AttachmentMessage';
import { getDisplayName } from '../utils/user';
import { renderMarkdown } from '../utils/markdown';

// Маппинг id реакции на иконку lucide-react
const REACTION_ICONS: Record<string, any> = {
  heart: Heart,
  thumbsUp: ThumbsUp,
  thumbsDown: ThumbsDown,
  laugh: Laugh,
  smile: Smile,
  flame: Flame,
  trophy: Trophy,
  zap: Zap,
};

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'long', year: 'numeric' });
}

function MessageList({
  messages,
  selfId,
  firstUnreadId,
  editingId,
  editDraft,
  setEditDraft,
  commitEdit,
  cancelEdit,
  onMessageContext,
  onReactionClick,
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
  let lastSenderId = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
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

    if (!unreadShown && firstUnreadId && m.id === firstUnreadId && m.senderId !== selfId) {
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

    if (m.kind === 'call') {
      out.push(<CallMessage key={m.id} message={m} selfId={selfId} onRejoin={onRejoinCall} />);
      lastSenderId = null;
      continue;
    }

    if (m.kind === 'system') {
      out.push(<SystemMessage key={m.id} message={m} sendersById={sendersById} />);
      lastSenderId = null;
      continue;
    }

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
    const isAttachment =
      (m.kind === 'image' || m.kind === 'video' || m.kind === 'file') && m.attachmentPath;
    const sender = !mine && sendersById ? sendersById.get(m.senderId) : null;
    const showSenderHeader = isGroup && !mine && m.senderId !== lastSenderId;

    const senderName = sender
      ? getDisplayName(sender)
      : isGroup && !mine
        ? `Пользователь #${m.senderId}`
        : '';

    out.push(
      <div
        key={m.id}
        className={`flex ${mine ? 'justify-end' : 'justify-start'} ${showSenderHeader ? 'mt-2' : ''}`}
      >
        {isGroup && !mine && (
          <div className="w-8 mr-2 shrink-0 flex items-end">
            {showSenderHeader ? (
              <button
                type="button"
                onClick={() => onShowGroupMemberProfile?.(m.senderId)}
                title={senderName}
              >
                <Avatar name={senderName || '?'} src={sender?.avatarPath || null} size={32} />
              </button>
            ) : null}
          </div>
        )}
        <div className={`max-w-[75%] ${showSenderHeader ? '' : ''}`}>
          {showSenderHeader && (
            <div className="text-[11px] text-slate-400 mb-0.5 ml-1">{senderName}</div>
          )}
          <div
            className={`px-3 py-2 text-sm whitespace-pre-wrap break-words rounded-2xl
              ${
                m.deleted
                  ? 'bg-bg-2 text-slate-500 italic'
                  : mine
                    ? 'bg-accent text-white'
                    : 'bg-bg-2 text-slate-100'
              }
            `}
            title={new Date(m.createdAt).toLocaleString()}
            onContextMenu={(e) => onMessageContext(e, m)}
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
              <>
                {/* Реакции на сообщение */}
                {m.reactions && m.reactions.length > 0 && (
                  <div
                    className={`flex flex-wrap gap-1.5 mt-1.5 ${mine ? 'justify-end' : 'justify-start'}`}
                  >
                    {m.reactions.map((r) => {
                      const Icon = REACTION_ICONS[r.emoji];
                      const hasReacted = r.users.includes(selfId);
                      return (
                        <button
                          key={r.emoji}
                          type="button"
                          onClick={() => onReactionClick?.(m.id, r.emoji, hasReacted)}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-sm border transition-colors ${
                            hasReacted
                              ? mine
                                ? 'bg-white/20 border-white/30 text-white'
                                : 'bg-accent/20 border-accent/30 text-accent'
                              : mine
                                ? 'bg-white/5 border-white/10 text-white/80 hover:bg-white/10'
                                : 'bg-bg-3 border-border text-slate-200 hover:bg-bg-2'
                          }`}
                          title={`${r.count} реакций`}
                        >
                          {Icon && <Icon size={16} />}
                          <span className="font-medium">{r.count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div
                  className={`text-[10px] mt-0.5 text-right flex items-center justify-end gap-1 ${
                    mine ? 'text-white/70' : 'text-slate-500'
                  }`}
                >
                  {m.editedAt && <span className="italic">изменено</span>}
                  <span>{formatTime(m.createdAt)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>,
    );
    lastSenderId = m.senderId;
  }
  return <>{out}</>;
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

export default memo(MessageList);
