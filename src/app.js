'use strict';

(() => {
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  const chat = $('chat');
  const chatInner = $('chatInner');
  const input = $('input');
  const sendBtn = $('sendBtn');

  const MODELS = [
    ['', 'По умолчанию'],
    ['fable', 'Fable'],
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['haiku', 'Haiku'],
  ];
  const MODES = [
    ['acceptEdits', 'Принимать правки'],
    ['plan', 'Только план'],
    ['auto', 'Авто'],
    ['bypassPermissions', 'Всё разрешено ⚠'],
  ];
  const SUGGESTIONS = [
    'Объясни структуру этого проекта',
    'Найди возможные ошибки в коде и предложи исправления',
    'Напиши README для проекта',
  ];

  const state = {
    settings: { cwd: '', model: '', permissionMode: 'acceptEdits', claudePath: '' },
    claudePath: null,
    chatId: null,
    running: false,
    sessions: [],
    filter: '',
    authOk: null,
    // состояние отрисовки текущего хода
    cur: null,
    streamed: new Set(),
    live: new Map(),
    tools: new Map(),
    typingEl: null,
    lastNotice: '',
    hadResult: false,
    stick: true,
  };

  // ───────────── утилиты ─────────────

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\n… (обрезано)' : s);
  const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p : '');

  function relTime(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) return Math.floor(s / 60) + ' мин';
    if (s < 86400) return Math.floor(s / 3600) + ' ч';
    return Math.floor(s / 86400) + ' дн';
  }

  function bucketOf(ms) {
    const startToday = new Date().setHours(0, 0, 0, 0);
    if (ms >= startToday) return 'Сегодня';
    if (ms >= startToday - 86400000) return 'Вчера';
    if (ms >= startToday - 6 * 86400000) return 'Последние 7 дней';
    return 'Ранее';
  }

  let scrollQueued = false;
  function scroll(force) {
    if (!force && !state.stick) return;
    if (force) chat.scrollTop = chat.scrollHeight;
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      chat.scrollTop = chat.scrollHeight;
    });
  }
  chat.addEventListener('scroll', () => {
    state.stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
  });

  // ───────────── отрисовка чата ─────────────

  function clearEmpty() {
    const e = chatInner.querySelector('.empty');
    if (e) e.remove();
  }

  function showEmpty() {
    chatInner.textContent = '';
    const box = el('div', 'empty');
    box.append(
      el('h1', null, 'С чего начнём?'),
      el('p', 'empty-sub', 'Рабочая папка: ' + state.settings.cwd)
    );
    const list = el('div', 'suggest');
    for (const text of SUGGESTIONS) {
      const b = el('button', 'suggest-btn', text);
      b.type = 'button';
      b.addEventListener('click', () => {
        input.value = text;
        autoGrow();
        input.focus();
      });
      list.append(b);
    }
    box.append(list);
    chatInner.append(box);
  }

  function resetChat() {
    chatInner.textContent = '';
    state.cur = null;
    state.streamed.clear();
    state.live.clear();
    state.tools.clear();
    state.typingEl = null;
    state.lastNotice = '';
    state.stick = true;
  }

  function endTurn() {
    state.cur = null;
    state.live.clear();
  }

  function showTyping() {
    if (state.typingEl) return;
    const t = el('div', 'typing');
    t.append(el('span'), el('span'), el('span'));
    state.typingEl = t;
    chatInner.append(t);
    scroll(true);
  }

  function removeTyping() {
    if (state.typingEl) {
      state.typingEl.remove();
      state.typingEl = null;
    }
  }

  function addUser(text) {
    clearEmpty();
    endTurn();
    const m = el('div', 'msg user');
    const b = el('div', 'bubble');
    b.textContent = text;
    m.append(b);
    chatInner.append(m);
    scroll(true);
  }

  function assistant() {
    clearEmpty();
    removeTyping();
    if (!state.cur) {
      const m = el('div', 'msg assistant');
      const body = el('div', 'blocks');
      m.append(body);
      chatInner.append(m);
      state.cur = body;
    }
    return state.cur;
  }

  function notice(text, kind) {
    if (!text || state.lastNotice === text) return;
    state.lastNotice = text;
    clearEmpty();
    removeTyping();
    endTurn();
    const n = el('div', 'notice ' + (kind || 'info'), text);
    chatInner.append(n);
    scroll(true);
  }

  function newTextBlock() {
    const d = el('div', 'md');
    assistant().append(d);
    return { type: 'text', el: d, text: '', queued: false };
  }

  function paintText(b) {
    if (b.queued) return;
    b.queued = true;
    requestAnimationFrame(() => {
      b.queued = false;
      b.el.innerHTML = window.renderMarkdown(b.text);
      scroll();
    });
  }

  function newThinkingBlock() {
    const d = el('details', 'thinking');
    const body = el('div', 'thinking-body');
    d.append(el('summary', null, 'Размышление'), body);
    assistant().append(d);
    return { type: 'thinking', el: body, text: '' };
  }

  // ───────────── карточки инструментов ─────────────

  function toolSummary(name, input) {
    if (!input || typeof input !== 'object') return '';
    const pick =
      input.command ?? input.file_path ?? input.path ?? input.pattern ??
      input.query ?? input.url ?? input.description ?? input.prompt ?? '';
    return String(pick).split('\n')[0].slice(0, 160);
  }

  function formatToolInput(name, input) {
    if (!input || typeof input !== 'object') return '';
    if (typeof input.command === 'string') return input.command;
    if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      const head = input.file_path ? input.file_path + '\n' : '';
      const minus = input.old_string.split('\n').map((l) => '- ' + l).join('\n');
      const plus = input.new_string.split('\n').map((l) => '+ ' + l).join('\n');
      return clip(head + minus + '\n' + plus, 4000);
    }
    if (name === 'Write' && typeof input.content === 'string') {
      return clip((input.file_path || '') + '\n' + input.content, 4000);
    }
    try { return clip(JSON.stringify(input, null, 2), 4000); } catch { return String(input); }
  }

  function resultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[изображение]' : ''))
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  function ensureTool(id, name) {
    let t = state.tools.get(id);
    if (t) return t;
    const d = el('details', 'tool');
    const desc = el('span', 'tool-desc');
    const st = el('span', 'tool-state running');
    const sum = el('summary');
    sum.append(el('span', 'tool-name', name), desc, st);
    const inPre = el('pre', 'tool-in');
    const outLabel = el('div', 'tool-label hidden', 'Результат');
    const outPre = el('pre', 'tool-out hidden');
    const body = el('div', 'tool-body');
    body.append(el('div', 'tool-label', 'Вход'), inPre, outLabel, outPre);
    d.append(sum, body);
    assistant().append(d);
    t = { id, name, d, desc, st, inPre, outLabel, outPre, done: false };
    state.tools.set(id, t);
    scroll();
    return t;
  }

  function setToolInput(t, input) {
    t.desc.textContent = toolSummary(t.name, input);
    t.inPre.textContent = formatToolInput(t.name, input);
  }

  function setToolResult(t, content, isError) {
    t.done = true;
    t.st.className = 'tool-state ' + (isError ? 'error' : 'done');
    t.outLabel.classList.remove('hidden');
    t.outPre.classList.remove('hidden');
    t.outPre.textContent = clip(resultText(content), 5000) || '(пусто)';
    if (isError) t.d.classList.add('is-error');
  }

  // ───────────── события CLI ─────────────

  function handleEvent(ev, replay) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'system': onSystem(ev); break;
      case 'stream_event': if (!replay && !ev.parent_tool_use_id) onStream(ev.event); break;
      case 'assistant': if (!ev.parent_tool_use_id) onAssistant(ev, replay); break;
      case 'user': if (!ev.parent_tool_use_id) onUser(ev, replay); break;
      case 'result': onResult(ev); break;
      case 'raw': notice(ev.text, 'muted'); break;
      case 'notice': notice(ev.text, ev.kind); break;
      default: break;
    }
  }

  function onSystem(ev) {
    if (ev.subtype !== 'init') return;
    if (ev.model) $('hint').textContent = 'Модель: ' + ev.model + ' · Enter — отправить · Esc — остановить';
  }

  function onStream(e) {
    if (!e) return;
    switch (e.type) {
      case 'message_start':
        if (e.message && e.message.id) state.streamed.add(e.message.id);
        state.live.clear();
        break;
      case 'content_block_start': {
        const b = e.content_block || {};
        if (b.type === 'text') state.live.set(e.index, newTextBlock());
        else if (b.type === 'thinking') state.live.set(e.index, newThinkingBlock());
        else if (b.type === 'tool_use') {
          state.live.set(e.index, { type: 'tool', tool: ensureTool(b.id, b.name), json: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const lb = state.live.get(e.index);
        const d = e.delta || {};
        if (!lb) break;
        if (d.type === 'text_delta' && lb.type === 'text') {
          lb.text += d.text;
          paintText(lb);
        } else if (d.type === 'thinking_delta' && lb.type === 'thinking') {
          lb.text += d.thinking;
          lb.el.textContent = lb.text;
          scroll();
        } else if (d.type === 'input_json_delta' && lb.type === 'tool') {
          lb.json += d.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const lb = state.live.get(e.index);
        if (lb && lb.type === 'tool') {
          try { setToolInput(lb.tool, JSON.parse(lb.json || '{}')); } catch { /* ждём полное сообщение */ }
        }
        break;
      }
      default: break;
    }
  }

  function onAssistant(ev, replay) {
    const msg = ev.message || {};
    const streamed = !replay && state.streamed.has(msg.id);
    const synthetic = msg.model === '<synthetic>';
    const content = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];

    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text') {
        if (synthetic) {
          notice(b.text, 'error');
          if (/not logged in|\/login|authentication/i.test(b.text) || ev.error === 'authentication_failed') {
            setAuth(false);
          }
        } else if (!streamed && b.text && b.text.trim()) {
          const tb = newTextBlock();
          tb.text = b.text;
          paintText(tb);
        }
      } else if (b.type === 'thinking') {
        if (!streamed && b.thinking) {
          const th = newThinkingBlock();
          th.el.textContent = b.thinking;
        }
      } else if (b.type === 'tool_use') {
        setToolInput(ensureTool(b.id, b.name), b.input);
      }
    }
  }

  function onUser(ev, replay) {
    const c = ev.message && ev.message.content;
    if (Array.isArray(c)) {
      let hasResult = false;
      const texts = [];
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'tool_result') {
          hasResult = true;
          const t = state.tools.get(b.tool_use_id);
          if (t) setToolResult(t, b.content, !!b.is_error);
        } else if (b.type === 'text') texts.push(b.text);
      }
      if (replay && !hasResult && texts.length) addReplayedUser(texts.join('\n'));
    } else if (replay && typeof c === 'string') {
      addReplayedUser(c);
    }
  }

  function addReplayedUser(text) {
    if (/^\s*<(local-command|command-)/.test(text)) return;
    addUser(text);
  }

  function onResult(ev) {
    state.hadResult = true;

    if (ev.is_error) notice(ev.result || 'Ошибка: ' + (ev.subtype || 'неизвестно'), 'error');

    const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
    if (denials.length) {
      const names = [...new Set(denials.map((d) => d.tool_name || d.toolName || '?'))].join(', ');
      notice(
        'Claude хотел использовать: ' + names +
          '. Текущий режим этого не разрешает — при необходимости переключите режим сверху.',
        'warn'
      );
    }

    const parts = [];
    if (ev.duration_ms) parts.push((ev.duration_ms / 1000).toFixed(1) + ' с');
    if (ev.total_cost_usd) parts.push('$' + Number(ev.total_cost_usd).toFixed(4));
    endTurn();
    if (parts.length) chatInner.append(el('div', 'run-meta', parts.join(' · ')));
    scroll();
  }

  function onDone(info) {
    removeTyping();
    for (const t of state.tools.values()) {
      if (!t.done) t.st.className = 'tool-state stopped';
    }
    endTurn();

    if (info.stopped) {
      notice('Остановлено.', 'muted');
    } else if (info.error) {
      notice(info.error, 'error');
    } else if (info.code && !state.hadResult) {
      notice((info.stderr || '').trim() || 'Процесс завершился с кодом ' + info.code, 'error');
    }
    if (/not logged in|\/login/i.test(info.stderr || '')) setAuth(false);

    setRunning(false);
    loadSessions();
    input.focus();
  }

  // ───────────── отправка ─────────────

  function setRunning(v) {
    state.running = v;
    sendBtn.classList.toggle('stop', v);
    sendBtn.textContent = v ? '■' : '↑';
    sendBtn.title = v ? 'Остановить (Esc)' : 'Отправить';
    $('newChat').disabled = v;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || state.running) return;
    addUser(text);
    input.value = '';
    autoGrow();
    state.hadResult = false;
    state.lastNotice = '';
    setRunning(true);
    showTyping();
    const res = await api.send({
      text,
      chatId: state.chatId,
      cwd: state.settings.cwd,
      model: state.settings.model,
      permissionMode: state.settings.permissionMode,
    });
    if (!res.ok) {
      removeTyping();
      notice(res.error, 'error');
      setRunning(false);
      return;
    }
    state.chatId = res.chatId;
    loadSessions();
  }

  function stop() {
    if (state.running) api.stop();
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }

  // ───────────── сессии ─────────────

  async function loadSessions() {
    try { state.sessions = await api.listSessions(); } catch { state.sessions = []; }
    renderSessions();
  }

  function renderSessions() {
    const list = $('sessionList');
    list.textContent = '';
    const q = state.filter.trim().toLowerCase();
    const items = state.sessions.filter(
      (s) => !q || s.title.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q)
    );
    if (!items.length) {
      list.append(el('div', 'side-empty', q ? 'Ничего не найдено' : 'Пока нет чатов'));
      return;
    }
    let last = '';
    for (const s of items) {
      const bucket = bucketOf(s.mtime);
      if (bucket !== last) {
        list.append(el('div', 'side-group', bucket));
        last = bucket;
      }
      const row = el('div', 'session-row');
      const b = el('button', 'session' + (s.id === state.chatId ? ' active' : ''));
      b.type = 'button';
      b.title = s.title + '\n' + (s.cwd || '');
      b.append(
        el('span', 'session-title', s.title),
        el('span', 'session-meta', [baseName(s.cwd), relTime(s.mtime)].filter(Boolean).join(' · '))
      );
      b.addEventListener('click', () => openSession(s));
      const del = el('button', 'session-del', '×');
      del.type = 'button';
      del.title = 'Удалить чат';
      del.setAttribute('aria-label', 'Удалить чат');
      del.addEventListener('click', () => deleteSession(s));
      row.append(b, del);
      list.append(row);
    }
  }

  async function deleteSession(s) {
    if (state.running && s.id === state.chatId) return;
    const name = s.title.length > 60 ? s.title.slice(0, 60) + '…' : s.title;
    if (!window.confirm('Удалить чат «' + name + '»? Это действие нельзя отменить.')) return;
    const ok = await api.deleteSession(s.id);
    if (!ok) { notice('Не удалось удалить чат.', 'error'); return; }
    if (s.id === state.chatId) newChat();
    await loadSessions();
  }

  async function openSession(s) {
    if (state.running) return;
    const r = await api.loadSession(s.id);
    if (!r.ok) { notice(r.error, 'error'); return; }
    resetChat();
    state.chatId = s.id;
    const dir = r.cwd || s.cwd;
    if (dir) {
      const ok = await setCwd(dir);
      if (!ok) notice('Папка сессии не найдена: ' + dir + '. Продолжить диалог из неё не получится.', 'warn');
    }
    for (const ev of r.events) handleEvent(ev, true);
    endTurn();
    scroll(true);
    renderSessions();
  }

  function newChat() {
    if (state.running) return;
    state.chatId = null;
    resetChat();
    showEmpty();
    renderSessions();
    input.focus();
  }

  // ───────────── настройки ─────────────

  function updateFolderLabel() {
    const label = $('folderLabel');
    label.textContent = baseName(state.settings.cwd);
    $('folderBtn').title = state.settings.cwd + '\nНажмите, чтобы сменить рабочую папку';
  }

  async function setCwd(dir) {
    const res = await api.setSettings({ cwd: dir });
    state.settings = res.settings;
    updateFolderLabel();
    return res.settings.cwd === dir;
  }

  function fillSelect(sel, options, value) {
    sel.textContent = '';
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.append(o);
    }
    sel.value = value;
  }

  // ───────────── вход и баннер ─────────────

  function showBanner(text, buttons) {
    $('banner').classList.remove('hidden');
    $('bannerText').textContent = text;
    $('bannerLog').classList.add('hidden');
    $('bannerLog').textContent = '';
    const actions = $('bannerActions');
    actions.textContent = '';
    for (const b of buttons || []) actions.append(b);
  }

  function hideBanner() {
    $('banner').classList.add('hidden');
  }

  function button(label, onClick, cls) {
    const b = el('button', 'btn ' + (cls || ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function setAuth(ok) {
    state.authOk = ok;
    const pill = $('authPill');
    pill.className = 'pill ' + (ok ? 'ok' : 'bad');
    pill.textContent = ok ? 'Вход выполнен' : 'Нужен вход';
    if (ok) hideBanner();
    else {
      showBanner(
        'Claude CLI не авторизован. Войдите в аккаунт Anthropic — откроется браузер.',
        [button('Войти', doLogin, 'primary')]
      );
    }
  }

  async function refreshAuth() {
    const r = await api.authStatus();
    if (r.noCli) {
      state.authOk = null;
      $('authPill').className = 'pill bad';
      $('authPill').textContent = 'CLI не найден';
      showBanner(
        'Claude CLI не найден. Установите его или укажите путь в настройках.',
        [button('Открыть настройки', openSettings, 'primary')]
      );
      return;
    }
    setAuth(r.loggedIn);
  }

  async function doLogin() {
    showBanner('Открываю браузер для входа… Подтвердите вход там и вернитесь сюда.', []);
    $('bannerLog').classList.remove('hidden');
    const r = await api.authLogin();
    await refreshAuth();
    if (!state.authOk) {
      showBanner(
        'Вход не выполнен' + (r.error ? ': ' + r.error : '') + '. Попробуйте ещё раз.',
        [button('Войти', doLogin, 'primary')]
      );
    }
  }

  api.onAuthLog((text) => {
    const log = $('bannerLog');
    log.classList.remove('hidden');
    log.textContent = (log.textContent + text).slice(-800);
  });

  // ───────────── диалог настроек ─────────────

  function openSettings() {
    $('cliPath').value = state.settings.claudePath || '';
    $('cliDetected').textContent = state.claudePath
      ? 'Сейчас используется: ' + state.claudePath
      : 'Claude CLI не найден.';
    $('isolateCfg').checked = !!state.settings.isolateConfig;
    $('dataDir').textContent = state.dataDir || '';
    $('settingsDlg').showModal();
  }

  $('openSettings').addEventListener('click', openSettings);
  $('settingsCancel').addEventListener('click', () => $('settingsDlg').close());
  $('cliBrowse').addEventListener('click', async () => {
    const p = await api.pickClaude();
    if (p) $('cliPath').value = p;
  });
  $('settingsSave').addEventListener('click', async () => {
    const res = await api.setSettings({
      claudePath: $('cliPath').value.trim(),
      isolateConfig: $('isolateCfg').checked,
    });
    state.settings = res.settings;
    state.claudePath = res.claudePath;
    state.dataDir = res.dataDir;
    $('settingsDlg').close();
    refreshAuth();
  });

  // ───────────── обработчики интерфейса ─────────────

  sendBtn.addEventListener('click', () => (state.running ? stop() : send()));
  $('newChat').addEventListener('click', newChat);
  $('toggleSide').addEventListener('click', () => $('app').classList.toggle('side-collapsed'));
  $('sessionFilter').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderSessions();
  });

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.running) stop();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newChat();
    }
  });

  $('folderBtn').addEventListener('click', async () => {
    if (state.running) return;
    const dir = await api.pickFolder();
    if (!dir) return;
    await setCwd(dir);
    newChat();
  });

  $('modelSel').addEventListener('change', async (e) => {
    state.settings = (await api.setSettings({ model: e.target.value })).settings;
  });
  $('modeSel').addEventListener('change', async (e) => {
    state.settings = (await api.setSettings({ permissionMode: e.target.value })).settings;
  });

  chatInner.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-ext]');
    if (link) {
      e.preventDefault();
      api.openExternal(link.getAttribute('href'));
      return;
    }
    const copyBtn = e.target.closest('.code-copy');
    if (copyBtn) {
      const code = copyBtn.closest('.code').querySelector('code').textContent;
      api.copy(code);
      copyBtn.textContent = 'Скопировано';
      setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1400);
    }
  });

  api.onEvent(({ event }) => handleEvent(event, false));
  api.onDone(onDone);

  // ───────────── старт ─────────────

  (async function init() {
    const info = await api.init();
    state.settings = info.settings;
    state.claudePath = info.claudePath;
    state.dataDir = info.dataDir;
    fillSelect($('modelSel'), MODELS, state.settings.model || '');
    fillSelect($('modeSel'), MODES, state.settings.permissionMode);
    updateFolderLabel();
    showEmpty();
    setRunning(false);
    loadSessions();
    refreshAuth();
    input.focus();
  })();
})();
