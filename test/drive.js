#!/usr/bin/env node
'use strict';

// Управляет уже запущенным приложением через Chrome DevTools Protocol:
//   electron . --remote-debugging-port=9333
// и сохраняет скриншоты. Нужен только для самопроверки интерфейса.
// Сценарий выбирается переменной SCENARIO: chat (по умолчанию) | stop | nologin | session

const fs = require('fs');
const path = require('path');

const PORT = process.env.CDP_PORT || '9333';
const OUT = process.env.OUT_DIR || __dirname;
const SCENARIO = process.env.SCENARIO || 'chat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page;
    } catch { /* ещё не поднялся */ }
    await sleep(250);
  }
  throw new Error('Окно приложения не найдено на порту ' + PORT);
}

async function connect() {
  const target = await waitForTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('screenshot:', file);
  };
  const waitFor = async (expr, label, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evaluate(expr)) return;
      await sleep(200);
    }
    throw new Error('Таймаут ожидания: ' + label);
  };
  const type = (text) => evaluate(`(() => {
    const i = document.getElementById('input');
    i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input'));
    document.getElementById('sendBtn').click();
  })()`);

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await waitFor(`document.readyState === 'complete' && !!window.api && !!document.querySelector('.empty')`, 'загрузка интерфейса');
  await sleep(500);
  return { ws, cdp, evaluate, shot, waitFor, type, consoleErrors };
}

