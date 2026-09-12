/* ============================================================================
   starter.js — what an empty Web Studio starts with.

   A page rather than a blank file, because the fastest way to learn what an
   editor does is to change something that already works. It uses a custom
   property, a media query, a grid and one event listener, so every panel in
   the app has something to show the moment it opens.
   ========================================================================== */
(function (root) {
  'use strict';

  const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hello</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>

  <header class="hero">
    <h1>Hello.</h1>
    <p class="lede">Edit anything on the left. The page redraws as you type.</p>
    <button class="cta" id="count">Pressed 0 times</button>
  </header>

  <main class="cards">
    <article class="card">
      <h2>Markup</h2>
      <p>Type <code>&lt;</code> and the suggestions know which elements
        belong where.</p>
    </article>
    <article class="card">
      <h2>Style</h2>
      <p>Put the caret on a number and drag the grip that appears. Colours
        open a picker.</p>
    </article>
    <article class="card">
      <h2>Script</h2>
      <p>Whatever you log turns up in the console below the preview.</p>
    </article>
  </main>

  <script src="script.js"></script>
</body>
</html>
`;

  const CSS = `:root {
  --ink: #1b1f27;
  --paper: #fbfaf7;
  --accent: #2f6fed;
  --edge: #e3e0d8;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0 24px 48px;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.6 "Segoe UI", system-ui, sans-serif;
}

.hero {
  max-width: 640px;
  margin: 0 auto;
  padding: 72px 0 40px;
  text-align: center;
}

.hero h1 {
  margin: 0;
  font-size: 56px;
  letter-spacing: -1.5px;
}

.lede {
  margin: 10px 0 26px;
  font-size: 18px;
  color: #5c6473;
}

.cta {
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  font-weight: 600;
  padding: 11px 24px;
  cursor: pointer;
  transition: transform .12s ease, box-shadow .12s ease;
}

.cta:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(47, 111, 237, 0.3);
}

.cards {
  max-width: 900px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 18px;
}

.card {
  background: #fff;
  border: 1px solid var(--edge);
  border-radius: 12px;
  padding: 20px 22px;
}

.card h2 {
  margin: 0 0 6px;
  font-size: 15px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--accent);
}

.card p { margin: 0; color: #4a5261; }

code {
  background: #f0eee8;
  border-radius: 4px;
  padding: 1px 5px;
  font: 14px ui-monospace, Consolas, monospace;
}

@media (max-width: 520px) {
  .hero { padding-top: 44px; }
  .hero h1 { font-size: 40px; }
}
`;

  const JS = `const button = document.getElementById('count');
let presses = 0;

button.addEventListener('click', () => {
  presses += 1;
  button.textContent = \`Pressed \${presses} time\${presses === 1 ? '' : 's'}\`;
  console.log('press', presses);
});

console.log('Ready.');
`;

  root.WS.starter = {
    docs: () => ([
      { name: 'index.html', lang: 'html', text: HTML },
      { name: 'styles.css', lang: 'css', text: CSS },
      { name: 'script.js', lang: 'js', text: JS }
    ])
  };
})(window);
