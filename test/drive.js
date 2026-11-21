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