const scenarios = {
  async chat(t) {
    await t.shot('01-empty.png');
    console.log('initial:', JSON.stringify(await t.evaluate(`({
      folder: document.getElementById('folderLabel').textContent,
      pill: document.getElementById('authPill').textContent,
      models: [...document.querySelectorAll('#modelSel option')].map(o => o.textContent),
      modes: [...document.querySelectorAll('#modeSel option')].map(o => o.textContent),
    })`)));

    await t.type('Покажи статус репозитория');
    await sleep(700);
    await t.shot('02-streaming.png');
    await t.waitFor(`!!document.querySelector('.run-meta')`, 'завершение ответа', 40000);
    await sleep(400);
    await t.shot('03-done.png');

    console.log('result:', JSON.stringify(await t.evaluate(`({
      userMsgs: document.querySelectorAll('.msg.user').length,
      tools: [...document.querySelectorAll('.tool')].map(x => ({
        name: x.querySelector('.tool-name').textContent,
        desc: x.querySelector('.tool-desc').textContent,
        state: x.querySelector('.tool-state').className,
        out: x.querySelector('.tool-out').textContent,
      })),
      hasHeading: !!document.querySelector('.md h3'),
      hasStrong: !!document.querySelector('.md strong'),
      hasCode: !!document.querySelector('.code pre code'),
      hasTable: !!document.querySelector('.md table'),
      hasQuote: !!document.querySelector('.md blockquote'),
      nestedList: !!document.querySelector('.md ul ul'),
      link: document.querySelector('.md a')?.getAttribute('href') || null,
      typingGone: !document.querySelector('.typing'),
      notices: [...document.querySelectorAll('.notice')].map(n => n.textContent),
      meta: document.querySelector('.run-meta')?.textContent || null,
      sendIsStop: document.getElementById('sendBtn').classList.contains('stop'),
    })`), null, 2));

    await t.evaluate(`document.querySelector('.tool')?.setAttribute('open', '')`);
    await sleep(200);
    await t.shot('04-tool-open.png');
    await t.cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 620, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    await t.shot('05-narrow.png');
    await t.cdp('Emulation.clearDeviceMetricsOverride');
  },

  async stop(t) {
    await t.type('Долгий запрос');
    await sleep(900);
    console.log('before stop, running:', await t.evaluate(`document.getElementById('sendBtn').classList.contains('stop')`));
    await t.evaluate(`document.getElementById('sendBtn').click()`);
    await t.waitFor(`!document.getElementById('sendBtn').classList.contains('stop')`, 'остановка', 10000);
    await sleep(300);
    await t.shot('10-stopped.png');
    console.log('after stop:', JSON.stringify(await t.evaluate(`({
      notices: [...document.querySelectorAll('.notice')].map(n => n.textContent),
      toolStates: [...document.querySelectorAll('.tool-state')].map(s => s.className),
      typing: !!document.querySelector('.typing'),
      newChatEnabled: !document.getElementById('newChat').disabled,
    })`)));
    // после остановки можно отправить снова
    await t.type('Ещё раз');
    await t.waitFor(`!!document.querySelector('.run-meta')`, 'повторный ответ', 40000);
    console.log('second run ok');
  },

  async nologin(t) {
    await sleep(1500);
    console.log('pill:', await t.evaluate(`document.getElementById('authPill').textContent`));
    await t.type('привет');
    await t.waitFor(`!document.getElementById('sendBtn').classList.contains('stop')`, 'ответ CLI', 60000);
    await sleep(400);
    await t.shot('20-nologin.png');
    console.log('state:', JSON.stringify(await t.evaluate(`({
      pill: document.getElementById('authPill').textContent,
      banner: !document.getElementById('banner').classList.contains('hidden'),
      bannerText: document.getElementById('bannerText').textContent,
      notices: [...document.querySelectorAll('.notice')].map(n => n.textContent),
    })`), null, 2));
  },

  // Своя история: создание, повторное открытие, продолжение с --resume, удаление.
  async history(t) {
    const sidebar = () => t.evaluate(`({
      count: document.querySelectorAll('.session').length,
      titles: [...document.querySelectorAll('.session-title')].map(n => n.textContent),
      empty: document.querySelector('.side-empty')?.textContent || null,
    })`);
    const metas = (n) => t.waitFor(`document.querySelectorAll('.run-meta').length >= ${n}`, 'ответ ' + n, 40000);

    console.log('sidebar at start (должно быть пусто):', JSON.stringify(await sidebar()));

    await t.type('Первый чат');
    await metas(1);
    await sleep(300);
    console.log('after first chat:', JSON.stringify(await sidebar()));

    await t.evaluate(`document.getElementById('newChat').click()`);
    await sleep(200);
    console.log('chat cleared:', await t.evaluate(`!!document.querySelector('.empty') && !document.querySelector('.msg')`));
    await t.type('Второй чат');
    await metas(1);
    await sleep(300);
    console.log('after second chat:', JSON.stringify(await sidebar()));

    // открыть первый чат из истории
    await t.evaluate(`[...document.querySelectorAll('.session')].find(b => b.textContent.includes('Первый чат')).click()`);
    await sleep(600);
    await t.shot('30-reopened.png');
    console.log('replayed:', JSON.stringify(await t.evaluate(`({
      users: [...document.querySelectorAll('.bubble')].map(b => b.textContent),
      tools: document.querySelectorAll('.tool').length,
      toolState: document.querySelector('.tool-state')?.className,
      toolOut: document.querySelector('.tool-out')?.textContent,
      hasTable: !!document.querySelector('.md table'),
      meta: document.querySelector('.run-meta')?.textContent || null,
      notices: [...document.querySelectorAll('.notice')].map(n => n.textContent),
      active: document.querySelector('.session.active .session-title')?.textContent,
    })`)));

    // продолжить диалог: должен уйти --resume
    await t.type('Продолжение');
    await metas(2);
    await sleep(300);
    console.log('continued:', JSON.stringify(await t.evaluate(`({
      users: [...document.querySelectorAll('.bubble')].map(b => b.textContent),
      resumedNote: document.body.innerText.includes('продолжение сессии'),
      lastAnswerStart: [...document.querySelectorAll('.md')].map(m => m.textContent.slice(0, 120)).slice(-3),
      runMetas: document.querySelectorAll('.run-meta').length,
      sessions: document.querySelectorAll('.session').length,
    })`)));

    // удалить второй чат
    await t.evaluate(`window.confirm = () => true`);
    await t.evaluate(`[...document.querySelectorAll('.session-row')].find(r => r.textContent.includes('Второй чат')).querySelector('.session-del').click()`);
    await sleep(500);
    console.log('after delete:', JSON.stringify(await sidebar()));
  },

  // После перезапуска история должна остаться.
  async reopen(t) {
    await t.waitFor(`document.querySelectorAll('.session').length > 0`, 'список чатов', 10000);
    console.log('sidebar after restart:', JSON.stringify(await t.evaluate(`[...document.querySelectorAll('.session-title')].map(n => n.textContent)`)));
    await t.evaluate(`document.querySelector('.session').click()`);
    await sleep(600);
    console.log('replayed after restart:', JSON.stringify(await t.evaluate(`({
      users: [...document.querySelectorAll('.bubble')].map(b => b.textContent),
      tools: document.querySelectorAll('.tool').length,
      metas: document.querySelectorAll('.run-meta').length,
    })`)));
  },

  // Потерянная сессия CLI: чат продолжается с чистого контекста без ошибки.
  async missing(t) {
    const metas = (n) => t.waitFor(`document.querySelectorAll('.run-meta').length >= ${n}`, 'ответ ' + n, 40000);
    await t.type('Сообщение A');
    await metas(1);
    await sleep(300);
    await t.type('Сообщение B');
    await metas(2);
    await sleep(300);
    await t.shot('40-missing.png');
    console.log('missing-session:', JSON.stringify(await t.evaluate(`({
      users: [...document.querySelectorAll('.bubble')].map(b => b.textContent),
      notices: [...document.querySelectorAll('.notice')].map(n => ({ cls: n.className, text: n.textContent.slice(0, 90) })),
      resumedNote: document.body.innerText.includes('продолжение сессии'),
      running: document.getElementById('sendBtn').classList.contains('stop'),
    })`), null, 2));
  },

  // Полный путь входа: ссылка, неверный код, верный код, отмена.
  async login(t) {
    const banner = () => t.evaluate(`({
      pill: document.getElementById('authPill').textContent,
      visible: !document.getElementById('banner').classList.contains('hidden'),
      text: document.getElementById('bannerText').textContent,
      log: document.getElementById('bannerLog').textContent,
      form: !document.getElementById('bannerForm').classList.contains('hidden'),
      buttons: [...document.querySelectorAll('#bannerActions button')].map(b => b.textContent),
    })`);
    const submit = (code) => t.evaluate(`(() => {
      document.getElementById('authCode').value = ${JSON.stringify(code)};
      document.getElementById('authSend').click();
    })()`);
    const clickBanner = (label) => t.evaluate(`[...document.querySelectorAll('#bannerActions button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);

    await t.waitFor(`document.getElementById('authPill').textContent === 'Нужен вход'`, 'статус «Нужен вход»', 10000);
    console.log('1 not logged in:', JSON.stringify(await banner()));

    await clickBanner('Войти');
    await t.waitFor(`document.querySelectorAll('#bannerActions button').length >= 3`, 'кнопки со ссылкой', 10000);
    await t.shot('50-login-waiting.png');
    console.log('2 waiting for code:', JSON.stringify(await banner()));

    await submit('wrong-code');
    await t.waitFor(`document.getElementById('bannerText').textContent.includes('Нажмите «Войти»')`, 'отказ по неверному коду', 10000);
    await t.shot('51-login-wrong.png');
    console.log('3 wrong code:', JSON.stringify(await banner()));

    await clickBanner('Войти');
    await t.waitFor(`!document.getElementById('bannerForm').classList.contains('hidden')`, 'форма кода', 10000);
    await submit('good-code#state');
    await t.waitFor(`document.getElementById('authPill').textContent === 'Вход выполнен'`, 'успешный вход', 10000);
    await sleep(300);
    await t.shot('52-login-ok.png');
    console.log('4 good code:', JSON.stringify(await banner()));
  },

  async logincancel(t) {
    await t.waitFor(`document.getElementById('authPill').textContent === 'Нужен вход'`, 'статус «Нужен вход»', 10000);
    await t.evaluate(`[...document.querySelectorAll('#bannerActions button')].find(b => b.textContent === 'Войти').click()`);
    await t.waitFor(`document.querySelectorAll('#bannerActions button').length >= 3`, 'кнопки со ссылкой', 10000);
    await t.evaluate(`[...document.querySelectorAll('#bannerActions button')].find(b => b.textContent === 'Отмена').click()`);
    await t.waitFor(`document.getElementById('bannerText').textContent.includes('отменён')`, 'отмена входа', 10000);
    console.log('cancelled:', JSON.stringify(await t.evaluate(`({
      text: document.getElementById('bannerText').textContent,
      form: !document.getElementById('bannerForm').classList.contains('hidden'),
      pill: document.getElementById('authPill').textContent,
    })`)));
  },

  // MCP: добавление, импорт, проверка, включение, передача флагов в CLI.
  async mcp(t) {
    const { spawn } = require('child_process');
    const fakeMcp = path.join(__dirname, 'fake-mcp.js');
    const argsLog = process.env.FAKE_ARGS_LOG;
    const userData = process.env.MARK_DESK_USER_DATA;
    // Свободный порт: фиксированный может быть занят чужим сервисом.
    const port = await new Promise((resolve) => {
      const s = require('net').createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const httpServer = spawn(process.execPath, [fakeMcp, '--http', String(port)], { stdio: 'ignore' });
    await sleep(600);
    const ev = (code) => t.evaluate(code);
    const setVal = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); })()`);
    const click = (id) => ev(`document.getElementById('${id}').click()`);
    const list = () => ev(`[...document.querySelectorAll('#mcpList .mcp-item')].map(i => ({ name: i.querySelector('.mcp-name').textContent, type: i.querySelector('.mcp-type').textContent, on: i.querySelector('input').checked, status: i.querySelector('.mcp-status') ? i.querySelector('.mcp-status').textContent : null }))`);
    const rowBtn = (name, label) => ev(`(() => { const row = [...document.querySelectorAll('#mcpList .mcp-item')].find(i => i.querySelector('.mcp-name').textContent === ${JSON.stringify(name)}); [...row.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click(); })()`);
    const rowStatus = (name) => `(() => { const row = [...document.querySelectorAll('#mcpList .mcp-item')].find(i => i.querySelector('.mcp-name').textContent === ${JSON.stringify(name)}); const s = row && row.querySelector('.mcp-status'); return s ? s.textContent : ''; })()`;
    const metas = (n) => t.waitFor(`document.querySelectorAll('.run-meta').length >= ${n}`, 'ответ ' + n, 40000);
    const lastArgs = () => JSON.parse(fs.readFileSync(argsLog, 'utf8').trim().split('\n').pop());
    const sendMsg = async (text, n) => { await t.type(text); await metas(n); await sleep(300); };

    try {
      console.log('badge at start hidden:', await ev(`document.getElementById('mcpBadge').classList.contains('hidden')`));
      await click('openMcp');
      await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);
      console.log('1 empty list:', await ev(`document.querySelector('.mcp-empty')?.textContent`));
      await t.shot('60-mcp-empty.png');

      // форма: stdio-сервер с проверкой
      await click('mcpAdd');
      await setVal('mcpName', 'fake');
      await setVal('mcpType', 'stdio');
      await setVal('mcpCommand', 'node');
      await setVal('mcpArgs', fakeMcp);
      await setVal('mcpEnv', 'FAKE_GREETING=hi');
      await click('mcpFormTest');
      await t.waitFor(`document.getElementById('mcpTestResult').textContent.includes('Инструментов')`, 'проверка stdio', 45000);
      await t.shot('61-mcp-form-test.png');
      console.log('2 form test:', await ev(`document.getElementById('mcpTestResult').textContent`));
      await click('mcpFormSave');
      await t.waitFor(`document.querySelectorAll('#mcpList .mcp-item').length === 1`, 'сервер сохранён', 5000);

      // валидация имени
      await click('mcpAdd');
      await setVal('mcpName', 'bad name!');
      await setVal('mcpCommand', 'node');
      await click('mcpFormSave');
      await sleep(300);
      console.log('3 validation:', await ev(`document.getElementById('mcpTestResult').textContent`));
      await click('mcpFormCancel');

      // импорт JSON (fake уже есть — должен быть пропущен)
      await click('mcpImport');
      await setVal('mcpJson', JSON.stringify({ mcpServers: {
        fakehttp: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
        badone: { command: 'node', args: ['-e', 'process.exit(1)'] },
        fake: { command: 'x' },
      } }));
      await click('mcpJsonDo');
      await t.waitFor(`document.getElementById('mcpJsonResult').textContent.length > 0`, 'результат импорта', 5000);
      console.log('4 import:', await ev(`document.getElementById('mcpJsonResult').textContent`));
      await click('mcpJsonCancel');

      // проверка http (ответ tools/list приходит как SSE) и сломанного stdio
      const waitStatus = async (name, ms) => {
        await t.waitFor(`(() => { const s = ${rowStatus(name)}; return s !== '' && s !== 'Проверяю…'; })()`, 'статус ' + name, ms);
        return ev(rowStatus(name));
      };
      await rowBtn('fakehttp', 'Проверить');
      console.log('5a fakehttp status:', JSON.stringify(await waitStatus('fakehttp', 25000)));
      await rowBtn('badone', 'Проверить');
      console.log('5b badone status:', JSON.stringify(await waitStatus('badone', 45000)));
      await t.shot('62-mcp-list.png');
      console.log('5 list after tests:', JSON.stringify(await list(), null, 1));

      // отключить fake
      await ev(`[...document.querySelectorAll('#mcpList .mcp-item')].find(i => i.querySelector('.mcp-name').textContent === 'fake').querySelector('input').click()`);
      await t.waitFor(`[...document.querySelectorAll('#mcpList .mcp-item')].find(i => i.querySelector('.mcp-name').textContent === 'fake').classList.contains('off')`, 'fake отключён', 5000);
      await click('mcpClose');
      await sleep(200);
      console.log('6 badge:', await ev(`document.getElementById('mcpBadge').textContent`));

      // запуск чата: флаги CLI и статус серверов
      await sendMsg('проверка mcp', 1);
      await t.shot('63-mcp-chat.png');
      const a1 = lastArgs();
      const cfgPath = a1[a1.indexOf('--mcp-config') + 1];
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const allowAt = a1.indexOf('--allowedTools');
      console.log('7 cli args:', JSON.stringify({
        hasMcpConfig: a1.includes('--mcp-config'),
        strict: a1.includes('--strict-mcp-config'),
        servers: Object.keys(cfg.mcpServers),
        badone: cfg.mcpServers.badone,
        fakehttp: cfg.mcpServers.fakehttp,
        allowed: allowAt >= 0 ? a1.slice(allowAt + 1) : null,
      }, null, 1));
      console.log('7 chat:', JSON.stringify(await ev(`({
        notices: [...document.querySelectorAll('.notice')].map(n => n.textContent),
        hint: document.getElementById('hint').textContent,
      })`)));

      // строгий режим
      await click('openMcp');
      await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);
      await click('mcpStrict');
      await sleep(300);
      await click('mcpClose');
      await sendMsg('строгий режим', 2);
      console.log('8 strict flag:', lastArgs().includes('--strict-mcp-config'));

      // режим «Только план»: инструменты серверов не разрешаются заранее
      await setVal('modeSel', 'plan');
      await sleep(300);
      await sendMsg('режим плана', 3);
      const a3 = lastArgs();
      console.log('9 plan mode allowedTools present:', a3.includes('--allowedTools'), '| mcp-config present:', a3.includes('--mcp-config'));

      // удаление и файл на диске
      await ev(`window.confirm = () => true`);
      await click('openMcp');
      await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);
      await rowBtn('badone', 'Удалить');
      await t.waitFor(`document.querySelectorAll('#mcpList .mcp-item').length === 2`, 'badone удалён', 5000);
      const saved = JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8'));
      console.log('10 mcp.json servers:', saved.servers.map((s) => s.name + ':' + s.type + ':' + (s.enabled ? 'on' : 'off')).join(', '));
    } finally {
      httpServer.kill();
    }
  },

  // OAuth: пресет, вход (PKCE, регистрация клиента), шифрование токенов, токен в окружении CLI,
  // обновление по истечении, выход, отказ, отмена. Браузер заменён чтением адреса из файла.
  async oauth(t) {
    const { spawn } = require('child_process');
    const urlFile = process.env.MARK_DESK_OPEN_URL_FILE;
    const argsLog = process.env.FAKE_ARGS_LOG;
    const userData = process.env.MARK_DESK_USER_DATA;
    const ev = (code) => t.evaluate(code);
    const setVal = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); })()`);
    const click = (id) => ev(`document.getElementById('${id}').click()`);

    const srv = spawn(process.execPath, [path.join(__dirname, 'fake-oauth-mcp.js')], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, EXPIRES_IN: '6' },
    });
    const port = await new Promise((resolve, reject) => {
      srv.stdout.once('data', (d) => resolve(JSON.parse(String(d).split('\n')[0]).port));
      srv.once('error', reject);
    });
    const base = `http://127.0.0.1:${port}`;
    const stats = async () => (await fetch(base + '/_stats')).json();
    const rowOf = (name) => `[...document.querySelectorAll('#mcpList .mcp-item')].find(i => i.querySelector('.mcp-name').textContent === ${JSON.stringify(name)})`;
    const rowText = (name) => ev(`((${rowOf(name)}) || { textContent: '' }).textContent`);
    const rowBtn = (name, label) => ev(`[...(${rowOf(name)}).querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    const waitRow = (name, text, ms = 15000) => t.waitFor(`(((${rowOf(name)}) || {}).textContent || '').includes(${JSON.stringify(text)})`, `«${text}» у ${name}`, ms);
    const readUrl = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        if (fs.existsSync(urlFile)) { const u = fs.readFileSync(urlFile, 'utf8'); if (u) return u; }
        await sleep(100);
      }
      throw new Error('адрес входа не появился');
    };
    // «Браузер»: открывает адрес входа, идёт по редиректу на обратный вызов приложения.
    const browser = async (url, extra = '') => {
      const r = await fetch(url + extra, { redirect: 'manual' });
      const loc = r.headers.get('location');
      if (!loc) throw new Error('нет редиректа: HTTP ' + r.status);
      return (await fetch(loc)).status;
    };
    const lastArgs = () => JSON.parse(fs.readFileSync(argsLog, 'utf8').trim().split('\n').pop());
    const lastEnv = () => JSON.parse(fs.readFileSync(argsLog + '.env', 'utf8').trim().split('\n').pop());
    const metas = (n) => t.waitFor(`document.querySelectorAll('.run-meta').length >= ${n}`, 'ответ ' + n, 40000);
    const sendMsg = async (text, n) => { await t.type(text); await metas(n); await sleep(300); };
    const runConfig = () => { const a = lastArgs(); return JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config') + 1], 'utf8')); };

    try {
      await click('openMcp');
      await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);

      // 1. пресет Higgsfield добавляет сервер, но вход не запускает
      await click('mcpPreset');
      await t.waitFor(`document.querySelectorAll('#mcpList .mcp-item').length === 1`, 'пресет добавлен', 5000);
      console.log('1 preset:', JSON.stringify(await ev(`(() => { const i = document.querySelector('#mcpList .mcp-item'); return { name: i.querySelector('.mcp-name').textContent, url: i.querySelector('.mcp-sum').textContent, text: i.querySelector('.mcp-status').textContent, buttons: [...i.querySelectorAll('button')].map(b => b.textContent) }; })()`)));
      console.log('1 login not started (no url file):', !fs.existsSync(urlFile));
      await t.shot('79-oauth-preset.png');
      await ev(`window.confirm = () => true`);
      await rowBtn('higgsfield', 'Удалить');
      await t.waitFor(`document.querySelectorAll('#mcpList .mcp-item').length === 0`, 'пресет удалён', 5000);

      // 1b. пресет 1Cifer: вход не запускается, вызовы инструментов по умолчанию не разрешены
      await click('mcpPresetCifer');
      await t.waitFor(`document.querySelectorAll('#mcpList .mcp-item').length === 1`, 'пресет 1Cifer добавлен', 5000);
      console.log('1b 1cifer preset:', JSON.stringify(await ev(`(() => { const i = document.querySelector('#mcpList .mcp-item'); return { name: i.querySelector('.mcp-name').textContent, url: i.querySelector('.mcp-sum').textContent, oauthNeedsLogin: i.textContent.includes('OAuth: нужен вход'), toolsDeniedHint: i.textContent.includes('отклоняются'), alwaysDeniedLine: i.textContent.includes('Всегда запрещены: decide, delete_tasks'), buttons: [...i.querySelectorAll('button')].map(b => b.textContent) }; })()`)));
      await t.shot('78-oauth-1cifer-preset.png');
      await rowBtn('1cifer', 'Изменить');
      console.log('1b form: auth =', await ev(`document.getElementById('mcpAuth').value`), '| auto-approve checked =', await ev(`document.getElementById('mcpAuto').checked`), '| deny field =', JSON.stringify(await ev(`document.getElementById('mcpDeny').value`)));
      await click('mcpFormCancel');
      await rowBtn('1cifer', 'Удалить');
      await t.waitFor(`document.querySelectorAll('#mcpList .mcp-item').length === 0`, 'пресет 1Cifer удалён', 5000);
      console.log('1b login not started (no url file):', !fs.existsSync(urlFile));

      // 2. сервер с OAuth через форму
      await click('mcpAdd');
      await setVal('mcpName', 'oauthfake');
      await setVal('mcpType', 'http');
      await setVal('mcpUrl', base + '/mcp');
      await setVal('mcpAuth', 'oauth');
      await setVal('mcpDeny', 'delete_tasks\ndecide\nбез пробелов нельзя');
      console.log('2 client id field visible:', await ev(`!document.getElementById('mcpClientIdField').classList.contains('hidden')`));
      await click('mcpFormSave');
      await t.waitFor(`document.querySelectorAll('#mcpList .mcp-item').length === 1`, 'сервер сохранён', 5000);
      console.log('2 saved:', JSON.stringify(await rowText('oauthfake')));

      // 3. проверка без входа
      await rowBtn('oauthfake', 'Проверить');
      await waitRow('oauthfake', 'Нужен вход через OAuth');
      console.log('3 test without login: ok (понятная ошибка)');

      // 4. вход
      fs.rmSync(urlFile, { force: true });
      await rowBtn('oauthfake', 'Войти');
      const authUrl = await readUrl();
      const au = new URL(authUrl);
      const q = Object.fromEntries(au.searchParams);
      console.log('4 auth url:', JSON.stringify({
        sameServer: au.origin === base, path: au.pathname, response_type: q.response_type,
        method: q.code_challenge_method, challengeLen: (q.code_challenge || '').length, hasState: !!q.state,
        scope: q.scope, resourceOk: q.resource === base + '/mcp', loopbackRedirect: /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(q.redirect_uri),
      }));
      await t.shot('80-oauth-waiting.png');
      console.log('4 while waiting:', JSON.stringify(await rowText('oauthfake')));
      console.log('4 callback page status:', await browser(authUrl));
      await waitRow('oauthfake', 'Инструментов');
      await t.shot('81-oauth-done.png');
      console.log('4 after login:', JSON.stringify(await rowText('oauthfake')));
      const s1 = await stats();
      console.log('4 server:', JSON.stringify({ registrations: s1.registrations, tokenCalls: s1.token, registered: s1.lastRegistration }));

      // 5. токены лежат зашифрованными
      const store = fs.readFileSync(path.join(userData, 'mcp-oauth.json'), 'utf8');
      console.log('5 store:', JSON.stringify({ enc: JSON.parse(store).enc, plaintextTokenVisible: /at-\d|rt-\d/.test(store) }));

      // 6. запуск чата: в файле плейсхолдер, токен в окружении процесса
      await click('mcpClose');
      await sendMsg('чат с oauth', 1);
      const cfg1 = runConfig();
      const env1 = lastEnv();
      const envName = Object.keys(env1)[0];
      const hdr = cfg1.mcpServers.oauthfake.headers.Authorization;
      const a1 = lastArgs();
      const ai = a1.indexOf('--allowedTools');
      const di = a1.indexOf('--disallowedTools');
      console.log('6 allow/deny flags:', JSON.stringify({ allowed: ai >= 0 ? a1[ai + 1] : null, disallowed: di >= 0 ? a1.slice(di + 1) : null }));
      console.log('6 run 1:', JSON.stringify({
        header: hdr, envVars: Object.keys(env1).length, headerMatchesEnv: hdr === 'Bearer ${' + envName + '}',
        envTokenIsServerToken: env1[envName] === (await stats()).lastAccessToken, rawTokenInConfigFile: JSON.stringify(cfg1).includes('at-'),
      }));

      // 7. токен истёк — перед запуском он обновляется сам
      await sleep(7000);
      await sendMsg('после истечения', 2);
      const env2 = lastEnv();
      const s2 = await stats();
      console.log('7 run 2:', JSON.stringify({ refreshCalls: s2.token.refresh_token, tokenChanged: env2[envName] !== env1[envName], envTokenIsServerToken: env2[envName] === s2.lastAccessToken }));

      // 8. выход: токены стёрты, регистрация клиента остаётся
      await click('openMcp');
      await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);
      await rowBtn('oauthfake', 'Выйти');
      await waitRow('oauthfake', 'нужен вход');
      console.log('8 after logout:', JSON.stringify(await rowText('oauthfake')));
      await click('mcpClose');
      await sendMsg('без токена', 3);
      const cfg3 = runConfig();
      console.log('8 run 3:', JSON.stringify({ authHeader: !!(cfg3.mcpServers.oauthfake.headers && cfg3.mcpServers.oauthfake.headers.Authorization), envVars: Object.keys(lastEnv()).length }));
      console.log('8 notices:', JSON.stringify(await ev(`[...document.querySelectorAll('.notice')].map(n => n.textContent)`)));

      // 9. пользователь отказал во входе
      await click('openMcp');
      await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);
      fs.rmSync(urlFile, { force: true });
      await rowBtn('oauthfake', 'Войти');
      await browser(await readUrl(), '&deny=1');
      await waitRow('oauthfake', 'access_denied');
      console.log('9 denied:', JSON.stringify(await rowText('oauthfake')));

      // 10. отмена входа
      fs.rmSync(urlFile, { force: true });
      await rowBtn('oauthfake', 'Войти');
      await readUrl();
      await rowBtn('oauthfake', 'Отмена входа');
      await waitRow('oauthfake', 'отменён');
      console.log('10 cancelled:', JSON.stringify(await rowText('oauthfake')));

      // 11. повторный вход проходит и использует прежнюю регистрацию клиента
      fs.rmSync(urlFile, { force: true });
      await rowBtn('oauthfake', 'Войти');
      await browser(await readUrl());
      await waitRow('oauthfake', 'вход выполнен');
      console.log('11 relogin ok, total registrations:', (await stats()).registrations, '| tokenCalls:', JSON.stringify((await stats()).token));

      // 12–13. RFC 9207: чужой iss и отсутствующий iss отклоняются, код не обменивается на токен
      const clickLogin = () => ev(`[...(${rowOf('oauthfake')}).querySelectorAll('button')].find(b => b.textContent === 'Войти' || b.textContent === 'Войти заново').click()`);
      const codesBefore = (await stats()).token.authorization_code;
      fs.rmSync(urlFile, { force: true });
      await clickLogin();
      await browser(await readUrl(), '&iss_mode=wrong');
      await waitRow('oauthfake', 'iss не совпал');
      console.log('12 wrong iss:', JSON.stringify(await rowText('oauthfake')));
      fs.rmSync(urlFile, { force: true });
      await clickLogin();
      await browser(await readUrl(), '&iss_mode=missing');
      await waitRow('oauthfake', 'не вернул параметр iss');
      console.log('13 missing iss:', JSON.stringify(await rowText('oauthfake')));
      console.log('12-13 code exchanged anyway:', (await stats()).token.authorization_code !== codesBefore);
      await t.shot('82-oauth-iss-rejected.png');
    } finally {
      srv.kill();
    }
  },

  // Разрешения по инструментам: список с типами, пресеты, сохранение, флаги CLI, новый инструмент сервера.
  // Запускать с FAKE_ARGS_LOG и FAKE_MCP_EXTRA_FILE.
  async permissions(t) {
    const fakeMcp = path.join(__dirname, 'fake-mcp.js');
    const extraFile = process.env.FAKE_MCP_EXTRA_FILE;
    const argsLog = process.env.FAKE_ARGS_LOG;
    const userData = process.env.MARK_DESK_USER_DATA;
    fs.rmSync(extraFile, { force: true });
    const ev = (code) => t.evaluate(code);
    const setVal = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); })()`);
    const click = (id) => ev(`document.getElementById('${id}').click()`);
    const rowBtn = (name, label) => ev(`[...[...document.querySelectorAll('#mcpList .mcp-item')].find(i => i.querySelector('.mcp-name').textContent === ${JSON.stringify(name)}).querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    const rowText = (name) => ev(`([...document.querySelectorAll('#mcpList .mcp-item')].find(i => i.querySelector('.mcp-name').textContent === ${JSON.stringify(name)}) || { textContent: '' }).textContent`);
    const permRows = () => ev(`[...document.querySelectorAll('#mcpPermList .perm-row')].map(r => ({ name: r.querySelector('.perm-name').textContent, kind: r.querySelector('.perm-badge').textContent, fresh: !!r.querySelector('.perm-badge.fresh'), checked: r.querySelector('input').checked }))`);
    const preset = (k) => ev(`document.querySelector('#mcpPermView [data-preset="${k}"]').click()`);
    const saved = () => JSON.parse(fs.readFileSync(path.join(userData, 'mcp.json'), 'utf8')).servers.find((s) => s.name === 'perm');
    const brief = (s) => ({ autoApprove: s.autoApprove, allow: s.allowTools && s.allowTools.length, deny: s.denyTools && s.denyTools.length, known: s.knownTools && s.knownTools.length });
    const lastArgs = () => JSON.parse(fs.readFileSync(argsLog, 'utf8').trim().split('\n').pop());
    const flags = () => {
      const a = lastArgs();
      const ai = a.indexOf('--allowedTools');
      const di = a.indexOf('--disallowedTools');
      const short = (list) => list && list.map((x) => x.replace('mcp__perm__', ''));
      return {
        allowed: short(ai >= 0 ? a.slice(ai + 1, di > ai ? di : undefined) : null),
        disallowed: short(di >= 0 ? a.slice(di + 1, ai > di ? ai : undefined) : null),
      };
    };
    const metas = (n) => t.waitFor(`document.querySelectorAll('.run-meta').length >= ${n}`, 'ответ ' + n, 40000);
    const sendMsg = async (text, n) => { await t.type(text); await metas(n); await sleep(300); };

    // 1. сервер добавлен импортом JSON
    await click('openMcp');
    await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);
    await click('mcpImport');
    await setVal('mcpJson', JSON.stringify({ mcpServers: { perm: { command: 'node', args: [fakeMcp] } } }));
    await click('mcpJsonDo');
    await t.waitFor(`document.getElementById('mcpJsonResult').textContent.includes('Добавлено')`, 'импорт', 5000);
    await click('mcpJsonCancel');

    // 2. окно «Разрешения»: список подтягивается сам, типы по подсказкам сервера и по названиям
    await rowBtn('perm', 'Разрешения');
    await t.waitFor(`document.querySelectorAll('#mcpPermList .perm-row').length === 7`, 'список инструментов', 45000);
    console.log('2 tools:', JSON.stringify(await permRows()));
    console.log('2 summary:', await ev(`document.getElementById('mcpPermSummary').textContent`));
    await t.shot('90-permissions.png');

    // 3. «Только чтение» → сохранить
    await preset('read');
    console.log('3 read preset checked:', JSON.stringify((await permRows()).filter((r) => r.checked).map((r) => r.name)));
    await click('mcpPermSave');
    await t.waitFor(`document.getElementById('mcpListView') && !document.getElementById('mcpListView').classList.contains('hidden')`, 'возврат к списку', 5000);
    console.log('3 row:', JSON.stringify((await rowText('perm')).replace(/\s+/g, ' ')));
    console.log('3 saved:', JSON.stringify(brief(saved())));
    await t.shot('91-permissions-saved.png');

    // 4–5. флаги CLI: разрешены только три, остальные скрыты; в режиме плана разрешений нет, запреты остаются
    await click('mcpClose');
    await sendMsg('чат с ограничениями', 1);
    console.log('4 cli flags:', JSON.stringify(flags()));
    await setVal('modeSel', 'plan');
    await sleep(300);
    await sendMsg('в режиме плана', 2);
    console.log('5 plan flags:', JSON.stringify(flags()));
    await setVal('modeSel', 'acceptEdits');

    // 6. правка сервера формой не стирает разрешения по инструментам
    await click('openMcp');
    await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);
    await rowBtn('perm', 'Изменить');
    console.log('6 form managed note visible:', await ev(`!document.getElementById('mcpPermManaged').classList.contains('hidden')`), '| simple controls hidden:', await ev(`document.getElementById('mcpPermSimple').classList.contains('hidden')`));
    await click('mcpFormSave');
    await t.waitFor(`!document.getElementById('mcpListView').classList.contains('hidden')`, 'форма сохранена', 5000);
    console.log('6 after form save:', JSON.stringify(brief(saved())));

    // 7. новый инструмент сервера: по умолчанию не разрешён
    fs.writeFileSync(extraFile, 'x');
    await rowBtn('perm', 'Разрешения');
    await t.waitFor(`document.querySelectorAll('#mcpPermList .perm-row').length === 7`, 'список из сохранённых', 5000);
    await click('mcpPermRefresh');
    await t.waitFor(`document.querySelectorAll('#mcpPermList .perm-row').length === 8`, 'новый инструмент', 45000);
    const rows7 = await permRows();
    console.log('7 new tool:', JSON.stringify(rows7.find((r) => r.name === 'brand_new')), '| notice:', await ev(`document.getElementById('mcpPermResult').textContent`));
    await t.shot('92-permissions-new-tool.png');
    await click('mcpPermSave');
    await t.waitFor(`!document.getElementById('mcpListView').classList.contains('hidden')`, 'сохранено', 5000);
    console.log('7 saved (allow stays 3):', JSON.stringify(brief(saved())), '| brand_new denied:', saved().denyTools.includes('brand_new'));

    // 8. «Все» → разрешены все восемь
    await rowBtn('perm', 'Разрешения');
    await preset('all');
    await click('mcpPermSave');
    await t.waitFor(`!document.getElementById('mcpListView').classList.contains('hidden')`, 'сохранено', 5000);
    console.log('8 saved all:', JSON.stringify(brief(saved())));
    await click('mcpClose');
    await sendMsg('всё разрешено', 3);
    console.log('8 cli flags:', JSON.stringify(flags()));

    // 9. «Ни одного» → сервер отклоняет всё, строка предупреждает
    await click('openMcp');
    await t.waitFor(`document.getElementById('mcpDlg').open`, 'диалог MCP', 5000);
    await rowBtn('perm', 'Разрешения');
    await preset('none');
    await click('mcpPermSave');
    await t.waitFor(`!document.getElementById('mcpListView').classList.contains('hidden')`, 'сохранено', 5000);
    console.log('9 saved none:', JSON.stringify(brief(saved())), '| row warns:', (await rowText('perm')).includes('отклоняются'));
    await click('mcpClose');
    await sendMsg('ничего не разрешено', 4);
    console.log('9 cli flags:', JSON.stringify(flags()));
    fs.rmSync(extraFile, { force: true });
  },

  // Отказанные вызовы MCP-инструментов: понятная подсказка. Запускать с FAKE_DENY=mcp__1cifer__list_tasks.
  async denial(t) {
    await t.type('вызови инструмент');
    await t.waitFor(`document.querySelectorAll('.run-meta').length >= 1`, 'ответ', 40000);
    await sleep(300);
    console.log('denial notices:', JSON.stringify(await t.evaluate(`[...document.querySelectorAll('.notice')].map(n => n.textContent)`), null, 1));
  },

  // Коннекторы аккаунта Claude (Higgsfield): список, «Разрешить», флаги CLI, тишина в чате.
  async connectors(t) {
    const argsLog = process.env.FAKE_ARGS_LOG;
    const ev = (code) => t.evaluate(code);
    const metas = (n) => t.waitFor(`document.querySelectorAll('.run-meta').length >= ${n}`, 'ответ ' + n, 40000);
    const lastArgs = () => JSON.parse(fs.readFileSync(argsLog, 'utf8').trim().split('\n').pop());

    await ev(`document.getElementById('openMcp').click()`);
    await t.waitFor(`document.querySelectorAll('#connList .mcp-item').length === 3`, 'список коннекторов', 15000);
    console.log('1 connectors:', JSON.stringify(await ev(`[...document.querySelectorAll('#connList .mcp-item')].map(i => ({
      name: i.querySelector('.mcp-name').textContent,
      status: i.querySelector('.mcp-status').textContent,
      allowed: i.querySelector('input').checked,
    }))`), null, 1));
    await t.shot('70-connectors.png');

    // разрешить Higgsfield
    await ev(`[...document.querySelectorAll('#connList .mcp-item')].find(i => i.querySelector('.mcp-name').textContent === 'Higgsfield').querySelector('input').click()`);
    await sleep(400);
    console.log('2 allowed after click:', JSON.stringify(await ev(`[...document.querySelectorAll('#connList .mcp-item')].map(i => i.querySelector('.mcp-name').textContent + '=' + i.querySelector('input').checked)`)));
    await ev(`document.getElementById('mcpClose').click()`);

    await t.type('проверка коннектора');
    await metas(1);
    await sleep(300);
    const a = lastArgs();
    const at = a.indexOf('--allowedTools');
    console.log('3 allowedTools:', JSON.stringify(at >= 0 ? a.slice(at + 1) : null), '| mcp-config:', a.includes('--mcp-config'));
    console.log('4 chat:', JSON.stringify(await ev(`({
      notices: [...document.querySelectorAll('.notice')].map(n => n.textContent),
      hint: document.getElementById('hint').textContent,
    })`)));
    await t.shot('71-connectors-chat.png');

    // режим плана: ничего не разрешается заранее
    await ev(`(() => { const s = document.getElementById('modeSel'); s.value = 'plan'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    await t.type('план');
    await metas(2);
    console.log('5 plan mode allowedTools present:', lastArgs().includes('--allowedTools'));
  },

  // Настоящий CLI: вызов безобидного инструмента коннектора Higgsfield (баланс). Содержимое ответа не выводим.
  // Запускать с настоящим вошедшим CLI и settings.json, где allowedConnectors содержит «claude.ai Higgsfield».
  async realhiggs(t) {
    await t.waitFor(`document.getElementById('authPill').textContent === 'Вход выполнен'`, 'вход в CLI', 40000);
    await t.type('Call the Higgsfield balance tool once. Then answer with one word only: OK if the tool call worked, FAIL if it did not. Do not reveal any amounts.');
    await t.waitFor(`!!document.querySelector('.run-meta') || !!document.querySelector('.notice.error')`, 'ответ модели', 180000);
    await sleep(600);
    console.log('real run:', JSON.stringify(await t.evaluate(`({
      tools: [...document.querySelectorAll('.tool')].map(x => ({ name: x.querySelector('.tool-name').textContent, state: x.querySelector('.tool-state').className })),
      answerFirstWord: ([...document.querySelectorAll('.md')].pop()?.textContent || '').trim().split(/\\s+/)[0],
      notices: [...document.querySelectorAll('.notice')].map(n => n.textContent),
      hint: document.getElementById('hint').textContent,
    })`), null, 1));
  },

  // Переключатель отдельной конфигурации CLI.
  async isolate(t) {
    const status = () => t.evaluate(`window.api.authStatus().then(r => r.text)`);
    console.log('auth status before:', await status());
    await t.evaluate(`document.getElementById('openSettings').click()`);
    await sleep(300);
    console.log('dialog:', JSON.stringify(await t.evaluate(`({
      checked: document.getElementById('isolateCfg').checked,
      dataDir: document.getElementById('dataDir').textContent,
    })`)));
    await t.evaluate(`document.getElementById('isolateCfg').click(); document.getElementById('settingsSave').click()`);
    await sleep(1500);
    console.log('auth status after:', await status());
  },
};

async function main() {
  const t = await connect();
  if (!scenarios[SCENARIO]) throw new Error('Неизвестный сценарий: ' + SCENARIO);
  await scenarios[SCENARIO](t);
  console.log('console errors:', JSON.stringify(t.consoleErrors));
  try { await t.cdp('Browser.close'); } catch { /* окно уже закрывается */ }
  t.ws.close();
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
