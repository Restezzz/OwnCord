import fs from 'node:fs';
import db from './db.js';
import { absolutePathFor } from './uploads.js';

// История переписок и звонков хранится максимум RETENTION_DAYS дней.
// По умолчанию — 90. После истечения сообщения удаляются из БД и связанные
// файлы (голосовые, вложения) — с диска. Аватары и сами группы/пользователи
// не трогаем — они привязаны к актуальным аккаунтам, не к истории.
//
// Запускается раз в час из index.js. Дёшево: один SELECT по индексу
// `created_at`, плюс N unlink'ов. Транзакцию для DELETE не используем —
// сценарий идемпотентный, при падении сервера в следующий тик добьём.

const DEFAULT_DAYS = 90;
// Раз в час. Можно меняться через env, но реальной необходимости нет —
// точность ретеншна «до часа» более чем достаточно для 90-дневного окна.
const TICK_MS = 60 * 60 * 1000;

function retentionDays() {
  const v = Number(process.env.RETENTION_DAYS);
  if (Number.isFinite(v) && v > 0) return Math.floor(v);
  return DEFAULT_DAYS;
}

export function runRetentionOnce() {
  const days = retentionDays();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // Сначала собираем пути файлов, чтобы удалить их после успешного DELETE.
  const stale = db
    .prepare(`SELECT id, attachment_path FROM messages WHERE created_at < ?`)
    .all(cutoff);

  if (!stale.length) return { deleted: 0 };

  const ids = stale.map((r) => r.id);
  // Удаляем пачкой. SQLite ограничивает число параметров (по умолчанию 999),
  // на всякий случай чанкуем.
  const CHUNK = 500;
  let removed = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const info = db
      .prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
      .run(...chunk);
    removed += info.changes;
  }

  // Файлы — best-effort, не валим процесс при I/O ошибках.
  for (const r of stale) {
    if (!r.attachment_path) continue;
    const abs = absolutePathFor(r.attachment_path);
    if (!abs) continue;
    fs.promises.unlink(abs).catch(() => { /* ignore */ });
  }

  return { deleted: removed, days };
}

let timer = null;
export function startRetention() {
  // В тестах — не запускаем планировщик, чтобы не «жил» процесс.
  if (process.env.NODE_ENV === 'test') return;
  // Один прогон сразу при старте (на случай простоя).
  try {
    const r = runRetentionOnce();
    if (r.deleted) {
      // eslint-disable-next-line no-console
      console.log(`[retention] startup sweep: removed ${r.deleted} messages older than ${r.days} days`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[retention] startup sweep failed:', e?.message || e);
  }
  if (timer) return;
  timer = setInterval(() => {
    try {
      const r = runRetentionOnce();
      if (r.deleted) {
        // eslint-disable-next-line no-console
        console.log(`[retention] removed ${r.deleted} messages older than ${r.days} days`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[retention] sweep failed:', e?.message || e);
    }
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopRetention() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
