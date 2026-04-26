import { Router } from 'express';
import fs from 'node:fs';
import db from '../db.js';
import { authRequired } from '../auth.js';
import { uploadVoice, uploadAttachment, publicPathFor, absolutePathFor } from '../uploads.js';
import { emitToPair, emitToGroup } from '../ioHub.js';

const router = Router();

function rowToMessage(row) {
  if (!row) return null;
  let payload = null;
  const raw = row.payload ?? row.payloadJson ?? null;
  if (raw) {
    try { payload = JSON.parse(raw); } catch { /* ignore */ }
  }
  return {
    id: row.id,
    senderId: row.sender_id ?? row.senderId,
    receiverId: row.receiver_id ?? row.receiverId ?? null,
    groupId: row.group_id ?? row.groupId ?? null,
    content: row.deleted ? '' : row.content || '',
    createdAt: row.created_at ?? row.createdAt,
    editedAt: row.edited_at ?? row.editedAt ?? null,
    deleted: !!(row.deleted ?? 0),
    kind: row.kind || 'text',
    attachmentPath: row.attachment_path ?? row.attachmentPath ?? null,
    durationMs: row.duration_ms ?? row.durationMs ?? null,
    attachmentName: row.attachment_name ?? row.attachmentName ?? null,
    attachmentSize: row.attachment_size ?? row.attachmentSize ?? null,
    attachmentMime: row.attachment_mime ?? row.attachmentMime ?? null,
    payload,
  };
}

const MSG_COLS = `id, sender_id, receiver_id, group_id, content, created_at, edited_at, deleted,
              kind, attachment_path, duration_ms, attachment_name, attachment_size, attachment_mime,
              payload`;

// Универсальный emit обновления сообщения — либо в пару, либо в группу
// (в зависимости от того, что у него установлено). Все участники подписаны
// на group:<id> комнату при connect / при добавлении в группу, поэтому
// дополнительно слать в персональные комнаты не нужно — это приводило бы
// к двойной доставке (сокет одновременно в group:<id> и user:<id>).
function emitMessage(event, row, payload) {
  if (row.group_id) {
    emitToGroup(row.group_id, event, payload);
  } else {
    emitToPair(row.sender_id, row.receiver_id, event, payload);
  }
}

function getMessage(id) {
  return db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id);
}

function canAccessRow(userId, row) {
  if (!row) return false;
  if (row.group_id) {
    return !!db
      .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(row.group_id, userId);
  }
  return row.sender_id === userId || row.receiver_id === userId;
}

// История переписки с конкретным пользователем.
router.get('/:peerId', authRequired, (req, res) => {
  const peerId = Number(req.params.peerId);
  if (!Number.isInteger(peerId)) return res.status(400).json({ error: 'bad peerId' });
  const me = req.user.id;
  const rows = db
    .prepare(
      `SELECT ${MSG_COLS}
       FROM messages
       WHERE (sender_id = ? AND receiver_id = ?)
          OR (sender_id = ? AND receiver_id = ?)
       ORDER BY created_at ASC
       LIMIT 500`,
    )
    .all(me, peerId, peerId, me);
  res.json({ messages: rows.map(rowToMessage) });
});

// Отправка голосового сообщения (multipart/form-data: file=voice, to=peerId, durationMs?).
router.post('/voice', authRequired, uploadVoice.single('voice'), (req, res) => {
  const to = Number(req.body.to);
  const durationMs = Number(req.body.durationMs) || null;
  if (!Number.isInteger(to)) return res.status(400).json({ error: 'bad to' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
  if (!peer) return res.status(404).json({ error: 'no such user' });

  const pubPath = publicPathFor(req.file.path);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages (sender_id, receiver_id, content, created_at, kind, attachment_path, duration_ms)
       VALUES (?, ?, '', ?, 'voice', ?, ?)`,
    )
    .run(req.user.id, to, now, pubPath, durationMs);

  const msg = rowToMessage(getMessage(info.lastInsertRowid));
  emitToPair(req.user.id, to, 'dm:new', msg);
  res.json({ ok: true, message: msg });
});

// Отправка вложения произвольного типа (multipart/form-data: file, to, content?).
router.post('/file', authRequired, uploadAttachment.single('file'), (req, res) => {
  const to = Number(req.body.to);
  if (!Number.isInteger(to)) return res.status(400).json({ error: 'bad to' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
  if (!peer) return res.status(404).json({ error: 'no such user' });

  const caption = typeof req.body.content === 'string' ? req.body.content.trim().slice(0, 4000) : '';
  const pubPath = publicPathFor(req.file.path);
  const mime = req.file.mimetype || 'application/octet-stream';
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO messages (
         sender_id, receiver_id, content, created_at, kind,
         attachment_path, attachment_name, attachment_size, attachment_mime
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.user.id, to, caption, now, kind,
      pubPath, req.file.originalname, req.file.size, mime,
    );

  const msg = rowToMessage(getMessage(info.lastInsertRowid));
  emitToPair(req.user.id, to, 'dm:new', msg);
  res.json({ ok: true, message: msg });
});

// Редактирование текстового сообщения (только своё, только text).
router.patch('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'bad content' });
  const trimmed = content.trim();
  if (!trimmed) return res.status(400).json({ error: 'empty' });
  if (trimmed.length > 4000) return res.status(400).json({ error: 'too long' });

  const row = getMessage(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'not your message' });
  if (row.deleted) return res.status(400).json({ error: 'deleted' });
  if (row.kind !== 'text') return res.status(400).json({ error: 'not editable' });

  const editedAt = Date.now();
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(trimmed, editedAt, id);

  const updated = rowToMessage(getMessage(id));
  emitMessage('dm:update', row, updated);
  res.json({ ok: true, message: updated });
});

// Удаление своего сообщения.
// Поведение зависит от настройки автора hide_on_delete:
//   - false (default): мягкое удаление, плашка "сообщение удалено" остаётся (dm:delete).
//   - true: жёсткое удаление, у обеих сторон сообщение полностью пропадает (dm:remove).
router.delete('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const row = getMessage(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'not your message' });
  if (row.deleted) return res.json({ ok: true, message: rowToMessage(row) });

  // Удалим файл, если есть
  if (row.attachment_path) {
    const abs = absolutePathFor(row.attachment_path);
    if (abs) fs.promises.unlink(abs).catch(() => { /* ignore */ });
  }

  const author = db
    .prepare('SELECT hide_on_delete FROM users WHERE id = ?')
    .get(req.user.id);
  const hardRemove = !!author?.hide_on_delete;

  if (hardRemove) {
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    emitMessage('dm:remove', row, {
      id, senderId: row.sender_id, receiverId: row.receiver_id, groupId: row.group_id,
    });
    return res.json({ ok: true, removed: true });
  }

  db.prepare(
    `UPDATE messages SET deleted = 1, content = '', attachment_path = NULL,
       duration_ms = NULL, attachment_name = NULL, attachment_size = NULL, attachment_mime = NULL
     WHERE id = ?`,
  ).run(id);

  const updated = rowToMessage(getMessage(id));
  emitMessage('dm:delete', row, {
    id, senderId: row.sender_id, receiverId: row.receiver_id, groupId: row.group_id,
  });
  res.json({ ok: true, message: updated });
});

export default router;
