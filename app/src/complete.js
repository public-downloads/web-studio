/* ============================================================================
   complete.js — the suggestion list.

   Two halves: `suggest(ctx)` decides what to offer for a caret position, and
   `Completion` puts it on screen. They are kept apart so the first can be
   reasoned about — and tested — without a DOM.

   Ordering matters more than breadth. A list of forty properties sorted
   alphabetically is a list you scroll past; the match quality, then how
   commonly the thing is actually used, decide the order.
   ========================================================================== */
(function (root) {
  'use strict';

  const S = root.WS.schema;

  /* ── matching ────────────────────────────────────────────────────────── */

  /**
   * Subsequence match with bonuses for prefixes and word boundaries, so
   * `jc` finds `justify-content` and `disp` beats `display-mode`.
   * @returns {{score: number, hits: number[]}|null}
   */
  function fuzzy(query, candidate) {
    if (!query) return { score: 0, hits: [] };
    const q = query.toLowerCase();
    const c = candidate.toLowerCase();

    if (c === q) return { score: 1000, hits: range(0, q.length) };
    if (c.startsWith(q)) return { score: 700 - candidate.length, hits: range(0, q.length) };

    const hits = [];
    let ci = 0;
    let score = 0;
    let streak = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const found = c.indexOf(q[qi], ci);
      if (found < 0) return null;
      const boundary = found === 0 || /[-_. :]/.test(c[found - 1]);
      streak = found === ci ? streak + 1 : 0;
      score += 10 + streak * 8 + (boundary ? 25 : 0) - Math.min(found - ci, 8);
      hits.push(found);
      ci = found + 1;
    }
    return { score: score - candidate.length * 0.5, hits };
  }

  const range = (from, to) => { const out = []; for (let i = from; i < to; i++) out.push(i); return out; };

  /* Things people reach for constantly, floated up the list. */
  const HOT_ELEMENTS = ['div', 'span', 'p', 'a', 'img', 'button', 'input', 'ul', 'li', 'section',
    'header', 'footer', 'nav', 'main', 'h1', 'h2', 'h3', 'form', 'label', 'script', 'link'];
  const HOT_CSS = ['display', 'color', 'background', 'background-color', 'margin', 'padding',
    'width', 'height', 'font-size', 'font-weight', 'flex', 'flex-direction', 'gap', 'align-items',
    'justify-content', 'border', 'border-radius', 'position', 'text-align', 'grid-template-columns'];

  const hotness = (list, name) => {
    const at = list.indexOf(name);
    return at < 0 ? 0 : (list.length - at) * 2;
  };

  /* ── what to offer ───────────────────────────────────────────────────── */

  const JS_MEMBERS = {
    document: {
      querySelector: 'The first element matching a CSS selector, or null.',
      querySelectorAll: 'Every element matching a selector, as a static NodeList.',
      getElementById: 'The element with this id.',
      createElement: 'A new element, not yet in the document.',
      addEventListener: 'Listen for an event on the document.',
      body: 'The <body> element.',
      head: 'The <head> element.',
      documentElement: 'The <html> element.'
    },
    console: {
      log: 'Print to the console.',
      warn: 'Print as a warning.',
      error: 'Print as an error.',
      table: 'Print an array or object as a table.',
      time: 'Start a timer.',
      timeEnd: 'Stop a timer and print how long it took.'
    },
    Math: {
      round: 'Nearest integer.', floor: 'Round down.', ceil: 'Round up.',
      min: 'Smallest argument.', max: 'Largest argument.', abs: 'Absolute value.',
      random: 'A number in [0, 1).', pow: 'Raise to a power.', sqrt: 'Square root.',
      hypot: 'Length of a vector.', PI: '3.14159…'
    },
    JSON: { parse: 'Text to value.', stringify: 'Value to text.' },
    Object: {
      keys: 'The own enumerable keys.', values: 'The own enumerable values.',
      entries: 'Key/value pairs.', assign: 'Copy properties onto a target.',
      freeze: 'Make an object immutable.', fromEntries: 'Pairs back into an object.'
    },
    localStorage: {
      getItem: 'Read a stored string.', setItem: 'Store a string.',
      removeItem: 'Delete one key.', clear: 'Delete everything.'
    },
    window: {
      addEventListener: 'Listen for an event on the window.',
      requestAnimationFrame: 'Run a function before the next repaint.',
      setTimeout: 'Run a function after a delay.',
      matchMedia: 'Query a media condition from script.',
      innerWidth: 'Viewport width in pixels.', innerHeight: 'Viewport height in pixels.',
      scrollTo: 'Scroll the page.'
    }
  };

  const ELEMENT_MEMBERS = {
    textContent: 'The text inside, with no markup.',
    innerHTML: 'The markup inside. Never assign untrusted text to it.',
    classList: 'add / remove / toggle / contains for classes.',
    style: 'Inline styles, as an object.',
    dataset: 'The `data-*` attributes.',
    addEventListener: 'Listen for an event on this element.',
    setAttribute: 'Set an attribute.', getAttribute: 'Read an attribute.',
    remove: 'Take the element out of the document.',
    append: 'Add children at the end.', closest: 'Nearest ancestor matching a selector.',
    getBoundingClientRect: 'Position and size on screen.',
    value: 'The current value of a form control.',
    checked: 'Whether a checkbox or radio is ticked.'
  };

  const JS_SNIPPETS = [
    { label: 'querySelector', insert: "document.querySelector('')", caret: -2,
      doc: 'Find one element by CSS selector.' },
    { label: 'addEventListener', insert: "addEventListener('click', () => {\n  \n})", caret: 31,
      doc: 'Listen for an event.' },
    { label: 'for…of', insert: 'for (const item of items) {\n  \n}', caret: 30,
      doc: 'Iterate the values of an array or any iterable.' },
    { label: 'function', insert: 'function name() {\n  \n}', caret: 9, doc: 'Declare a function.' },
    { label: 'arrow function', insert: '() => {\n  \n}', caret: 10, doc: 'A function expression.' },
    { label: 'fetch', insert: "const res = await fetch('');\nconst data = await res.json();", caret: 25,
      doc: 'Request a URL and read the JSON body.' }
  ];

  /**
   * @param {object} ctx from analyze.contextAt
   * @param {{classes?: () => string[], ids?: () => string[], vars?: () => string[],
   *          identifiers?: () => string[]}} [providers] names gathered from the
   *   other documents, so CSS can complete classes that the HTML uses and vice
   *   versa.
   * @returns {object[]} items, best first
   */
  function suggest(ctx, providers) {
    providers = providers || {};
    const items = [];
    const add = (item) => items.push(item);

    switch (ctx.kind) {
      case 'tag':
      case 'close-tag': {
        for (const name in S.elements) {
          add({
            label: name,
            kind: 'element',
            detail: S.isVoid(name) ? 'void' : '',
            doc: S.elements[name],
            boost: hotness(HOT_ELEMENTS, name),
            insert: ctx.kind === 'close-tag' ? name + '>' : name,
            replace: ctx.word.length
          });
        }
        break;
      }

      case 'attr': {
        const attrs = S.attrsFor(ctx.tag);
        for (const name in attrs) {
          add({
            label: name,
            kind: 'attribute',
            detail: attrs[name].own ? '' : 'global',
            doc: attrs[name].doc,
            boost: attrs[name].own ? 40 : 0,
            insert: name === 'data-*' ? 'data-' : name + '="',
            caret: name === 'data-*' ? null : undefined,
            closeQuote: name !== 'data-*',
            replace: ctx.word.length
          });
        }
        break;
      }

      case 'attr-value': {
        const fixed = S.valuesFor(ctx.tag, ctx.attr);
        if (fixed) {
          /* The schema lists these in the order you are most likely to want
             them, which alphabetical sorting would throw away. */
          fixed.forEach((value, i) => {
            add({ label: value, kind: 'value', doc: '', boost: fixed.length - i,
              insert: value, replace: ctx.word.length });
          });
        }
        if (ctx.attr === 'class') {
          const typed = ctx.word.split(/\s+/).pop();
          for (const name of (providers.classes ? providers.classes() : [])) {
            add({ label: name, kind: 'class', detail: 'in your CSS',
              doc: 'A class your stylesheet already styles.',
              insert: name, replace: typed.length });
          }
        }
        if (ctx.attr === 'href' || ctx.attr === 'for' || ctx.attr === 'aria-labelledby') {
          for (const id of (providers.ids ? providers.ids() : [])) {
            const value = ctx.attr === 'href' ? '#' + id : id;
            add({ label: value, kind: 'id', detail: 'in your HTML',
              doc: 'An id used in the document.', insert: value, replace: ctx.word.length });
          }
        }
        break;
      }

      case 'css-prop': {
        for (const name in S.css) {
          add({
            label: name,
            kind: 'property',
            doc: S.css[name].doc,
            boost: hotness(HOT_CSS, name),
            insert: name + ': ',
            replace: ctx.word.length
          });
        }
        for (const name of (providers.vars ? providers.vars() : [])) {
          add({ label: name, kind: 'variable', detail: 'custom property',
            doc: 'A custom property defined in this stylesheet.',
            insert: name + ': ', replace: ctx.word.length });
        }
        break;
      }

      case 'css-value': {
        /* Inside `var(`, the only thing that belongs is a custom property. */
        if (ctx.inVar) {
          for (const name of (providers.vars ? providers.vars() : [])) {
            add({ label: name, kind: 'variable', detail: 'custom property',
              doc: 'Use the value of ' + name + '.', insert: name, replace: ctx.word.length });
          }
          break;
        }

        const prop = S.css[ctx.prop];
        if (prop && prop.values) {
          /* Where a property has a fixed set of values, those come first: on
             `display:` you want `flex`, not the list of your colour variables. */
          prop.values.forEach((value, i) => {
            add({ label: value, kind: 'value', doc: '', boost: 40 + (prop.values.length - i),
              insert: value, replace: ctx.word.length });
          });
        }
        if (isColourProp(ctx.prop)) {
          for (const name in NAMED_COLOURS) {
            add({ label: name, kind: 'colour', colour: NAMED_COLOURS[name],
              doc: '', insert: name, replace: ctx.word.length });
          }
          add({ label: 'Pick a colour…', kind: 'action', action: 'colour',
            doc: 'Open the colour picker and write the value here.', replace: ctx.word.length });
        }
        for (const name of (providers.vars ? providers.vars() : [])) {
          add({ label: 'var(' + name + ')', kind: 'variable', detail: 'custom property',
            doc: 'Use the value of ' + name + '.', boost: 30,
            insert: 'var(' + name + ')', replace: ctx.word.length });
        }
        for (const fn of CSS_FUNCTIONS) {
          add({ label: fn.label, kind: 'function', doc: fn.doc,
            insert: fn.insert, caret: fn.caret, replace: ctx.word.length });
        }
        break;
      }

      case 'css-selector': {
        for (const name of (providers.classes ? providers.classes() : [])) {
          add({ label: '.' + name, kind: 'class', detail: 'in your HTML',
            doc: 'A class the markup already uses.', boost: 60,
            insert: '.' + name, replace: ctx.word.length });
        }
        for (const id of (providers.ids ? providers.ids() : [])) {
          add({ label: '#' + id, kind: 'id', detail: 'in your HTML',
            doc: 'An id the markup already uses.', boost: 40,
            insert: '#' + id, replace: ctx.word.length });
        }
        for (const name in S.elements) {
          add({ label: name, kind: 'element', doc: S.elements[name],
            boost: hotness(HOT_ELEMENTS, name), insert: name, replace: ctx.word.length });
        }
        for (const name in S.pseudo) {
          add({ label: name, kind: 'pseudo', doc: S.pseudo[name],
            insert: name.endsWith('()') ? name.slice(0, -1) : name,
            caret: name.endsWith('()') ? name.length - 1 : undefined,
            replace: ctx.word.length });
        }
        break;
      }

      case 'css-at': {
        for (const name in S.atRules) {
          add({ label: name, kind: 'at-rule', doc: S.atRules[name],
            insert: name + ' ', replace: ctx.word.length });
        }
        break;
      }

      case 'js-member': {
        /* A known global has a known shape; anything else is assumed to be an
           element, which is what a variable in a page script usually holds. */
        const known = JS_MEMBERS[ctx.object];
        const members = known || ELEMENT_MEMBERS;
        for (const name in members) {
          add({ label: name, kind: 'member', doc: members[name],
            insert: name, replace: ctx.word.length });
        }
        if (!known) {
          for (const name in JS_MEMBERS.document) {
            if (name in members) continue;
            add({ label: name, kind: 'member', doc: JS_MEMBERS.document[name],
              insert: name, replace: ctx.word.length });
          }
        }
        break;
      }

      case 'js': {
        for (const snippet of JS_SNIPPETS) {
          add({ label: snippet.label, kind: 'snippet', detail: 'snippet', doc: snippet.doc,
            boost: 30, insert: snippet.insert, caret: snippet.caret, replace: ctx.word.length });
        }
        for (const name of JS_WORDS) {
          add({ label: name, kind: 'keyword', doc: '', insert: name, replace: ctx.word.length });
        }
        for (const name of (providers.identifiers ? providers.identifiers() : [])) {
          add({ label: name, kind: 'local', detail: 'in this file', doc: '',
            boost: 25, insert: name, replace: ctx.word.length });
        }
        for (const id of (providers.ids ? providers.ids() : [])) {
          add({ label: "document.getElementById('" + id + "')", kind: 'id', detail: 'in your HTML',
            doc: 'Look up the element with this id.', boost: 10,
            insert: "document.getElementById('" + id + "')", replace: ctx.word.length });
        }
        break;
      }

      default:
        return [];
    }

    return rank(items, ctx.word);
  }

  function rank(items, word) {
    const scored = [];
    const seen = new Set();
    for (const item of items) {
      const key = item.kind + ' ' + item.label;
      if (seen.has(key)) continue;
      seen.add(key);
      const match = fuzzy(word || '', item.label);
      if (!match) continue;
      item.hits = match.hits;
      item.score = match.score + (item.boost || 0);
      scored.push(item);
    }
    scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length ||
      a.label.localeCompare(b.label));
    return scored.slice(0, 60);
  }

  const COLOUR_PROPS = /(^|-)(color|background|border|outline|shadow|fill|stroke)($|-)/;
  const isColourProp = (prop) => !!prop && (COLOUR_PROPS.test(prop) || prop === 'background' ||
    prop === 'box-shadow' || prop === 'text-shadow');

  const NAMED_COLOURS = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
    yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
    silver: '#c0c0c0', teal: '#008080', navy: '#000080', maroon: '#800000', olive: '#808000',
    lime: '#00ff00', aqua: '#00ffff', fuchsia: '#ff00ff', pink: '#ffc0cb', brown: '#a52a2a',
    gold: '#ffd700', coral: '#ff7f50', crimson: '#dc143c', indigo: '#4b0082',
    salmon: '#fa8072', tomato: '#ff6347', violet: '#ee82ee', khaki: '#f0e68c',
    transparent: 'transparent', currentColor: 'currentColor'
  };

  const CSS_FUNCTIONS = [
    { label: 'var()', doc: 'The value of a custom property, with an optional fallback.',
      insert: 'var()', caret: 4 },
    { label: 'calc()', doc: 'Arithmetic across units, e.g. `calc(100% - 2rem)`.',
      insert: 'calc()', caret: 5 },
    { label: 'clamp()', doc: 'A value with a floor and a ceiling: `clamp(min, ideal, max)`.',
      insert: 'clamp()', caret: 6 },
    { label: 'min()', doc: 'The smallest of its arguments.', insert: 'min()', caret: 4 },
    { label: 'max()', doc: 'The largest of its arguments.', insert: 'max()', caret: 4 },
    { label: 'rgb()', doc: 'A colour from red, green and blue channels.', insert: 'rgb()', caret: 4 },
    { label: 'hsl()', doc: 'A colour from hue, saturation and lightness.', insert: 'hsl()', caret: 4 },
    { label: 'linear-gradient()', doc: 'A gradient along a line.',
      insert: 'linear-gradient()', caret: 16 },
    { label: 'url()', doc: 'A file path or data URI.', insert: 'url()', caret: 4 },
    { label: 'translate()', doc: 'Move an element without affecting layout.',
      insert: 'translate()', caret: 10 },
    { label: 'repeat()', doc: 'Repeat grid tracks, e.g. `repeat(3, 1fr)`.', insert: 'repeat()', caret: 7 },
    { label: 'minmax()', doc: 'A grid track with a floor and a ceiling.', insert: 'minmax()', caret: 7 }
  ];

  const JS_WORDS = ['const', 'let', 'function', 'return', 'if', 'else', 'for', 'while', 'class',
    'new', 'await', 'async', 'try', 'catch', 'finally', 'throw', 'import', 'export', 'default',
    'typeof', 'instanceof', 'true', 'false', 'null', 'undefined', 'this', 'switch', 'case',
    'break', 'continue', 'document', 'window', 'console', 'Math', 'JSON', 'Object', 'Array',
    'Promise', 'Number', 'String', 'Boolean', 'Set', 'Map', 'localStorage', 'fetch',
    'setTimeout', 'requestAnimationFrame'];

  /* ── the popup ───────────────────────────────────────────────────────── */

  const ICONS = {
    element: '<>', attribute: '=', value: '"', property: ':', variable: '--', class: '.',
    id: '#', pseudo: ':', 'at-rule': '@', member: '.', keyword: 'K', local: 'v',
    snippet: '{}', function: 'f', colour: '■', action: '▸'
  };

  /**
   * @param {object} editor from WS.Editor
   * @param {{getContext: function, providers: object, onAction: function}} opts
   */
  function Completion(editor, opts) {
    const box = document.createElement('div');
    box.className = 'cmp';
    box.hidden = true;
    const list = document.createElement('div');
    list.className = 'cmp-list';
    const docPane = document.createElement('div');
    docPane.className = 'cmp-doc';
    box.append(list, docPane);
    editor.el.appendChild(box);

    let items = [];
    let index = 0;
    let open = false;
    let ctx = null;

    function show() {
      ctx = opts.getContext();
      if (!ctx) return close();
      items = suggest(ctx, opts.providers || {});
      if (!items.length) return close();

      render();
      place();
      box.hidden = false;
      open = true;
    }

    function render() {
      const frag = document.createDocumentFragment();
      items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'cmp-row' + (i === index ? ' is-active' : '');
        row.dataset.index = String(i);

        const icon = document.createElement('span');
        icon.className = 'cmp-icon cmp-icon-' + item.kind;
        if (item.kind === 'colour' && item.colour) {
          icon.style.color = item.colour === 'transparent' ? 'var(--edge)' : item.colour;
        }
        icon.textContent = ICONS[item.kind] || '*';

        const label = document.createElement('span');
        label.className = 'cmp-label';
        label.innerHTML = mark(item.label, item.hits);

        row.append(icon, label);
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'cmp-detail';
          detail.textContent = item.detail;
          row.appendChild(detail);
        }
        frag.appendChild(row);
      });
      list.replaceChildren(frag);
      showDoc();
      scrollIntoView();
    }

    function mark(label, hits) {
      const set = new Set(hits || []);
      let out = '';
      for (let i = 0; i < label.length; i++) {
        const ch = root.WS.escapeHtml(label[i]);
        out += set.has(i) ? '<b>' + ch + '</b>' : ch;
      }
      return out;
    }

    function showDoc() {
      const item = items[index];
      if (!item || !item.doc) { docPane.hidden = true; return; }
      docPane.hidden = false;
      docPane.innerHTML = formatDoc(item.doc);
    }

    function scrollIntoView() {
      const row = list.children[index];
      if (!row) return;
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }

    function place() {
      const caret = editor.caretCoords();
      const hostHeight = editor.el.clientHeight;
      box.style.left = Math.max(4, Math.min(caret.x, editor.el.clientWidth - 340)) + 'px';
      const below = caret.y + caret.lineHeight + 4;
      /* Flip above the caret when there is not room underneath. */
      if (below + 260 > hostHeight && caret.y > 260) {
        box.style.top = '';
        box.style.bottom = (hostHeight - caret.y + 4) + 'px';
      } else {
        box.style.bottom = '';
        box.style.top = below + 'px';
      }
    }

    function close() {
      if (!open && box.hidden) return;
      box.hidden = true;
      open = false;
      items = [];
      index = 0;
    }

    function move(delta) {
      if (!open) return;
      index = (index + delta + items.length) % items.length;
      render();
    }

    function accept() {
      const item = items[index];
      if (!item) return false;
      close();

      if (item.action) {
        if (opts.onAction) opts.onAction(item.action, ctx);
        return true;
      }

      const sel = editor.selection;
      const start = sel.start - (item.replace || 0);
      let text = item.insert == null ? item.label : item.insert;
      let caret = item.caret;

      /* Do not type a quote the pairing already put there. */
      if (item.closeQuote && editor.value[sel.end] === '"') {
        text = text.replace(/"$/, '');
        caret = text.length + 1;
      }
      editor.replaceRange(start, sel.end, text, caret == null ? undefined
        : (caret < 0 ? text.length + caret : caret));
      return true;
    }

    list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.cmp-row');
      if (!row) return;
      e.preventDefault();
      index = Number(row.dataset.index);
      accept();
    });

    editor.on('key', (e) => {
      if (e.key === 'Escape' && open) { e.preventDefault(); close(); return; }

      if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); show(); return; }

      if (!open) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
      if (e.key === 'PageDown') { e.preventDefault(); move(8); return; }
      if (e.key === 'PageUp') { e.preventDefault(); move(-8); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept();
        return;
      }
    });

    return {
      show,
      close,
      get open() { return open; },
      /** Called after every edit: refresh if useful, otherwise fold away. */
      retrigger(trigger) {
        const next = opts.getContext();
        if (!next) return close();
        if (open) return show();
        if (trigger) show();
      }
    };
  }

  /** `like this` in a doc string becomes a code span. */
  function formatDoc(text) {
    return root.WS.escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  root.WS.complete = { suggest, fuzzy, Completion, formatDoc, isColourProp, NAMED_COLOURS };
})(window);
