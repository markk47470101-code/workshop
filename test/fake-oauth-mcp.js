#!/usr/bin/env node
'use strict';

// Поддельный MCP-сервер с OAuth 2.1 для проверки входа: обнаружение настроек, регистрация клиента,
// код авторизации с PKCE, обновление токена. Печатает {"port":N} и слушает 127.0.0.1.
// EXPIRES_IN — срок жизни токена в секундах (по умолчанию 3600).

const http = require('http');
const crypto = require('crypto');

const EXPIRES_IN = Number(process.env.EXPIRES_IN || 3600);
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const clients = new Map(); // client_id -> redirect_uris
const codes = new Map(); // code -> { challenge, redirectUri, clientId }
const accessTokens = new Map(); // token -> expiresAt
const refreshTokens = new Set();
let counter = 0;
let lastAccessToken = null;
const stats = {
  registrations: 0,
  authorize: 0,
  token: { authorization_code: 0, refresh_token: 0 },
  mcp401: 0,
  mcpOk: 0,
  lastAuthorizeQuery: null,
  lastRegistration: null,
};

const TOOLS = [
  { name: 'echo', description: 'Возвращает текст' },
  { name: 'add', description: 'Складывает числа' },
];

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}

function issue(res) {
  const access = 'at-' + ++counter;
  const refresh = 'rt-' + counter;
  accessTokens.set(access, Date.now() + EXPIRES_IN * 1000);
  refreshTokens.add(refresh);
  lastAccessToken = access;
  send(res, 200, {
    access_token: access,
    token_type: 'Bearer',
    expires_in: EXPIRES_IN,
    refresh_token: refresh,
    scope: 'openid offline_access',
  });
}

const server = http.createServer(async (req, res) => {
  const base = 'http://' + req.headers.host;
  const url = new URL(req.url, base);

  if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return send(res, 200, {
      resource: base + '/mcp',
      authorization_servers: [base],
      scopes_supported: ['openid', 'offline_access'],
      bearer_methods_supported: ['header'],
    });
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    return send(res, 200, {
      issuer: base,
      authorization_endpoint: base + '/authorize',
      token_endpoint: base + '/token',
      registration_endpoint: base + '/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (req.method === 'POST' && url.pathname === '/register') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid_client_metadata' }); }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || !uris.every((u) => /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(u))) {
      return send(res, 400, { error: 'invalid_redirect_uri', error_description: 'only loopback redirect URIs are allowed' });
    }
    const clientId = 'cid-' + ++counter;
    clients.set(clientId, uris);
    stats.registrations++;
    stats.lastRegistration = { client_name: body.client_name, auth_method: body.token_endpoint_auth_method, redirect_uris: uris };
    return send(res, 201, { client_id: clientId, redirect_uris: uris, token_endpoint_auth_method: 'none' });
  }
  if (req.method === 'GET' && url.pathname === '/authorize') {
    const q = Object.fromEntries(url.searchParams);
    stats.authorize++;
    stats.lastAuthorizeQuery = q;
    const uris = clients.get(q.client_id);
    if (!uris || !uris.includes(q.redirect_uri)) { res.writeHead(400).end('unknown client or redirect_uri'); return; }
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.state) {
      res.writeHead(400).end('bad authorization request');
      return;
    }
    if (q.resource !== base + '/mcp') { res.writeHead(400).end('bad resource'); return; }
    const target = new URL(q.redirect_uri);
    if (q.deny === '1') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'user denied access');
    } else {
      const code = 'code-' + ++counter;
      codes.set(code, { challenge: q.code_challenge, redirectUri: q.redirect_uri, clientId: q.client_id });
      target.searchParams.set('code', code);
    }
    // iss_mode (для проверки RFC 9207): ok — верный issuer, wrong — чужой, missing — не возвращать
    const issMode = q.iss_mode || 'ok';
    if (issMode === 'ok') target.searchParams.set('iss', base);
    else if (issMode === 'wrong') target.searchParams.set('iss', 'https://evil.example');
    target.searchParams.set('state', q.state);
    res.writeHead(302, { Location: target.toString() }).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/token') {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    if (form.grant_type === 'authorization_code') {
      const c = codes.get(form.code);
      codes.delete(form.code);
      const verifierOk = c && b64url(crypto.createHash('sha256').update(form.code_verifier || '').digest()) === c.challenge;
      if (!c || !verifierOk || c.redirectUri !== form.redirect_uri || c.clientId !== form.client_id) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'bad code, verifier or redirect_uri' });
      }
      stats.token.authorization_code++;
      return issue(res);
    }
    if (form.grant_type === 'refresh_token') {
      if (!refreshTokens.has(form.refresh_token)) return send(res, 400, { error: 'invalid_grant' });
      refreshTokens.delete(form.refresh_token); // ротация
      stats.token.refresh_token++;
      return issue(res);
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }
  if (req.method === 'POST' && url.pathname === '/mcp') {
    const raw = await readBody(req);
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const exp = m && accessTokens.get(m[1]);
    if (!exp || exp <= Date.now()) {
      stats.mcp401++;
      return send(res, 401, { error: 'unauthorized' }, {
        'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="openid offline_access"`,
      });
    }
    stats.mcpOk++;
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(res, 400, {}); }
    if (msg.method === 'initialize') {
      return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-oauth-mcp', version: '1.0.0' } } });
    }
    if (msg.method === 'tools/list') return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
  if (req.method === 'GET' && url.pathname === '/_stats') return send(res, 200, { ...stats, lastAccessToken });
  res.writeHead(404).end();
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
