import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Путь к файлу БД можно переопределить через переменную окружения
// (используется в тестах для изоляции). По умолчанию — server/data/owncord.sqlite.
const dbPath = process.env.OWNCORD_DB_FILE || path.resolve(__dirname, '..', 'data', 'owncord.sqlite');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password   TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON messages (sender_id, receiver_id, created_at);
`);

// Идемпотентные миграции для уже существующих БД.
function hasColumn(table, col) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === col);
}

function addColumn(table, col, def) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

addColumn('users', 'display_name', 'TEXT');
addColumn('users', 'avatar_path', 'TEXT');
// Если включено — при удалении автором сообщения оно полностью исчезает
// у обеих сторон (вместо плашки "сообщение удалено").
addColumn('users', 'hide_on_delete', 'INTEGER NOT NULL DEFAULT 0');
// Soft-delete для аккаунта пользователя. Сообщения и история звонков
// остаются (история переписок не должна терять контекст), но логин
// блокируется, аватар стирается, имя подменяется на «Удалённый
// пользователь», и юзер пропадает из всех групп.
addColumn('users', 'deleted_at', 'INTEGER');
// Время, когда пользователь принял политику конфиденциальности
// (152-ФЗ). Заполняется только если на момент регистрации сервер
// требовал чекбокс согласия (`REQUIRE_PRIVACY_CONSENT=1`). NULL означает
// либо «модуль был выключен», либо аккаунт создан до его включения —
// для compliance-аудита достаточно различать «есть запись о согласии»
// vs «нет» по конкретному пользователю.
addColumn('users', 'privacy_consent_at', 'INTEGER');

addColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
addColumn('messages', 'attachment_path', 'TEXT');
addColumn('messages', 'duration_ms', 'INTEGER');
addColumn('messages', 'edited_at', 'INTEGER');
addColumn('messages', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
// Метаданные для прикреплённых файлов: оригинальное имя, размер, mime-тип.
addColumn('messages', 'attachment_name', 'TEXT');
addColumn('messages', 'attachment_size', 'INTEGER');
addColumn('messages', 'attachment_mime', 'TEXT');
// Дополнительные данные для системных сообщений (например, call_*) — JSON-строка.
addColumn('messages', 'payload', 'TEXT');

// Серверные мьюты (отключение уведомлений и звонков от конкретного юзера).
db.exec(`
  CREATE TABLE IF NOT EXISTS mutes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (user_id, target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mutes_user ON mutes (user_id);
`);

// Группы: один чат на несколько пользователей (до ~4 для звонков).
// owner_id — создатель, может редактировать имя/аватар/участников и удалять группу.
// group_members — участники. role = 'owner'|'member'.
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    avatar_path TEXT,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (group_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id);
`);

// Групповые сообщения: ссылка на групповой чат вместо receiver_id.
// Колонка добавляется после создания таблицы groups, чтобы FK имела смысл.
addColumn('messages', 'group_id', 'INTEGER REFERENCES groups(id) ON DELETE CASCADE');
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, created_at);`);

// Если БД была создана до введения групп, `receiver_id` имеет ограничение
// NOT NULL. Для групповых сообщений нужна возможность хранить NULL. SQLite
// не позволяет менять NOT NULL напрямую — пересоздаём таблицу.
function receiverIsNotNull() {
  const row = db
    .prepare('PRAGMA table_info(messages)')
    .all()
    .find((c) => c.name === 'receiver_id');
  return !!row && row.notnull === 1;
}

if (receiverIsNotNull()) {
  db.exec(`
    BEGIN;
    CREATE TABLE messages_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      group_id        INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      content         TEXT NOT NULL,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      edited_at       INTEGER,
      deleted         INTEGER NOT NULL DEFAULT 0,
      kind            TEXT NOT NULL DEFAULT 'text',
      attachment_path TEXT,
      duration_ms     INTEGER,
      attachment_name TEXT,
      attachment_size INTEGER,
      attachment_mime TEXT,
      payload         TEXT
    );
    INSERT INTO messages_new (id, sender_id, receiver_id, group_id, content,
      created_at, edited_at, deleted, kind, attachment_path, duration_ms,
      attachment_name, attachment_size, attachment_mime, payload)
    SELECT id, sender_id, receiver_id, group_id, content,
      created_at, edited_at, deleted, kind, attachment_path, duration_ms,
      attachment_name, attachment_size, attachment_mime, payload
    FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_new RENAME TO messages;
    CREATE INDEX idx_messages_pair ON messages (sender_id, receiver_id, created_at);
    CREATE INDEX idx_messages_group ON messages (group_id, created_at);
    COMMIT;
  `);
}

// Web Push подписки. Один пользователь может иметь несколько подписок
// (на разных устройствах/браузерах). Endpoint у Web Push уникален —
// используем как primary key.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    last_used  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id);
`);

// Одноразовые / multi-use инвайт-коды. Используются параллельно с общим
// REGISTRATION_CODE из .env: при регистрации сначала сверяемся с .env-кодом,
// если он не задан или не подошёл — пробуем найти запись в этой таблице.
// max_uses=NULL — без ограничения по числу использований.
// expires_at=NULL — без срока действия.
db.exec(`
  CREATE TABLE IF NOT EXISTS invite_codes (
    code        TEXT PRIMARY KEY COLLATE NOCASE,
    note        TEXT,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    max_uses    INTEGER,
    uses_count  INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER,
    revoked_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes (created_by);
`);

// На старте процесса гасим висящие kind='groupcall' с status='active' —
// в памяти после рестарта сервера их состояние уже потеряно.
try {
  const stale = db
    .prepare(`SELECT id, payload FROM messages WHERE kind = 'groupcall'`)
    .all();
  const upd = db.prepare('UPDATE messages SET payload = ? WHERE id = ?');
  for (const r of stale) {
    let p = {};
    try { p = JSON.parse(r.payload || '{}'); } catch { /* */ }
    if (p.status === 'active') {
      p.status = 'ended';
      p.endedAt = p.endedAt || Date.now();
      upd.run(JSON.stringify(p), r.id);
    }
  }
} catch { /* ignore */ }

export default db;
