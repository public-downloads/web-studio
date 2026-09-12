/* ============================================================================
   highlight.js — tokenizers for HTML, CSS and JavaScript.

   Each tokenizer returns a flat, sorted, non-overlapping list of
   `{ start, end, cls }` ranges. Anything not covered is plain text, so a
   tokenizer that gives up mid-file degrades to uncoloured text rather than to
   garbage — which matters when you are highlighting a document that is
   half-typed by definition.

   HTML delegates: the body of a <style> element is handed to the CSS
   tokenizer and the body of a <script> to the JavaScript one, both with an
   offset so their ranges land in the right place.

   render() then merges those ranges with the diagnostics list and emits HTML.
   ========================================================================== */
(function (root) {
  'use strict';

  /* ── shared helpers ──────────────────────────────────────────────────── */

  function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
  }

  /** Binary search for the 1-based line and column of a character offset. */
  function posToLineCol(starts, pos) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - starts[lo] + 1 };
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ESCAPES[c]);

  const isIdent = (ch) => /[A-Za-z0-9_$]/.test(ch);

  /* ── JavaScript ──────────────────────────────────────────────────────── */

  const JS_KEYWORDS = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
    'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'static',
    'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
    'yield', 'async', 'get', 'set']);

  const JS_ATOMS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

  const JS_GLOBALS = new Set(['window', 'document', 'console', 'Math', 'JSON', 'Object', 'Array',
    'String', 'Number', 'Boolean', 'Promise', 'Set', 'Map', 'Date', 'RegExp', 'Error',
    'localStorage', 'sessionStorage', 'fetch', 'navigator', 'location', 'history', 'globalThis',
    'setTimeout', 'setInterval', 'requestAnimationFrame', 'customElements', 'CSS', 'Intl']);

  /* After these, a `/` starts a regular expression rather than a division. */
  const REGEX_OK_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
    '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'instanceof', 'in', 'of',
    'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', '']);

  function tokenizeJs(text, offset) {
    offset = offset || 0;
    const out = [];
    const push = (start, end, cls) => { if (end > start) out.push({ start: start + offset, end: end + offset, cls }); };
    let i = 0;
    let lastSignificant = '';   // last token, to tell regex from division

    while (i < text.length) {
      const ch = text[i];

      /* whitespace */
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

      /* comments */
      if (ch === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        push(i, end < 0 ? text.length : end, 'tok-comment');
        i = end < 0 ? text.length : end;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        const stop = end < 0 ? text.length : end + 2;
        push(i, stop, 'tok-comment');
        i = stop;
        continue;
      }

      /* strings */
      if (ch === '"' || ch === "'") {
        const end = scanQuoted(text, i, ch);
        push(i, end, 'tok-string');
        i = end;
        lastSignificant = 'str';
        continue;
      }
      if (ch === '`') {
        const end = scanTemplate(text, i, push);
        push(i, i + 1, 'tok-string');
        i = end;
        lastSignificant = 'str';
        continue;
      }

      /* regular expressions — only where one could legally start */
      if (ch === '/' && REGEX_OK_AFTER.has(lastSignificant)) {
        const end = scanRegex(text, i);
        if (end > i) {
          push(i, end, 'tok-regex');
          i = end;
          lastSignificant = 'regex';
          continue;
        }
      }

      /* numbers */
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        let j = i;
        while (j < text.length && /[0-9a-fA-FxXoObBeE._n]/.test(text[j])) {
          if ((text[j] === '-' || text[j] === '+') && !/[eE]/.test(text[j - 1])) break;
          j++;
        }
        push(i, j, 'tok-num');
        i = j;
        lastSignificant = 'num';
        continue;
      }

      /* identifiers and keywords */
      if (isIdent(ch) && !/[0-9]/.test(ch)) {
        let j = i;
        while (j < text.length && isIdent(text[j])) j++;
        const word = text.slice(i, j);
        const afterDot = lastSignificant === '.';
        let cls = null;
        if (afterDot) cls = 'tok-member';
        else if (JS_KEYWORDS.has(word)) cls = 'tok-keyword';
        else if (JS_ATOMS.has(word)) cls = 'tok-atom';
        else if (JS_GLOBALS.has(word)) cls = 'tok-global';
        else if (/^[A-Z]/.test(word)) cls = 'tok-type';
        else if (text[skipSpace(text, j)] === '(') cls = 'tok-fn';
        if (cls) push(i, j, cls);
        i = j;
        lastSignificant = JS_KEYWORDS.has(word) ? word : 'ident';
        continue;
      }

      /* punctuation */
      push(i, i + 1, 'tok-punct');
      lastSignificant = ch;
      i++;
    }
    return out;
  }

  const skipSpace = (text, i) => { while (i < text.length && /\s/.test(text[i])) i++; return i; };

  function scanQuoted(text, start, quote) {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === quote) return i + 1;
      if (text[i] === '\n') return i;   // unterminated: stop at the line end
      i++;
    }
    return text.length;
  }

  /** Template literals colour their `${…}` holes as real code. */
  function scanTemplate(text, start, push) {
    let i = start + 1;
    let chunk = i;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '`') {
        push(chunk, i + 1, 'tok-string');
        return i + 1;
      }
      if (text[i] === '$' && text[i + 1] === '{') {
        push(chunk, i, 'tok-string');
        const close = matchBrace(text, i + 1);
        push(i, i + 2, 'tok-punct');
        for (const t of tokenizeJs(text.slice(i + 2, close), i + 2)) push(t.start, t.end, t.cls);
        push(close, close + 1, 'tok-punct');
        i = close + 1;
        chunk = i;
        continue;
      }
      i++;
    }
    push(chunk, text.length, 'tok-string');
    return text.length;
  }

  function matchBrace(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (!depth) return i; }
      else if (text[i] === '"' || text[i] === "'") i = scanQuoted(text, i, text[i]) - 1;
    }
    return text.length;
  }

  function scanRegex(text, start) {
    let i = start + 1;
    let inClass = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '\n') return start;          // not a regex after all
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i++;
        while (i < text.length && /[dgimsuvy]/.test(text[i])) i++;
        return i;
      }
      i++;
    }
    return start;
  }

  /* ── CSS ─────────────────────────────────────────────────────────────── */

  function tokenizeCss(text, offset) {
    offset = offset || 0;
    const out = [];
    const push = (start, end, cls) => { if (end > start) out.push({ start: start + offset, end: end + offset, cls }); };
    let i = 0;
    let inBlock = false;      // between { and }
    let inValue = false;      // between : and ; inside a block

    while (i < text.length) {
      const ch = text[i];

      if (/\s/.test(ch)) { i++; continue; }

      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        const stop = end < 0 ? text.length : end + 2;
        push(i, stop, 'tok-comment');
        i = stop;
        continue;
      }

      if (ch === '{') { push(i, i + 1, 'tok-punct'); inBlock = true; inValue = false; i++; continue; }
      if (ch === '}') { push(i, i + 1, 'tok-punct'); inBlock = false; inValue = false; i++; continue; }
      if (ch === ';') { push(i, i + 1, 'tok-punct'); inValue = false; i++; continue; }
      if (ch === ':' && inBlock && !inValue) { push(i, i + 1, 'tok-punct'); inValue = true; i++; continue; }

      if (ch === '"' || ch === "'") {
        const end = scanQuoted(text, i, ch);
        push(i, end, 'tok-string');
        i = end;
        continue;
      }

      /* at-rules: @media, @keyframes, … */
      if (ch === '@') {
        let j = i + 1;
        while (j < text.length && /[\w-]/.test(text[j])) j++;
        push(i, j, 'tok-at');
        i = j;
        continue;
      }

      /* colours */
      if (ch === '#') {
        let j = i + 1;
        while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++;
        const len = j - i - 1;
        if (inValue && (len === 3 || len === 4 || len === 6 || len === 8)) { push(i, j, 'tok-color'); i = j; continue; }
        /* otherwise it is an id selector */
        while (j < text.length && /[\w-]/.test(text[j])) j++;
        push(i, j, 'tok-selector-id');
        i = j;
        continue;
      }

      if (ch === '.' && !inValue && /[A-Za-z_-]/.test(text[i + 1] || '')) {
        let j = i + 1;
        while (j < text.length && /[\w-]/.test(text[j])) j++;
        push(i, j, 'tok-selector-class');
        i = j;
        continue;
      }

      if (ch === ':' && !inValue) {
        let j = i + 1;
        if (text[j] === ':') j++;
        while (j < text.length && /[\w-]/.test(text[j])) j++;
        push(i, j, 'tok-pseudo');
        i = j;
        continue;
      }

      /* custom properties, both sides of the colon */
      if (ch === '-' && text[i + 1] === '-') {
        let j = i + 2;
        while (j < text.length && /[\w-]/.test(text[j])) j++;
        push(i, j, 'tok-var');
        i = j;
        continue;
      }

      if (ch === '!') {
        let j = i + 1;
        while (j < text.length && /[\w]/.test(text[j])) j++;
        push(i, j, 'tok-important');
        i = j;
        continue;
      }

      /* numbers with units */
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        let j = i;
        while (j < text.length && /[0-9.]/.test(text[j])) j++;
        while (j < text.length && /[a-z%]/i.test(text[j])) j++;
        push(i, j, 'tok-num');
        i = j;
        continue;
      }

      /* words: property, value keyword, function or element selector */
      if (/[A-Za-z_-]/.test(ch)) {
        let j = i;
        while (j < text.length && /[\w-]/.test(text[j])) j++;
        const next = text[skipSpace(text, j)];
        let cls;
        if (next === '(') cls = 'tok-fn';
        else if (inValue) cls = 'tok-value';
        else if (inBlock) cls = 'tok-prop';
        else cls = 'tok-selector-tag';
        push(i, j, cls);
        i = j;
        continue;
      }

      push(i, i + 1, 'tok-punct');
      i++;
    }
    return out;
  }

  /* ── HTML ────────────────────────────────────────────────────────────── */

  function tokenizeHtml(text, offset) {
    offset = offset || 0;
    const out = [];
    const push = (start, end, cls) => { if (end > start) out.push({ start: start + offset, end: end + offset, cls }); };
    let i = 0;

    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt < 0) { markEntities(text, i, text.length, push); break; }
      markEntities(text, i, lt, push);
      i = lt;

      /* comments */
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        const stop = end < 0 ? text.length : end + 3;
        push(i, stop, 'tok-comment');
        i = stop;
        continue;
      }
      /* doctype, CDATA and friends */
      if (text.startsWith('<!', i) || text.startsWith('<?', i)) {
        const end = text.indexOf('>', i);
        const stop = end < 0 ? text.length : end + 1;
        push(i, stop, 'tok-meta');
        i = stop;
        continue;
      }

      const m = /^<(\/?)([A-Za-z][\w.:-]*)/.exec(text.slice(i));
      if (!m) { push(i, i + 1, 'tok-punct'); i++; continue; }

      const nameEnd = i + m[0].length;
      push(i, i + 1 + m[1].length, 'tok-punct');
      push(i + 1 + m[1].length, nameEnd, 'tok-tag');

      const tagEnd = markAttributes(text, nameEnd, push);
      const tagName = m[2].toLowerCase();
      i = tagEnd;

      /* <style> and <script> bodies are other languages */
      if (!m[1] && (tagName === 'style' || tagName === 'script') && !text.slice(nameEnd, tagEnd).includes('/>')) {
        const close = findClose(text, tagEnd, tagName);
        const body = text.slice(tagEnd, close);
        const inner = tagName === 'style'
          ? tokenizeCss(body, tagEnd)
          : tokenizeJs(body, tagEnd);
        for (const t of inner) push(t.start, t.end, t.cls);
        i = close;
      }
    }
    return out;
  }

  /** Attribute names, `=`, quoted values, up to and including the closing `>`. */
  function markAttributes(text, from, push) {
    let i = from;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '>') { push(i, i + 1, 'tok-punct'); return i + 1; }
      if (ch === '/' && text[i + 1] === '>') { push(i, i + 2, 'tok-punct'); return i + 2; }
      if (ch === '<') return i;              // unterminated tag; bail out
      if (/\s/.test(ch)) { i++; continue; }

      if (ch === '=') { push(i, i + 1, 'tok-punct'); i++; continue; }
      if (ch === '"' || ch === "'") {
        const end = scanQuoted(text, i, ch);
        push(i, end, 'tok-string');
        i = end;
        continue;
      }
      let j = i;
      while (j < text.length && !/[\s=>/<'"]/.test(text[j])) j++;
      if (j === i) j++;
      push(i, j, 'tok-attr');
      i = j;
    }
    return i;
  }

  function findClose(text, from, tagName) {
    const re = new RegExp('</' + tagName + '\\s*>', 'i');
    const m = re.exec(text.slice(from));
    return m ? from + m.index : text.length;
  }

  const ENTITY = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

  function markEntities(text, from, to, push) {
    if (to <= from) return;
    const slice = text.slice(from, to);
    ENTITY.lastIndex = 0;
    let m;
    while ((m = ENTITY.exec(slice))) push(from + m.index, from + m.index + m[0].length, 'tok-entity');
  }

  /* ── rendering ───────────────────────────────────────────────────────── */

  const TOKENIZERS = { html: tokenizeHtml, css: tokenizeCss, js: tokenizeJs };

  /**
   * Paint `text` as `lang`, underlining any diagnostic ranges.
   * @returns {string} HTML for the highlight layer.
   */
  function render(text, lang, diagnostics) {
    const tokenize = TOKENIZERS[lang] || TOKENIZERS.html;
    let tokens;
    try { tokens = tokenize(text, 0); } catch (e) { tokens = []; }

    /* A trailing newline needs a character after it or the layer comes up one
       line short of the textarea and the two drift apart as you scroll. */
    const marks = (diagnostics || [])
      .filter((d) => d.end > d.start)
      .sort((a, b) => a.start - b.start);

    const cuts = new Set([0, text.length]);
    for (const t of tokens) { cuts.add(t.start); cuts.add(t.end); }
    for (const d of marks) { cuts.add(d.start); cuts.add(d.end); }
    const points = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);

    let ti = 0, di = 0;
    const parts = [];
    for (let k = 0; k < points.length - 1; k++) {
      const from = points[k], to = points[k + 1];
      if (to <= from) continue;

      while (ti < tokens.length && tokens[ti].end <= from) ti++;
      const token = (ti < tokens.length && tokens[ti].start <= from) ? tokens[ti] : null;

      while (di < marks.length && marks[di].end <= from) di++;
      let severity = null;
      for (let j = di; j < marks.length && marks[j].start < to; j++) {
        if (marks[j].start <= from && marks[j].end >= to) {
          if (marks[j].severity === 'error') { severity = 'error'; break; }
          severity = severity || marks[j].severity;
        }
      }

      const classes = [];
      if (token) classes.push(token.cls);
      if (severity) classes.push('sq-' + severity);
      const body = escapeHtml(text.slice(from, to));
      parts.push(classes.length ? `<span class="${classes.join(' ')}">${body}</span>` : body);
    }
    return parts.join('') + '\n';
  }

  root.WS = root.WS || {};
  root.WS.highlight = { render, tokenizeHtml, tokenizeCss, tokenizeJs };
  root.WS.lineStarts = lineStarts;
  root.WS.posToLineCol = posToLineCol;
  root.WS.escapeHtml = escapeHtml;
})(window);
