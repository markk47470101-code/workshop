'use strict';

// Небольшой и безопасный Markdown-рендерер: весь HTML экранируется до разметки,
// ссылки только http(s), никаких inline-стилей (CSP их не пропустит).
(function () {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(src) {
    const codes = [];
    let s = src.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = esc(s);
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t, u) => '<a href="' + u + '" data-ext="1">' + t + '</a>'
    );
    s = s.replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (_, p, u) => p + '<a href="' + u + '" data-ext="1">' + u + '</a>'
    );
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[+i]) + '</code>');
    return s;
  }

  function codeBlock(code, lang) {
    return (
      '<div class="code"><div class="code-head"><span class="code-lang">' +
      esc(lang || 'text') +
      '</span><button class="code-copy" type="button">Копировать</button></div>' +
      '<pre><code>' +
      esc(code) +
      '</code></pre></div>'
    );
  }

  const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;

  function renderList(lines) {
    const items = [];
    for (const l of lines) {
      const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (m) {
        items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] });
      } else if (items.length && l.trim()) {
        items[items.length - 1].text += '\n' + l.trim();
      }
    }
    let idx = 0;
    function build(base) {
      const tag = items[idx].ordered ? 'ol' : 'ul';
      let html = '<' + tag + '>';
      while (idx < items.length && items[idx].indent === base) {
        const it = items[idx++];
        let text = it.text.replace(/^\[ \]\s+/, '☐ ').replace(/^\[[xX]\]\s+/, '☑ ');
        let inner = inline(text).replace(/\n/g, '<br>');
        if (idx < items.length && items[idx].indent > base) inner += build(items[idx].indent);
        html += '<li>' + inner + '</li>';
      }
      return html + '</' + tag + '>';
    }
    let html = '';
    while (idx < items.length) html += build(items[idx].indent);
    return html;
  }

  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const splitRow = (r) =>
    r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function render(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      let m = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
      if (m) {
        const fenceChar = m[1][0];
        const fenceLen = m[1].length;
        const closing = new RegExp('^\\s*\\' + fenceChar + '{' + fenceLen + ',}\\s*$');
        const buf = [];
        i++;
        while (i < lines.length && !closing.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push(codeBlock(buf.join('\n'), m[2]));
        continue;
      }

      if (!line.trim()) { i++; continue; }

      m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const n = Math.min(m[1].length + 1, 6);
        out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>');
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) =>
          c.startsWith(':') && c.endsWith(':') ? 'al-center' : c.endsWith(':') ? 'al-right' : ''
        );
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const cell = (tag, c, k) =>
          '<' + tag + (aligns[k] ? ' class="' + aligns[k] + '"' : '') + '>' + inline(c) + '</' + tag + '>';
        out.push(
          '<div class="table-wrap"><table><thead><tr>' +
            head.map((c, k) => cell('th', c, k)).join('') +
            '</tr></thead><tbody>' +
            rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k] || '', k)).join('') + '</tr>').join('') +
            '</tbody></table></div>'
        );
        continue;
      }

      if (LIST_RE.test(line)) {
        const buf = [];
        while (i < lines.length) {
          const l = lines[i];
          if (LIST_RE.test(l)) { buf.push(l); i++; }
          else if (l.trim() && /^\s{2,}/.test(l)) { buf.push(l); i++; }
          else if (!l.trim() && i + 1 < lines.length && (LIST_RE.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) { i++; }
          else break;
        }
        out.push(renderList(buf));
        continue;
      }

      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(`{3,}|~{3,}|#{1,6}\s|>)/.test(lines[i]) &&
        !LIST_RE.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push('<p>' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }
    return out.join('\n');
  }

  window.renderMarkdown = render;
})();
