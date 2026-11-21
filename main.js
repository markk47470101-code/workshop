'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mcp = require('./mcp');
const { createOAuth } = require('./oauth');

// Для тестов: отдельная папка данных, чтобы не трогать реальные.
if (process.env.MARK_DESK_USER_DATA) {
  app.setPath('userData', process.env.MARK_DESK_USER_DATA);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[\w.\[\]-]{1,64}$/;
const MODES = new Set(['acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk', 'manual']);
const DEFAULTS = {
  cwd: '',
  model: '',
  permissionMode: 'acceptEdits',
  claudePath: '',
  isolateConfig: false,
  strictMcp: false,
  allowedConnectors: [],
};
const CONNECTOR_RE = /^claude\.ai [\w .@()+-]{1,80}$/;
// Как CLI называет инструменты сервера: mcp__<имя с заменой символов на _>__<инструмент>.
const connectorPrefix = (name) => 'mcp__' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');

let settings = { ...DEFAULTS };
let chats = [];
let win = null;
let activeRun = null;
let authProc = null;
let nextRunId = 1;
// OAuth для удалённых MCP-серверов; токены шифруются средствами системы (DPAPI/Keychain).
const oauth = createOAuth({
  dir: () => app.getPath('userData'),
  encrypt: (text) =>
    safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString('base64') : null,
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  // Для проверок без браузера адрес входа можно записать в файл.
  openUrl: async (url) => {
    if (process.env.MARK_DESK_OPEN_URL_FILE) fs.writeFileSync(process.env.MARK_DESK_OPEN_URL_FILE, url);
    else await shell.openExternal(url);
  },
});
const mcpStore = mcp.createStore(() => app.getPath('userData'), { getToken: (s) => oauth.token(s) });

// ───────────────────────── файлы и настройки ─────────────────────────

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
  if (!settings.cwd || !isDir(settings.cwd)) {
    settings.cwd = isDir(process.cwd()) ? process.cwd() : os.homedir();
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Не удалось сохранить настройки:', err.message);
  }
}

// ───────────────────────── собственная история ─────────────────────────
//
// Чаты хранятся только в папке данных приложения и не зависят ни от ~/.claude,
// ни от истории десктопного приложения Claude:
//   <userData>/history/index.json   — список чатов (заголовок, папка, id сессии CLI)
//   <userData>/history/<id>.jsonl   — события чата, по одному JSON на строку

const historyDir = () => path.join(app.getPath('userData'), 'history');
const indexFile = () => path.join(historyDir(), 'index.json');
const chatFile = (id) => path.join(historyDir(), id + '.jsonl');

function loadIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    chats = Array.isArray(parsed)
      ? parsed.filter((c) => c && UUID_RE.test(c.id || '') && typeof c.title === 'string')
      : [];
  } catch {
    chats = [];
  }
}

function saveIndex() {
  try {
    fs.mkdirSync(historyDir(), { recursive: true });
    const tmp = indexFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(chats));
    fs.renameSync(tmp, indexFile());
  } catch (err) {
    console.error('Не удалось сохранить историю:', err.message);
  }
}

const findChat = (id) => (typeof id === 'string' && UUID_RE.test(id) ? chats.find((c) => c.id === id) : null);

// Создаёт описание чата, но в список он попадёт только после успешного запуска CLI.
function newChat(text, cwd) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    sessionId: null,
    title: text.replace(/\s+/g, ' ').trim().slice(0, 90),
    cwd,
    createdAt: now,
    updatedAt: now,
  };
}

function appendChat(id, obj) {
  try {
    fs.mkdirSync(historyDir(), { recursive: true });
    fs.appendFileSync(chatFile(id), JSON.stringify(obj) + '\n');
  } catch (err) {
    console.error('Не удалось записать историю:', err.message);
  }
}

const clipText = (s, n) => {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '\n… (обрезано)' : s;
};

function slimResult(content) {
  if (typeof content === 'string') return clipText(content, 8000);
  if (Array.isArray(content)) {
    return content.map((b) =>
      b && b.type === 'text' ? { type: 'text', text: clipText(b.text, 8000) } : { type: 'text', text: '[вложение]' }
    );
  }
  return '';
}

function slimInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? clipText(v, 8000) : v;
  return JSON.stringify(out).length > 60000 ? { note: '(слишком большой вход, не сохранён)' } : out;
}

function slimBlock(b) {
  if (!b || typeof b !== 'object') return b;
  if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: slimInput(b.input) };
  if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking };
  return b;
}

