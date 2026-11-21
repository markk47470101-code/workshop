'use strict';

// MCP-серверы Mark Desk: хранение, проверка и конфигурация для CLI.
//
// Серверы лежат в <userData>/mcp.json и при каждом запуске CLI передаются ему через
// --mcp-config. Так список серверов приложения не зависит от настроек CLI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_RE = /^[A-Za-z0-9-]+$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['stdio', 'http', 'sse']);

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'mark-desk', version: '0.1.0' },
};

// ───────────────────────── проверка и нормализация ─────────────────────────

function cleanMap(map, keyRe) {
  const out = {};
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [k, v] of Object.entries(map)) {
      const key = String(k).trim();
      const value = String(v == null ? '' : v);
      if (keyRe.test(key) && !/[\r\n]/.test(value)) out[key] = value;
    }
  }
  return out;
}

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// Имена инструментов без повторов; некорректные строки отбрасываются.
function cleanToolNames(list) {
  const src = Array.isArray(list) ? list : [];
  return [...new Set(src.map((t) => String(t).trim()).filter((t) => TOOL_NAME_RE.test(t)))].slice(0, 100);
}

// Последний полученный от сервера список инструментов (нужен окну «Разрешения» без обращения к сети).
function cleanKnownTools(list) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name) || seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({
      name: t.name,
      description: String(t.description || '').slice(0, 200),
      readOnly: typeof t.readOnly === 'boolean' ? t.readOnly : null,
      destructive: typeof t.destructive === 'boolean' ? t.destructive : null,
    });
    if (out.length >= 100) break;
  }
  return out;
}

// Возвращает { server } или { error }.
function validate(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Некорректные данные сервера.' };

  const name = String(raw.name || '').trim();
  if (!NAME_RE.test(name)) {
    return { error: 'Имя: только латиница, цифры, «-» и «_», до 40 символов.' };
  }
  const type = TYPES.has(raw.type) ? raw.type : 'stdio';
  const server = {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : crypto.randomUUID(),
    name,
    type,
    enabled: raw.enabled !== false,
    autoApprove: raw.autoApprove !== false,
    // Инструменты, которые запрещены всегда, даже если сервер разрешён целиком.
    denyTools: cleanToolNames(raw.denyTools),
    // null — разрешён сервер целиком (кроме denyTools); массив — разрешены только перечисленные инструменты,
    // новые инструменты сервера по умолчанию недоступны.
    allowTools: Array.isArray(raw.allowTools) ? cleanToolNames(raw.allowTools) : null,
    knownTools: cleanKnownTools(raw.knownTools),
    auth: 'none',
  };

  if (type === 'stdio') {
    const command = String(raw.command || '').trim();
    if (!command) return { error: 'Укажите команду запуска.' };
    if (/[\r\n]/.test(command)) return { error: 'Команда не может содержать переводы строк.' };
    server.command = command;
    server.args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)).filter((a) => a !== '') : [];
    server.env = cleanMap(raw.env, ENV_KEY_RE);
  } else {
    let url;
    try { url = new URL(String(raw.url || '').trim()); } catch { return { error: 'Некорректный URL.' }; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: 'URL должен начинаться с http:// или https://.' };
    }
    server.url = url.toString();
    server.headers = cleanMap(raw.headers, HEADER_RE);
    // OAuth: вход через браузер; токен подставляется в Authorization при каждом запуске.
    if (raw.auth === 'oauth') {
      server.auth = 'oauth';
      server.oauthClientId = String(raw.oauthClientId || '').trim().slice(0, 200);
    }
  }
  return { server };
}

// Переменная окружения, через которую токен попадает в CLI (в файле конфигурации остаётся ${имя}).
const tokenEnvName = (server) => 'MARK_DESK_TOKEN_' + server.id.replace(/-/g, '').slice(0, 12).toUpperCase();

// На Windows команды без .exe (npx, npm, uvx, *.cmd) запускаются через cmd /c.
function effectiveCommand(server, platform = process.platform) {
  if (platform === 'win32' && !/\.exe$/i.test(server.command)) {
    return { command: 'cmd', args: ['/c', server.command, ...server.args] };
  }
  return { command: server.command, args: server.args };
}

