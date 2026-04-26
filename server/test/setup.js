import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Изолированный файл БД для тестов и фиктивный JWT-секрет.
// Файл создаётся уникальным, чтобы тесты не пересекались.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owncord-test-'));
process.env.OWNCORD_DB_FILE = path.join(tmpDir, 'test.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(tmpDir, 'uploads');

// На случай, если код проверяет NODE_ENV
process.env.NODE_ENV = 'test';
