/* ============================================================================
   parse.js — forgiving parsers that keep source offsets.

   Both are written for a document that is being typed, so they never throw and
   never discard input: an unclosed tag or a stray brace produces a tree that
   is merely incomplete, not an exception. Every node remembers where it came
   from, which is what lets a click in the preview scroll to the right line.
   ========================================================================== */
(function (root) {
  'use strict';

  const VOID = root.WS.schema.isVoid;

  /* Elements whose content is text, not markup. */
  const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

  /* ── HTML ────────────────────────────────────────────────────────────── */

  /**
   * @returns {{root: object, elements: object[], errors: object[]}}
   *   `elements` is every element in document order, so a numeric id can
   *   address a node from the preview and back.
   */
  function parseHtml(text) {
    const rootNode = { tag: '#root', children: [], start: 0, end: text.length, parent: null, depth: -1 };
    const elements = [];
    const errors = [];
    const stack = [rootNode];
    let i = 0;

    const top = () => stack[stack.length - 1];

    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt < 0) break;
      i = lt;

      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        i = end < 0 ? text.length : end + 3;
        continue;
      }
      if (text.startsWith('<!', i) || text.startsWith('<?', i)) {
        const end = text.indexOf('>', i);
        i = end < 0 ? text.length : end + 1;
        continue;
      }

      /* closing tag */
      const close = /^<\/\s*([A-Za-z][\w.:-]*)\s*>?/.exec(text.slice(i));
      if (close) {
        const name = close[1].toLowerCase();
        const stop = i + close[0].length;
        let depth = -1;
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === name) { depth = k; break; }
        if (depth < 0) {
          errors.push({ start: i, end: stop, severity: 'error',
            message: `</${close[1]}> closes nothing that is open here.` });
        } else {
          for (let k = stack.length - 1; k > depth; k--) {
            const orphan = stack[k];
            errors.push({ start: orphan.start, end: orphan.openEnd, severity: 'warning',
              message: `<${orphan.tag}> is still open where </${close[1]}> appears.` });
            orphan.end = i;
            stack.pop();
          }
          top().end = stop;
          top().closeStart = i;
          stack.pop();
        }
        i = stop;
        continue;
      }

      /* opening tag */
      const open = /^<([A-Za-z][\w.:-]*)/.exec(text.slice(i));
      if (!open) { i++; continue; }

      const name = open[1].toLowerCase();
      const attrsFrom = i + open[0].length;
      const tag = readAttributes(text, attrsFrom);

      const node = {
        tag: name,
        rawTag: open[1],
        attrs: tag.attrs,
        attrRanges: tag.ranges,
        start: i,
        nameStart: i + 1,
        nameEnd: attrsFrom,
        openEnd: tag.end,
        end: tag.end,
        selfClosing: tag.selfClosing,
        children: [],
        parent: top(),
        depth: stack.length - 1,
        id: elements.length
      };
      elements.push(node);
      top().children.push(node);

      if (tag.unterminated) {
        errors.push({ start: i, end: Math.min(text.length, tag.end), severity: 'error',
          message: `<${open[1]}> is missing its closing '>'.` });
      }

      i = tag.end;

      if (tag.selfClosing || VOID(name)) continue;

      /* Raw-text elements swallow everything up to their own close tag, so a
         `<` inside a script does not look like markup. */
      if (RAW_TEXT.has(name)) {
        const re = new RegExp('</\\s*' + name + '\\s*>', 'i');
        const m = re.exec(text.slice(i));
        node.textStart = i;
        node.textEnd = m ? i + m.index : text.length;
        node.end = m ? i + m.index + m[0].length : text.length;
        node.closeStart = m ? i + m.index : undefined;
        i = node.end;
        continue;
      }

      stack.push(node);
    }

    for (let k = stack.length - 1; k > 0; k--) {
      const orphan = stack[k];
      errors.push({ start: orphan.start, end: orphan.openEnd, severity: 'warning',
        message: `<${orphan.tag}> is never closed.` });
      orphan.end = text.length;
    }

    return { root: rootNode, elements, errors };
  }

  /**
   * Reads attributes from just after a tag name.
   * @returns {{attrs: object, ranges: object[], end: number, selfClosing: boolean, unterminated: boolean}}
   */
  function readAttributes(text, from) {
    const attrs = Object.create(null);
    const ranges = [];
    let i = from;

    while (i < text.length) {
      const ch = text[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '>') return { attrs, ranges, end: i + 1, selfClosing: false, unterminated: false };
      if (ch === '/' && text[i + 1] === '>') return { attrs, ranges, end: i + 2, selfClosing: true, unterminated: false };
      if (ch === '<') return { attrs, ranges, end: i, selfClosing: false, unterminated: true };

      const nameStart = i;
      while (i < text.length && !/[\s=>/<'"]/.test(text[i])) i++;
      if (i === nameStart) { i++; continue; }
      const name = text.slice(nameStart, i);

      let value = '', valueStart = -1, valueEnd = -1, quoted = false;
      const eq = skipWs(text, i);
      if (text[eq] === '=') {
        let v = skipWs(text, eq + 1);
        if (text[v] === '"' || text[v] === "'") {
          const quote = text[v];
          const close = text.indexOf(quote, v + 1);
          const stop = close < 0 ? text.length : close;
          valueStart = v + 1;
          valueEnd = stop;
          value = text.slice(valueStart, valueEnd);
          quoted = true;
          i = close < 0 ? text.length : close + 1;
        } else {
          valueStart = v;
          while (v < text.length && !/[\s>]/.test(text[v])) v++;
          valueEnd = v;
          value = text.slice(valueStart, valueEnd);
          i = v;
        }
      }
      attrs[name.toLowerCase()] = value;
      ranges.push({ name, nameStart, nameEnd: nameStart + name.length, value, valueStart, valueEnd, quoted });
    }
    return { attrs, ranges, end: text.length, selfClosing: false, unterminated: true };
  }

  const skipWs = (text, i) => { while (i < text.length && /\s/.test(text[i])) i++; return i; };

  /** The innermost element containing `pos`, or null. */
  function nodeAt(tree, pos) {
    let found = null;
    const walk = (node) => {
      for (const child of node.children) {
        if (pos >= child.start && pos <= child.end) { found = child; walk(child); }
      }
    };
    walk(tree.root);
    return found;
  }

  /* ── CSS ─────────────────────────────────────────────────────────────── */

  /**
   * Rules and at-rules with their source ranges. Nested rules inside `@media`
   * and friends come back flattened, each carrying the at-rule it sits in.
   * @returns {{rules: object[], errors: object[]}}
   */
  function parseCss(text) {
    const rules = [];
    const errors = [];
    let i = 0;
    const context = [];

    while (i < text.length) {
      i = skipTrivia(text, i);
      if (i >= text.length) break;

      if (text[i] === '}') {
        if (context.length) {
          const at = context.pop();
          at.end = i + 1;
        } else {
          errors.push({ start: i, end: i + 1, severity: 'error', message: 'A `}` with no block open.' });
        }
        i++;
        continue;
      }

      const selStart = i;
      const brace = findBlockStart(text, i);
      if (brace < 0) {
        const rest = text.slice(i).trim();
        if (rest) {
          errors.push({ start: i, end: text.length, severity: 'warning',
            message: 'This rule has no `{ }` block.' });
        }
        break;
      }

      /* A `;` before the `{` means a statement at-rule such as @import. */
      const semi = text.indexOf(';', selStart);
      if (semi >= 0 && semi < brace && text[selStart] === '@') {
        rules.push({ kind: 'statement', selector: text.slice(selStart, semi).trim(),
          start: selStart, end: semi + 1, at: context[context.length - 1] || null });
        i = semi + 1;
        continue;
      }

      const selector = text.slice(selStart, brace).trim();

      if (selector.startsWith('@') && !/^@(font-face|page)/i.test(selector)) {
        const at = { kind: 'at', selector, start: selStart, bodyStart: brace + 1,
          end: text.length, at: context[context.length - 1] || null };
        rules.push(at);
        context.push(at);
        i = brace + 1;
        continue;
      }

      const bodyEnd = matchBlock(text, brace);
      const rule = {
        kind: 'rule',
        selector,
        selectorStart: selStart,
        selectorEnd: brace,
        bodyStart: brace + 1,
        bodyEnd: bodyEnd < 0 ? text.length : bodyEnd,
        start: selStart,
        end: bodyEnd < 0 ? text.length : bodyEnd + 1,
        at: context[context.length - 1] || null,
        declarations: []
      };
      if (bodyEnd < 0) {
        errors.push({ start: selStart, end: brace + 1, severity: 'warning',
          message: 'This block is never closed.' });
      }
      rule.declarations = readDeclarations(text, rule.bodyStart, rule.bodyEnd);
      rules.push(rule);
      i = rule.end;
    }

    for (const at of context) {
      errors.push({ start: at.start, end: at.bodyStart, severity: 'warning',
        message: 'This block is never closed.' });
    }
    return { rules, errors };
  }

  function readDeclarations(text, from, to) {
    const out = [];
    let i = from;
    while (i < to) {
      i = skipTrivia(text, i);
      if (i >= to) break;
      const colon = indexOutsideStrings(text, ':', i, to);
      if (colon < 0) break;
      const name = text.slice(i, colon).trim();
      if (!name || /[{}]/.test(name)) break;
      let end = indexOutsideStrings(text, ';', colon + 1, to);
      if (end < 0) end = to;
      out.push({
        name,
        nameStart: i,
        nameEnd: i + name.length,
        value: text.slice(colon + 1, end).trim(),
        valueStart: skipTrivia(text, colon + 1),
        valueEnd: end,
        start: i,
        end: Math.min(end + 1, to)
      });
      i = end + 1;
    }
    return out;
  }

  /** First `{` that is not inside a comment or a string. */
  function findBlockStart(text, from) {
    return indexOutsideStrings(text, '{', from, text.length);
  }

  function indexOutsideStrings(text, needle, from, to) {
    let i = from;
    while (i < to) {
      const ch = text[i];
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? to : end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < to && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
        i++;
        continue;
      }
      if (ch === needle) return i;
      i++;
    }
    return -1;
  }

  /** Offset of the `}` matching the `{` at `open`, or -1. */
  function matchBlock(text, open) {
    let depth = 0;
    let i = open;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
        i++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (!depth) return i; }
      i++;
    }
    return -1;
  }

  function skipTrivia(text, i) {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      return i;
    }
  }

  /** The rule whose body contains `pos`, or null. */
  function ruleAt(sheet, pos) {
    let best = null;
    for (const rule of sheet.rules) {
      if (rule.kind !== 'rule') continue;
      if (pos >= rule.start && pos <= rule.end) best = rule;
    }
    return best;
  }

  root.WS.parse = { parseHtml, parseCss, nodeAt, ruleAt, readAttributes, matchBlock, skipTrivia };
})(window);
