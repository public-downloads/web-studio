/* ============================================================================
   edits.js — turning a gesture into a change in the source.

   Dragging a box on screen is only useful if what comes out the other side is
   code you would have been willing to write. So every function here works on
   the text: it finds the declaration or the element in the source, changes
   that, and returns a new string. Nothing round-trips through a parsed model
   that then has to be printed back out, because printing back out is where
   formatting goes to die.

   All of it is pure. Given the same text and the same request you get the same
   answer, which is what makes it testable without a browser.
   ========================================================================== */
(function (root) {
  'use strict';

  const INDENT = root.WS.INDENT || '  ';

  /* ── source geometry ─────────────────────────────────────────────────── */

  const lineStart = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;

  function lineEnd(text, pos) {
    const at = text.indexOf('\n', pos);
    return at < 0 ? text.length : at;
  }

  /** The whitespace the line containing `pos` begins with. */
  function indentAt(text, pos) {
    const from = lineStart(text, pos);
    return (/^[ \t]*/.exec(text.slice(from, lineEnd(text, pos))) || [''])[0];
  }

  const isBlank = (s) => !/\S/.test(s);

  /* ── moving an element ───────────────────────────────────────────────── */

  /** Would moving `source` into `target` put it inside itself? */
  const wouldNestInItself = (source, target) =>
    target.start >= source.start && target.end <= source.end;

  /**
   * Move an element's markup next to, or inside, another element.
   *
   * @param {string} html
   * @param {object} source node being moved
   * @param {object} target node being dropped onto
   * @param {'before'|'after'|'inside'} position
   * @returns {string|null} the new source, or null if the move makes no sense
   */
  function moveNode(html, source, target, position) {
    if (!source || !target || source === target) return null;
    if (wouldNestInItself(source, target)) return null;

    const cut = cutRange(html, source);
    const fragment = html.slice(source.start, source.end);

    let at;
    if (position === 'inside') at = target.openEnd;
    else if (position === 'before') at = lineStart(html, target.start);
    else at = lineEnd(html, target.end);

    /* Dropping something back exactly where it already was is not a move. */
    if (at >= cut.from && at <= cut.to) return null;

    const indent = position === 'inside'
      ? indentAt(html, target.start) + INDENT
      : indentAt(html, target.start);
    const block = reindent(fragment, indentAt(html, source.start), indent);

    if (position === 'before') return splice(html, cut, at, indent + block + '\n');
    return splice(html, cut, at, '\n' + indent + block);
  }

  /**
   * Remove [cut.from, cut.to) and insert `block` at `at`, in whichever order
   * keeps the offsets honest.
   */
  function splice(html, cut, at, block) {
    if (at <= cut.from) {
      return html.slice(0, at) + block + html.slice(at, cut.from) + html.slice(cut.to);
    }
    return html.slice(0, cut.from) + html.slice(cut.to, at) + block + html.slice(at);
  }

  /**
   * The range to lift out: the element, plus the indentation in front of it and
   * the newline after it when those exist only to hold the element.
   */
  function cutRange(html, node) {
    let from = node.start;
    if (isBlank(html.slice(lineStart(html, node.start), node.start))) {
      from = lineStart(html, node.start);
    }
    let to = node.end;
    if (isBlank(html.slice(node.end, lineEnd(html, node.end)))) {
      to = Math.min(html.length, lineEnd(html, node.end) + 1);
    }
    return { from, to };
  }

  /** Re-hang a multi-line fragment under a different indent. */
  function reindent(fragment, was, now) {
    const lines = fragment.split('\n');
    if (lines.length === 1) return fragment;
    return lines.map((line, i) => {
      if (i === 0) return line;
      if (isBlank(line)) return '';
      return now + (line.startsWith(was) ? line.slice(was.length) : line.replace(/^[ \t]*/, ''));
    }).join('\n');
  }

  /* ── inline styles ───────────────────────────────────────────────────── */

  /** Split `a: 1; b: 2` into an ordered list of pairs. */
  function parseInline(value) {
    const out = [];
    for (const part of String(value || '').split(';')) {
      const at = part.indexOf(':');
      if (at < 0) continue;
      const name = part.slice(0, at).trim();
      if (name) out.push({ name, value: part.slice(at + 1).trim() });
    }
    return out;
  }

  const printInline = (pairs) => pairs.map((p) => p.name + ': ' + p.value).join('; ');

  /** Merge `props` into a list of pairs; a null value removes the property. */
  function mergeProps(pairs, props) {
    const out = pairs.slice();
    for (const name in props) {
      const value = props[name];
      const at = out.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
      if (value == null || value === '') {
        if (at >= 0) out.splice(at, 1);
      } else if (at >= 0) {
        out[at] = { name: out[at].name, value };
      } else {
        out.push({ name, value });
      }
    }
    return out;
  }

  /**
   * Write declarations into an element's `style` attribute, adding the
   * attribute if it is not there yet.
   * @returns {string} the new HTML
   */
  function setInlineStyle(html, node, props) {
    const existing = (node.attrRanges || []).find((a) => a.name.toLowerCase() === 'style');
    const merged = mergeProps(existing ? parseInline(existing.value) : [], props);
    const text = printInline(merged);

    if (existing && existing.valueStart >= 0) {
      if (!text) {
        /* An empty style attribute is litter; take the whole thing out. */
        let from = existing.nameStart;
        while (from > node.nameEnd && /\s/.test(html[from - 1])) from--;
        const to = existing.quoted ? existing.valueEnd + 1 : existing.valueEnd;
        return html.slice(0, from) + html.slice(to);
      }
      return html.slice(0, existing.valueStart) + text + html.slice(existing.valueEnd);
    }
    if (!text) return html;

    const at = node.openEnd - (node.selfClosing ? 2 : 1);
    return html.slice(0, at) + ' style="' + text + '"' + html.slice(at);
  }

  /* ── stylesheet rules ────────────────────────────────────────────────── */

  /** The selectors that would target this element, most specific first. */
  function candidateSelectors(node) {
    const out = [];
    const classes = (node.attrs.class || '').trim().split(/\s+/).filter(Boolean);
    if (node.attrs.id) out.push('#' + node.attrs.id, node.tag + '#' + node.attrs.id);
    if (classes.length > 1) out.push('.' + classes.join('.'));
    for (let i = classes.length - 1; i >= 0; i--) {
      out.push('.' + classes[i], node.tag + '.' + classes[i]);
    }
    out.push(node.tag);
    return out;
  }

  const normalise = (selector) => String(selector).trim().replace(/\s+/g, ' ').toLowerCase();

  /**
   * The rule already styling this element, if there is an obvious one.
   *
   * Rules inside `@media` and friends are skipped: a width you dragged at
   * desktop size does not belong in the phone breakpoint, and quietly putting
   * it there would be the kind of help nobody asked for.
   *
   * @param {object[]} rules from parse.parseCss
   * @returns {object|null}
   */
  function ruleFor(rules, node) {
    const wanted = candidateSelectors(node).map(normalise);
    let best = null;
    let bestRank = Infinity;
    for (const rule of rules) {
      if (rule.kind !== 'rule' || rule.at) continue;
      const rank = wanted.indexOf(normalise(rule.selector));
      if (rank < 0) continue;
      /* Equal specificity: the later rule is the one that actually applies. */
      if (rank <= bestRank) { best = rule; bestRank = rank; }
    }
    return best;
  }

  /** The selector to create when nothing matches yet, or null to go inline. */
  function newSelectorFor(node) {
    if (node.attrs.id) return '#' + node.attrs.id;
    const first = (node.attrs.class || '').trim().split(/\s+/).filter(Boolean)[0];
    return first ? '.' + first : null;
  }

  /**
   * Write declarations into an existing rule body.
   * @returns {string} the new stylesheet
   */
  function setRuleProperties(css, rule, props) {
    const edits = [];
    const bodyIndent = indentAt(css, rule.start) + INDENT;

    for (const name in props) {
      const value = props[name];
      const existing = rule.declarations.find((d) => d.name.toLowerCase() === name.toLowerCase());

      if (value == null || value === '') {
        if (existing) edits.push({ from: declStart(css, existing), to: existing.end, text: '' });
        continue;
      }
      if (existing) {
        edits.push({ from: existing.valueStart, to: existing.valueEnd, text: value });
      } else {
        edits.push({
          from: rule.bodyEnd, to: rule.bodyEnd,
          text: newDeclaration(css, rule, bodyIndent, name, value)
        });
      }
    }

    /* Back to front, so earlier offsets are still valid when they are used. */
    edits.sort((a, b) => b.from - a.from);
    let out = css;
    for (const edit of edits) out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
    return out;
  }

  /** Swallow the whitespace in front of a declaration when deleting it. */
  function declStart(css, decl) {
    return isBlank(css.slice(lineStart(css, decl.start), decl.start))
      ? lineStart(css, decl.start) : decl.start;
  }

  /** A new declaration, formatted to match the rule it is joining. */
  function newDeclaration(css, rule, indent, name, value) {
    const body = css.slice(rule.bodyStart, rule.bodyEnd);
    if (!body.includes('\n')) {
      const trimmed = body.trim();
      const separator = !trimmed || trimmed.endsWith(';') ? ' ' : '; ';
      return separator + name + ': ' + value + '; ';
    }
    const tail = css.slice(lineStart(css, rule.bodyEnd), rule.bodyEnd);
    return (isBlank(tail) ? '' : '\n') + indent + name + ': ' + value + ';\n';
  }

  /**
   * Append a new rule to a stylesheet.
   * @returns {{text: string, start: number}} the sheet, and where the rule landed
   */
  function createRule(css, selector, props) {
    const pairs = mergeProps([], props);
    const body = pairs.map((p) => INDENT + p.name + ': ' + p.value + ';').join('\n');
    const gap = !css.trim() ? '' : css.endsWith('\n\n') ? '' : css.endsWith('\n') ? '\n' : '\n\n';
    const start = css.length + gap.length;
    return { text: css + gap + selector + ' {\n' + body + '\n}\n', start };
  }

  root.WS.edits = {
    moveNode,
    wouldNestInItself,
    setInlineStyle,
    setRuleProperties,
    createRule,
    ruleFor,
    newSelectorFor,
    candidateSelectors,
    parseInline,
    printInline,
    mergeProps,
    indentAt,
    lineStart,
    lineEnd,
    reindent,
    cutRange
  };
})(window);