// Сохраняет в историю только то, что нужно для повторного показа чата.
function persistEvent(run, ev) {
  const chat = findChat(run.chatId);
  if (!chat) return;

  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init' && UUID_RE.test(ev.session_id || '') && chat.sessionId !== ev.session_id) {
        chat.sessionId = ev.session_id;
        saveIndex();
      }
      break;
    case 'assistant': {
      const m = ev.message || {};
      if (ev.parent_tool_use_id || m.model === '<synthetic>') break;
      appendChat(chat.id, {
        type: 'assistant',
        message: {
          id: m.id,
          role: 'assistant',
          model: m.model,
          content: Array.isArray(m.content) ? m.content.map(slimBlock) : m.content,
        },
      });
      break;
    }
    case 'user': {
      const c = ev.message && ev.message.content;
      if (ev.parent_tool_use_id || !Array.isArray(c)) break;
      const blocks = c
        .filter((b) => b && b.type === 'tool_result')
        .map((b) => ({
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          is_error: !!b.is_error,
          content: slimResult(b.content),
        }));
      if (blocks.length) appendChat(chat.id, { type: 'user', message: { role: 'user', content: blocks } });
      break;
    }
    case 'result':
      chat.updatedAt = Date.now();
      if (!ev.is_error) {
        appendChat(chat.id, { type: 'result', duration_ms: ev.duration_ms });
      }
      saveIndex();
      break;
    default:
      break;
  }
}

async function loadChat(id) {
  const chat = findChat(id);
  if (!chat) return { ok: false, error: 'Чат не найден.' };
  try {
    const raw = await fsp.readFile(chatFile(chat.id), 'utf8');
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* повреждённая строка */ }
    }
    return { ok: true, cwd: chat.cwd, events: events.slice(-1500) };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, cwd: chat.cwd, events: [] };
    return { ok: false, error: err.message };
  }
}

// ───────────────────────── поиск Claude CLI ─────────────────────────

// CLI, который поставляется вместе с десктопным приложением Claude.
function findBundledClaude() {
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Claude-Data'));
  if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Claude'));
  }

  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'claude-code'));
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch { /* нет папки */ }
    for (const s of subs) if (s.isDirectory()) candidates.push(path.join(root, s.name, 'claude-code'));
  }

  let best = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === bin) {
        let m = 0;
        try { m = fs.statSync(p).mtimeMs; } catch { /* пропускаем */ }
        if (!best || m > best.m) best = { p, m };
      }
    }
  };
  candidates.forEach((c) => walk(c, 0));
  return best ? best.p : null;
}

function findClaude() {
  const forced = process.env.MARK_DESK_CLAUDE_PATH;
  if (forced && isFile(forced)) return forced;
  if (settings.claudePath && isFile(settings.claudePath)) return settings.claudePath;

  const win32 = process.platform === 'win32';
  const exts = win32 ? ['.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, 'claude' + ext);
      if (isFile(p)) return p;
    }
  }

  const home = os.homedir();
  const known = [
    path.join(home, '.local', 'bin', win32 ? 'claude.exe' : 'claude'),
    path.join(home, '.claude', 'local', win32 ? 'claude.exe' : 'claude'),
  ];
  if (win32 && process.env.APPDATA) known.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
  for (const p of known) if (isFile(p)) return p;

  return findBundledClaude();
}

// ───────────────────────── запуск процессов ─────────────────────────

function spawnClaude(args, options) {
  const exe = findClaude();
  if (!exe) {
    throw new Error('Claude CLI не найден. Укажите путь к нему в настройках (кнопка «Настройки» слева внизу).');
  }
  // .cmd/.bat на Windows нельзя запускать без shell. Аргументы у нас проверенные.
  if (/\.(cmd|bat)$/i.test(exe)) {
    // С shell:true Node склеивает аргументы пробелами, поэтому аргументы с пробелами берём в кавычки.
    const quote = (a) => (/[\s&|<>^()%!]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    return spawn(`"${exe}"`, args.map(quote), { ...options, shell: true });
  }
  return spawn(exe, args, options);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* уже завершён */ }
  } else {
    try { child.kill('SIGTERM'); } catch { /* уже завершён */ }
  }
}

