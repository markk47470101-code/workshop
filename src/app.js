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
    mcpRun: {},
    mcpSummary: '',
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
    const flush = () => {
      b.queued = false;
      b.el.innerHTML = window.renderMarkdown(b.text);
      scroll();
    };
    // В свёрнутом или полностью перекрытом окне requestAnimationFrame не вызывается — красим по таймеру.
    if (document.hidden) setTimeout(flush, 50);
    else requestAnimationFrame(flush);
  }

  function newThinkingBlock() {
    const d = el('details', 'thinking');
    const body = el('div', 'thinking-body');
    d.append(el('summary', null, 'Размышление'), body);
    assistant().append(d);
    return { type: 'thinking', el: body, text: '' };
  }

  // ───────────── карточки инструментов ─────────────

  // mcp__сервер__инструмент → «сервер · инструмент»
  function toolLabel(name) {
    return typeof name === 'string' && name.startsWith('mcp__')
      ? name.slice(5).replace(/^claude_ai_/, '').replace('__', ' · ')
      : name;
  }

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
    // mcp__сервер__инструмент → «сервер · инструмент»
    sum.append(el('span', 'tool-name', toolLabel(name)), desc, st);
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

  const MCP_RUN_LABEL = {
    connected: 'подключён',
    failed: 'не удалось подключиться',
    'needs-auth': 'нужна авторизация',
    pending: 'подключается…',
    disabled: 'отключён',
  };

  // Статус MCP-серверов из события init: проблемные показываем сразу, остальное — в строке под полем ввода.
  // Касается ли сервер пользователя: свои серверы приложения и разрешённые коннекторы аккаунта.
  // Остальные коннекторы аккаунта (например, ещё не авторизованные) чат предупреждениями не засоряют.
  const isRelevantMcp = (name) =>
    mcpState.servers.some((s) => s.name === name) ||
    (state.settings.allowedConnectors || []).includes(name);

  function onMcpStatus(list) {
    state.mcpRun = {};
    state.mcpSummary = '';
    let connected = 0;
    let pending = 0;
    let total = 0;
    for (const s of list) {
      if (!s || !s.name) continue;
      state.mcpRun[s.name] = s.status;
      if (!isRelevantMcp(s.name)) continue;
      total++;
      if (s.status === 'connected') connected++;
      else if (s.status === 'pending') pending++;
      else if (s.status === 'failed' || s.status === 'needs-auth') {
        const own = mcpState.servers.find((x) => x.name === s.name);
        const hint = own && own.auth === 'oauth' ? ' — войдите: «MCP-серверы» → «Войти»' : '';
        notice('MCP-сервер «' + s.name + '»: ' + (MCP_RUN_LABEL[s.status] || s.status) + hint, 'warn');
      }
    }
    if (total) state.mcpSummary = ' · MCP: ' + connected + '/' + total + (pending ? '…' : '');
    if (state.running) showTyping();
    if ($('mcpDlg').open) renderMcpList();
  }

  function onSystem(ev) {
    if (ev.subtype !== 'init') return;
    onMcpStatus(Array.isArray(ev.mcp_servers) ? ev.mcp_servers : []);
    if (ev.model) {
      $('hint').textContent =
        'Модель: ' + ev.model + state.mcpSummary + ' · Enter — отправить · Esc — остановить';
    }
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
      const all = [...new Set(denials.map((d) => d.tool_name || d.toolName || '?'))];
      const mcpNames = all.filter((n) => String(n).startsWith('mcp__'));
      const other = all.filter((n) => !String(n).startsWith('mcp__'));
      if (mcpNames.length) {
        notice(
          'Claude хотел вызвать MCP-инструменты: ' + mcpNames.map(toolLabel).join(', ') +
            '. Они не разрешены заранее — включите «Разрешать Claude вызывать инструменты без подтверждения» ' +
            'у сервера: «MCP-серверы» → «Изменить».',
          'warn'
        );
      }
      if (other.length) {
        notice(
          'Claude хотел использовать: ' + other.join(', ') +
            '. Текущий режим этого не разрешает — при необходимости переключите режим сверху.',
          'warn'
        );
      }
    }

    const parts = [];
    if (ev.duration_ms) parts.push((ev.duration_ms / 1000).toFixed(1) + ' с');
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
    $('bannerForm').classList.add('hidden');
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

  // Вход: CLI печатает ссылку и ждёт код со страницы входа (или сам получает ответ браузера).
  const URL_RE = /https?:\/\/\S+/;
  const login = { url: null, log: '', cancelled: false };

  function renderLoginBanner() {
    const actions = $('bannerActions');
    actions.textContent = '';
    if (login.url) {
      actions.append(
        button('Открыть ссылку', () => api.openExternal(login.url)),
        button('Копировать ссылку', () => api.copy(login.url))
      );
    }
    actions.append(button('Отмена', () => { login.cancelled = true; api.authCancel(); }, 'ghost'));

    // Служебный вывод CLI без ссылки и без приглашения к вводу.
    const shown = login.log
      .replace(/If the browser didn't open, visit:/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/Paste code here if prompted >/g, '')
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('\n');
    const log = $('bannerLog');
    log.textContent = shown;
    log.classList.toggle('hidden', !shown);
  }

  function loginFailure(r) {
    const lines = login.log.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).reverse();
    const reason = lines.find((l) => /couldn.t log in|error|failed|invalid|expired/i.test(l));
    return (reason || r.error || 'Вход не выполнен.') + ' Нажмите «Войти», чтобы получить новую ссылку и код.';
  }

  async function doLogin() {
    login.url = null;
    login.log = '';
    login.cancelled = false;
    showBanner(
      'Войдите в аккаунт Anthropic. Откроется браузер. Если страница покажет код — вставьте его ниже и нажмите «Отправить код».',
      []
    );
    $('bannerForm').classList.remove('hidden');
    $('authCode').value = '';
    renderLoginBanner();
    $('authCode').focus();

    const r = await api.authLogin();
    $('bannerForm').classList.add('hidden');
    await refreshAuth();
    if (!state.authOk && state.claudePath !== null) {
      showBanner(login.cancelled ? 'Вход отменён.' : loginFailure(r), [button('Войти', doLogin, 'primary')]);
    }
  }

  async function sendAuthCode() {
    const code = $('authCode').value.trim();
    if (!code) return;
    const ok = await api.authCode(code);
    if (!ok) {
      $('bannerText').textContent = 'Не удалось передать код: вход не запущен или уже завершён. Нажмите «Войти» ещё раз.';
      return;
    }
    $('authCode').value = '';
    $('bannerText').textContent = 'Проверяю код…';
  }

  $('authSend').addEventListener('click', sendAuthCode);
  $('authCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendAuthCode();
    }
  });

  api.onAuthLog((text) => {
    login.log = (login.log + text).slice(-4000);
    const m = login.log.match(URL_RE);
    if (m) login.url = m[0];
    renderLoginBanner();
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

  // ───────────── MCP-серверы ─────────────

  const mcpState = { servers: [], strict: false, tests: {}, editingId: null, oauthBusy: null };

  // Готовые серверы одной кнопкой. Вход (OAuth) пользователь запускает отдельно.
  const MCP_PRESETS = {
    higgsfield: {
      name: 'higgsfield',
      type: 'http',
      url: 'https://mcp.higgsfield.ai/mcp',
      auth: 'oauth',
      autoApprove: true,
    },
    // Рабочая система компании (задачи агентам, согласования, юридические справки).
    cifer: {
      name: '1cifer',
      type: 'http',
      url: 'https://mcp.1cifer.kz/mcp',
      auth: 'oauth',
      // Сервер разрешён целиком, но решения по карточкам согласования и удаление задач остаются за человеком.
      autoApprove: true,
      denyTools: ['decide', 'delete_tasks'],
    },
  };

  const mcpSummary = (s) => (s.type === 'stdio' ? [s.command, ...s.args].join(' ') : s.url);

  function updateMcpBadge() {
    const n = mcpState.servers.filter((s) => s.enabled).length;
    const badge = $('mcpBadge');
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n === 0);
  }

  function describeTest(r) {
    if (r.ok) {
      const info = r.serverInfo ? [r.serverInfo.name, r.serverInfo.version].filter(Boolean).join(' ') : '';
      const shown = r.tools.slice(0, 10).map((t) => t.name).join(', ') + (r.tools.length > 10 ? '…' : '');
      return {
        cls: 'ok',
        text:
          '✓ Подключено' + (info ? ' · ' + info : '') +
          '\nИнструментов: ' + r.tools.length + (shown ? ' — ' + shown : '') +
          (r.note ? '\n' + r.note : ''),
      };
    }
    return { cls: r.unsupported ? '' : 'bad', text: (r.unsupported ? '' : '✕ ') + r.error };
  }

  function mcpStatusFor(s) {
    if (mcpState.tests[s.id]) return mcpState.tests[s.id];
    const run = state.mcpRun[s.name];
    if (run) {
      return { cls: run === 'connected' ? 'ok' : 'bad', text: 'В последнем запуске: ' + (MCP_RUN_LABEL[run] || run) };
    }
    return null;
  }

  function renderMcpList() {
    const box = $('mcpList');
    box.textContent = '';
    $('mcpStrict').checked = mcpState.strict;
    if (!mcpState.servers.length) {
      box.append(el('div', 'mcp-empty', 'Серверов пока нет. Добавьте сервер или вставьте JSON из его документации.'));
      return;
    }
    for (const s of mcpState.servers) {
      const item = el('div', 'mcp-item' + (s.enabled ? '' : ' off'));

      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.checked = s.enabled;
      sw.title = s.enabled ? 'Включён — нажмите, чтобы отключить' : 'Отключён — нажмите, чтобы включить';
      sw.setAttribute('aria-label', 'Сервер включён');
      sw.addEventListener('change', () => toggleMcp(s, sw.checked));
      const top = el('div', 'mcp-top');
      top.append(sw, el('span', 'mcp-name', s.name), el('span', 'mcp-type', s.type));

      const sum = el('div', 'mcp-sum', mcpSummary(s));
      sum.title = mcpSummary(s);
      item.append(top, sum);
      if (s.auth === 'oauth') item.append(oauthLine(s));
      if (!s.autoApprove) {
        item.append(el(
          'div',
          'mcp-status warn',
          'Вызовы инструментов отклоняются. Выберите, что можно разрешить, в «Разрешения».'
        ));
      } else if (Array.isArray(s.allowTools)) {
        const denied = s.denyTools || [];
        const total = (s.knownTools || []).length || s.allowTools.length + denied.length;
        item.append(el(
          'div',
          'mcp-status',
          'Разрешено инструментов: ' + s.allowTools.length + ' из ' + total +
            (denied.length ? ' · запрещены: ' + denied.join(', ') : '')
        ));
      } else if (s.denyTools && s.denyTools.length) {
        item.append(el('div', 'mcp-status', 'Всегда запрещены: ' + s.denyTools.join(', ')));
      }

      const st = mcpStatusFor(s);
      if (st) item.append(el('div', 'mcp-status ' + st.cls, st.text));

      const actions = el('div', 'mcp-actions');
      if (s.auth === 'oauth') {
        if (mcpState.oauthBusy === s.id) {
          actions.append(button('Отмена входа', () => api.mcpOAuthCancel(), 'sm'));
        } else {
          const signedIn = s.oauth && s.oauth.state === 'ok';
          actions.append(button(signedIn ? 'Войти заново' : 'Войти', () => oauthLogin(s), 'sm primary'));
          if (signedIn) actions.append(button('Выйти', () => oauthLogout(s), 'sm'));
        }
      }
      actions.append(
        button('Разрешения', () => openPermissions(s), 'sm'),
        button('Проверить', () => testMcp(s), 'sm'),
        button('Изменить', () => editMcp(s), 'sm'),
        button('Удалить', () => deleteMcp(s), 'sm')
      );
      item.append(actions);
      box.append(item);
    }
  }

  function oauthLine(s) {
    const o = s.oauth || { state: 'none' };
    let cls = 'warn';
    let text = 'OAuth: нужен вход';
    if (mcpState.oauthBusy === s.id) {
      text = 'OAuth: жду подтверждения входа в браузере…';
    } else if (o.state === 'ok') {
      cls = 'ok';
      text = '✓ OAuth: вход выполнен';
      if (o.expiresAt && o.canRefresh) text += ' · токен обновляется сам';
      else if (o.expiresAt) {
        text += ' · токен до ' + new Date(o.expiresAt).toLocaleString('ru-RU', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
      }
    } else if (o.state === 'expired') {
      text = 'OAuth: сессия истекла — войдите снова';
    }
    return el('div', 'mcp-status ' + cls, text);
  }

  async function oauthLogin(s) {
    mcpState.oauthBusy = s.id;
    mcpState.tests[s.id] = { cls: '', text: 'Открываю браузер… Подтвердите вход там и вернитесь сюда.' };
    renderMcpList();
    const r = await api.mcpOAuthLogin(s.id);
    mcpState.oauthBusy = null;
    await refreshMcp();
    if (!r.ok) {
      mcpState.tests[s.id] = { cls: 'bad', text: '✕ ' + r.error };
      renderMcpList();
      return;
    }
    mcpState.tests[s.id] = { cls: '', text: 'Вход выполнен. Проверяю соединение…' };
    renderMcpList();
    mcpState.tests[s.id] = describeTest(await api.mcpTest(s.id));
    await refreshMcp(); // список инструментов сохранён — обновим данные серверов
    renderMcpList();
  }

  async function oauthLogout(s) {
    await api.mcpOAuthLogout(s.id);
    delete mcpState.tests[s.id];
    delete state.mcpRun[s.name]; // статус прошлого запуска после выхода уже недостоверен
    await refreshMcp();
  }

  // ───── разрешения по инструментам ─────

  const permState = { id: null, tools: [], allowed: new Set(), fresh: new Set() };
  const PERM_BADGE = { read: 'чтение', write: 'изменяет', danger: 'опасно' };
  const PERM_ORDER = { read: 0, write: 1, danger: 2 };

  // Подсказки сервера (annotations) важнее догадок по названию.
  function classifyTool(t) {
    if (t.destructive === true) return 'danger';
    if (t.readOnly === true) return 'read';
    const n = String(t.name).toLowerCase();
    if (/(^|_)(delete|remove|drop|destroy|purge|wipe|decide|approve|reject|pay|transfer|send)(_|$)/.test(n)) return 'danger';
    if (/^(list|get|ask|search|find|read|show|fetch|query|describe|check|view|lookup)(_|$)/.test(n)) return 'read';
    return 'write';
  }

  const permServer = () => mcpState.servers.find((s) => s.id === permState.id);

  // Какие инструменты отмечены по сохранённым настройкам сервера.
  function allowedBySettings(s, tools) {
    if (!s.autoApprove) return new Set();
    const deny = new Set(s.denyTools || []);
    const base = Array.isArray(s.allowTools) ? s.allowTools : tools.map((t) => t.name);
    return new Set(base.filter((n) => !deny.has(n)));
  }

  function updatePermSummary() {
    const total = permState.tools.length;
    const allowed = permState.tools.filter((t) => permState.allowed.has(t.name)).length;
    $('mcpPermSummary').textContent = total
      ? 'Разрешено ' + allowed + ' из ' + total
      : 'Список инструментов пуст — нажмите «Обновить список».';
  }

  function renderPerms() {
    const s = permServer();
    $('mcpPermTitle').textContent = 'Разрешения: ' + (s ? s.name : '');
    const box = $('mcpPermList');
    box.textContent = '';
    const sorted = [...permState.tools].sort(
      (a, b) =>
        PERM_ORDER[classifyTool(a)] - PERM_ORDER[classifyTool(b)] || a.name.localeCompare(b.name)
    );
    for (const t of sorted) {
      const kind = classifyTool(t);
      const row = el('label', 'perm-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = permState.allowed.has(t.name);
      cb.dataset.tool = t.name;
      cb.addEventListener('change', () => {
        if (cb.checked) permState.allowed.add(t.name);
        else permState.allowed.delete(t.name);
        updatePermSummary();
      });
      const head = el('div');
      head.append(el('span', 'perm-name', t.name), el('span', 'perm-badge ' + kind, PERM_BADGE[kind]));
      if (permState.fresh.has(t.name)) head.append(el('span', 'perm-badge fresh', 'новый'));
      row.append(cb, head, el('div', 'perm-desc', t.description || 'Без описания'));
      box.append(row);
    }
    updatePermSummary();
  }

  function applyPermPreset(kind) {
    const pick = { read: (k) => k === 'read', safe: (k) => k !== 'danger', all: () => true, none: () => false }[kind];
    if (!pick) return;
    permState.allowed = new Set(permState.tools.filter((t) => pick(classifyTool(t))).map((t) => t.name));
    renderPerms();
  }

  async function refreshPermTools() {
    const s = permServer();
    if (!s) return;
    showResult('mcpPermResult', { cls: '', text: 'Запрашиваю список инструментов у сервера…' });
    const r = await api.mcpTest(s.id);
    if (!r.ok) {
      showResult('mcpPermResult', { cls: 'bad', text: '✕ ' + r.error });
      return;
    }
    const before = new Set(permState.tools.map((t) => t.name));
    if (before.size) {
      permState.fresh = new Set(r.tools.map((t) => t.name).filter((n) => !before.has(n)));
      permState.allowed = new Set([...permState.allowed].filter((n) => r.tools.some((t) => t.name === n)));
    } else {
      permState.fresh = new Set();
      permState.allowed = allowedBySettings(s, r.tools);
    }
    permState.tools = r.tools;
    $('mcpPermResult').className = 'mcp-result hidden';
    if (permState.fresh.size) {
      showResult('mcpPermResult', {
        cls: '',
        text: 'Новые инструменты: ' + [...permState.fresh].join(', ') + '. По умолчанию они не разрешены.',
      });
    }
    await refreshMcp(); // список инструментов сохранён в настройках сервера
    renderPerms();
  }

  async function openPermissions(s) {
    permState.id = s.id;
    permState.tools = s.knownTools || [];
    permState.allowed = allowedBySettings(s, permState.tools);
    permState.fresh = new Set();
    $('mcpPermResult').className = 'mcp-result hidden';
    renderPerms();
    showMcpView('perm');
    if (!permState.tools.length) await refreshPermTools();
  }

  async function savePerms() {
    const s = permServer();
    if (!s) return;
    const names = permState.tools.map((t) => t.name);
    const allowed = names.filter((n) => permState.allowed.has(n));
    const denied = names.filter((n) => !permState.allowed.has(n));
    // Явный список разрешённых: новые инструменты сервера остаются недоступными, пока их не отметят.
    const r = await api.mcpSave({
      ...s,
      autoApprove: allowed.length > 0,
      allowTools: allowed,
      denyTools: denied,
      knownTools: permState.tools,
    });
    if (!r.ok) {
      showResult('mcpPermResult', { cls: 'bad', text: '✕ ' + r.error });
      return;
    }
    mcpState.servers = r.servers;
    updateMcpBadge();
    renderMcpList();
    showMcpView('list');
  }

  async function addMcpPreset(key) {
    const preset = MCP_PRESETS[key];
    if (!mcpState.servers.some((s) => s.name === preset.name)) {
      const r = await api.mcpSave(preset);
      if (!r.ok) {
        mcpState.tests.preset = { cls: 'bad', text: '✕ ' + r.error };
        alert(r.error);
        return;
      }
      mcpState.servers = r.servers;
      updateMcpBadge();
    }
    renderMcpList();
  }

  async function refreshMcp() {
    try {
      const r = await api.mcpList();
      mcpState.servers = r.servers;
      mcpState.strict = r.strict;
    } catch { /* оставляем прежний список */ }
    updateMcpBadge();
    if ($('mcpDlg').open) renderMcpList();
  }

  function showMcpView(name) {
    $('mcpListView').classList.toggle('hidden', name !== 'list');
    $('mcpFormView').classList.toggle('hidden', name !== 'form');
    $('mcpJsonView').classList.toggle('hidden', name !== 'json');
    $('mcpPermView').classList.toggle('hidden', name !== 'perm');
  }

  function syncMcpType() {
    const stdio = $('mcpType').value === 'stdio';
    $('mcpStdioFields').classList.toggle('hidden', !stdio);
    $('mcpRemoteFields').classList.toggle('hidden', stdio);
    $('mcpClientIdField').classList.toggle('hidden', stdio || $('mcpAuth').value !== 'oauth');
  }

  function showResult(id, r) {
    const box = $(id);
    box.className = 'mcp-result ' + r.cls;
    box.textContent = r.text;
  }

  function editMcp(s) {
    mcpState.editingId = s ? s.id : null;
    const stdio = !s || s.type === 'stdio';
    $('mcpName').value = s ? s.name : '';
    $('mcpType').value = s ? s.type : 'stdio';
    $('mcpCommand').value = s && stdio ? s.command : '';
    $('mcpArgs').value = s && stdio ? s.args.join('\n') : '';
    $('mcpEnv').value = s && stdio ? Object.entries(s.env).map(([k, v]) => k + '=' + v).join('\n') : '';
    $('mcpUrl').value = s && !stdio ? s.url : '';
    $('mcpAuth').value = s && !stdio && s.auth === 'oauth' ? 'oauth' : 'none';
    $('mcpClientId').value = s && !stdio && s.oauthClientId ? s.oauthClientId : '';
    $('mcpHeaders').value = s && !stdio ? Object.entries(s.headers).map(([k, v]) => k + ': ' + v).join('\n') : '';
    $('mcpAuto').checked = s ? s.autoApprove : true;
    $('mcpDeny').value = s && s.denyTools ? s.denyTools.join('\n') : '';
    // Если разрешения настроены по инструментам, простые поля здесь не нужны.
    const managed = !!(s && Array.isArray(s.allowTools));
    $('mcpPermSimple').classList.toggle('hidden', managed);
    $('mcpPermManaged').classList.toggle('hidden', !managed);
    $('mcpTestResult').className = 'mcp-result hidden';
    syncMcpType();
    showMcpView('form');
    $('mcpName').focus();
  }

  function readMcpForm() {
    const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const existing = mcpState.servers.find((s) => s.id === mcpState.editingId);
    const type = $('mcpType').value;
    const draft = {
      id: mcpState.editingId || undefined,
      name: $('mcpName').value.trim(),
      type,
      enabled: existing ? existing.enabled : true,
      autoApprove: $('mcpAuto').checked,
      denyTools: lines($('mcpDeny').value),
    };
    if (existing && Array.isArray(existing.allowTools)) {
      draft.autoApprove = existing.autoApprove;
      draft.denyTools = existing.denyTools;
      draft.allowTools = existing.allowTools;
    }
    if (type === 'stdio') {
      draft.command = $('mcpCommand').value.trim();
      draft.args = lines($('mcpArgs').value);
      draft.env = {};
      for (const l of lines($('mcpEnv').value)) {
        const i = l.indexOf('=');
        if (i > 0) draft.env[l.slice(0, i).trim()] = l.slice(i + 1);
      }
    } else {
      draft.url = $('mcpUrl').value.trim();
      draft.auth = $('mcpAuth').value;
      draft.oauthClientId = $('mcpClientId').value.trim();
      draft.headers = {};
      for (const l of lines($('mcpHeaders').value)) {
        const i = l.indexOf(':');
        if (i > 0) draft.headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
    }
    return draft;
  }

  async function saveMcpForm() {
    const r = await api.mcpSave(readMcpForm());
    if (!r.ok) { showResult('mcpTestResult', { cls: 'bad', text: '✕ ' + r.error }); return; }
    mcpState.servers = r.servers;
    delete mcpState.tests[r.server.id];
    updateMcpBadge();
    renderMcpList();
    showMcpView('list');
  }

  async function testMcpForm() {
    showResult('mcpTestResult', { cls: '', text: 'Проверяю… Первый запуск через npx может занять до минуты.' });
    showResult('mcpTestResult', describeTest(await api.mcpTest(readMcpForm())));
  }

  async function testMcp(s) {
    mcpState.tests[s.id] = { cls: '', text: 'Проверяю…' };
    renderMcpList();
    mcpState.tests[s.id] = describeTest(await api.mcpTest(s.id));
    await refreshMcp(); // список инструментов сохранён — обновим данные серверов
    renderMcpList();
  }

  async function toggleMcp(s, enabled) {
    const r = await api.mcpSave({ ...s, enabled });
    if (r.ok) mcpState.servers = r.servers;
    updateMcpBadge();
    renderMcpList();
  }

  async function deleteMcp(s) {
    if (!window.confirm('Удалить MCP-сервер «' + s.name + '»?')) return;
    mcpState.servers = await api.mcpDelete(s.id);
    delete mcpState.tests[s.id];
    updateMcpBadge();
    renderMcpList();
  }

  async function importMcp() {
    const r = await api.mcpImport($('mcpJson').value);
    if (!r.ok) { showResult('mcpJsonResult', { cls: 'bad', text: '✕ ' + r.error }); return; }
    mcpState.servers = r.servers;
    updateMcpBadge();
    renderMcpList();
    const parts = [];
    if (r.added.length) parts.push('Добавлено: ' + r.added.join(', ') + '.');
    for (const s of r.skipped) parts.push('Пропущен «' + s.name + '»: ' + s.reason + '.');
    showResult('mcpJsonResult', { cls: r.added.length ? 'ok' : 'bad', text: parts.join('\n') || 'Нечего добавлять.' });
    if (r.added.length) $('mcpJson').value = '';
  }

  // Коннекторы аккаунта Claude: показываем статус и даём разрешить вызовы их инструментов.
  const connState = { list: null, loading: false, error: null };

  function connStatusText(c) {
    if (c.status === 'connected') return '✓ Подключён';
    if (c.status === 'needs-auth') return 'Нужна авторизация — подключите коннектор на claude.ai (Settings → Connectors)';
    return '✕ Не удалось подключиться';
  }

  function renderConnectors() {
    const box = $('connList');
    box.textContent = '';
    if (connState.loading) { box.append(el('div', 'mcp-empty', 'Загружаю список…')); return; }
    if (connState.error) { box.append(el('div', 'mcp-empty', connState.error)); return; }
    if (!connState.list || !connState.list.length) {
      box.append(el('div', 'mcp-empty', 'Коннекторов не найдено. Подключите их на claude.ai — CLI подхватит их сам (нужен вход в аккаунт).'));
      return;
    }
    if (mcpState.strict) {
      box.append(el('div', 'dlg-note', 'Включён режим «Только серверы Mark Desk»: коннекторы сейчас не подключаются.'));
    }
    const allowed = new Set(state.settings.allowedConnectors || []);
    for (const c of connState.list) {
      const item = el('div', 'mcp-item');
      const left = el('div', 'mcp-top');
      left.append(el('span', 'mcp-name', c.name.replace(/^claude\.ai /, '')), el('span', 'mcp-type', 'claude.ai'));

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = allowed.has(c.name);
      cb.addEventListener('change', () => toggleConnector(c.name, cb.checked));
      const label = el('label', 'check');
      label.title = 'Claude сможет вызывать инструменты этого коннектора без подтверждения';
      label.append(cb, el('span', null, 'Разрешить'));

      const row = el('div', 'mcp-conn-row');
      row.append(left, label);
      const cls = c.status === 'connected' ? 'ok' : c.status === 'needs-auth' ? '' : 'bad';
      item.append(row, el('div', 'mcp-status ' + cls, connStatusText(c)));
      box.append(item);
    }
  }

  async function loadConnectors(force) {
    if (connState.loading || (connState.list && !force)) return;
    connState.loading = true;
    connState.error = null;
    renderConnectors();
    try {
      const r = await api.connectorsList();
      if (r.ok) connState.list = r.connectors;
      else connState.error = r.error;
    } catch (err) {
      connState.error = String(err.message || err);
    }
    connState.loading = false;
    renderConnectors();
  }

  async function toggleConnector(name, on) {
    const cur = new Set(state.settings.allowedConnectors || []);
    if (on) cur.add(name); else cur.delete(name);
    state.settings = (await api.setSettings({ allowedConnectors: [...cur] })).settings;
    renderConnectors();
  }

  $('connReload').addEventListener('click', () => loadConnectors(true));

  $('openMcp').addEventListener('click', async () => {
    await refreshMcp();
    showMcpView('list');
    renderMcpList();
    $('mcpDlg').showModal();
    loadConnectors(false);
  });
  $('mcpClose').addEventListener('click', () => $('mcpDlg').close());
  $('mcpAdd').addEventListener('click', () => editMcp(null));
  $('mcpImport').addEventListener('click', () => {
    $('mcpJson').value = '';
    $('mcpJsonResult').className = 'mcp-result hidden';
    showMcpView('json');
    $('mcpJson').focus();
  });
  $('mcpPermCancel').addEventListener('click', () => showMcpView('list'));
  $('mcpPermSave').addEventListener('click', savePerms);
  $('mcpPermRefresh').addEventListener('click', refreshPermTools);
  document.querySelectorAll('#mcpPermView [data-preset]').forEach((b) => {
    b.addEventListener('click', () => applyPermPreset(b.dataset.preset));
  });
  $('mcpType').addEventListener('change', syncMcpType);
  $('mcpAuth').addEventListener('change', syncMcpType);
  $('mcpPreset').addEventListener('click', () => addMcpPreset('higgsfield'));
  $('mcpPresetCifer').addEventListener('click', () => addMcpPreset('cifer'));
  $('mcpFormCancel').addEventListener('click', () => showMcpView('list'));
  $('mcpFormTest').addEventListener('click', testMcpForm);
  $('mcpFormSave').addEventListener('click', saveMcpForm);
  $('mcpJsonCancel').addEventListener('click', () => showMcpView('list'));
  $('mcpJsonDo').addEventListener('click', importMcp);
  $('mcpStrict').addEventListener('change', async (e) => {
    state.settings = (await api.setSettings({ strictMcp: e.target.checked })).settings;
    mcpState.strict = e.target.checked;
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
    refreshMcp();
    input.focus();
  })();
})();
