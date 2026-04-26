import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import messageRoutes from './routes/messages.js';
import meRoutes from './routes/me.js';
import muteRoutes from './routes/mutes.js';
import groupRoutes from './routes/groups.js';
import inviteRoutes from './routes/invites.js';
import pushRoutes from './routes/push.js';
import { attachSocket } from './socket.js';
import { UPLOADS_DIR, MAX_UPLOAD_BYTES } from './uploads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Статика для загруженных файлов (аватары, голосовые).
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800'),
}));

// Отдаём ICE-серверы клиенту, чтобы секреты TURN не хранились во фронте.
app.get('/api/ice', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_PASSWORD || undefined,
    });
  }
  res.json({ iceServers });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/me', meRoutes);
app.use('/api/mutes', muteRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/push', pushRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Публичный конфиг клиента (лимиты, фичи).
app.get('/api/config', (_req, res) => res.json({
  maxUploadBytes: MAX_UPLOAD_BYTES,
}));

// Глобальный обработчик ошибок (multer/прочее) — возвращает JSON вместо HTML.
app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error('[api-error]', err?.message || err);
  const status = err?.status || err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  res.status(status).json({ error: err?.message || 'bad request' });
});

// В production раздаём собранный клиент с того же порта.
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const server = http.createServer(app);
attachSocket(server);

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => {
  console.log(`[owncord] listening on http://localhost:${PORT}`);
});