function toCliConfig(server, platform, tokenEnv) {
  if (server.type === 'stdio') {
    const { command, args } = effectiveCommand(server, platform);
    const cfg = { type: 'stdio', command, args };
    if (Object.keys(server.env).length) cfg.env = server.env;
    return cfg;
  }
  const cfg = { type: server.type, url: server.url };
  const headers = { ...server.headers };
  if (tokenEnv) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
    headers.Authorization = 'Bearer ${' + tokenEnv + '}';
  }
  if (Object.keys(headers).length) cfg.headers = headers;
  return cfg;
}

// Разбирает JSON из документации серверов: { "mcpServers": { имя: {...} } } и похожие формы.
function parseImport(text) {
  let root;
  try { root = JSON.parse(String(text).replace(/^﻿/, '')); } catch (err) {
    return { error: 'Не удалось разобрать JSON: ' + err.message };
  }
  if (!root || typeof root !== 'object') return { error: 'Ожидается JSON-объект.' };

  let entries = null;
  const holder = root.mcpServers || root.servers;
  if (holder && typeof holder === 'object' && !Array.isArray(holder)) entries = Object.entries(holder);
  else if (Array.isArray(holder)) entries = holder.map((s) => [s && s.name, s]);
  else if (Object.values(root).every((v) => v && typeof v === 'object' && (v.command || v.url))) {
    entries = Object.entries(root);
  }
  if (!entries || !entries.length) return { error: 'В JSON не найдено ни одного сервера (ключ mcpServers).' };

  const servers = [];
  const skipped = [];
  for (const [rawName, cfg] of entries) {
    const name = String(rawName || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
    if (!name || !cfg || typeof cfg !== 'object') { skipped.push({ name: String(rawName), reason: 'нет настроек' }); continue; }
    let type = String(cfg.type || '').toLowerCase();
    if (type === 'streamable-http' || type === 'streamable_http') type = 'http';
    if (!TYPES.has(type)) type = cfg.url ? 'http' : 'stdio';
    const v = validate({
      name,
      type,
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
      url: cfg.url,
      headers: cfg.headers,
      enabled: cfg.disabled === true ? false : true,
    });
    if (v.error) skipped.push({ name, reason: v.error });
    else servers.push(v.server);
  }
  return { servers, skipped };
}

// ───────────────────────── хранилище ─────────────────────────

// getToken(server) → действующий OAuth-токен сервера или null.
function createStore(getDir, { getToken = () => null } = {}) {
  const file = () => path.join(getDir(), 'mcp.json');
  const runFile = () => path.join(getDir(), 'mcp-active.json');
  let servers = [];

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
      servers = (Array.isArray(parsed.servers) ? parsed.servers : [])
        .map((s) => validate(s).server)
        .filter(Boolean);
    } catch {
      servers = [];
    }
  }

  function save() {
    try {
      fs.mkdirSync(getDir(), { recursive: true });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ servers }, null, 2));
      fs.renameSync(tmp, file());
    } catch (err) {
      console.error('Не удалось сохранить MCP-серверы:', err.message);
    }
  }

  const list = () => servers.map((s) => ({ ...s }));
  const get = (id) => servers.find((s) => s.id === id) || null;

  function upsert(raw) {
    // Форма сервера не знает про разрешения по инструментам и список инструментов — не теряем их при правке.
    const prev = raw && typeof raw === 'object' ? servers.find((s) => s.id === raw.id) : null;
    const merged = prev
      ? {
          ...raw,
          allowTools: raw.allowTools === undefined ? prev.allowTools : raw.allowTools,
          knownTools: raw.knownTools === undefined ? prev.knownTools : raw.knownTools,
        }
      : raw;
    const v = validate(merged);
    if (v.error) return { ok: false, error: v.error };
    const dup = servers.find((s) => s.name.toLowerCase() === v.server.name.toLowerCase() && s.id !== v.server.id);
    if (dup) return { ok: false, error: 'Сервер с именем «' + v.server.name + '» уже есть.' };
    const i = servers.findIndex((s) => s.id === v.server.id);
    if (i >= 0) servers[i] = v.server;
    else servers.push(v.server);
    save();
    return { ok: true, server: v.server, servers: list() };
  }

  // Запоминает список инструментов, полученный при проверке соединения.
  function setKnownTools(id, tools) {
    const s = servers.find((x) => x.id === id);
    if (!s) return;
    s.knownTools = cleanKnownTools(tools);
    save();
  }

  function remove(id) {
    const before = servers.length;
    servers = servers.filter((s) => s.id !== id);
    if (servers.length !== before) save();
    return list();
  }

  function importJson(text) {
    const parsed = parseImport(text);
    if (parsed.error) return { ok: false, error: parsed.error };
    const added = [];
    const skipped = [...parsed.skipped];
    for (const s of parsed.servers) {
      if (servers.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) {
        skipped.push({ name: s.name, reason: 'сервер с таким именем уже есть' });
      } else {
        servers.push(s);
        added.push(s.name);
      }
    }
    if (added.length) save();
    return { ok: true, added, skipped, servers: list() };
  }

  // Аргументы CLI для запуска: конфигурация серверов и разрешения на их инструменты.
  // extraAllow — префиксы инструментов, разрешённых заранее (например, коннекторы аккаунта Claude).
  // Возвращает { args, env }: env содержит токены OAuth, которые CLI подставит вместо ${...} в заголовках.
  function runArgs({ permissionMode, strict, extraAllow = [] }) {
    const enabled = servers.filter((s) => s.enabled);
    const args = [];
    const env = {};

    if (enabled.length || strict) {
      const mcpServers = {};
      for (const s of enabled) {
        let tokenEnv = null;
        if (s.type !== 'stdio' && s.auth === 'oauth') {
          const token = getToken(s);
          if (token) {
            tokenEnv = tokenEnvName(s);
            env[tokenEnv] = token;
          }
        }
        mcpServers[s.name] = toCliConfig(s, undefined, tokenEnv);
      }
      try {
        fs.mkdirSync(getDir(), { recursive: true });
        fs.writeFileSync(runFile(), JSON.stringify({ mcpServers }, null, 2));
        args.push('--mcp-config', runFile());
        if (strict) args.push('--strict-mcp-config');
      } catch (err) {
        console.error('Не удалось записать конфигурацию MCP:', err.message);
      }
    }

    // Подтверждений в приложении нет, поэтому инструменты серверов разрешаются заранее —
    // но не в режиме «Только план», который обещает ничего не выполнять.
    if (permissionMode !== 'plan') {
      const allow = [];
      for (const s of enabled) {
        if (!s.autoApprove) continue;
        if (Array.isArray(s.allowTools)) allow.push(...s.allowTools.map((t) => 'mcp__' + s.name + '__' + t));
        else allow.push('mcp__' + s.name);
      }
      allow.push(...extraAllow);
      if (allow.length) args.push('--allowedTools', ...allow);
    }
    // Запреты действуют в любом режиме и сильнее разрешений.
    const deny = enabled.flatMap((s) => (s.denyTools || []).map((t) => 'mcp__' + s.name + '__' + t));
    if (deny.length) args.push('--disallowedTools', ...deny);
    return { args, env };
  }

  return { load, list, get, upsert, remove, importJson, runArgs, setKnownTools };
}

