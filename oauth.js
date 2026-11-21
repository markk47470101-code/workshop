'use strict';

// OAuth 2.1 для удалённых MCP-серверов: обнаружение настроек (RFC 9728 и RFC 8414),
// автоматическая регистрация клиента (RFC 7591), код авторизации с PKCE и обратным вызовом на
// 127.0.0.1 (RFC 8252), обновление токена. Токены хранятся зашифрованными (safeStorage).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENT_NAME = 'Mark Desk';
const PREFERRED_PORT = 53682; // постоянный порт позволяет переиспользовать регистрацию клиента
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const trimSlash = (s) => String(s).replace(/\/+$/, '');
const unique = (list) => [...new Set(list)];

function isLoopbackHost(h) {
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

// Все адреса из метаданных должны быть https (loopback допускаем для проверки без сети).
function safeUrl(value, what) {
  let u;
  try { u = new URL(String(value)); } catch { throw new Error('Некорректный адрес ' + what + '.'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
    throw new Error('Адрес ' + what + ' должен начинаться с https://.');
  }
  return u;
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: res.status, ok: res.ok, headers: res.headers, text, json };
  } catch (err) {
    const host = new URL(url).host;
    throw new Error(
      err.name === 'AbortError'
        ? 'Сервер не ответил вовремя: ' + host
        : 'Нет соединения с ' + host + ': ' + ((err.cause && err.cause.code) || err.message)
    );
  } finally {
    clearTimeout(timer);
  }
}

function oauthError(prefix, status, json) {
  const e = json && typeof json === 'object' ? json : {};
  const detail = e.error
    ? e.error + (e.error_description ? ' — ' + e.error_description : '')
    : 'HTTP ' + status;
  const err = new Error(prefix + ': ' + detail);
  err.code = e.error || null;
  return err;
}

// ───────────────────────── обнаружение настроек ─────────────────────────

async function discover(mcpUrl) {
  const u = safeUrl(mcpUrl, 'MCP-сервера');
  const origin = u.origin;
  const p = u.pathname === '/' ? '' : trimSlash(u.pathname);

  // 1. Запрос без токена: сервер должен ответить 401 и подсказать, где метаданные.
  let prmHint = null;
  let scopeHint = null;
  try {
    const probe = await request(u.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mark-desk', version: '0.1.0' } },
      }),
      timeoutMs: 15000,
    });
    if (probe.status === 401) {
      const h = probe.headers.get('www-authenticate') || '';
      const m = h.match(/resource_metadata="([^"]+)"/i);
      const s = h.match(/scope="([^"]+)"/i);
      if (m) prmHint = m[1];
      if (s) scopeHint = s[1];
    } else if (probe.ok) {
      throw new Error('Сервер отвечает без авторизации — вход через OAuth не нужен.');
    }
  } catch (err) {
    if (/без авторизации/.test(err.message)) throw err;
    // иначе пробуем стандартные адреса метаданных ниже
  }

  // 2. Метаданные защищённого ресурса: какой сервер авторизации ему доверяет.
  const prmCandidates = unique([
    prmHint,
    `${origin}/.well-known/oauth-protected-resource${p}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean));
  let prm = null;
  for (const c of prmCandidates) {
    try {
      const r = await request(safeUrl(c, 'метаданных ресурса').toString());
      if (r.ok && r.json && typeof r.json === 'object') { prm = r.json; break; }
    } catch { /* пробуем следующий адрес */ }
  }
  if (prm && prm.resource) {
    let same = false;
    try { same = new URL(prm.resource).origin === origin; } catch { /* неверный resource */ }
    if (!same) throw new Error('Метаданные OAuth относятся к другому ресурсу — вход остановлен.');
  }

  let issuer = origin;
  if (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers.length) {
    issuer = trimSlash(prm.authorization_servers[0]);
  }

  // 3. Метаданные сервера авторизации (RFC 8414 с вставкой пути, затем OpenID Connect).
  const iu = safeUrl(issuer, 'сервера авторизации');
  const ip = iu.pathname === '/' ? '' : trimSlash(iu.pathname);
  const candidates = ip
    ? [
        `${iu.origin}/.well-known/oauth-authorization-server${ip}`,
        `${iu.origin}/.well-known/openid-configuration${ip}`,
        `${iu.origin}${ip}/.well-known/openid-configuration`,
      ]
    : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`];
  if (!prm) candidates.push(`${origin}/.well-known/oauth-authorization-server`);

  let meta = null;
  for (const c of candidates) {
    try {
      const r = await request(safeUrl(c, 'метаданных авторизации').toString());
      if (r.ok && r.json && r.json.authorization_endpoint && r.json.token_endpoint) { meta = r.json; break; }
    } catch { /* пробуем следующий адрес */ }
  }
  if (!meta) throw new Error('Не удалось найти настройки OAuth у сервера авторизации (' + iu.host + ').');
  if (prm && meta.issuer && trimSlash(meta.issuer) !== issuer) {
    throw new Error('Сервер авторизации вернул чужие метаданные (issuer не совпадает).');
  }
  if (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes('S256')) {
    throw new Error('Сервер авторизации не поддерживает PKCE (S256).');
  }

  const issParamSupported = meta.authorization_response_iss_parameter_supported === true;
  const scope =
    scopeHint ||
    (prm && Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(' ') : '') ||
    '';
  return {
    issuer,
    authorizationEndpoint: safeUrl(meta.authorization_endpoint, 'авторизации').toString(),
    tokenEndpoint: safeUrl(meta.token_endpoint, 'выдачи токенов').toString(),
    registrationEndpoint: meta.registration_endpoint
      ? safeUrl(meta.registration_endpoint, 'регистрации клиента').toString()
      : null,
    // RFC 9207: сервер сообщает в ответе браузера свой issuer, чтобы клиент не принял чужой ответ.
    issParamSupported,
    scope,
  };
}

