import { Router } from 'express';
import db from '../db.js';
import { authRequired } from '../auth.js';
import { getOnlineUserIds } from '../presence.js';

const router = Router();

function publicUser(row, online) {
  const deleted = !!row.deleted_at;
  return {
    id: row.id,
    // Для удалённых имя не светим — клиент сам подставит «Удалённый
    // пользователь». Username тоже зануляем, чтобы он нигде случайно
    // не отрисовался.
    username: deleted ? null : row.username,
    displayName: deleted ? null : (row.display_name || row.username),
    avatarPath: deleted ? null : (row.avatar_path || null),
    createdAt: row.created_at,
    online: deleted ? false : online,
    deleted,
  };
}

router.get('/', authRequired, (req, res) => {
  // Возвращаем всех, включая удалённых, чтобы фронт смог отрисовать
  // авторов исторических сообщений и контакты из старых DM. У удалённых
  // публичные поля занулены, флаг `deleted: true` — клиент сам решит,
  // показывать в списке для звонков/писем или нет.
  const rows = db
    .prepare(
      `SELECT id, username, display_name, avatar_path, created_at, deleted_at
       FROM users
        ORDER BY COALESCE(display_name, username) COLLATE NOCASE`,
    )
    .all();
  const online = getOnlineUserIds();
  const users = rows.map((u) => ({
    ...publicUser(u, online.has(u.id)),
    self: u.id === req.user.id,
  }));
  res.json({ users });
});

router.get('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const row = db
    .prepare(
      `SELECT id, username, display_name, avatar_path, created_at, deleted_at
       FROM users WHERE id = ?`,
    )
    .get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const online = getOnlineUserIds();
  res.json({ user: publicUser(row, online.has(row.id)) });
});

export default router;
