/* ============================================================================
   analyze.js — what is at the caret, and what looks wrong.

   contextAt() is the question every other feature asks: completion, inline
   help and the status line all work from the same answer, so they can never
   disagree about what you are editing.

   The diagnostics are deliberately quiet. A document you are halfway through
   typing is always invalid, and an editor that shouts about it is one you stop
   reading. Only things that are almost certainly mistakes get marked.
   ========================================================================== */
(function (root) {
  'use strict';

  const S = root.WS.schema;
  const { parseHtml, parseCss, readAttributes } = root.WS.parse;

  /* ── where is the caret? ─────────────────────────────────────────────── */

  /**
   * @param {string} text
   * @param {number} pos
   * @param {'html'|'css'|'js'} lang
   * @returns {{kind: string, word: string, [tag]: string, [attr]: string, [prop]: string}}
   *   `kind` is one of: tag, close-tag, attr, attr-value, text, comment,
   *   css-selector, css-prop, css-value, css-at, js, js-member, none.
   */
  function contextAt(text, pos, lang) {
    if (lang === 'css') return cssContext(text, pos);
    if (lang === 'js') return jsContext(text, pos);
    return htmlContext(text, pos);
  }

  function htmlContext(text, pos) {
    /* Inside <style> or <script>, the caret is in another language. */
    const embedded = embeddedRegion(text, pos);
    if (embedded) {
      const inner = embedded.lang === 'css'
        ? cssContext(text.slice(embedded.start, embedded.end), pos - embedded.start)
        : jsContext(text.slice(embedded.start, embedded.end), pos - embedded.start);
      inner.embedded = embedded.lang;
      inner.regionStart = embedded.start;
      return inner;
    }

    const lt = text.lastIndexOf('<', Math.max(0, pos - 1));
    if (lt < 0) return { kind: 'text', word: wordBefore(text, pos) };

    /* Comments swallow everything, including things that look like tags. */
    const commentStart = text.lastIndexOf('<!--', pos);
    if (commentStart >= 0) {
      const commentEnd = text.indexOf('-->', commentStart + 4);
      if (commentEnd < 0 || pos <= commentEnd + 3) return { kind: 'comment', word: '' };
    }

    if (text.startsWith('<!', lt) || text.startsWith('<?', lt)) {
      const end = text.indexOf('>', lt);
      if (end < 0 || pos <= end) return { kind: 'comment', word: '' };
      return { kind: 'text', word: wordBefore(text, pos) };
    }

    const closing = text[lt + 1] === '/';
    const nameFrom = lt + (closing ? 2 : 1);
    const nameMatch = /^[A-Za-z][\w.:-]*/.exec(text.slice(nameFrom));

    /* `<` on its own, with the name not yet typed. */
    if (!nameMatch) {
      if (pos <= nameFrom + 1) {
        return { kind: closing ? 'close-tag' : 'tag', word: text.slice(nameFrom, pos) };
      }
      return { kind: 'text', word: wordBefore(text, pos) };
    }

    const nameEnd = nameFrom + nameMatch[0].length;
    const tag = nameMatch[0].toLowerCase();

    if (closing) {
      const gt = text.indexOf('>', lt);
      if (gt < 0 || pos <= gt) {
        return { kind: 'close-tag', word: text.slice(nameFrom, Math.max(nameFrom, Math.min(pos, nameEnd))), tag };
      }
      return { kind: 'text', word: wordBefore(text, pos) };
    }

    const tagInfo = readAttributes(text, nameEnd);
    if (pos > tagInfo.end) return { kind: 'text', word: wordBefore(text, pos) };

    if (pos <= nameEnd) {
      return { kind: 'tag', word: text.slice(nameFrom, pos), tag };
    }

    /* Inside a quoted attribute value. */
    for (const range of tagInfo.ranges) {
      if (range.valueStart >= 0 && pos >= range.valueStart && pos <= range.valueEnd) {
        return {
          kind: 'attr-value',
          tag,
          attr: range.name.toLowerCase(),
          word: text.slice(range.valueStart, pos),
          valueStart: range.valueStart,
          valueEnd: range.valueEnd
        };
      }
      if (pos > range.nameStart && pos <= range.nameEnd) {
        return { kind: 'attr', tag, word: text.slice(range.nameStart, pos) };
      }
    }
    return { kind: 'attr', tag, word: '' };
  }

  /** The <style> or <script> body containing `pos`, if any. */
  function embeddedRegion(text, pos) {
    const OPEN = /<(style|script)\b[^>]*>/gi;
    let m;
    while ((m = OPEN.exec(text))) {
      const lang = m[1].toLowerCase() === 'style' ? 'css' : 'js';
      const start = m.index + m[0].length;
      const closeRe = new RegExp('</\\s*' + m[1] + '\\s*>', 'i');
      const rest = closeRe.exec(text.slice(start));
      const end = rest ? start + rest.index : text.length;
      if (pos >= start && pos <= end) {
        /* A <script src=…> has no body worth completing in. */
        if (lang === 'js' && /\ssrc\s*=/i.test(m[0]) && end === start) return null;
        return { lang, start, end };
      }
      OPEN.lastIndex = end;
    }
    return null;
  }

  function cssContext(text, pos) {
    const state = cssStateAt(text, pos);
    if (state.inComment) return { kind: 'comment', word: '' };
    if (state.inString) return { kind: 'none', word: '' };

    if (state.blockKind !== 'rule') {
      const prelude = text.slice(state.stmtStart, pos).trim();
      if (prelude.startsWith('@') && !/\s/.test(prelude)) return { kind: 'css-at', word: prelude };
      /* The word carries its own `.`, `#` or `:` so that typing `.he` offers
         classes and not every element with an h and an e in it. */
      return { kind: 'css-selector', word: selectorToken(text, pos), prelude };
    }

    if (state.colon < 0) {
      return { kind: 'css-prop', word: text.slice(state.stmtStart, pos).trim(), rule: state.selector };
    }
    const word = wordBefore(text, pos, /[\w.%#-]/);
    return {
      kind: 'css-value',
      prop: text.slice(state.stmtStart, state.colon).trim(),
      word,
      /* Already inside `var(`: the name alone completes it, and offering
         `var(--x)` here would nest one call inside another. */
      inVar: /var\(\s*$/.test(text.slice(0, pos - word.length)),
      valueStart: state.colon + 1,
      rule: state.selector
    };
  }

  /** The selector fragment at `pos`, including any leading sigil. */
  function selectorToken(text, pos) {
    let i = pos;
    while (i > 0 && /[\w-]/.test(text[i - 1])) i--;
    if (text[i - 1] === ':') {
      i--;
      if (text[i - 1] === ':') i--;
    } else if (text[i - 1] === '.' || text[i - 1] === '#') {
      i--;
    }
    return text.slice(i, pos);
  }

  /**
   * Walks the sheet once to find the block, statement and colon that surround
   * `pos`. Cheaper than parsing, and correct while the text is mid-edit.
   */
  function cssStateAt(text, pos) {
    const stack = [];
    let stmtStart = 0;
    let colon = -1;
    let parens = 0;
    let i = 0;

    while (i < pos && i < text.length) {
      const ch = text[i];

      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0 || end + 2 > pos) return { inComment: true };
        i = end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < text.length && text[j] !== quote && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
        if (j >= pos) return { inString: true };
        i = j + 1;
        continue;
      }
      if (ch === '(') { parens++; i++; continue; }
      if (ch === ')') { parens = Math.max(0, parens - 1); i++; continue; }

      if (ch === '{') {
        const prelude = text.slice(stmtStart, i).trim();
        const isAt = prelude.startsWith('@') && !/^@(font-face|page)\b/i.test(prelude);
        stack.push({ kind: isAt ? 'at' : 'rule', selector: prelude });
        stmtStart = i + 1;
        colon = -1;
        i++;
        continue;
      }
      if (ch === '}') {
        stack.pop();
        stmtStart = i + 1;
        colon = -1;
        i++;
        continue;
      }
      if (ch === ';' && !parens) { stmtStart = i + 1; colon = -1; i++; continue; }
      if (ch === ':' && colon < 0 && !parens && stack.length &&
          stack[stack.length - 1].kind === 'rule') { colon = i; i++; continue; }
      i++;
    }

    const block = stack[stack.length - 1];
    return {
      inComment: false,
      inString: false,
      blockKind: block ? block.kind : 'top',
      selector: block ? block.selector : '',
      stmtStart,
      colon
    };
  }

  function jsContext(text, pos) {
    /* Comments and strings are not places to suggest identifiers. */
    const line = text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos);
    if (/\/\//.test(line)) return { kind: 'comment', word: '' };
    const openComment = text.lastIndexOf('/*', pos);
    if (openComment >= 0 && text.indexOf('*/', openComment + 2) >= pos - 1) return { kind: 'comment', word: '' };

    const word = wordBefore(text, pos);
    const before = text.slice(0, pos - word.length).trimEnd();
    if (before.endsWith('.')) {
      const obj = wordBefore(before, before.length - 1);
      return { kind: 'js-member', word, object: obj };
    }
    return { kind: 'js', word };
  }

  function wordBefore(text, pos, pattern) {
    const re = pattern || /[\w$-]/;
    let i = pos;
    while (i > 0 && re.test(text[i - 1])) i--;
    return text.slice(i, pos);
  }

  /* ── diagnostics ─────────────────────────────────────────────────────── */

  const VENDOR = /^-(webkit|moz|ms|o)-/;

  function diagnose(text, lang) {
    try {
      if (lang === 'css') return cssDiagnostics(text, 0);
      if (lang === 'js') return jsDiagnostics(text, 0);
      return htmlDiagnostics(text);
    } catch (e) {
      return [];   // a broken analyser must never break the editor
    }
  }

  function htmlDiagnostics(text) {
    const tree = parseHtml(text);
    const out = tree.errors.slice();
    const ids = new Map();

    for (const node of tree.elements) {
      if (!S.elements[node.tag] && !node.tag.includes('-') && !node.tag.includes(':')) {
        out.push({ start: node.nameStart, end: node.nameStart + node.rawTag.length, severity: 'warning',
          message: `<${node.rawTag}> is not a standard element. Custom elements need a hyphen in the name.` });
      }
      const id = node.attrs.id;
      if (id) {
        if (ids.has(id)) {
          out.push({ start: node.start, end: node.openEnd, severity: 'warning',
            message: `id="${id}" is used more than once. Ids have to be unique.` });
        }
        ids.set(id, node);
      }
      if (node.tag === 'img' && !('alt' in node.attrs)) {
        out.push({ start: node.start, end: node.openEnd, severity: 'warning',
          message: 'This image has no alt text. Use alt="" if it is purely decorative.' });
      }
      if (node.tag === 'a' && node.attrs.target === '_blank' && !/noopener/.test(node.attrs.rel || '')) {
        out.push({ start: node.start, end: node.openEnd, severity: 'warning',
          message: 'A target="_blank" link should carry rel="noopener".' });
      }
    }

    /* The embedded languages get checked too. */
    for (const node of tree.elements) {
      if (node.textStart == null) continue;
      const body = text.slice(node.textStart, node.textEnd);
      if (node.tag === 'style') out.push(...cssDiagnostics(body, node.textStart));
      else if (node.tag === 'script' && !node.attrs.src && !/json/i.test(node.attrs.type || '')) {
        out.push(...jsDiagnostics(body, node.textStart));
      }
    }
    return out;
  }

  function cssDiagnostics(text, offset) {
    const sheet = parseCss(text);
    const out = sheet.errors.map((e) => shift(e, offset));

    for (const rule of sheet.rules) {
      if (rule.kind === 'at' || rule.kind === 'statement') {
        const name = (/^@[\w-]+/.exec(rule.selector) || [''])[0];
        if (name && !S.atRules[name]) {
          out.push({ start: rule.start + offset, end: rule.start + name.length + offset,
            severity: 'warning', message: `${name} is not a rule I recognise.` });
        }
        continue;
      }
      if (rule.kind !== 'rule') continue;

      if (!rule.selector) {
        out.push({ start: rule.start + offset, end: rule.selectorEnd + offset, severity: 'warning',
          message: 'This block has no selector.' });
      }
      for (const dec of rule.declarations) {
        if (dec.name.startsWith('--') || VENDOR.test(dec.name)) continue;
        if (!S.css[dec.name]) {
          out.push({ start: dec.nameStart + offset, end: dec.nameEnd + offset, severity: 'warning',
            message: `\`${dec.name}\` is not a property I recognise. Check the spelling.` });
        } else if (!dec.value) {
          out.push({ start: dec.nameStart + offset, end: dec.end + offset, severity: 'warning',
            message: `\`${dec.name}\` has no value.` });
        }
      }
    }
    return out;
  }

  /* No JavaScript parser here — just the bracket balance, which catches the
     mistake that actually stops a script from running. */
  function jsDiagnostics(text, offset) {
    const out = [];
    const tokens = root.WS.highlight.tokenizeJs(text, 0);
    const skip = new Set();
    for (const t of tokens) {
      if (t.cls === 'tok-comment' || t.cls === 'tok-string' || t.cls === 'tok-regex') {
        for (let i = t.start; i < t.end; i++) skip.add(i);
      }
    }

    const PAIRS = { ')': '(', ']': '[', '}': '{' };
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if (skip.has(i)) continue;
      const ch = text[i];
      if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, i });
      else if (PAIRS[ch]) {
        const open = stack.pop();
        if (!open) {
          out.push({ start: i + offset, end: i + 1 + offset, severity: 'error',
            message: `This \`${ch}\` closes nothing.` });
        } else if (open.ch !== PAIRS[ch]) {
          out.push({ start: i + offset, end: i + 1 + offset, severity: 'error',
            message: `Expected \`${closerFor(open.ch)}\` to match the \`${open.ch}\` above, found \`${ch}\`.` });
        }
      }
    }
    for (const open of stack) {
      out.push({ start: open.i + offset, end: open.i + 1 + offset, severity: 'error',
        message: `This \`${open.ch}\` is never closed.` });
    }
    return out;
  }

  const closerFor = (ch) => ({ '(': ')', '[': ']', '{': '}' })[ch];
  const shift = (d, offset) => (offset ? { ...d, start: d.start + offset, end: d.end + offset } : d);

  /* ── outline ─────────────────────────────────────────────────────────── */

  /** A flat list of `{label, detail, pos, depth}` for the structure panel. */
  function outline(text, lang) {
    try {
      if (lang === 'css') return cssOutline(text);
      if (lang === 'js') return jsOutline(text);
      return htmlOutline(text);
    } catch (e) {
      return [];
    }
  }

  function htmlOutline(text) {
    const tree = parseHtml(text);
    const out = [];
    for (const node of tree.elements) {
      if (node.tag === 'html' || node.tag === 'head' || node.tag === 'body') continue;
      const id = node.attrs.id ? '#' + node.attrs.id : '';
      const cls = node.attrs.class ? '.' + node.attrs.class.trim().split(/\s+/).join('.') : '';
      out.push({
        label: node.tag,
        detail: id + cls,
        pos: node.start,
        end: node.end,
        depth: Math.max(0, node.depth - 2),
        nodeId: node.id
      });
    }
    return out;
  }

  function cssOutline(text) {
    const sheet = parseCss(text);
    return sheet.rules
      .filter((r) => r.kind !== 'statement')
      .map((r) => ({
        label: r.selector.replace(/\s+/g, ' '),
        detail: r.kind === 'rule' ? `${r.declarations.length}` : '',
        pos: r.start,
        end: r.end,
        depth: r.at ? 1 : 0
      }));
  }

  const JS_DECL = /^[ \t]*(?:export\s+)?(?:async\s+)?(function\s*\*?\s*([\w$]+)|class\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function|\(|[\w$]+\s*=>))/gm;

  function jsOutline(text) {
    const out = [];
    JS_DECL.lastIndex = 0;
    let m;
    while ((m = JS_DECL.exec(text))) {
      const name = m[2] || m[3] || m[4];
      const kind = m[1].startsWith('class') ? 'class' : 'function';
      out.push({ label: name, detail: kind, pos: m.index, depth: 0 });
    }
    return out;
  }

  root.WS.analyze = { contextAt, diagnose, outline, embeddedRegion, cssStateAt, wordBefore };
})(window);
