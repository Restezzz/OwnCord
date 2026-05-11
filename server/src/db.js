import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Путь к файлу БД можно переопределить через переменную окружения
// (используется в тестах для изоляции). По умолчанию — server/data/owncord.sqlite.
const dbPath =
  process.env.OWNCORD_DB_FILE || path.resolve(__dirname, '..', 'data', 'owncord.sqlite');
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
// Отметка о прочтении сообщения получателем (для DM 1:1). NULL = ещё не прочитано.
// Используется UI клиента для рендера галочек: одна галка = доставлено сервером
// (есть запись в БД), две галки = прочитано (read_at != NULL). Для группы пока
// не используем — там было бы N статусов на каждого участника.
addColumn('messages', 'read_at', 'INTEGER');
// Пересылка сообщений: ссылка на оригинал, чтобы UI рисовал плашку
// «Переслано от X». Файлы/payload не дублируются — копируем ссылку
// attachment_path, тот же физический файл в /uploads/. forwarded_from_user_id
// FK с ON DELETE SET NULL: если автор оригинала удалит аккаунт, плашка
// останется, но имя автора не подставим (UI покажет «Удалённый пользователь»).
// forwarded_from_message_id и forwarded_from_created_at — без FK, потому что
// оригинальное сообщение могло быть удалено владельцем; нам важна только
// ссылка для отображения, а не каскадная целостность.
addColumn(
  'messages',
  'forwarded_from_user_id',
  'INTEGER REFERENCES users(id) ON DELETE SET NULL',
);
addColumn('messages', 'forwarded_from_message_id', 'INTEGER');
addColumn('messages', 'forwarded_from_created_at', 'INTEGER');
// Ответ на сообщение (reply). Ссылается на id оригинала в этом же чате.
// ON DELETE SET NULL: если оригинал жёстко удалили (hide_on_delete у автора),
// ссылка обнуляется, но текст ответа остаётся видимым. Soft-delete оригинала
// (deleted=1) на ссылку не влияет — UI покажет «удалённое сообщение» в
// плашке-цитате, что соответствует поведению Telegram.
addColumn('messages', 'reply_to_message_id', 'INTEGER REFERENCES messages(id) ON DELETE SET NULL');
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to_message_id);`);

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

// Миграция для обновления роли создателя до 'owner' если она ещё 'member'
const ownerRoleUpdate = db.prepare(`
  UPDATE group_members
  SET role = 'owner'
  WHERE role = 'member'
    AND group_id IN (SELECT id FROM groups WHERE owner_id = group_members.user_id)
`);
ownerRoleUpdate.run();
console.log('[db] Updated owner roles in group_members');

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

// Реакции на сообщения (heart, thumbs_up, thumbs_down, fire, poop и т.д.)
db.exec(`
  CREATE TABLE IF NOT EXISTS message_reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    UNIQUE(message_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions (message_id);
  CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions (user_id);
`);

// На старте процесса гасим висящие kind='groupcall' с status='active' —
// в памяти после рестарта сервера их состояние уже потеряно.
try {
  const stale = db.prepare(`SELECT id, payload FROM messages WHERE kind = 'groupcall'`).all();
  const upd = db.prepare('UPDATE messages SET payload = ? WHERE id = ?');
  for (const r of stale) {
    let p = {};
    try {
      p = JSON.parse(r.payload || '{}');
    } catch {
      /* */
    }
    if (p.status === 'active') {
      p.status = 'ended';
      p.endedAt = p.endedAt || Date.now();
      upd.run(JSON.stringify(p), r.id);
    }
  }
} catch {
  /* ignore */
}

export default db;
