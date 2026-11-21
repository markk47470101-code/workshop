#!/usr/bin/env node
'use strict';

// Имитация Claude CLI для проверки интерфейса без входа в аккаунт и без расхода токенов.
// Понимает: `auth status`, `auth login` и `-p --output-format stream-json ...` (промпт из stdin).

const args = process.argv.slice(2);
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (args[0] === 'auth' && args[1] === 'status') {
    console.log('Logged in (fake) config=' + (process.env.CLAUDE_CONFIG_DIR || 'default'));
    return;
  }
  if (args[0] === 'auth' && args[1] === 'login') {
    console.log('Fake login: opening browser…');
    await sleep(300);
    return;
  }

  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;

  const resumeIdx = args.indexOf('--resume');
  const resumed = resumeIdx >= 0;
  const sessionId = resumed ? args[resumeIdx + 1] : require('crypto').randomUUID();
  const msgId = 'msg_fake_1';
  const toolId = 'toolu_fake_1';

  // Имитация потерянной сессии, как у настоящего CLI.
  if (resumed && process.env.FAKE_MISSING_RESUME === '1') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, num_turns: 0, session_id: sessionId });
    console.error('No conversation found with session ID: ' + sessionId);
    process.exit(1);
  }

  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model-1', cwd: process.cwd(), tools: ['Bash'] });

  const streamText = async (index, text) => {
    out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
    for (let i = 0; i < text.length; i += 12) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(i, i + 12) } } });
      await sleep(15);
    }
    out({ type: 'stream_event', event: { type: 'content_block_stop', index } });
  };

  out({ type: 'stream_event', event: { type: 'message_start', message: { id: msgId, role: 'assistant', content: [] } } });

  const intro = `Вы написали: **${prompt.trim().slice(0, 80)}**\n\nСейчас посмотрю на файлы в папке.` +
    (resumed ? `\n\n(продолжение сессии ${sessionId.slice(0, 8)})` : '');
  await streamText(0, intro);
  out({ type: 'assistant', message: { id: msgId, role: 'assistant', model: 'fake-model-1', content: [{ type: 'text', text: intro }] } });

  // инструмент
  const input = { command: 'git status --short', description: 'Статус репозитория' };
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } } });
  const json = JSON.stringify(input);
  for (let i = 0; i < json.length; i += 10) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 10) } } });
    await sleep(10);
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  out({ type: 'assistant', message: { id: msgId, role: 'assistant', model: 'fake-model-1', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input }] } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  await sleep(400);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: ' M src/app.js\n?? test/\n', is_error: false }] } });

  // финальный ответ с разметкой
  const msg2 = 'msg_fake_2';
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: msg2, role: 'assistant', content: [] } } });
  const answer = [
    '## Итог',
    '',
    'В репозитории есть **изменения**: файл `src/app.js` и папка `test/`.',
    '',
    '- первый пункт',
    '- второй пункт со [ссылкой](https://example.com)',
    '  - вложенный пункт',
    '',
    '```js',
    'function hello(name) {',
    '  return `Привет, ${name}!`;',
    '}',
    '```',
    '',
    '| Файл | Статус |',
    '|------|:------:|',
    '| src/app.js | изменён |',
    '| test/ | новый |',
    '',
    '> Это цитата для проверки оформления.',
  ].join('\n');
  await streamText(0, answer);
  out({ type: 'assistant', message: { id: msg2, role: 'assistant', model: 'fake-model-1', content: [{ type: 'text', text: answer }] } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });

  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 2400, total_cost_usd: 0.0123, num_turns: 2, session_id: sessionId, result: answer, permission_denials: [] });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
