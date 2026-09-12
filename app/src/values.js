/* ============================================================================
   values.js — editing the two value types you cannot usefully type blind.

   A number wants to be nudged until it looks right, and a colour wants to be
   seen. Both get a small popover under the caret: drag the number, pick the
   colour. Neither writes to the document while you are still deciding — the
   preview updates from a candidate string and the document takes a single edit
   when you let go, so one gesture stays one undo step.
   ========================================================================== */
(function (root) {
  'use strict';

  const NUMBER = /-?\d*\.?\d+(?:px|em|rem|%|vw|vh|vmin|vmax|ch|ex|pt|cm|mm|in|s|ms|deg|turn|fr)?/g;

  /* A hex, rgb() or hsl() literal is a colour wherever it appears — inside a
     `box-shadow`, a gradient, or an attribute this editor has never heard of. */
  const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/gi;
  /* A bare word is only a colour where a colour belongs, otherwise keywords
     like `round` or `content` would be mistaken for one. */
  const COLOUR_NAMED = new RegExp('\\b(?:' +
    Object.keys(root.WS.complete.NAMED_COLOURS).join('|') + ')\\b', 'gi');

  const NAMED = {};
  for (const name in root.WS.complete.NAMED_COLOURS) {
    NAMED[name.toLowerCase()] = root.WS.complete.NAMED_COLOURS[name];
  }

  /* ── colour parsing and formatting ─────────────────────────────────── */

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const byte = (n) => clamp(Math.round(n), 0, 255);

  /** @returns {{r:number,g:number,b:number,a:number}|null} */
  function parseColour(text) {
    let value = String(text || '').trim();
    if (!value) return null;

    const named = NAMED[value.toLowerCase()];
    if (named === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (named === 'currentColor') return null;
    if (named) value = named;

    if (value[0] === '#') {
      const hex = value.slice(1);
      const short = hex.length === 3 || hex.length === 4;
      if (![3, 4, 6, 8].includes(hex.length) || /[^0-9a-fA-F]/.test(hex)) return null;
      const at = (i) => short
        ? parseInt(hex[i] + hex[i], 16)
        : parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return {
        r: at(0), g: at(1), b: at(2),
        a: (short ? hex.length === 4 : hex.length === 8) ? at(3) / 255 : 1
      };
    }

    const rgb = /^rgba?\(([^)]*)\)$/i.exec(value);
    if (rgb) {
      const parts = rgb[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      /* `n * 255 / 100` rather than `n * 2.55`: the latter puts 50% at
         127.4999… and rounds it down, one short of what a browser gives. */
      const channel = (raw) => raw.trim().endsWith('%')
        ? byte(parseFloat(raw) * 255 / 100)
        : byte(parseFloat(raw));
      return {
        r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]),
        a: parts[3] == null ? 1 : alphaOf(parts[3])
      };
    }

    const hsl = /^hsla?\(([^)]*)\)$/i.exec(value);
    if (hsl) {
      const parts = hsl[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const c = hslToRgb(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
      c.a = parts[3] == null ? 1 : alphaOf(parts[3]);
      return c;
    }
    return null;
  }

  const alphaOf = (raw) => clamp(raw.trim().endsWith('%')
    ? parseFloat(raw) / 100 : parseFloat(raw), 0, 1);

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 100) / 100;
    l = clamp(l, 0, 100) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const table = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
    const [r, g, b] = table[Math.floor(h / 60) % 6];
    return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255), a: 1 };
  }

  function rgbToHsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
    const d = max - min;
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: Math.round(((h * 60) % 360 + 360) % 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  const hex2 = (n) => byte(n).toString(16).padStart(2, '0');

  /** @param {'hex'|'rgb'|'hsl'} format */
  function formatColour(c, format) {
    const a = clamp(c.a == null ? 1 : c.a, 0, 1);
    if (format === 'rgb') {
      return a >= 1
        ? `rgb(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)})`
        : `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${round(a, 2)})`;
    }
    if (format === 'hsl') {
      const h = rgbToHsl(c);
      return a >= 1
        ? `hsl(${h.h}, ${h.s}%, ${h.l}%)`
        : `hsla(${h.h}, ${h.s}%, ${h.l}%, ${round(a, 2)})`;
    }
    const base = '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
    return a >= 1 ? base : base + hex2(a * 255);
  }

  function round(n, places) {
    const f = Math.pow(10, places);
    return Math.round(n * f) / f;
  }

  /** The format a value is already written in, so edits keep the author's style. */
  function formatOf(text) {
    const value = String(text || '').trim().toLowerCase();
    if (value.startsWith('hsl')) return 'hsl';
    if (value.startsWith('rgb')) return 'rgb';
    return 'hex';
  }

  /* ── finding the token under the caret ─────────────────────────────── */

  function findToken(text, from, to, pos, re) {
    re.lastIndex = 0;
    const slice = text.slice(from, to);
    let m;
    while ((m = re.exec(slice))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (pos >= start && pos <= end) return { start, end, value: m[0] };
    }
    return null;
  }

  const isColourProp = root.WS.complete.isColourProp;

  /** The colour under the caret, literal anywhere, named only where it fits. */
  function colourAt(text, from, to, pos, prop) {
    const literal = findToken(text, from, to, pos, COLOUR_LITERAL);
    if (literal) return literal;
    if (prop && isColourProp(prop)) return findToken(text, from, to, pos, COLOUR_NAMED);
    return null;
  }

  function fromRange(text, from, to, pos, prop) {
    if (from < 0 || to < from) return null;
    /* Colours win over numbers: the caret inside `rgba(0, 0, 0, .5)` is also
       inside a number, and the picker is the better tool for it. */
    const colour = colourAt(text, from, to, pos, prop);
    if (colour) return Object.assign({ kind: 'colour', prop }, colour);
    const hit = findToken(text, from, to, pos, NUMBER);
    if (hit) return Object.assign({ kind: 'number', prop }, hit);
    return null;
  }

  /** Classify the value the caret sits in, or null when it is not one of ours. */
  function analyse(editor) {
    const text = editor.value;
    const pos = editor.selection.start;
    if (editor.selection.end !== pos) return null;

    if (editor.lang === 'js') return null;
    if (editor.lang === 'css') return cssValueAt(text, pos, 0);

    /* HTML: a <style> block, an inline style attribute, or an attribute whose
       value simply is a colour or a number. */
    const region = root.WS.analyze.embeddedRegion(text, pos);
    if (region && region.lang === 'css') {
      const hit = cssValueAt(text.slice(region.start, region.end), pos - region.start, region.start);
      return hit;
    }
    if (region) return null;

    const ctx = root.WS.analyze.contextAt(text, pos, 'html');
    if (ctx.kind !== 'attr-value' || ctx.valueStart == null) return null;

    if (ctx.attr === 'style') {
      const decl = inlineDeclarationAt(text, ctx.valueStart, ctx.valueEnd, pos);
      if (!decl) return null;
      return fromRange(text, decl.valueStart, decl.valueEnd, pos, decl.prop);
    }

    const whole = text.slice(ctx.valueStart, ctx.valueEnd);
    const colourish = /colou?r/i.test(ctx.attr) || !!parseColour(whole.trim());
    if (colourish) {
      const hit = colourAt(text, ctx.valueStart, ctx.valueEnd, pos, 'color');
      if (hit) return Object.assign({ kind: 'colour', attr: ctx.attr }, hit);
    }
    /* Only where the whole value is a number, or `width="12"` and `id="row2"`
       would be treated the same way. */
    if (/^\s*-?\d*\.?\d+\s*$/.test(whole)) {
      const hit = findToken(text, ctx.valueStart, ctx.valueEnd, pos, NUMBER);
      if (hit) return Object.assign({ kind: 'number', attr: ctx.attr, integer: true }, hit);
    }
    return null;
  }

  /** The declaration value the caret is inside, within a stylesheet. */
  function cssValueAt(css, pos, offset) {
    const state = root.WS.analyze.cssStateAt(css, pos);
    if (state.inComment || state.inString) return null;
    if (state.blockKind !== 'rule' || state.colon < 0) return null;

    const prop = css.slice(state.stmtStart, state.colon).trim();
    const valueStart = state.colon + 1;
    let valueEnd = valueStart;
    let depth = 0;
    while (valueEnd < css.length) {
      const ch = css[valueEnd];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ';' || ch === '}') && depth <= 0) break;
      valueEnd++;
    }
    const hit = fromRange(css, valueStart, valueEnd, pos, prop);
    if (!hit) return null;
    return Object.assign(hit, { start: hit.start + offset, end: hit.end + offset });
  }

  /** Split an inline `style="a: 1; b: 2"` and find the declaration at `pos`. */
  function inlineDeclarationAt(text, from, to, pos) {
    let i = from;
    while (i < to) {
      let end = text.indexOf(';', i);
      if (end < 0 || end > to) end = to;
      const colon = text.indexOf(':', i);
      if (colon >= 0 && colon < end && pos > colon && pos <= end) {
        return { prop: text.slice(i, colon).trim(), valueStart: colon + 1, valueEnd: end };
      }
      i = end + 1;
    }
    return null;
  }

  /* ── the controller ────────────────────────────────────────────────── */

  /**
   * @param {object} editor
   * @param {{root: HTMLElement}} ui the popover markup, already in the document
   * @param {{preview?: function, previewRestore?: function, isBusy?: function}} hooks
   */
  function ValueTools(editor, ui, hooks) {
    const box = ui.root;
    let token = null;
    let scrub = null;

    const el = (sel) => box.querySelector(sel);
    const numPane = el('.vt-number');
    const colPane = el('.vt-colour');
    const numInput = el('.vt-num-input');
    const numHint = el('.vt-num-hint');
    const scrubGrip = el('.vt-grip');
    const swatch = el('.vt-swatch');
    const native = el('.vt-native');
    const hexInput = el('.vt-hex');
    const channels = [...box.querySelectorAll('.vt-ch')];

    function hide() {
      if (box.hidden) return;
      box.hidden = true;
      token = null;
      endLive();
    }

    /** Show a candidate value in the preview without touching the document. */
    function live(next) {
      if (!token) return;
      const text = editor.value.slice(0, token.start) + next + editor.value.slice(token.end);
      if (hooks.preview) hooks.preview(text);
    }

    function endLive() {
      if (hooks.previewRestore) hooks.previewRestore();
    }

    /** Write the value to the document as one edit. */
    function commit(next) {
      if (!token || next === token.value) { endLive(); return; }
      const at = token.start;
      const end = token.end;
      endLive();
      token = null;                                   // refresh() re-derives it
      editor.replaceRange(at, end, next, next.length);
    }

    /* ── numbers ─────────────────────────────────────────────────────── */

    const splitNumber = (text) => {
      const m = /^(-?\d*\.?\d+)(.*)$/.exec(String(text).trim());
      return m ? { n: parseFloat(m[1]), unit: m[2] || '' } : { n: 0, unit: '' };
    };

    function stepFor(e) {
      /* Whole numbers by default; Alt for fine detail, Shift for coarse. */
      if (e.altKey) return 0.1;
      if (e.shiftKey) return 10;
      return 1;
    }

    function showNumber() {
      numPane.hidden = false;
      colPane.hidden = true;
      numInput.value = token.value;
      numHint.textContent = 'drag - Alt 0.1 - Shift 10';
    }

    scrubGrip.addEventListener('pointerdown', (e) => {
      if (!token || token.kind !== 'number') return;
      e.preventDefault();
      scrubGrip.setPointerCapture(e.pointerId);
      const parts = splitNumber(token.value);
      scrub = { x: e.clientX, base: parts.n, unit: parts.unit, step: stepFor(e), value: token.value };
      box.classList.add('is-scrubbing');
    });

    scrubGrip.addEventListener('pointermove', (e) => {
      if (!scrub) return;
      const step = stepFor(e);
      if (step !== scrub.step) {
        /* Changing the modifier mid-drag rebases, so the value does not jump. */
        scrub.base = splitNumber(scrub.value).n;
        scrub.x = e.clientX;
        scrub.step = step;
      }
      const steps = Math.round((e.clientX - scrub.x) / 4);
      const raw = scrub.base + steps * step;
      const value = round(raw, step < 1 ? 2 : 0);
      scrub.value = (token.integer ? Math.round(value) : value) + scrub.unit;
      numInput.value = scrub.value;
      numHint.textContent = (step === 0.1 ? '0.1' : step === 10 ? '10' : '1') + ' per notch';
      live(scrub.value);
    });

    const endScrub = (e) => {
      if (!scrub) return;
      const final = scrub.value;
      scrub = null;
      box.classList.remove('is-scrubbing');
      if (e && e.pointerId != null && scrubGrip.hasPointerCapture(e.pointerId)) {
        scrubGrip.releasePointerCapture(e.pointerId);
      }
      commit(final);
      setTimeout(refresh, 0);
    };
    scrubGrip.addEventListener('pointerup', endScrub);
    scrubGrip.addEventListener('pointercancel', endScrub);

    numInput.addEventListener('input', () => { if (token) live(numInput.value); });
    numInput.addEventListener('change', () => { if (token) commit(numInput.value); });
    numInput.addEventListener('keydown', (e) => {
      if (!token) return;
      if (e.key === 'Enter') { e.preventDefault(); commit(numInput.value); editor.focus(); return; }
      if (e.key === 'Escape') { e.preventDefault(); endLive(); editor.focus(); return; }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const parts = splitNumber(numInput.value);
      const step = stepFor(e) * (e.key === 'ArrowUp' ? 1 : -1);
      numInput.value = round(parts.n + step, step % 1 === 0 ? 0 : 2) + parts.unit;
      live(numInput.value);
    });

    /* ── colours ─────────────────────────────────────────────────────── */

    let colour = { r: 255, g: 255, b: 255, a: 1 };
    let format = 'hex';

    function showColour() {
      numPane.hidden = true;
      colPane.hidden = false;
      colour = parseColour(token.value) || { r: 255, g: 255, b: 255, a: 1 };
      format = formatOf(token.value);
      paint();
      for (const button of box.querySelectorAll('.vt-fmt')) {
        button.setAttribute('aria-pressed', button.dataset.fmt === format ? 'true' : 'false');
      }
    }

    function paint() {
      swatch.style.setProperty('--swatch', formatColour(colour, 'rgb'));
      native.value = '#' + hex2(colour.r) + hex2(colour.g) + hex2(colour.b);
      hexInput.value = formatColour(colour, 'hex');
      for (const input of channels) {
        const ch = input.dataset.ch;
        input.value = ch === 'a' ? round(colour.a, 2) : byte(colour[ch]);
      }
    }

    const emitColour = (final) => {
      const next = formatColour(colour, format);
      paint();
      if (final) commit(next); else live(next);
    };

    native.addEventListener('input', () => {
      const parsed = parseColour(native.value);
      if (!parsed) return;
      colour = { r: parsed.r, g: parsed.g, b: parsed.b, a: colour.a };
      emitColour(false);
    });
    native.addEventListener('change', () => emitColour(true));

    for (const input of channels) {
      input.addEventListener('input', () => {
        const ch = input.dataset.ch;
        const raw = parseFloat(input.value);
        if (!isFinite(raw)) return;
        colour[ch] = ch === 'a' ? clamp(raw, 0, 1) : byte(raw);
        emitColour(false);
      });
      input.addEventListener('change', () => emitColour(true));
    }

    hexInput.addEventListener('change', () => {
      const parsed = parseColour(hexInput.value);
      if (!parsed) { paint(); return; }
      colour = parsed;
      emitColour(true);
    });

    for (const button of box.querySelectorAll('.vt-fmt')) {
      button.addEventListener('click', () => {
        format = button.dataset.fmt;
        for (const other of box.querySelectorAll('.vt-fmt')) {
          other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
        }
        emitColour(true);
      });
    }

    /* ── placement ───────────────────────────────────────────────────── */

    function place() {
      const anchor = editor.caretCoords(token.start);
      const host = editor.el.parentNode;
      const hostBox = host.getBoundingClientRect();
      /* Caret coordinates are pane-relative; the pane is offset inside the
         host whenever the layout is split. */
      const paneBox = editor.el.getBoundingClientRect();
      const x = anchor.x + (paneBox.left - hostBox.left);
      const y = anchor.y + (paneBox.top - hostBox.top);

      box.hidden = false;
      box.style.visibility = 'hidden';
      box.style.left = '0px';
      box.style.top = '0px';
      const self = box.getBoundingClientRect();

      let top = y + anchor.lineHeight + 3;
      if (top + self.height > hostBox.height && y - self.height - 3 > 0) {
        top = y - self.height - 3;
      }
      box.style.left = Math.max(4, Math.min(x - 8, hostBox.width - self.width - 4)) + 'px';
      box.style.top = Math.max(2, Math.min(top, hostBox.height - self.height - 2)) + 'px';
      box.style.visibility = '';
    }

    /** Re-derive what the caret is on and show or hide accordingly. */
    function refresh() {
      if (scrub) return;
      if (hooks.isBusy && hooks.isBusy()) return hide();
      if (box.contains(document.activeElement)) return;   // the user is inside the popover
      let next = null;
      try { next = analyse(editor); } catch (e) { next = null; }
      if (!next) return hide();
      token = next;
      if (next.kind === 'number') showNumber(); else showColour();
      place();
    }

    /** Open the popover for a value the completion list just inserted. */
    function open() {
      setTimeout(() => { hide(); refresh(); if (!box.hidden) focusFirst(); }, 0);
    }

    function focusFirst() {
      if (!numPane.hidden) numInput.select();
      else if (channels[0]) channels[0].select();
    }

    editor.on('caret', () => setTimeout(refresh, 0));
    editor.on('change', () => setTimeout(refresh, 0));
    editor.on('scroll', () => { if (!box.hidden && token) place(); });
    editor.textarea.addEventListener('blur', () => setTimeout(() => {
      if (!box.contains(document.activeElement)) hide();
    }, 150));
    box.addEventListener('focusout', () => setTimeout(() => {
      if (!box.contains(document.activeElement) && document.activeElement !== editor.textarea) hide();
    }, 150));

    return { refresh, hide, open, isOpen: () => !box.hidden };
  }

  root.WS.ValueTools = ValueTools;
  root.WS.colour = { parse: parseColour, format: formatColour, formatOf, hslToRgb, rgbToHsl };
  root.WS.valueTokens = { analyse, findToken, NUMBER, COLOUR_LITERAL, COLOUR_NAMED };
})(window);
