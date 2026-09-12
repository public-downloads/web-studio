/* ============================================================================
   editor.js — a small code editor built on a textarea.

   The textarea stays the real editing surface: native caret, native selection,
   native undo, native IME. A <pre> underneath paints the syntax colours and a
   gutter tracks it. Programmatic edits go through execCommand('insertText') so
   they land on the browser's own undo stack rather than wiping it.

   `lang` is one of 'html', 'css' or 'js', and decides how Enter, `>` and
   Ctrl+/ behave.
   ========================================================================== */
(function (root) {
  'use strict';

  const INDENT = '  ';

  function Editor(host, opts) {
    opts = opts || {};
    const ta = host.querySelector('.ed-input');
    const layer = host.querySelector('.ed-layer code');
    const scroll = host.querySelector('.ed-scroll');
    const gutter = host.querySelector('.ed-gutter');
    const gutterInner = host.querySelector('.ed-gutter-inner');

    const listeners = { change: [], caret: [], scroll: [], key: [] };
    let diagnostics = [];
    let lineCount = -1;
    let frame = 0;
    let mirror = null;
    let suppress = false;

    let lang = opts.lang || 'html';

    /* ── events ──────────────────────────────────────────────────────── */

    function on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); return api; }
    function emit(name, arg) { for (const fn of (listeners[name] || [])) fn(arg); }

    /* ── rendering ───────────────────────────────────────────────────── */

    function scheduleRender() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; render(); });
    }

    function render() {
      const text = ta.value;
      layer.innerHTML = root.WS.highlight.render(text, lang, diagnostics);
      renderGutter(text);
      syncScroll();
    }

    function renderGutter(text) {
      const lines = countLines(text);
      if (lines !== lineCount) {
        lineCount = lines;
        const frag = document.createDocumentFragment();
        for (let i = 1; i <= lines; i++) {
          const el = document.createElement('div');
          el.className = 'ed-ln';
          el.textContent = String(i);
          frag.appendChild(el);
        }
        gutterInner.replaceChildren(frag);
      }
      markGutter(text);
    }

    function markGutter(text) {
      const rows = gutterInner.children;
      for (const row of rows) row.className = 'ed-ln';

      const starts = root.WS.lineStarts(text);
      for (const d of diagnostics) {
        const { line } = root.WS.posToLineCol(starts, d.start);
        const row = rows[line - 1];
        if (!row) continue;
        if (d.severity === 'error') row.classList.add('has-error');
        else if (d.severity === 'warning' && !row.classList.contains('has-error')) row.classList.add('has-warning');
      }
      const cur = root.WS.posToLineCol(starts, ta.selectionStart).line;
      if (rows[cur - 1]) rows[cur - 1].classList.add('is-current');
    }

    function countLines(text) {
      let count = 1;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
      return count;
    }

    function syncScroll() {
      const x = ta.scrollLeft, y = ta.scrollTop;
      layer.parentNode.style.transform = `translate(${-x}px, ${-y}px)`;
      gutterInner.style.transform = `translateY(${-y}px)`;
    }

    /* ── caret geometry ──────────────────────────────────────────────── */

    function ensureMirror() {
      if (mirror) return mirror;
      mirror = document.createElement('div');
      const cs = getComputedStyle(ta);
      Object.assign(mirror.style, {
        position: 'absolute', top: '0', left: '0',
        visibility: 'hidden', pointerEvents: 'none',
        whiteSpace: 'pre', font: cs.font, letterSpacing: cs.letterSpacing,
        padding: cs.padding, tabSize: cs.tabSize, lineHeight: cs.lineHeight
      });
      scroll.appendChild(mirror);
      return mirror;
    }

    /** Caret position in pixels, relative to the editor host. */
    function caretCoords(pos) {
      const m = ensureMirror();
      m.textContent = ta.value.slice(0, pos == null ? ta.selectionStart : pos);
      const marker = document.createElement('span');
      marker.textContent = '​';
      m.appendChild(marker);
      const x = marker.offsetLeft;
      const y = marker.offsetTop;
      m.textContent = '';

      const scrollBox = scroll.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      return {
        x: x - ta.scrollLeft + (scrollBox.left - hostBox.left),
        y: y - ta.scrollTop + (scrollBox.top - hostBox.top),
        lineHeight: lh
      };
    }

    /* ── edits ───────────────────────────────────────────────────────── */

    /** Replace [start,end) with `text`, keeping the native undo stack intact. */
    function replaceRange(start, end, text, caretOffset) {
      ta.focus();
      ta.setSelectionRange(start, end);
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok) {
        const v = ta.value;
        ta.value = v.slice(0, start) + text + v.slice(end);
      }
      const caret = start + (caretOffset == null ? text.length : caretOffset);
      ta.setSelectionRange(caret, caret);
      onInput();
    }

    function insert(text, caretOffset) {
      replaceRange(ta.selectionStart, ta.selectionEnd, text, caretOffset);
    }

    /* ── key handling ────────────────────────────────────────────────── */

    const CLOSERS = { '"': '"', "'": "'", '`': '`', '(': ')', '[': ']', '{': '}' };

    function onKeyDown(e) {
      emit('key', e);
      if (e.defaultPrevented) return;

      const start = ta.selectionStart, end = ta.selectionEnd, v = ta.value;

      /* Tab / Shift+Tab — indent or outdent whole lines when text is selected */
      if (e.key === 'Tab') {
        e.preventDefault();
        if (start !== end || e.shiftKey) {
          const from = v.lastIndexOf('\n', start - 1) + 1;
          const toRaw = v.indexOf('\n', end);
          const to = toRaw < 0 ? v.length : toRaw;
          const block = v.slice(from, to);
          const shifted = e.shiftKey
            ? block.replace(/^([ \t]{1,2})/gm, '')
            : block.replace(/^/gm, INDENT);
          const delta = shifted.length - block.length;
          ta.setSelectionRange(from, to);
          try { document.execCommand('insertText', false, shifted); }
          catch (err) { ta.value = v.slice(0, from) + shifted + v.slice(to); }
          ta.setSelectionRange(from, to + delta);
          onInput();
        } else {
          insert(INDENT);
        }
        return;
      }

      /* Enter — carry the indent, and open a block between a pair */
      if (e.key === 'Enter' && !e.shiftKey && start === end) {
        const lineStart = v.lastIndexOf('\n', start - 1) + 1;
        const lineHead = v.slice(lineStart, start);
        const indent = (/^[ \t]*/.exec(lineHead) || [''])[0];
        const before = lineHead.trimEnd();
        const after = v.slice(start);

        const opensTag = /<[A-Za-z][^<>]*>$/.test(before) && !/\/>$/.test(before) &&
          !/^<\//.test(before.slice(before.lastIndexOf('<')));
        const opensBrace = /[{([]$/.test(before);
        const opensBlock = lang === 'html' ? (opensTag || opensBrace) : opensBrace;
        const closesNext = lang === 'html'
          ? /^\s*(<\/|[)\]}])/.test(after)
          : /^\s*[)\]}]/.test(after);

        if (opensBlock && closesNext) {
          e.preventDefault();
          insert('\n' + indent + INDENT + '\n' + indent, 1 + indent.length + INDENT.length);
          return;
        }
        if (opensBlock) { e.preventDefault(); insert('\n' + indent + INDENT); return; }
        if (indent) { e.preventDefault(); insert('\n' + indent); return; }
        return;
      }

      /* `>` — close the tag you just opened, unless it is a void element */
      if (e.key === '>' && lang === 'html' && start === end) {
        const openAt = v.lastIndexOf('<', start - 1);
        if (openAt >= 0 && !/[<>]/.test(v.slice(openAt + 1, start))) {
          const inner = v.slice(openAt + 1, start);
          const m = /^([A-Za-z][\w.:-]*)/.exec(inner);
          if (m && !inner.endsWith('/') && !inner.startsWith('/') &&
              !inner.startsWith('!') && !inner.startsWith('?')) {
            const name = m[1];
            if (!root.WS.schema.isVoid(name)) {
              e.preventDefault();
              insert('></' + name + '>', 1);
              return;
            }
          }
        }
      }

      /* Bracket and quote pairing, and typing over the closing half */
      if (CLOSERS[e.key] && start === end) {
        const next = v.charAt(start);
        if (!/[\w-]/.test(next)) {
          e.preventDefault();
          insert(e.key + CLOSERS[e.key], 1);
          return;
        }
      }
      if (/^["'`)\]}]$/.test(e.key) && start === end && v.charAt(start) === e.key) {
        e.preventDefault();
        ta.setSelectionRange(start + 1, start + 1);
        emitCaret();
        return;
      }

      /* Backspace inside an empty pair deletes both halves */
      if (e.key === 'Backspace' && start === end && start > 0) {
        const prev = v.charAt(start - 1), next = v.charAt(start);
        if (CLOSERS[prev] === next) {
          e.preventDefault();
          replaceRange(start - 1, start + 1, '');
          return;
        }
      }

      /* Ctrl+/ — toggle comments on the selected lines */
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        toggleComment();
        return;
      }
    }

    /* JavaScript gets line comments — they nest, and `/*` inside a regex or a
       string is a genuinely nasty thing to toggle back off. */
    function toggleComment() {
      if (lang === 'js') return toggleLineComment();

      const v = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
      const from = v.lastIndexOf('\n', start - 1) + 1;
      const toRaw = v.indexOf('\n', end);
      const to = toRaw < 0 ? v.length : toRaw;
      const block = v.slice(from, to);
      const open = lang === 'css' ? '/*' : '<!--';
      const close = lang === 'css' ? '*/' : '-->';
      const trimmed = block.trim();
      const indent = (/^[ \t]*/.exec(block) || [''])[0];

      let next;
      if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
        next = indent + block.replace(open, '')
          .replace(new RegExp(close.replace(/[-*/]/g, '\\$&') + '\\s*$'), '').trim();
      } else {
        next = indent + open + ' ' + block.slice(indent.length).trimEnd() + ' ' + close;
      }
      writeBlock(from, to, next);
    }

    function toggleLineComment() {
      const v = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
      const from = v.lastIndexOf('\n', start - 1) + 1;
      const toRaw = v.indexOf('\n', end);
      const to = toRaw < 0 ? v.length : toRaw;
      const block = v.slice(from, to);
      const lines = block.split('\n');
      const meaningful = lines.filter((l) => l.trim());
      const allCommented = meaningful.length > 0 && meaningful.every((l) => /^\s*\/\//.test(l));

      const next = lines.map((line) => {
        if (!line.trim()) return line;
        if (allCommented) return line.replace(/^(\s*)\/\/ ?/, '$1');
        const indent = (/^[ \t]*/.exec(line) || [''])[0];
        return indent + '// ' + line.slice(indent.length);
      }).join('\n');
      writeBlock(from, to, next);
    }

    function writeBlock(from, to, next) {
      const v = ta.value;
      ta.setSelectionRange(from, to);
      try { document.execCommand('insertText', false, next); }
      catch (e) { ta.value = v.slice(0, from) + next + v.slice(to); }
      ta.setSelectionRange(from, from + next.length);
      onInput();
    }

    /* ── plumbing ────────────────────────────────────────────────────── */

    function onInput() {
      if (suppress) return;
      scheduleRender();
      emit('change', ta.value);
      emitCaret();
    }

    function emitCaret() {
      emit('caret', { start: ta.selectionStart, end: ta.selectionEnd });
      if (!frame) markGutter(ta.value);
    }

    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('scroll', () => { syncScroll(); emit('scroll'); }, { passive: true });
    ta.addEventListener('click', emitCaret);
    ta.addEventListener('select', emitCaret);
    ta.addEventListener('keyup', (e) => {
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' ||
          e.key === 'PageUp' || e.key === 'PageDown') emitCaret();
    });
    gutter.addEventListener('wheel', (e) => { ta.scrollTop += e.deltaY; }, { passive: true });

    /** Scroll `pos` into view with a little breathing room. */
    function reveal(pos) {
      const c = caretCoords(pos);
      const box = scroll.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      const yInBox = c.y - (box.top - hostBox.top);
      if (yInBox < 0) ta.scrollTop += yInBox - c.lineHeight;
      else if (yInBox + c.lineHeight > box.height) ta.scrollTop += yInBox + c.lineHeight * 2 - box.height;
    }

    const api = {
      el: host,
      textarea: ta,
      get lang() { return lang; },
      /** Switching document type re-colours in place; the text is set separately. */
      setLang(next) { lang = next; lineCount = -1; render(); },
      on,
      focus: () => ta.focus(),
      get value() { return ta.value; },
      set value(v) {
        suppress = true;
        ta.value = v;
        suppress = false;
        lineCount = -1;
        render();
        emit('change', v);
        emitCaret();
      },
      get selection() { return { start: ta.selectionStart, end: ta.selectionEnd }; },
      /**
       * @param {{focus?:boolean}} [opts] pass `focus: false` to move the caret
       *   in a pane that is not on screen without pulling focus off the one
       *   that is.
       */
      setSelection(start, end, opts) {
        if (!opts || opts.focus !== false) ta.focus();
        ta.setSelectionRange(start, end == null ? start : end);
        reveal(start);
        scheduleRender();
        emitCaret();
      },
      setDiagnostics(list) { diagnostics = list || []; scheduleRender(); },
      replaceRange,
      insert,
      caretCoords,
      reveal,
      refresh: render
    };
    return api;
  }

  root.WS = root.WS || {};
  root.WS.Editor = Editor;
  root.WS.INDENT = INDENT;
})(window);
