import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.resolve(__dirname, '..', 'uploads');

const avatarsDir = path.join(UPLOADS_DIR, 'avatars');
const voiceDir = path.join(UPLOADS_DIR, 'voice');
const filesDir = path.join(UPLOADS_DIR, 'files');

for (const d of [UPLOADS_DIR, avatarsDir, voiceDir, filesDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function extFromMime(mime) {
  if (!mime) return '';
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mpeg')) return '.mp3';
  return '';
}

// multer по RFC 7578 интерпретирует имя как latin1.
// Любые UTF-8 байты в `originalname` прилетают сюда побайтово как latin1,
// поэтому кириллица превращается в "Ð¾Ð±Ñ€Ð°Ð·" — нужно перекодировать обратно.
function fixUtf8(name) {
  if (!name) return name;
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function storage(subdir) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, subdir),
    filename: (_req, file, cb) => {
      // Чиним кодировку прямо в объекте: дальше его читают и messages.js,
      // и любой другой обработчик — все увидят корректное имя.
      file.originalname = fixUtf8(file.originalname);
      const ext = path.extname(file.originalname) || extFromMime(file.mimetype) || '.bin';
      const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext.toLowerCase()}`;
      cb(null, name);
    },
  });
}

export const uploadAvatar = multer({
  storage: storage(avatarsDir),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
  fileFilter: (_req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('only images'));
    cb(null, true);
  },
});

export const uploadVoice = multer({
  storage: storage(voiceDir),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB ≈ 15+ минут сжатого аудио
  fileFilter: (_req, file, cb) => {
    if (!/^audio\//.test(file.mimetype)) return cb(new Error('only audio'));
    cb(null, true);
  },
});

// Любой файл (фото/видео/документы). По умолчанию — 500 МБ,
// можно поднять/опустить через переменную окружения MAX_UPLOAD_MB
// (например, MAX_UPLOAD_MB=2048 = 2 ГБ).
// Имя на диске генерируется случайно, но оригинальное имя сохраняется в БД.
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 500);
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export const uploadAttachment = multer({
  storage: storage(filesDir),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

export function publicPathFor(absolutePath) {
  const rel = path.relative(UPLOADS_DIR, absolutePath).replace(/\\/g, '/');
  return `/uploads/${rel}`;
}

export function absolutePathFor(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return null;
  const rel = publicPath.slice('/uploads/'.length);
  // безопасность: не выходим за пределы UPLOADS_DIR
  const abs = path.resolve(UPLOADS_DIR, rel);
  if (!abs.startsWith(UPLOADS_DIR)) return null;
  return abs;
}