// ───────────────────────── проверка соединения ─────────────────────────

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* уже завершён */ }
  } else {
    try { child.kill('SIGTERM'); } catch { /* уже завершён */ }
  }
}

// Последние строки stderr сервера; вывод cmd.exe в чужой кодировке («кракозябры») пропускаем.
const tail = (s) =>
  s && s.trim() && !/�/.test(s) ? '\n' + s.trim().split(/\r?\n/).slice(-4).join('\n') : '';

// Есть ли такая команда: абсолютный путь или имя в PATH (на Windows — с учётом PATHEXT).
function commandExists(command, env = process.env) {
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const win = process.platform === 'win32';
  const exts = win ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const candidates = (base) => exts.map((e) => base + e);
  if (/[\\/]/.test(command)) return candidates(command).some(isFile);
  return (env.PATH || '').split(path.delimiter).filter(Boolean)
    .some((dir) => candidates(path.join(dir, command)).some(isFile));
}

// Подсказки сервера (annotations из спецификации MCP) помогают отличить чтение от изменения и удаления.
function normalizeTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => {
      const a = t.annotations && typeof t.annotations === 'object' ? t.annotations : {};
      return {
        name: t.name,
        description: String(t.description || '').slice(0, 200),
        readOnly: typeof a.readOnlyHint === 'boolean' ? a.readOnlyHint : null,
        destructive: typeof a.destructiveHint === 'boolean' ? a.destructiveHint : null,
      };
    });
}

