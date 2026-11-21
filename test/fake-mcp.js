#!/usr/bin/env node
'use strict';

// Минимальный MCP-сервер для проверки приложения.
//   node fake-mcp.js                 — stdio
//   node fake-mcp.js --http <port>   — HTTP (ответы JSON, путь /mcp)

// Инструменты разного рода: часть с подсказками (annotations), часть без — их тип определяется по названию.
const BASE_TOOLS = [
  { name: 'echo', description: 'Возвращает переданный текст', annotations: { readOnlyHint: true } },
  { name: 'add', description: 'Складывает два числа' },
  { name: 'list_things', description: 'Список вещей' },
  { name: 'ask_question', description: 'Задать вопрос справочной системе' },
  { name: 'create_thing', description: 'Создаёт вещь' },
  { name: 'delete_things', description: 'Удаляет вещи', annotations: { destructiveHint: true } },
  { name: 'decide', description: 'Решение по карточке согласования' },
];
// FAKE_MCP_EXTRA_FILE: пока файл существует, сервер отдаёт ещё один (новый) инструмент.
const fs = require('fs');
const tools = () =>
  process.env.FAKE_MCP_EXTRA_FILE && fs.existsSync(process.env.FAKE_MCP_EXTRA_FILE)
    ? [...BASE_TOOLS, { name: 'brand_new', description: 'Новый инструмент, появился после первой проверки' }]
    : BASE_TOOLS;

function handle(msg) {
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    };
  }
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: tools() } };
  if (msg.method === 'tools/call') {
    const { name, arguments: a = {} } = msg.params || {};
    const text = name === 'add' ? String(Number(a.a) + Number(a.b)) : String(a.text || '');
    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
  }
  if (msg.id !== undefined) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  return null; // уведомление
}

const httpIdx = process.argv.indexOf('--http');
if (httpIdx >= 0) {
  const port = Number(process.argv[httpIdx + 1]) || 8765;
  require('http')
    .createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(404).end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        const reply = handle(msg);
        if (!reply) { res.writeHead(202).end(); return; }
        // Половину ответов отдаём как SSE, чтобы проверить оба формата.
        const sse = msg.method === 'tools/list';
        res.writeHead(200, {
          'Content-Type': sse ? 'text/event-stream' : 'application/json',
          'Mcp-Session-Id': 'fake-session',
        });
        res.end(sse ? 'event: message\ndata: ' + JSON.stringify(reply) + '\n\n' : JSON.stringify(reply));
      });
    })
    .listen(port, '127.0.0.1', () => console.error('fake-mcp http on ' + port));
} else {
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const reply = handle(msg);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
}