// ───────────────────────── приём ответа браузера ─────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function resultPage(res, status, title, text) {
  const html =
    '<!doctype html><meta charset="utf-8"><title>Mark Desk</title>' +
    '<style>body{font:16px/1.6 system-ui,sans-serif;background:#161513;color:#ece8df;display:grid;place-items:center;height:100vh;margin:0}' +
    'main{max-width:30em;padding:2em;text-align:center}h1{font-size:1.4em;margin:0 0 .5em}p{color:#b8b2a5;margin:0}</style>' +
    '<main><h1>' + esc(title) + '</h1><p>' + esc(text) + '</p></main>';
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function startCallbackServer() {
  return new Promise((resolve, reject) => {
    const waiter = { state: null, resolve: null, reject: null };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const q = url.searchParams;
      if (!waiter.state || q.get('state') !== waiter.state) {
        resultPage(res, 400, 'Неверный запрос', 'Параметр state не совпал. Вернитесь в Mark Desk и начните вход заново.');
        return;
      }
      if (q.get('error')) {
        const msg = q.get('error') + (q.get('error_description') ? ': ' + q.get('error_description') : '');
        resultPage(res, 200, 'Вход не выполнен', msg);
        waiter.reject(new Error('Вход отклонён: ' + msg));
        return;
      }
      const code = q.get('code');
      if (!code) { resultPage(res, 400, 'Неверный запрос', 'В ответе нет кода авторизации.'); return; }
      resultPage(res, 200, 'Готово', 'Вход выполнен. Эту вкладку можно закрыть и вернуться в Mark Desk.');
      waiter.resolve({ code, iss: q.get('iss') });
    });

    const listen = (port) =>
      new Promise((ok, fail) => {
        const onError = (e) => { server.off('listening', onListening); fail(e); };
        const onListening = () => { server.off('error', onError); ok(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });

    listen(PREFERRED_PORT)
      .catch(() => listen(0))
      .then(() => {
        const port = server.address().port;
        resolve({
          port,
          redirectUri: `http://127.0.0.1:${port}/callback`,
          // Ждём код с нужным state; по таймауту или отмене промис отклоняется.
          expect(state, timeoutMs) {
            return new Promise((ok, fail) => {
              const timer = setTimeout(() => fail(new Error('Время ожидания входа истекло. Попробуйте ещё раз.')), timeoutMs);
              waiter.state = state;
              waiter.resolve = (result) => { clearTimeout(timer); ok(result); };
              waiter.reject = (err) => { clearTimeout(timer); fail(err); };
            });
          },
          abort(err) { if (waiter.reject) waiter.reject(err); },
          close() { try { server.close(); server.closeAllConnections(); } catch { /* уже закрыт */ } },
        });
      })
      .catch(reject);
  });
}

// ───────────────────────── токены ─────────────────────────