function cliEnv() {
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  if (settings.isolateConfig) {
    // Отдельная конфигурация CLI: свой вход, свои настройки, свои файлы сессий.
    const dir = path.join(app.getPath('userData'), 'claude-config');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* создаст сам CLI */ }
    env.CLAUDE_CONFIG_DIR = dir;
  }
  return env;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function runClaudeOnce(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnClaude(args, { cwd: os.homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: cliEnv() });
    } catch (err) {
      resolve({ code: -1, out: '', err: err.message, noCli: true });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// Запускает один ход диалога. Бросает исключение, если CLI не удалось запустить.
function launch(chat, text, { model, permissionMode, resume }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Некому отвечать на запросы разрешений — всё, что требует вопроса, отклоняется,
    // а не зависает.
    '--permission-prompts', 'none',
  ];
  if (MODES.has(permissionMode)) args.push('--permission-mode', permissionMode);
  if (typeof model === 'string' && model && MODEL_RE.test(model)) args.push('--model', model);
  const resumeId = resume && UUID_RE.test(chat.sessionId || '') ? chat.sessionId : null;
  if (resumeId) args.push('--resume', resumeId);
  // MCP-серверы приложения. Эти флаги принимают списки значений, поэтому идут последними.
  const mcpRun = mcpStore.runArgs({
    permissionMode,
    strict: !!settings.strictMcp,
    extraAllow: (settings.allowedConnectors || []).map(connectorPrefix),
  });
  args.push(...mcpRun.args);

  const child = spawnClaude(args, {
    cwd: chat.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...cliEnv(), ...mcpRun.env },
  });

  const run = {
    id: nextRunId++,
    chatId: chat.id,
    child,
    buf: '',
    stderr: '',
    stopped: false,
    finished: false,
    resumed: !!resumeId,
    gotContent: false,
    heldResult: null,
    opts: { text, model, permissionMode },
  };
  activeRun = run;

  const deliver = (event) => {
    try { persistEvent(run, event); } catch (err) { console.error('persist:', err.message); }
    send('claude:event', { runId: run.id, event });
  };

  const handleLine = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { event = { type: 'raw', text: line }; }
    if (event.type === 'assistant' || event.type === 'stream_event') run.gotContent = true;
    // Ошибка возобновления сессии приходит как result до любого ответа. Придерживаем её:
    // если окажется, что сессия потеряна, мы тихо начнём диалог заново.
    if (run.resumed && !run.gotContent && event.type === 'result' && event.is_error) {
      run.heldResult = event;
      return;
    }
    deliver(event);
  };

  const finish = (info) => {
    if (run.finished) return;
    run.finished = true;
    const rest = run.buf.trim();
    if (rest) handleLine(rest);
    if (activeRun === run) activeRun = null;

    const sessionLost = run.resumed && !run.stopped && /no conversation found/i.test(run.stderr);
    if (sessionLost) {
      chat.sessionId = null;
      saveIndex();
      send('claude:event', {
        runId: run.id,
        event: {
          type: 'notice',
          kind: 'warn',
          text: 'Контекст этого чата в CLI недоступен (сессия удалена или создана в другой конфигурации). Продолжаю с чистого контекста — история на экране сохранена.',
        },
      });
      try {
        launch(chat, text, { model, permissionMode, resume: false });
        return;
      } catch (err) {
        info = { code: -1, error: err.message };
      }
    } else if (run.heldResult) {
      deliver(run.heldResult);
    }
    send('claude:done', { runId: run.id, stopped: run.stopped, stderr: run.stderr, ...info });
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    run.buf += chunk;
    let i;
    while ((i = run.buf.indexOf('\n')) >= 0) {
      const line = run.buf.slice(0, i).trim();
      run.buf = run.buf.slice(i + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (c) => { run.stderr = (run.stderr + c).slice(-8000); });
  child.on('error', (e) => finish({ code: -1, error: e.message }));
  child.on('close', (code, signal) => finish({ code, signal }));
  child.stdin.on('error', () => { /* процесс мог завершиться раньше */ });
  child.stdin.end(text);

  return run;
}

// ───────────────────────── IPC ─────────────────────────

const publicState = () => ({
  settings,
  claudePath: findClaude(),
  dataDir: app.getPath('userData'),
});

ipcMain.handle('app:init', () => ({ ...publicState(), platform: process.platform }));

ipcMain.handle('settings:set', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    if (typeof patch.cwd === 'string' && isDir(patch.cwd)) settings.cwd = patch.cwd;
    if (typeof patch.model === 'string' && (patch.model === '' || MODEL_RE.test(patch.model))) {
      settings.model = patch.model;
    }
    if (typeof patch.permissionMode === 'string' && MODES.has(patch.permissionMode)) {
      settings.permissionMode = patch.permissionMode;
    }
    if (typeof patch.claudePath === 'string' && (patch.claudePath === '' || isFile(patch.claudePath))) {
      settings.claudePath = patch.claudePath;
    }
    if (typeof patch.isolateConfig === 'boolean') settings.isolateConfig = patch.isolateConfig;
    if (typeof patch.strictMcp === 'boolean') settings.strictMcp = patch.strictMcp;
    if (Array.isArray(patch.allowedConnectors)) {
      settings.allowedConnectors = [...new Set(patch.allowedConnectors)]
        .filter((n) => typeof n === 'string' && CONNECTOR_RE.test(n))
        .slice(0, 50);
    }
  }
  saveSettings();
  return publicState();
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.cwd });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

