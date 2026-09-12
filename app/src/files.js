/* ============================================================================
   files.js — getting your files in and out.

   Three routes, in order of preference:

     1. The local server, when the launcher opened a file for you. It can read
        and write the exact path you double-clicked, and it resolves the
        stylesheet and script your HTML references so a project arrives whole.
     2. The File System Access API, when the browser has it. Save then writes
        back to the file you opened rather than dropping another copy in
        Downloads.
     3. A download, as the last resort.

   Whatever happens, the current text is mirrored into localStorage after every
   pause so closing the window is never how you lose work.
   ========================================================================== */
(function (root) {
  'use strict';

  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('token') || '';
  const SERVED = location.protocol.startsWith('http') && !!TOKEN;

  const hasPicker = typeof window.showOpenFilePicker === 'function';
  const hasSavePicker = typeof window.showSaveFilePicker === 'function';

  const EXT = { html: 'html', css: 'css', js: 'js' };

  const langOf = (name) => {
    const ext = String(name).toLowerCase().split('.').pop();
    if (ext === 'css') return 'css';
    if (ext === 'js' || ext === 'mjs') return 'js';
    return 'html';
  };

  /* ── the server route ────────────────────────────────────────────────── */

  const api = (path, query) => {
    const url = new URL(path, location.origin);
    url.searchParams.set('token', TOKEN);
    for (const key in (query || {})) url.searchParams.set(key, query[key]);
    return url.toString();
  };

  /** Paths the launcher has queued for this window, if any. */
  async function collectOpened() {
    if (!SERVED) return [];
    try {
      const res = await fetch(api('/__pending'), { cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.paths || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Load a file and, when it is HTML, whatever local stylesheet and script it
   * references. The server resolves those paths — it is the only side that
   * knows where the file actually lives.
   */
  async function loadProject(path) {
    const res = await fetch(api('/__project', { path }), { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function writeThroughServer(path, text) {
    const res = await fetch(api('/__file', { path }), { method: 'PUT', body: text });
    if (!res.ok) throw new Error(await res.text());
  }

  /* ── the picker route ────────────────────────────────────────────────── */

  const TYPES = [{
    description: 'Web files',
    accept: {
      'text/html': ['.html', '.htm'],
      'text/css': ['.css'],
      'text/javascript': ['.js', '.mjs']
    }
  }];

  /** @returns {Promise<Array<{name, text, handle, lang}>>} */
  async function pickFiles() {
    if (!hasPicker) return pickWithInput();
    const handles = await window.showOpenFilePicker({ multiple: true, types: TYPES });
    const out = [];
    for (const handle of handles) {
      const file = await handle.getFile();
      out.push({ name: file.name, text: await file.text(), handle, lang: langOf(file.name) });
    }
    return out;
  }

  /** A folder gives us the whole project at once, and handles for all of it. */
  async function pickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('This browser cannot open a folder. Open the files instead.');
    }
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const found = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      const lang = langOf(name);
      if (!/\.(html?|css|m?js)$/i.test(name)) continue;
      found.push({ name, handle, lang });
    }
    /* index.html, then whatever it needs. One of each is all the editor holds. */
    const pick = (lang) => found.find((f) => f.lang === lang && /^(index|main|app|styles?|script)\b/i.test(f.name))
      || found.find((f) => f.lang === lang);

    const out = [];
    for (const lang of ['html', 'css', 'js']) {
      const entry = pick(lang);
      if (!entry) continue;
      const file = await entry.handle.getFile();
      out.push({ name: entry.name, text: await file.text(), handle: entry.handle, lang });
    }
    if (!out.length) throw new Error('No HTML, CSS or JavaScript in that folder.');
    return { files: out, dirHandle: dir };
  }

  /** For browsers with no picker at all. */
  function pickWithInput() {
    return new Promise((done) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.html,.htm,.css,.js,.mjs';
      input.onchange = async () => {
        const out = [];
        for (const file of input.files) {
          out.push({ name: file.name, text: await file.text(), handle: null, lang: langOf(file.name) });
        }
        done(out);
      };
      input.click();
    });
  }

  async function ensureWritable(handle) {
    if (!handle || !handle.queryPermission) return false;
    if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  }

  /**
   * Write a document back where it came from.
   * @returns {Promise<'server'|'handle'|'download'|'saved-as'>} how it was saved
   */
  async function save(doc, opts) {
    opts = opts || {};
    if (!opts.forceNew && doc.path && SERVED) {
      await writeThroughServer(doc.path, doc.text);
      return 'server';
    }
    if (!opts.forceNew && doc.handle && await ensureWritable(doc.handle)) {
      const stream = await doc.handle.createWritable();
      await stream.write(doc.text);
      await stream.close();
      return 'handle';
    }
    return saveAs(doc);
  }

  async function saveAs(doc) {
    if (!hasSavePicker) { download(doc.name, doc.text); return 'download'; }
    const ext = EXT[doc.lang] || 'txt';
    const handle = await window.showSaveFilePicker({
      suggestedName: doc.name,
      types: [{ description: doc.lang.toUpperCase(), accept: { 'text/plain': ['.' + ext] } }]
    });
    const stream = await handle.createWritable();
    await stream.write(doc.text);
    await stream.close();
    doc.handle = handle;
    doc.name = handle.name;
    doc.path = null;              // the handle is now the way back to this file
    return 'saved-as';
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ── the draft ───────────────────────────────────────────────────────── */

  const DRAFT_KEY = 'web-studio:draft';

  function saveDraft(state) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        at: Date.now(),
        docs: state.docs.map((d) => ({ name: d.name, lang: d.lang, text: d.text, path: d.path || null })),
        active: state.active
      }));
    } catch (e) { /* private mode, or the quota; not worth interrupting for */ }
  }

  function readDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} };

  root.WS.files = {
    served: SERVED,
    token: TOKEN,
    hasPicker,
    langOf,
    collectOpened,
    loadProject,
    pickFiles,
    pickFolder,
    save,
    saveAs,
    download,
    saveDraft,
    readDraft,
    clearDraft
  };
})(window);
