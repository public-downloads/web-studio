/* ============================================================================
   app.js — the wiring.

   Everything else in src/ is a piece that can be reasoned about on its own.
   This file owns the state they share: which documents are open, which pane
   shows which one, and the order things happen in after a keystroke.

   The document text is the single source of truth. Panes render it, the
   preview is rebuilt from it, and nothing keeps a second copy that could
   drift.
   ========================================================================== */
(function (root) {
  'use strict';

  const { schema, analyze, parse, complete, files, edits, preview: pv } = root.WS;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    docs: [],
    panes: [],
    focused: null,
    split: false,
    loading: false,
    builtHtml: ''
  };

  /* ── documents ───────────────────────────────────────────────────────── */

  const makeDoc = (spec) => ({
    name: spec.name,
    lang: spec.lang || files.langOf(spec.name),
    text: spec.text || '',
    handle: spec.handle || null,
    path: spec.path || null,
    dirty: false
  });

  const htmlDoc = () => state.docs.find((d) => d.lang === 'html') || null;
  const docsOfLang = (lang) => state.docs.filter((d) => d.lang === lang);

  /** The three strings the preview is assembled from. */
  function snapshot() {
    const html = htmlDoc();
    return {
      html: html ? html.text : '',
      css: docsOfLang('css').map((d) => d.text).join('\n\n'),
      js: docsOfLang('js').map((d) => d.text).join('\n\n')
    };
  }

  const anyDirty = () => state.docs.some((d) => d.dirty);

  /* ── names shared between documents ──────────────────────────────────── */

  /** Recomputing on every keystroke is wasteful; the text is the cache key. */
  function memo(fn) {
    let key = null;
    let value = null;
    return (input) => {
      if (input === key) return value;
      key = input;
      try { value = fn(input); } catch (e) { value = []; }
      return value;
    };
  }

  const classesInHtml = memo((text) => {
    const found = new Set();
    const tree = parse.parseHtml(text);
    for (const node of tree.elements) {
      const raw = node.attrs.class;
      if (!raw) continue;
      for (const name of raw.split(/\s+/)) if (name) found.add(name);
    }
    return [...found];
  });

  const idsInHtml = memo((text) => {
    const found = new Set();
    const tree = parse.parseHtml(text);
    for (const node of tree.elements) if (node.attrs.id) found.add(node.attrs.id);
    return [...found];
  });

  const CLASS_IN_SELECTOR = /\.(-?[A-Za-z_][\w-]*)/g;

  const classesInCss = memo((text) => {
    const found = new Set();
    for (const rule of parse.parseCss(text).rules) {
      if (rule.kind !== 'rule') continue;
      let m;
      CLASS_IN_SELECTOR.lastIndex = 0;
      while ((m = CLASS_IN_SELECTOR.exec(rule.selector))) found.add(m[1]);
    }
    return [...found];
  });

  const VAR_DECL = /(--[\w-]+)\s*:/g;

  const varsInCss = memo((text) => {
    const found = new Set();
    let m;
    VAR_DECL.lastIndex = 0;
    while ((m = VAR_DECL.exec(text))) found.add(m[1]);
    return [...found];
  });

  const IDENT_DECL = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;

  const identsInJs = memo((text) => {
    const found = new Set();
    let m;
    IDENT_DECL.lastIndex = 0;
    while ((m = IDENT_DECL.exec(text))) found.add(m[1]);
    return [...found];
  });

  /** The CSS of the project, wherever it lives: .css files and <style> blocks. */
  function allCss() {
    const html = htmlDoc();
    let css = docsOfLang('css').map((d) => d.text).join('\n');
    if (html) {
      const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
      let m;
      while ((m = STYLE.exec(html.text))) css += '\n' + m[1];
    }
    return css;
  }

  const providers = {
    classes: () => {
      const html = htmlDoc();
      const fromCss = classesInCss(allCss());
      const fromHtml = html ? classesInHtml(html.text) : [];
      /* Whichever document you are in, the other one's names are the useful
         half — but both are offered so a class you just invented still
         completes on its second use. */
      return [...new Set([...fromHtml, ...fromCss])];
    },
    ids: () => {
      const html = htmlDoc();
      return html ? idsInHtml(html.text) : [];
    },
    vars: () => varsInCss(allCss()),
    identifiers: () => {
      const pane = focused();
      return pane && pane.doc.lang === 'js' ? identsInJs(pane.doc.text) : [];
    }
  };

  /* ── panes ───────────────────────────────────────────────────────────── */

  const focused = () => state.focused || state.panes[0];

  function makePane(el) {
    const host = el.querySelector('.ed');
    const tabs = el.querySelector('.pane-tabs');

    const editor = root.WS.Editor(host, { lang: 'html' });

    const valuesUi = document.getElementById('tpl-values').content.firstElementChild.cloneNode(true);
    el.appendChild(valuesUi);

    const pane = { el, host, tabs, editor, doc: null, diagnostics: [] };

    pane.values = root.WS.ValueTools(editor, { root: valuesUi }, {
      preview: (text) => livePreview(pane, text),
      previewRestore: () => { livePreviewText = null; schedulePreview(); },
      isBusy: () => pane.completion && pane.completion.open
    });

    pane.completion = complete.Completion(editor, {
      getContext: () => contextFor(pane),
      providers,
      onAction: (action) => {
        if (action === 'colour') openColourPicker(pane);
      }
    });

    editor.on('change', () => {
      if (state.loading || !pane.doc) return;
      pane.doc.text = editor.value;
      pane.doc.dirty = true;
      onDocChanged(pane);
    });

    editor.on('caret', () => {
      if (pane !== focused()) return;
      updateStatus(pane);
      markOutline(pane);
    });

    editor.textarea.addEventListener('focus', () => {
      state.focused = pane;
      renderTabs();
      renderOutline();
      updateStatus(pane);
    });

    return pane;
  }

  function contextFor(pane) {
    if (!pane.doc) return null;
    try {
      return analyze.contextAt(pane.editor.value, pane.editor.selection.start, pane.doc.lang);
    } catch (e) {
      return null;
    }
  }

  /** Put a document in a pane, without the round trip through `change`. */
  function showDoc(pane, doc) {
    if (!doc) return;
    /* The same file open twice would give two textareas racing to write it. */
    for (const other of state.panes) {
      if (other !== pane && other.doc === doc && !other.el.hidden) {
        const spare = state.docs.find((d) => d !== doc);
        if (spare) showDoc(other, spare);
      }
    }
    state.loading = true;
    pane.doc = doc;
    pane.editor.setLang(doc.lang);
    pane.editor.value = doc.text;
    state.loading = false;
    runDiagnostics(pane);
    renderTabs();
    if (pane === focused()) { renderOutline(); updateStatus(pane); }
  }

  /**
   * Anything that removes a document has to answer for the panes that were
   * showing it, including a hidden one — otherwise splitting the editor later
   * reveals a file that is no longer part of the project.
   */
  function ensurePaneDocs() {
    for (const pane of state.panes) {
      if (state.docs.includes(pane.doc)) continue;
      const fallback = state.docs.find((d) => !state.panes.some((p) => p !== pane && p.doc === d))
        || state.docs[0];
      if (pane.el.hidden) pane.doc = fallback;      // no visible editor to sync
      else showDoc(pane, fallback);
    }
  }

  function renderTabs() {
    for (const pane of state.panes) {
      const frag = document.createDocumentFragment();
      state.docs.forEach((doc) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab' + (doc === pane.doc ? ' is-active' : '');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', doc === pane.doc ? 'true' : 'false');
        tab.title = doc.path || doc.name;

        const label = document.createElement('span');
        label.textContent = doc.name;
        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        dot.hidden = !doc.dirty;
        tab.append(label, dot);

        tab.addEventListener('click', () => { showDoc(pane, doc); pane.editor.focus(); });
        tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeDoc(doc); });
        frag.appendChild(tab);
      });
      pane.tabs.replaceChildren(frag);
    }
    updateSaveState();
  }

  function closeDoc(doc) {
    if (state.docs.length < 2) return;
    const at = state.docs.indexOf(doc);
    state.docs.splice(at, 1);
    ensurePaneDocs();
    renderTabs();
    schedulePreview();
  }

  /* -- writing to a document from outside the editor -------------------- */

  /** The smallest replacement that turns `a` into `b`. */
  function minimalEdit(a, b) {
    let from = 0;
    const limit = Math.min(a.length, b.length);
    while (from < limit && a[from] === b[from]) from++;
    let tail = 0;
    while (tail < limit - from && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { from, to: a.length - tail, text: b.slice(from, b.length - tail) };
  }

  /**
   * Replace a document's text on behalf of a gesture in the preview.
   *
   * Routed through the editor rather than assigned, so Ctrl+Z takes a drag
   * back the same way it takes a typo back. execCommand needs the textarea
   * focused, so focus is borrowed and handed straight back - otherwise the
   * first drag would throw you out of the preview.
   */
  function patchDoc(doc, next) {
    if (next == null || next === doc.text) return false;
    const pane = state.panes.find((p) => p.doc === doc && !p.el.hidden);
    if (!pane) {
      doc.text = next;
    } else {
      const active = document.activeElement;
      const patch = minimalEdit(doc.text, next);
      state.loading = true;
      pane.editor.replaceRange(patch.from, patch.to, patch.text, 0);
      state.loading = false;
      doc.text = pane.editor.value;
      if (active && active !== pane.editor.textarea && active.focus) active.focus();
      runDiagnostics(pane);
    }
    doc.dirty = true;
    renderTabs();
    renderOutline();
    schedulePreview(true);
    return true;
  }

  /* -- the loop after an edit ------------------------------------------- */

  let diagTimer = 0;
  let previewTimer = 0;
  let draftTimer = 0;
  let livePreviewText = null;

  function onDocChanged(pane) {
    clearTimeout(diagTimer);
    diagTimer = setTimeout(() => runDiagnostics(pane), 180);

    schedulePreview();
    renderTabs();
    updateStatus(pane);

    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => files.saveDraft({
      docs: state.docs,
      active: state.docs.indexOf(focused() ? focused().doc : null)
    }), 900);

    if (pane === focused()) {
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(renderOutline, 200);
    }

    maybeComplete(pane);
  }

  function runDiagnostics(pane) {
    if (!pane.doc) return;
    pane.diagnostics = analyze.diagnose(pane.doc.text, pane.doc.lang);
    pane.editor.setDiagnostics(pane.diagnostics);
    if (pane === focused()) updateStatus(pane);
  }

  function schedulePreview(immediate) {
    clearTimeout(previewTimer);
    const docs = livePreviewText != null ? livePreviewText : snapshot();
    previewTimer = setTimeout(() => {
      state.builtHtml = docs.html;
      previewApi.update(docs, 0);
    }, immediate ? 0 : 120);
  }

  /** A value being dragged previews without the document being touched. */
  function livePreview(pane, text) {
    if (!pane.doc) return;
    const docs = snapshot();
    if (pane.doc.lang === 'html') docs.html = text;
    else if (pane.doc.lang === 'css') docs.css = replaceIn(docs.css, pane.doc.text, text);
    else docs.js = replaceIn(docs.js, pane.doc.text, text);
    livePreviewText = docs;
    schedulePreview();
  }

  const replaceIn = (joined, oldText, newText) =>
    joined.includes(oldText) ? joined.replace(oldText, () => newText) : newText;

  const COMPLETABLE = new Set(['tag', 'close-tag', 'attr', 'attr-value',
    'css-prop', 'css-value', 'css-selector', 'css-at', 'js', 'js-member']);

  function maybeComplete(pane) {
    const ctx = contextFor(pane);
    if (!ctx || !COMPLETABLE.has(ctx.kind)) return pane.completion.close();

    /* A number or colour under the caret gets the popover, not a word list. */
    let onValue = null;
    try { onValue = root.WS.valueTokens.analyse(pane.editor); } catch (e) { onValue = null; }
    if (onValue && !pane.completion.open) return pane.completion.close();

    const pos = pane.editor.selection.start;
    const ch = pane.editor.value[pos - 1] || '';
    const opens = /[\w$-]/.test(ch) || ch === '<' || ch === '.' || ch === '#' ||
      ch === '@' || ch === ':' || ch === '/';
    pane.completion.retrigger(opens && (ctx.word.length > 0 || ch === '<' || ch === '.' || ch === '@'));
  }

  function openColourPicker(pane) {
    /* Give the caret a colour to sit on, then let the popover find it. */
    const sel = pane.editor.selection;
    pane.editor.replaceRange(sel.start, sel.end, '#3b82f6');
    pane.values.open();
  }

  /* ── outline ─────────────────────────────────────────────────────────── */

  let outlineTimer = 0;
  let outlineRows = [];

  function renderOutline() {
    const pane = focused();
    const list = $('#outline');
    if (!pane || !pane.doc) return;

    list.dataset.lang = pane.doc.lang;
    $('#side-title').textContent = pane.doc.lang === 'css' ? 'Rules'
      : pane.doc.lang === 'js' ? 'Declarations' : 'Outline';

    const filter = $('#side-filter').value.trim().toLowerCase();
    outlineRows = analyze.outline(pane.doc.text, pane.doc.lang)
      .filter((row) => !filter ||
        (row.label + ' ' + (row.detail || '')).toLowerCase().includes(filter));

    if (!outlineRows.length) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      empty.textContent = filter ? 'Nothing matches that.' : 'Nothing here yet.';
      list.replaceChildren(empty);
    } else {
      const frag = document.createDocumentFragment();
      outlineRows.forEach((row, i) => {
        const el = document.createElement('div');
        el.className = 'out-row';
        el.dataset.index = String(i);
        el.style.paddingLeft = (10 + Math.min(row.depth, 8) * 11) + 'px';
        el.setAttribute('role', 'treeitem');

        const label = document.createElement('span');
        label.className = 'out-label';
        label.textContent = row.label;
        el.appendChild(label);

        if (row.detail) {
          const detail = document.createElement('span');
          detail.className = 'out-detail';
          detail.textContent = row.detail;
          el.appendChild(detail);
        }
        frag.appendChild(el);
      });
      list.replaceChildren(frag);
    }

    const html = htmlDoc();
    $('#stat-elements').textContent = html ? parse.parseHtml(html.text).elements.length : 0;
    $('#stat-rules').textContent = parse.parseCss(allCss()).rules.filter((r) => r.kind === 'rule').length;
    markOutline(pane);
  }

  function markOutline(pane) {
    if (!pane || !pane.doc) return;
    const pos = pane.editor.selection.start;
    let best = -1;
    outlineRows.forEach((row, i) => { if (row.pos <= pos) best = i; });
    const list = $('#outline');
    for (const row of list.children) row.classList.remove('is-active');
    const active = list.children[best];
    if (active && active.classList) active.classList.add('is-active');
  }

  $('#outline').addEventListener('click', (e) => {
    const row = e.target.closest('.out-row');
    if (!row) return;
    const item = outlineRows[Number(row.dataset.index)];
    const pane = focused();
    if (!item || !pane) return;
    pane.editor.setSelection(item.pos, item.end != null ? item.pos : undefined);
    pane.editor.focus();
    if (pane.doc.lang !== 'html' || item.nodeId == null) return;
    if (previewApi.mode === 'design') previewApi.select(item.nodeId);
    else previewApi.flash(item.nodeId);
  });

  $('#side-filter').addEventListener('input', renderOutline);

  /* ── inline help ─────────────────────────────────────────────────────── */

  const KIND_LABEL = {
    tag: 'element', 'close-tag': 'element', attr: 'attribute', 'attr-value': 'value',
    'css-prop': 'property', 'css-value': 'value', 'css-selector': 'selector',
    'css-at': 'at-rule', js: 'script', 'js-member': 'member', text: 'text',
    comment: 'comment', none: ''
  };

  function updateStatus(pane) {
    if (!pane || !pane.doc) return;
    const pos = pane.editor.selection.start;
    const starts = root.WS.lineStarts(pane.editor.value);
    const at = root.WS.posToLineCol(starts, pos);
    $('#caret-pos').textContent = at.line + ':' + at.col;

    const errors = pane.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = pane.diagnostics.length - errors;
    const diag = $('#diag-count');
    diag.textContent = errors || warnings
      ? [errors ? errors + (errors === 1 ? ' error' : ' errors') : '',
         warnings ? warnings + (warnings === 1 ? ' warning' : ' warnings') : '']
        .filter(Boolean).join(', ')
      : '';
    diag.classList.toggle('has-error', errors > 0);

    /* A message about the thing under the caret beats a definition of it. */
    const here = pane.diagnostics.find((d) => pos >= d.start && pos <= d.end);
    if (here) {
      $('#help-kind').textContent = here.severity;
      $('#help-text').innerHTML = complete.formatDoc(here.message);
      return;
    }
    const ctx = contextFor(pane);
    const help = describe(ctx);
    $('#help-kind').textContent = help.kind;
    $('#help-text').innerHTML = help.html;
  }

  /** Is what you have typed so far the start of something real? */
  const beginsSomething = (word, table) => {
    if (!word) return false;
    const lower = word.toLowerCase();
    for (const name in table) if (name.toLowerCase().startsWith(lower)) return true;
    return false;
  };

  function describe(ctx) {
    const blank = { kind: '', html: '' };
    if (!ctx) return blank;
    const kind = KIND_LABEL[ctx.kind] || '';

    const wrap = (name, doc) =>
      ({ kind, html: '<b>' + root.WS.escapeHtml(name) + '</b> — ' + complete.formatDoc(doc) });

    /* Half a word is not a mistake. Saying so on every keystroke trains you to
       stop reading the line that also carries the real errors. */
    const partial = (word, table) => beginsSomething(word, table)
      ? { kind, html: 'Keep typing, or press Enter to take a suggestion.' }
      : null;

    switch (ctx.kind) {
      case 'tag':
      case 'close-tag': {
        const name = (ctx.tag || ctx.word || '').toLowerCase();
        if (schema.elements[name]) return wrap('<' + name + '>', schema.elements[name]);
        if (name) {
          return partial(name, schema.elements) ||
            { kind, html: '<b>&lt;' + root.WS.escapeHtml(name) + '&gt;</b> — ' +
              (name.includes('-') ? 'A custom element. Define it with `customElements.define`.'
                : 'Not an element I recognise.') };
        }
        return { kind, html: 'Type an element name.' };
      }
      case 'attr':
      case 'attr-value': {
        const attrs = schema.attrsFor(ctx.tag);
        const name = ctx.kind === 'attr' ? ctx.word : ctx.attr;
        if (attrs[name]) return wrap(name, attrs[name].doc);
        if (name && name.startsWith('data-')) return wrap(name, schema.globalAttrs['data-*']);
        if (name && name.startsWith('on')) {
          return wrap(name, 'An inline event handler. A listener in your script is easier to maintain.');
        }
        if (!name) return { kind, html: 'Type an attribute name.' };
        return partial(name, attrs) ||
          { kind, html: '<b>' + root.WS.escapeHtml(name) + '</b> — not an attribute I know.' };
      }
      case 'css-prop':
      case 'css-value': {
        const name = ctx.kind === 'css-prop' ? ctx.word : ctx.prop;
        if (schema.css[name]) return wrap(name, schema.css[name].doc);
        if (name && name.startsWith('--')) {
          return wrap(name, 'A custom property. Read it back with `var(' + name + ')`.');
        }
        if (!name) return { kind, html: 'Type a property name.' };
        return partial(name, schema.css) ||
          { kind, html: '<b>' + root.WS.escapeHtml(name) + '</b> — not a property I know.' };
      }
      case 'css-selector': {
        const pseudo = /::?[\w-]+$/.exec(ctx.prelude || '');
        if (pseudo && schema.pseudo[pseudo[0]]) return wrap(pseudo[0], schema.pseudo[pseudo[0]]);
        return { kind, html: 'Which elements this rule applies to.' };
      }
      case 'css-at': {
        const name = (/^@[\w-]*/.exec(ctx.word) || [''])[0];
        if (schema.atRules[name]) return wrap(name, schema.atRules[name]);
        return { kind, html: 'An at-rule.' };
      }
      case 'js-member':
        return { kind, html: '<b>' + root.WS.escapeHtml(ctx.object) + '.</b> — Ctrl+Space lists what you can reach.' };
      case 'js':
        return { kind, html: 'Ctrl+Space for suggestions. Anything you log shows in the console.' };
      case 'comment':
        return { kind, html: 'A comment. It never reaches the page.' };
      default:
        return blank;
    }
  }

  /* ── the preview ─────────────────────────────────────────────────────── */

  const frame = $('#pv-frame');
  const conLog = $('#con-log');
  let conRows = 0;
  let conErrors = 0;

  const previewApi = pv.Preview(frame, {
    onConsole: (entry) => addConsole(entry.level, entry.text),
    onPick: (p) => { revealNode(p.node); previewApi.select(p.node); },
    onMove: (p) => onMove(p),
    onResize: (p) => onResize(p),
    onReposition: (p) => onReposition(p),
    onRemove: (p) => onRemove(p),
    onMeasure: (p) => onMeasure(p),
    onBeforeReload: () => resetConsole(),
    onReady: () => {}
  });

  function resetConsole() {
    conRows = 0;
    conErrors = 0;
    conLog.replaceChildren();
    updateConsoleCount();
  }

  function addConsole(level, text) {
    if (conRows === 0) conLog.replaceChildren();
    const row = document.createElement('div');
    row.className = 'con-row is-' + (level === 'warn' ? 'warn'
      : level === 'error' ? 'error' : level === 'note' ? 'note' : 'info');
    const time = document.createElement('span');
    time.className = 'con-times';
    time.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });
    const body = document.createElement('span');
    body.textContent = text;
    row.append(time, body);
    conLog.appendChild(row);

    conRows++;
    if (level === 'error') conErrors++;
    while (conLog.children.length > 300) conLog.removeChild(conLog.firstChild);
    conLog.scrollTop = conLog.scrollHeight;
    updateConsoleCount();
  }

  function updateConsoleCount() {
    const count = $('#con-count');
    count.textContent = conErrors ? conErrors + (conErrors === 1 ? ' error' : ' errors')
      : conRows ? conRows + ' message' + (conRows === 1 ? '' : 's') : '';
    count.classList.toggle('has-error', conErrors > 0);
  }

  /** A click in the preview: find the markup that made that element. */
  function revealNode(nodeId) {
    const doc = htmlDoc();
    if (!doc) return;
    const tree = parse.parseHtml(state.builtHtml || doc.text);
    const node = tree.elements[nodeId];
    if (!node) return;

    let pane = state.panes.find((p) => p.doc === doc && !p.el.hidden);
    if (!pane) { pane = focused(); showDoc(pane, doc); }
    pane.editor.setSelection(node.start, node.openEnd);
    pane.editor.focus();
    state.focused = pane;
  }

  /* -- direct manipulation ---------------------------------------------- */

  /** The element the preview is talking about, in the source it came from. */
  function nodeFor(nodeId) {
    const doc = htmlDoc();
    if (!doc) return null;
    const tree = parse.parseHtml(doc.text);
    const node = tree.elements[nodeId];
    return node ? { doc, tree, node } : null;
  }

  /**
   * Every place a stylesheet lives: the .css documents, and any <style> block
   * inside the page. Each can be read and written without the caller having to
   * care which it is.
   */
  function cssTargets() {
    const out = docsOfLang('css').map((doc) => ({
      name: doc.name,
      text: doc.text,
      write: (next) => patchDoc(doc, next)
    }));

    const html = htmlDoc();
    if (!html) return out;
    const source = html.text;
    for (const node of parse.parseHtml(source).elements) {
      if (node.tag !== 'style' || node.textStart == null) continue;
      const from = node.textStart, to = node.textEnd;
      out.push({
        name: html.name + ' <style>',
        text: source.slice(from, to),
        write: (next) => patchDoc(html, source.slice(0, from) + next + source.slice(to))
      });
    }
    return out;
  }

  const styleTarget = () => $('#style-target').value;

  /**
   * Write declarations for an element, into the rule that already styles it
   * where there is one. Falls back to a new rule, then to an inline style - in
   * that order, because a shared rule is what you would have written by hand
   * and `style=""` is what you would have written last.
   */
  function applyStyle(nodeId, props, label) {
    const found = nodeFor(nodeId);
    if (!found) return;
    const { doc, node } = found;
    const said = (where) => toast(label + '  ->  ' + where, 'good');

    if (styleTarget() === 'inline') {
      patchDoc(doc, edits.setInlineStyle(doc.text, node, props));
      return said('style=""');
    }

    for (const sheet of cssTargets()) {
      const rule = edits.ruleFor(parse.parseCss(sheet.text).rules, node);
      if (!rule) continue;
      sheet.write(edits.setRuleProperties(sheet.text, rule, props));
      return said(rule.selector + '  in ' + sheet.name);
    }

    const selector = edits.newSelectorFor(node);
    const sheet = cssTargets()[0];
    if (selector && sheet) {
      sheet.write(edits.createRule(sheet.text, selector, props).text);
      return said('new rule ' + selector + '  in ' + sheet.name);
    }
    patchDoc(doc, edits.setInlineStyle(doc.text, node, props));
    said('style="" - give it a class to keep your styles together');
  }

  function onResize(p) {
    /* A handle that moved one edge should write one dimension, not both. */
    const props = {};
    if (p.dir !== 'n' && p.dir !== 's') props.width = p.width + 'px';
    if (p.dir !== 'e' && p.dir !== 'w') props.height = p.height + 'px';
    applyStyle(p.node, props, [props.width, props.height].filter(Boolean).join(' x '));
  }

  function onReposition(p) {
    applyStyle(p.node, { left: p.left + 'px', top: p.top + 'px' },
      'left ' + p.left + 'px, top ' + p.top + 'px');
  }

  function onMove(p) {
    const found = nodeFor(p.node);
    if (!found) return;
    const target = found.tree.elements[p.target];
    if (!target) return;
    const next = edits.moveNode(found.doc.text, found.node, target, p.position);
    if (!next) return toast('That element cannot go there.', 'bad');
    patchDoc(found.doc, next);
    previewApi.select(p.node);
    toast('Moved ' + p.position + ' <' + target.tag + '>', 'good');
  }

  function onRemove(p) {
    const found = nodeFor(p.node);
    if (!found) return;
    const cut = edits.cutRange(found.doc.text, found.node);
    patchDoc(found.doc, found.doc.text.slice(0, cut.from) + found.doc.text.slice(cut.to));
    toast('Removed <' + found.node.tag + '>. Ctrl+Z puts it back.', 'good');
  }

  /** Live numbers while a gesture is under way, where the size normally sits. */
  function onMeasure(p) {
    const el = $('#pv-size');
    if (!p) return showViewportSize();
    if (p.drop !== undefined) el.textContent = p.drop || 'nowhere';
    else if (p.width != null) el.textContent = p.width + ' x ' + p.height;
    else if (p.left != null) el.textContent = p.left + ', ' + p.top;
  }

  function setDesign(on) {
    previewApi.setMode(on ? 'design' : 'off');
    $('#btn-design').setAttribute('aria-pressed', String(on));
    $('#style-target').hidden = !on;
    if (on && !htmlDoc()) toast('There is no HTML document to edit.', 'bad');
  }

  $('#btn-design').addEventListener('click', () => setDesign(previewApi.mode !== 'design'));

  /* -- viewport controls ------------------------------------------------- */

  const viewportSelect = $('#viewport');
  for (const view of pv.VIEWPORTS) {
    const option = document.createElement('option');
    option.value = view.id;
    option.textContent = view.width ? `${view.label} — ${view.width}×${view.height}` : view.label;
    viewportSelect.appendChild(option);
  }

  function showViewportSize() {
    const box = previewApi.layout();
    const view = previewApi.viewport;
    $('#pv-size').textContent = view.width
      ? `${box.width}×${box.height}  ${Math.round(box.scale * 100)}%`
      : '';
    $('#btn-rotate').disabled = !view.width;
  }

  viewportSelect.addEventListener('change', () => {
    previewApi.setViewport(viewportSelect.value);
    showViewportSize();
  });
  $('#zoom').addEventListener('change', () => { previewApi.setZoom($('#zoom').value); showViewportSize(); });
  $('#btn-rotate').addEventListener('click', (e) => {
    e.currentTarget.setAttribute('aria-pressed', String(previewApi.rotate()));
    showViewportSize();
  });
  $('#btn-reload').addEventListener('click', () => schedulePreview(true));
  $('#btn-clear-con').addEventListener('click', resetConsole);
  window.addEventListener('resize', showViewportSize);

  /* ── files ───────────────────────────────────────────────────────────── */

  let toastTimer = 0;

  function toast(message, tone) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast' + (tone ? ' is-' + tone : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, tone === 'bad' ? 5200 : 2400);
  }

  function updateSaveState() {
    const dirty = anyDirty();
    $('#dirty-dot').hidden = !dirty;
    const named = state.docs.filter((d) => d.path || d.handle).length;
    $('#save-note').textContent = dirty
      ? 'Unsaved changes'
      : named ? named + (named === 1 ? ' file on disk' : ' files on disk') : 'Not saved yet';
  }

  async function saveAll() {
    const dirty = state.docs.filter((d) => d.dirty);
    if (!dirty.length) { toast('Nothing to save.'); return; }
    let saved = 0;
    for (const doc of dirty) {
      try {
        await files.save(doc);
        doc.dirty = false;
        saved++;
      } catch (e) {
        if (e && e.name === 'AbortError') break;
        toast('Could not save ' + doc.name + ': ' + (e.message || e), 'bad');
      }
    }
    renderTabs();
    if (saved) toast(saved === 1 ? 'Saved ' + dirty[0].name : 'Saved ' + saved + ' files', 'good');
  }

  async function saveCurrentAs() {
    const pane = focused();
    if (!pane || !pane.doc) return;
    try {
      await files.saveAs(pane.doc);
      pane.doc.dirty = false;
      renderTabs();
      toast('Saved as ' + pane.doc.name, 'good');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast(String(e.message || e), 'bad');
    }
  }

  /**
   * The starter is scaffolding, not work. Opening a real page should replace
   * it outright, or its stylesheet would go on decorating the page you just
   * loaded. Anything you have touched or saved stays.
   */
  function dropStarterIfUntouched(incoming) {
    if (!incoming.some((file) => (file.lang || files.langOf(file.name)) === 'html')) return;
    const starterNames = new Set(root.WS.starter.docs().map((d) => d.name));
    state.docs = state.docs.filter((doc) =>
      doc.dirty || doc.path || doc.handle || !starterNames.has(doc.name));
    if (!state.docs.length) state.docs = root.WS.starter.docs().map(makeDoc).slice(0, 1);
  }

  /** Put a loaded file into the project, replacing one of the same name. */
  function adoptFile(file) {
    const existing = state.docs.find((d) => d.name === file.name);
    const doc = existing || makeDoc(file);
    if (existing) {
      existing.text = file.text;
      existing.handle = file.handle || existing.handle;
      existing.path = file.path || existing.path;
      existing.dirty = false;
    } else {
      doc.handle = file.handle || null;
      doc.path = file.path || null;
      state.docs.push(doc);
    }
    return doc;
  }

  async function openFiles() {
    try {
      const picked = await files.pickFiles();
      if (!picked.length) return;
      dropStarterIfUntouched(picked);
      let first = null;
      for (const file of picked) {
        const doc = adoptFile(file);
        if (!first) first = doc;
      }
      ensurePaneDocs();
      showDoc(focused(), first);
      renderTabs();
      schedulePreview(true);
      toast('Opened ' + picked.map((f) => f.name).join(', '), 'good');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast(String(e.message || e), 'bad');
    }
  }

  async function openFolder() {
    try {
      const { files: found } = await files.pickFolder();
      state.docs = found.map(makeDoc);
      state.panes.forEach((pane, i) => showDoc(pane, state.docs[Math.min(i, state.docs.length - 1)]));
      renderTabs();
      schedulePreview(true);
      toast('Opened ' + found.length + ' files', 'good');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast(String(e.message || e), 'bad');
    }
  }

  function exportPage() {
    const html = pv.build(snapshot(), { ids: false });
    const name = (htmlDoc() || { name: 'page.html' }).name;
    files.download(name.replace(/\.html?$/i, '') + '.export.html', html, 'text/html;charset=utf-8');
    toast('Exported one self-contained file', 'good');
  }

  function newProject() {
    if (anyDirty() && !confirm('Start again? Unsaved changes will be lost.')) return;
    files.clearDraft();
    state.docs = root.WS.starter.docs().map(makeDoc);
    state.panes.forEach((pane, i) => showDoc(pane, state.docs[Math.min(i + (i ? 1 : 0), state.docs.length - 1)]));
    renderTabs();
    schedulePreview(true);
  }

  $('#btn-open').addEventListener('click', openFiles);
  $('#btn-folder').addEventListener('click', openFolder);
  $('#btn-save').addEventListener('click', saveAll);
  $('#btn-saveas').addEventListener('click', saveCurrentAs);
  $('#btn-export').addEventListener('click', exportPage);
  $('#btn-new').addEventListener('click', newProject);
  $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());

  /* ── layout ──────────────────────────────────────────────────────────── */

  function setSplit(on) {
    state.split = on;
    const paneB = state.panes[1];
    paneB.el.hidden = !on;
    $('#pane-split').hidden = !on;
    $('#btn-split').setAttribute('aria-pressed', String(on));
    if (on) {
      const keep = state.docs.includes(paneB.doc) && paneB.doc !== state.panes[0].doc;
      showDoc(paneB, keep ? paneB.doc : state.docs.find((d) => d !== state.panes[0].doc));
      paneB.editor.refresh();
    }
  }

  $('#btn-split').addEventListener('click', () => setSplit(!state.split));

  $('#btn-sidebar').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    $('#side').hidden = !on;
  });

  /** Pointer-driven resizing for the two adjustable edges. */
  function draggable(handle, apply) {
    let active = false;
    handle.addEventListener('pointerdown', (e) => {
      active = true;
      handle.setPointerCapture(e.pointerId);
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (active) apply(e); });
    const stop = (e) => {
      if (!active) return;
      active = false;
      document.body.style.userSelect = '';
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      showViewportSize();
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  draggable($('#drag-main'), (e) => {
    const shell = $('#split-main').getBoundingClientRect();
    const ratio = (e.clientX - shell.left) / shell.width;
    const clamped = Math.max(0.2, Math.min(0.85, ratio));
    $('#editors').style.flex = `1 1 ${clamped * 100}%`;
    $('.preview').style.flex = `1 1 ${(1 - clamped) * 100}%`;
  });

  draggable($('#drag-console'), (e) => {
    const box = $('.preview').getBoundingClientRect();
    const height = Math.max(26, Math.min(box.height - 120, box.bottom - e.clientY));
    $('#console-panel').style.height = height + 'px';
  });

  /* Keyboard, for the same two edges. */
  $('#drag-console').addEventListener('keydown', (e) => {
    const panel = $('#console-panel');
    const current = panel.getBoundingClientRect().height;
    if (e.key === 'ArrowUp') { panel.style.height = (current + 24) + 'px'; e.preventDefault(); }
    if (e.key === 'ArrowDown') { panel.style.height = Math.max(26, current - 24) + 'px'; e.preventDefault(); }
  });

  /* ── global keys ─────────────────────────────────────────────────────── */

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    if (e.key === 's') {
      e.preventDefault();
      if (e.shiftKey) saveCurrentAs(); else saveAll();
      return;
    }
    if (e.key === 'o') { e.preventDefault(); openFiles(); return; }
    if (e.key === 'b') {
      e.preventDefault();
      $('#btn-sidebar').click();
      return;
    }
    if (e.key === '\\') { e.preventDefault(); setSplit(!state.split); return; }
    if (e.key === 'd') { e.preventDefault(); setDesign(previewApi.mode !== 'design'); return; }
    if (e.key === 'Enter') { e.preventDefault(); schedulePreview(true); return; }
    if (e.key >= '1' && e.key <= '9') {
      const doc = state.docs[Number(e.key) - 1];
      if (!doc) return;
      e.preventDefault();
      const pane = focused();
      showDoc(pane, doc);
      pane.editor.focus();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    files.saveDraft({ docs: state.docs, active: 0 });
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* ── starting up ─────────────────────────────────────────────────────── */

  function seed(docs) {
    state.docs = docs;
    showDoc(state.panes[0], state.docs[0]);
    if (state.panes[1]) state.panes[1].doc = state.docs[1] || state.docs[0];
    renderTabs();
    renderOutline();
    schedulePreview(true);
    updateSaveState();
  }

  async function collectFromServer(announce) {
    if (!files.served) return false;
    let paths = [];
    try { paths = await files.collectOpened(); } catch (e) { return false; }
    if (!paths.length) return false;

    let opened = 0;
    let firstDoc = null;
    for (const path of paths) {
      let project;
      try {
        project = await files.loadProject(path);
      } catch (e) {
        toast('Could not open ' + path, 'bad');
        continue;
      }
      const arrived = ['html', 'css', 'js']
        .map((lang) => (project[lang] ? Object.assign({ lang }, project[lang]) : null))
        .filter(Boolean);
      dropStarterIfUntouched(arrived);
      for (const file of arrived) {
        const doc = adoptFile(file);
        if (!firstDoc || file.lang === 'html') firstDoc = file.lang === 'html' ? doc : firstDoc || doc;
      }
      opened++;
    }
    ensurePaneDocs();
    if (!opened) return false;
    if (firstDoc) showDoc(state.panes[0], firstDoc);
    renderTabs();
    renderOutline();
    schedulePreview(true);
    if (announce) toast('Opened ' + opened + (opened === 1 ? ' file' : ' files'), 'good');
    return true;
  }

  async function start() {
    state.panes = [...document.querySelectorAll('.pane')].map(makePane);
    state.focused = state.panes[0];
    viewportSelect.value = 'fill';

    /* A file the launcher handed us wins; then a draft; then the starter. */
    const starter = root.WS.starter.docs().map(makeDoc);
    seed(starter);

    const fromServer = await collectFromServer(false);
    if (!fromServer) {
      const draft = files.readDraft();
      if (draft && draft.docs && draft.docs.length) {
        state.docs = draft.docs.map(makeDoc);
        showDoc(state.panes[0], state.docs[draft.active] || state.docs[0]);
        renderTabs();
        renderOutline();
        schedulePreview(true);
        toast('Picked up where you left off');
      }
    }

    showViewportSize();
    state.panes[0].editor.focus();

    /* Opening a second file usually just focuses this window, so the queue has
       to be checked again whenever the window comes back to the front. */
    if (files.served) {
      window.addEventListener('focus', () => collectFromServer(true));
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) collectFromServer(true);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* A handle for poking at the state from the console while developing. */
  root.__ws = { state, snapshot, previewApi, providers };
})(window);