ipcMain.handle('dialog:claude', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Claude CLI', extensions: ['exe', 'cmd'] }] : [],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

ipcMain.handle('shell:open', (_e, url) => {
  openExternalSafe(url);
});

ipcMain.handle('clipboard:write', (_e, text) => {
  if (typeof text === 'string') clipboard.writeText(text.slice(0, 1_000_000));
});

ipcMain.handle('sessions:list', () =>
  chats
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({ id: c.id, title: c.title, cwd: c.cwd, mtime: c.updatedAt }))
);

ipcMain.handle('sessions:load', (_e, id) => loadChat(id));

ipcMain.handle('sessions:delete', (_e, id) => {
  const chat = findChat(id);
  if (!chat || (activeRun && activeRun.chatId === chat.id)) return false;
  chats = chats.filter((c) => c.id !== chat.id);
  saveIndex();
  try { fs.unlinkSync(chatFile(chat.id)); } catch { /* файла могло не быть */ }
  return true;
});

ipcMain.handle('auth:status', async () => {
  const r = await runClaudeOnce(['auth', 'status']);
  return { loggedIn: r.code === 0, noCli: !!r.noCli, text: (r.out || r.err || '').trim() };
});

ipcMain.handle('auth:login', () => new Promise((resolve) => {
  if (authProc) { resolve({ ok: false, error: 'Вход уже выполняется.' }); return; }
  let child;
  try {
    // stdin открыт: CLI ждёт на нём код, который показывает страница входа.
    child = spawnClaude(['auth', 'login'], { cwd: os.homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv() });
  } catch (err) {
    resolve({ ok: false, error: err.message });
    return;
  }
  authProc = child;
  child.stdin.on('error', () => { /* процесс мог завершиться раньше */ });
  const forward = (d) => send('auth:log', String(d));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  const timer = setTimeout(() => killTree(child), 5 * 60 * 1000);
  child.on('error', (e) => { clearTimeout(timer); authProc = null; resolve({ ok: false, error: e.message }); });
  child.on('close', (code) => { clearTimeout(timer); authProc = null; resolve({ ok: code === 0, code }); });
}));

// Передаёт код со страницы входа в запущенный `claude auth login`. Сам код нигде не логируется.
ipcMain.handle('auth:code', (_e, code) => {
  if (!authProc || !authProc.stdin || authProc.stdin.destroyed) return false;
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c || c.length > 4000 || /[\r\n]/.test(c)) return false;
  try {
    authProc.stdin.write(c + '\n');
    return true;
  } catch {
    return false;
  }
});

// ───── MCP-серверы ─────

// Коннекторы аккаунта Claude (claude.ai) CLI подхватывает сам; `claude mcp list` показывает их статус.
function parseMcpList(out) {
  const res = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^(claude\.ai .+?):\s+(\S+)\s+-\s+(.*)$/);
    if (!m) continue;
    const raw = m[3].trim();
    let status = 'failed';
    if (/needs auth/i.test(raw)) status = 'needs-auth';
    else if (/connected/i.test(raw) && !/not connected|fail/i.test(raw)) status = 'connected';
    res.push({ name: m[1].trim(), url: m[2], status, raw });
  }
  return res;
}

ipcMain.handle('connectors:list', async () => {
  const r = await runClaudeOnce(['mcp', 'list'], 90000);
  if (r.noCli) return { ok: false, error: r.err };
  return { ok: true, connectors: parseMcpList(r.out) };
});

