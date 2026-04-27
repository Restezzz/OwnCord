import jwt from 'jsonwebtoken';
import db from './db.js';

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const TOKEN_TTL = '30d';

export function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'unauthorized' });

  // Аккаунт мог быть удалён уже после выдачи JWT — токен ещё валиден,
  // но дальнейшие запросы должны блокироваться.
  const row = db
    .prepare('SELECT deleted_at FROM users WHERE id = ?')
    .get(payload.id);
  if (!row || row.deleted_at) {
    return res.status(401).json({ error: 'account-deleted' });
  }

  req.user = payload;
  next();
}