async function tokenRequest(endpoint, params, clientSecret) {
  const body = new URLSearchParams(params);
  if (clientSecret) body.set('client_secret', clientSecret);
  const r = await request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!r.ok || !r.json || !r.json.access_token) throw oauthError('Сервер не выдал токен', r.status, r.json);
  if (r.json.token_type && String(r.json.token_type).toLowerCase() !== 'bearer') {
    throw new Error('Сервер выдал токен неподдерживаемого типа: ' + r.json.token_type);
  }
  return r.json;
}

function recordFromToken(tok, prev) {
  const now = Date.now();
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || (prev && prev.refreshToken) || null,
    obtainedAt: now,
    expiresAt: tok.expires_in ? now + Number(tok.expires_in) * 1000 : null,
    scope: tok.scope || (prev && prev.scope) || '',
  };
}

// encrypt(text) → base64 или null, если шифрование недоступно; decrypt(base64) → text.
function createOAuth({ dir, encrypt, decrypt, openUrl }) {
  const file = () => path.join(dir(), 'mcp-oauth.json');
  let records = null;
  let pending = null;
  const refreshing = new Map();

  function load() {
    if (records) return;
    records = {};
    try {
      const w = JSON.parse(fs.readFileSync(file(), 'utf8'));
      const text = w.enc === 'safe' ? decrypt(w.data) : Buffer.from(w.data, 'base64').toString('utf8');
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') records = obj;
    } catch { /* файла нет или он не читается */ }
  }

  function save() {
    try {
      const text = JSON.stringify(records);
      const enc = encrypt ? encrypt(text) : null;
      const wrapper = enc
        ? { v: 1, enc: 'safe', data: enc }
        : { v: 1, enc: 'plain', data: Buffer.from(text, 'utf8').toString('base64') };
      fs.mkdirSync(dir(), { recursive: true });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(wrapper));
      fs.renameSync(tmp, file());
    } catch (err) {
      console.error('Не удалось сохранить токены MCP:', err.message);
    }
  }

  const recordFor = (server) => {
    load();
    const rec = records[server.id];
    return rec && rec.serverUrl === server.url ? rec : null;
  };

  // Запас до истечения: 10 % срока жизни, но не больше минуты.
  const skew = (rec) => Math.min(60000, Math.max(500, ((rec.expiresAt || 0) - (rec.obtainedAt || 0)) * 0.1));
  const needsRefresh = (rec) => rec.expiresAt && rec.expiresAt - skew(rec) <= Date.now();

  function status(server) {
    const rec = recordFor(server);
    if (!rec || !rec.accessToken) return { state: rec && rec.lastError ? 'expired' : 'none' };
    if (rec.expiresAt && rec.expiresAt <= Date.now() && !rec.refreshToken) return { state: 'expired' };
    return { state: 'ok', expiresAt: rec.expiresAt || null, canRefresh: !!rec.refreshToken };
  }

  // Текущий токен без сетевых запросов (если он ещё действует).
  function token(server) {
    const rec = recordFor(server);
    if (!rec || !rec.accessToken) return null;
    if (rec.expiresAt && rec.expiresAt <= Date.now()) return null;
    return rec.accessToken;
  }

  // Возвращает действующий токен, при необходимости обновляя его.
  async function ensureFresh(server) {
    const rec = recordFor(server);
    if (!rec || !rec.accessToken) return null;
    if (!needsRefresh(rec)) return rec.accessToken;
    if (!rec.refreshToken || !rec.tokenEndpoint || !rec.client) return token(server);

    if (!refreshing.has(server.id)) {
      const job = (async () => {
        try {
          const tok = await tokenRequest(
            rec.tokenEndpoint,
            {
              grant_type: 'refresh_token',
              refresh_token: rec.refreshToken,
              client_id: rec.client.clientId,
              resource: server.url,
            },
            rec.client.clientSecret
          );
          Object.assign(rec, recordFromToken(tok, rec), { lastError: null });
          save();
        } catch (err) {
          // Обновление отклонено — нужен новый вход; сетевые сбои токен не стирают.
          if (err.code === 'invalid_grant' || err.code === 'invalid_token' || err.code === 'unauthorized_client') {
            rec.accessToken = null;
            rec.refreshToken = null;
            rec.lastError = err.message;
            save();
          }
        } finally {
          refreshing.delete(server.id);
        }
      })();
      refreshing.set(server.id, job);
    }
    await refreshing.get(server.id);
    return token(server);
  }

  async function registerClient(server, d, redirectUri) {
    if (server.oauthClientId) return { clientId: server.oauthClientId, issuer: d.issuer, redirectUri, manual: true };
    load();
    const prev = records[server.id];
    if (
      prev && prev.serverUrl === server.url && prev.client && prev.client.clientId &&
      prev.client.issuer === d.issuer && prev.client.redirectUri === redirectUri
    ) {
      return prev.client;
    }
    if (!d.registrationEndpoint) {
      throw new Error('Сервер не умеет регистрировать клиентов сам. Укажите OAuth Client ID в настройках сервера.');
    }
    const payload = {
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    if (d.scope) payload.scope = d.scope;
    const r = await request(d.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!(r.status === 200 || r.status === 201) || !r.json || !r.json.client_id) {
      throw oauthError('Сервер не зарегистрировал приложение', r.status, r.json);
    }
    const client = {
      clientId: String(r.json.client_id),
      clientSecret: r.json.client_secret ? String(r.json.client_secret) : null,
      issuer: d.issuer,
      redirectUri,
    };
    records[server.id] = { ...(prev && prev.serverUrl === server.url ? prev : {}), serverUrl: server.url, client };
    save();
    return client;
  }

  // Полный вход: браузер → код → токены. Возвращает { ok } или { ok: false, error }.
  async function login(server) {
    if (pending) return { ok: false, error: 'Вход уже выполняется.' };
    const flow = { cancelled: false, cb: null };
    pending = flow;
    try {
      const d = await discover(server.url);
      if (flow.cancelled) throw new Error('Вход отменён.');
      const cb = await startCallbackServer();
      flow.cb = cb;
      try {
        if (flow.cancelled) throw new Error('Вход отменён.');
        const client = await registerClient(server, d, cb.redirectUri);

        const verifier = b64url(crypto.randomBytes(48));
        const state = b64url(crypto.randomBytes(24));
        const auth = new URL(d.authorizationEndpoint);
        auth.searchParams.set('response_type', 'code');
        auth.searchParams.set('client_id', client.clientId);
        auth.searchParams.set('redirect_uri', cb.redirectUri);
        auth.searchParams.set('code_challenge', b64url(sha256(verifier)));
        auth.searchParams.set('code_challenge_method', 'S256');
        auth.searchParams.set('state', state);
        auth.searchParams.set('resource', server.url);
        if (d.scope) auth.searchParams.set('scope', d.scope);

        const waitForCode = cb.expect(state, LOGIN_TIMEOUT_MS);
        waitForCode.catch(() => { /* ошибка обрабатывается ниже */ });
        if (flow.cancelled) cb.abort(new Error('Вход отменён.'));
        await openUrl(auth.toString());
        const { code, iss } = await waitForCode;

        // RFC 9207: если сервер вернул iss, он обязан совпасть; если заявил о поддержке — обязан вернуть.
        if (iss != null && trimSlash(iss) !== d.issuer) {
          throw new Error('Ответ пришёл не от того сервера авторизации (iss не совпал) — вход остановлен.');
        }
        if (iss == null && d.issParamSupported) {
          throw new Error('Сервер авторизации не вернул параметр iss, хотя заявляет о его поддержке — вход остановлен.');
        }

        const tok = await tokenRequest(
          d.tokenEndpoint,
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: cb.redirectUri,
            client_id: client.clientId,
            code_verifier: verifier,
            resource: server.url,
          },
          client.clientSecret
        );
        load();
        records[server.id] = {
          serverUrl: server.url,
          client,
          tokenEndpoint: d.tokenEndpoint,
          ...recordFromToken(tok, null),
          lastError: null,
        };
        save();
        return { ok: true };
      } finally {
        cb.close();
      }
    } catch (err) {
      return { ok: false, error: flow.cancelled ? 'Вход отменён.' : err.message };
    } finally {
      pending = null;
    }
  }

  function cancel() {
    if (!pending) return false;
    pending.cancelled = true;
    if (pending.cb) pending.cb.abort(new Error('Вход отменён.'));
    return true;
  }

  // keepClient: сохранить регистрацию приложения на сервере, стереть только токены.
  function logout(id, keepClient = false) {
    load();
    const rec = records[id];
    if (!rec) return;
    if (keepClient && rec.client) records[id] = { serverUrl: rec.serverUrl, client: rec.client };
    else delete records[id];
    save();
  }

  return { status, token, ensureFresh, login, cancel, logout };
}

module.exports = { createOAuth, discover };
