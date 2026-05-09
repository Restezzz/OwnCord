// Конфиг десктоп-приложения. Хранится в userData/owncord.config.json:
//   - serverUrl     — куда грузим клиент (http://host:port или https://...)
//   - autoStart     — стартовать ли вместе с ОС (заходит в логин-айтемы).
//   - hotkeysEnabled — мастер-выключатель глобальных хоткеев.
//
// Зачем не localStorage клиента: serverUrl нужен ДО того, как мы загрузили
// клиент (иначе непонятно куда грузить), и хоткеи регистрируются в main-
// процессе, у которого нет доступа к renderer'овскому localStorage.
//
// Файл создаётся при первом запуске. Если parse падает — берём дефолты;
// записываем атомарно (write-rename), чтобы не получить полусохранённый
// JSON при крэше.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // Прод-инстанс по умолчанию. Для локальной разработки можно
  // переопределить через env: `OWNCORD_SERVER_URL=http://localhost:5173 ...`.
  // Юзер также может изменить адрес в UI («Настройки → Сервер»), и значение
  // сохранится в этот файл.
  serverUrl: process.env.OWNCORD_SERVER_URL || 'https://owncord.patgen.ru',
  autoStart: false,
  hotkeysEnabled: true,
  // Сериализованные биндинги. Главное — main-процесс перерегистрирует
  // shortcut'ы при изменении этого поля. Renderer заполняет его через
  // electronAPI.setShortcuts.
  shortcuts: {
    // 'toggleMute' | 'toggleDeafen' — accelerator-строка Electron'а
    // (https://electronjs.org/docs/latest/api/accelerator) или null.
    toggleMute: null,
    toggleDeafen: null,
  },
};

function configPath() {
  return path.join(app.getPath('userData'), 'owncord.config.json');
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      shortcuts: { ...DEFAULTS.shortcuts, ...(parsed?.shortcuts || {}) },
    };
  } catch {
    return { ...DEFAULTS, shortcuts: { ...DEFAULTS.shortcuts } };
  }
}

function save(cfg) {
  const file = configPath();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    // rename atomically — иначе при крэше получим полупустой JSON.
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

module.exports = { load, save, DEFAULTS, configPath };
