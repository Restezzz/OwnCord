import { Router } from 'express';
import db from '../db.js';
import { authRequired } from '../auth.js';
import { getOnlineUserIds } from '../presence.js';

const router = Router();

function publicUser(row, online) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatarPath: row.avatar_path || null,
    createdAt: row.created_at,
    online,
  };
}

router.get('/', authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, username, display_name, avatar_path, created_at
       FROM users ORDER BY COALESCE(display_name, username) COLLATE NOCASE`,
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
      `SELECT id, username, display_name, avatar_path, created_at
       FROM users WHERE id = ?`,
    )
    .get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const online = getOnlineUserIds();
  res.json({ user: publicUser(row, online.has(row.id)) });
});

export default router;