// К серверам с OAuth добавляем состояние входа (сами токены в окно не передаются).
const withAuth = (s) => (s.type !== 'stdio' && s.auth === 'oauth' ? { ...s, oauth: oauth.status(s) } : s);
const withAuthResult = (r) => (r && Array.isArray(r.servers) ? { ...r, servers: r.servers.map(withAuth) } : r);

ipcMain.handle('mcp:list', () => ({ servers: mcpStore.list().map(withAuth), strict: !!settings.strictMcp }));
ipcMain.handle('mcp:save', (_e, raw) => withAuthResult(mcpStore.upsert(raw)));
ipcMain.handle('mcp:delete', (_e, id) => {
  const s = mcpStore.get(String(id));
  if (s) oauth.logout(s.id);
  return mcpStore.remove(String(id)).map(withAuth);
});
ipcMain.handle('mcp:import', (_e, text) =>
  typeof text === 'string' && text.trim() && text.length < 200000
    ? withAuthResult(mcpStore.importJson(text))
    : { ok: false, error: 'Вставьте JSON с настройками серверов.' }
);
// Проверка по id сохранённого сервера или по черновику из формы.
ipcMain.handle('mcp:test', async (_e, arg) => {
  const v = typeof arg === 'string' ? { server: mcpStore.get(arg) } : mcp.validate(arg);
  if (v.error) return { ok: false, error: v.error };
  const server = v.server;
  const token = server && server.type !== 'stdio' && server.auth === 'oauth' ? await oauth.ensureFresh(server) : null;
  const result = await mcp.testServer(server, { token });
  // Для сохранённого сервера запоминаем список инструментов: по нему работает окно «Разрешения».
  if (typeof arg === 'string' && result.ok) mcpStore.setKnownTools(arg, result.tools);
  return result;
});

// Вход через OAuth: открывает браузер и ждёт подтверждения (до 5 минут).
ipcMain.handle('mcp:oauth-login', (_e, id) => {
  const s = mcpStore.get(String(id));
  if (!s || s.type === 'stdio' || s.auth !== 'oauth') return { ok: false, error: 'Для этого сервера OAuth не включён.' };
  return oauth.login(s);
});
ipcMain.handle('mcp:oauth-cancel', () => oauth.cancel());
ipcMain.handle('mcp:oauth-logout', (_e, id) => {
  oauth.logout(String(id), true);
  return true;
});

ipcMain.handle('auth:cancel', () => {
  if (!authProc) return false;
  killTree(authProc);
  return true;
});

ipcMain.handle('claude:send', async (_e, opts) => {
  if (activeRun) return { ok: false, error: 'Предыдущий запрос ещё выполняется.' };
  const { text, chatId, cwd, model, permissionMode } = opts || {};
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Пустое сообщение.' };

  let chat = findChat(chatId);
  const dir = chat ? chat.cwd : cwd;
  if (typeof dir !== 'string' || !isDir(dir)) return { ok: false, error: `Папка не найдена: ${dir}` };

  // Токены OAuth обновляем до запуска: CLI получит их через переменные окружения.
  await Promise.all(
    mcpStore.list()
      .filter((s) => s.enabled && s.type !== 'stdio' && s.auth === 'oauth')
      .map((s) => oauth.ensureFresh(s))
  );
  if (activeRun) return { ok: false, error: 'Предыдущий запрос ещё выполняется.' };

  const isNew = !chat;
  if (isNew) chat = newChat(text, dir);
  let run;
  try {
    run = launch(chat, text, { model, permissionMode, resume: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // События CLI приходят асинхронно, поэтому чат успевает попасть в список до первой записи.
  if (isNew) chats.push(chat);
  chat.updatedAt = Date.now();
  saveIndex();
  appendChat(chat.id, { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

  return { ok: true, runId: run.id, chatId: chat.id };
});

ipcMain.handle('claude:stop', () => {
  if (!activeRun) return false;
  activeRun.stopped = true;
  killTree(activeRun.child);
  return true;
});

// ───────────────────────── окно ─────────────────────────

function openExternalSafe(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.toString());
  } catch { /* некорректная ссылка */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    title: 'Mark Desk',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161513' : '#faf8f3',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Чтобы значок и группировка в панели задач Windows принадлежали приложению, а не electron.exe.
  if (process.platform === 'win32') app.setAppUserModelId('com.markdesk.app');

  app.whenReady().then(() => {
    loadSettings();
    loadIndex();
    mcpStore.load();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    if (activeRun) killTree(activeRun.child);
    if (authProc) killTree(authProc);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