function testStdio(server, timeoutMs) {
  return new Promise((resolve) => {
    // Проверяем сами, чтобы не получить невнятную ошибку от cmd /c.
    if (!commandExists(server.command, { ...process.env, ...server.env })) {
      resolve({ ok: false, error: 'Команда не найдена: ' + server.command + '. Проверьте имя или путь.' });
      return;
    }
    const { command, args } = effectiveCommand(server);
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...server.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    let buf = '';
    let stderr = '';
    let done = false;
    let serverInfo = null;
    let protocolVersion = null;
    let timer = null;

    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child);
      resolve(res);
    };
    timer = setTimeout(
      () => finish({ ok: false, error: 'Сервер не ответил за ' + Math.round(timeoutMs / 1000) + ' с.' + tail(stderr) }),
      timeoutMs
    );

    const write = (obj) => {
      try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* процесс закрылся */ }
    };

    child.on('error', (e) =>
      finish({ ok: false, error: e.code === 'ENOENT' ? 'Команда не найдена: ' + server.command : e.message })
    );
    child.on('close', (code) =>
      finish({ ok: false, error: 'Процесс завершился (код ' + code + ') до ответа.' + tail(stderr) })
    );
    child.stdin.on('error', () => { /* процесс закрылся */ });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { finish({ ok: false, error: 'initialize: ' + (msg.error.message || 'ошибка') }); return; }
          serverInfo = (msg.result && msg.result.serverInfo) || null;
          protocolVersion = (msg.result && msg.result.protocolVersion) || null;
          write({ jsonrpc: '2.0', method: 'notifications/initialized' });
          write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            finish({ ok: true, serverInfo, protocolVersion, tools: [], note: 'tools/list: ' + (msg.error.message || 'ошибка') });
          } else {
            finish({ ok: true, serverInfo, protocolVersion, tools: normalizeTools(msg.result && msg.result.tools) });
          }
          return;
        }
      }
    });

    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS });
  });
}

function parseRpc(text, contentType, id) {
  if (/text\/event-stream/i.test(contentType)) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (m.id === id) return m;
      } catch { /* не JSON */ }
    }
    throw new Error('Пустой ответ сервера.');
  }
  try {
    const m = JSON.parse(text);
    const msg = Array.isArray(m) ? m.find((x) => x && x.id === id) : m;
    if (msg) return msg;
  } catch { /* не JSON */ }
  throw new Error('Не удалось разобрать ответ сервера.');
}

async function testHttp(server, timeoutMs, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const baseHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...server.headers,
  };
  if (token) baseHeaders.Authorization = 'Bearer ' + token;
  let sessionId = null;
  let protocol = null;

  const rpc = async (body) => {
    const headers = { ...baseHeaders };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocol) headers['MCP-Protocol-Version'] = protocol;
    const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        server.auth === 'oauth'
          ? 'Нужен вход через OAuth — нажмите «Войти» у этого сервера.'
          : 'Сервер требует авторизацию (HTTP ' + res.status + '). Добавьте заголовок Authorization.'
      );
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (body.id === undefined) return null;
    return parseRpc(await res.text(), res.headers.get('content-type') || '', body.id);
  };

  try {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS });
    if (init.error) throw new Error('initialize: ' + (init.error.message || 'ошибка'));
    protocol = (init.result && init.result.protocolVersion) || null;
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const base = {
      ok: true,
      serverInfo: (init.result && init.result.serverInfo) || null,
      protocolVersion: protocol,
    };
    if (list.error) return { ...base, tools: [], note: 'tools/list: ' + (list.error.message || 'ошибка') };
    return { ...base, tools: normalizeTools(list.result && list.result.tools) };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'Сервер не ответил за ' + Math.round(timeoutMs / 1000) + ' с.' : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Быстрое рукопожатие без обращения к модели: initialize + tools/list.
function testServer(server, { token = null } = {}) {
  if (!server) return Promise.resolve({ ok: false, error: 'Сервер не найден.' });
  if (server.type === 'stdio') return testStdio(server, 40000);
  if (server.type === 'http') return testHttp(server, 15000, token);
  return Promise.resolve({
    ok: false,
    unsupported: true,
    error: 'Проверка SSE-серверов недоступна — статус появится после первого сообщения в чате.',
  });
}

module.exports = { createStore, validate, parseImport, effectiveCommand, toCliConfig, testServer };
