import 'dotenv/config';
import express from 'express';
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
import healthRoutes from './routes/health.js';
import { attachSocket } from './socket.js';
import { UPLOADS_DIR, MAX_UPLOAD_BYTES } from './uploads.js';
import { startRetention } from './retention.js';
import { buildCorsOptions, buildHelmet, apiLimiter, authLimiter, isProd } from './security.js';
import { privacyConfig, privacyHtml } from './privacy.js';
import cors from 'cors';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Доверяем X-Forwarded-* заголовкам, когда сервер стоит за nginx/cloudflare.
// Без этого express-rate-limit считает все запросы пришедшими с одного IP
// (loopback) и режет всё разом.
app.set('trust proxy', 1);
app.use(buildHelmet());
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '1mb' }));

// /api/health — настоящие проверки (БД + uploads + диск). См. routes/health.js.
// Регистрируем ДО apiLimiter, чтобы мониторинг (UptimeRobot и т.п.) мог
// пинговать его раз в минуту без риска получить 429.
app.use('/api/health', healthRoutes);

// Глобальный мягкий rate-limit на /api/* как защита от случайных циклов.
app.use('/api', apiLimiter());

// Статика для загруженных файлов (аватары, голосовые).
app.use(
  '/uploads',
  express.static(UPLOADS_DIR, {
    maxAge: '7d',
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800'),
  }),
);

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

// Жёсткий лимит на login/register — защита от перебора паролей
// и enumerate'а username'ов. Применяется только к POST.
app.use('/api/auth', authLimiter(), authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/me', meRoutes);
app.use('/api/mutes', muteRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/push', pushRoutes);

// Публичный конфиг клиента (лимиты, фичи).
app.get('/api/config', (_req, res) => {
  const pc = privacyConfig();
  res.json({
    maxUploadBytes: MAX_UPLOAD_BYTES,
    // Включён ли блок 152-ФЗ. Клиент использует это, чтобы:
    //   * показать ссылку «Политика конфиденциальности» на страницах входа/регистрации;
    //   * показать чекбокс согласия на регистрации (если requireConsent=true);
    //   * включить кнопку «Скачать мои данные» в настройках.
    privacy: {
      enabled: pc.enabled,
      requireConsent: pc.requireConsent,
    },
  });
});

// Страница политики обработки ПДн. Если оператор не задан в .env —
// 404 (фронт в этом случае ссылку и не покажет). Контент собирается из
// шаблона по ENV-переменным; для кастомного текста положи свой
// `/privacy` в nginx — он перехватит запрос до проксирования на node.
app.get('/privacy', (_req, res) => {
  const html = privacyHtml();
  if (!html)
    return res
      .status(404)
      .type('text/plain')
      .send('privacy policy is not configured on this server');
  res.type('text/html; charset=utf-8').send(html);
});

// Глобальный обработчик ошибок (multer/прочее) — возвращает JSON вместо HTML.
app.use((err, _req, res, _next) => {
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
const io = attachSocket(server);

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => {
  console.log(`[owncord] listening on http://localhost:${PORT}`);
});

// Фоновая чистка старых сообщений и файлов (см. RETENTION_DAYS в .env).
startRetention();

// --- Graceful shutdown -----------------------------------------------------
// SIGTERM (от systemd / docker stop) и SIGINT (Ctrl-C) — закрываем io,
// дожидаем активных HTTP-запросов, флашим SQLite и выходим. Без этого
// SIGTERM рвёт активные WS-соединения и может оставить недописанный WAL.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[owncord] ${signal} received, shutting down…`);
  // Принудительно отвалим клиентов через 8 сек, если кто-то завис на запросе.
  const killTimer = setTimeout(() => {
    console.warn('[owncord] forced exit after timeout');
    process.exit(1);
  }, 8000);
  // io.close() умеет дожидаться разъединения. server.close() ждёт keep-alive.
  Promise.allSettled([
    new Promise((resolve) => io.close(() => resolve())),
    new Promise((resolve) => server.close(() => resolve())),
  ]).finally(() => {
    try {
      db.close();
    } catch {
      /* */
    }
    clearTimeout(killTimer);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Если нужно явно проверить флаг production снаружи (например, тесты).
export { isProd };
