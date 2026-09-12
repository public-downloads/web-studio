/* ============================================================================
   schema.js — what the editor knows about HTML and CSS.

   Curated rather than exhaustive: the elements, attributes and properties you
   actually reach for, each with a line explaining it. Anything missing still
   works — nothing here rewrites your markup, it only offers suggestions.
   ========================================================================== */
(function (root) {
  'use strict';

  /* Elements that never take children, so `<img>` completes closed. */
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'source', 'track', 'wbr']);

  const ELEMENTS = {
    /* structure */
    html: 'The document root.',
    head: 'Metadata: title, links, scripts. Nothing here is rendered.',
    body: 'Everything that gets drawn.',
    title: 'The name in the browser tab and in search results.',
    meta: 'A piece of metadata — charset, viewport, description.',
    link: 'Pulls in an external resource, usually a stylesheet.',
    style: 'CSS written inline in the document.',
    script: 'JavaScript, inline or via `src`.',
    base: 'The base URL every relative link resolves against.',

    /* sectioning */
    header: 'Introductory content for the page or a section.',
    nav: 'A block of navigation links.',
    main: 'The dominant content. One per page.',
    section: 'A thematic grouping, normally with a heading.',
    article: 'Something that would still make sense on its own.',
    aside: 'Content tangential to what surrounds it.',
    footer: 'Closing content for the page or a section.',
    h1: 'The most important heading. One per page.',
    h2: 'A section heading.',
    h3: 'A sub-section heading.',
    h4: 'A fourth-level heading.',
    h5: 'A fifth-level heading.',
    h6: 'The least important heading.',
    hgroup: 'A heading together with its subheading.',

    /* text */
    div: 'A generic box with no meaning of its own. Reach for it last.',
    p: 'A paragraph.',
    span: 'A generic inline wrapper with no meaning of its own.',
    a: 'A link. `href` is what it points at.',
    strong: 'Strong importance. Bold by default, but the meaning is the point.',
    em: 'Stress emphasis. Italic by default.',
    b: 'Bold with no added importance — a keyword, a product name.',
    i: 'Italic with no added emphasis — a term, a foreign phrase.',
    u: 'Underlined for a non-textual reason, such as a spelling error.',
    s: 'No longer accurate or relevant.',
    mark: 'Highlighted for reference.',
    small: 'Side comments, small print.',
    sub: 'Subscript.',
    sup: 'Superscript.',
    br: 'A line break inside a block of text.',
    hr: 'A thematic break between sections.',
    blockquote: 'A quotation set apart from the text.',
    q: 'A short inline quotation.',
    cite: 'The title of a work.',
    code: 'A fragment of computer code.',
    pre: 'Preformatted text — whitespace and line breaks are kept.',
    kbd: 'Keyboard input.',
    samp: 'Sample output from a program.',
    var: 'A variable name.',
    abbr: 'An abbreviation. Put the expansion in `title`.',
    time: 'A date or time. `datetime` carries the machine-readable form.',
    address: 'Contact details for the nearest article or the page.',

    /* lists */
    ul: 'An unordered list.',
    ol: 'An ordered list.',
    li: 'One item in a list.',
    dl: 'A description list of term/description pairs.',
    dt: 'A term being described.',
    dd: 'The description of the term before it.',

    /* media */
    img: 'An image. `alt` describes it for people who cannot see it.',
    picture: 'Wraps `source` elements to pick an image per screen.',
    source: 'One candidate file for a picture, video or audio element.',
    figure: 'Self-contained content, often with a caption.',
    figcaption: 'The caption of a figure.',
    video: 'A video player.',
    audio: 'An audio player.',
    track: 'Subtitles or captions for a video.',
    canvas: 'A bitmap you draw on from JavaScript.',
    svg: 'Vector graphics written inline.',
    iframe: 'Another document embedded in this one.',

    /* tables */
    table: 'Tabular data. Not a layout tool.',
    thead: 'The header rows of a table.',
    tbody: 'The body rows of a table.',
    tfoot: 'The footer rows of a table.',
    tr: 'A row.',
    th: 'A header cell. `scope` says what it heads.',
    td: 'A data cell.',
    caption: 'The title of a table.',
    colgroup: 'A group of columns, for styling.',
    col: 'One column in a colgroup.',

    /* forms */
    form: 'A group of controls that submit together.',
    input: 'A control. `type` decides which one.',
    textarea: 'Multi-line text input.',
    button: 'A button. Set `type="button"` unless you want it to submit.',
    select: 'A dropdown.',
    option: 'One choice in a select.',
    optgroup: 'A labelled group of options.',
    label: 'Names a control. `for` ties it to the control it labels.',
    fieldset: 'A group of related controls.',
    legend: 'The caption of a fieldset.',
    datalist: 'Suggestions for an input, without restricting it.',
    output: 'The result of a calculation.',
    progress: 'Progress through a task.',
    meter: 'A measurement within a known range.',

    /* interactive */
    details: 'A disclosure widget that opens and closes.',
    summary: 'The visible heading of a details element.',
    dialog: 'A dialog box. `showModal()` opens it.',
    template: 'Markup that is parsed but not rendered until you clone it.',
    slot: 'A placeholder inside a web component.',
    noscript: 'Content for when scripting is off.'
  };

  /* Attributes worth suggesting everywhere. */
  const GLOBAL_ATTRS = {
    class: 'Space-separated class names, for CSS and JavaScript to hook onto.',
    id: 'A unique name for this element. One per document.',
    style: 'Inline CSS. Highest priority, and not reusable — prefer a class.',
    title: 'Advisory text, usually shown as a tooltip.',
    hidden: 'Removes the element from the page entirely.',
    tabindex: 'Where the element sits in the keyboard focus order.',
    role: 'Overrides what assistive technology thinks this element is.',
    'data-*': 'Your own data, readable as `element.dataset.*`.',
    'aria-label': 'A name for assistive technology when the visible text will not do.',
    'aria-hidden': 'Hides the element from assistive technology only.',
    contenteditable: 'Lets the user edit the content directly.',
    draggable: 'Whether the element can be dragged.',
    lang: 'The language of the content, e.g. `en`.',
    dir: 'Text direction: `ltr`, `rtl` or `auto`.'
  };

  /* Attributes that only make sense on particular elements. */
  const ATTRS = {
    a: { href: 'Where the link goes.', target: 'Where to open it. `_blank` opens a new tab.',
         rel: 'The relationship. Use `noopener` with `target="_blank"`.', download: 'Download instead of navigating.' },
    img: { src: 'The image file.', alt: 'What the image shows, for people who cannot see it.',
           width: 'Intrinsic width in pixels.', height: 'Intrinsic height in pixels.',
           loading: 'Set `lazy` to defer images below the fold.', srcset: 'Alternative files per screen density.' },
    script: { src: 'The script file.', type: 'Use `module` for ES modules.',
              defer: 'Run after parsing, in order.', async: 'Run as soon as it loads.' },
    link: { rel: 'The relationship — `stylesheet`, `icon`, `preconnect`.', href: 'The file.',
            as: 'What is being preloaded.', crossorigin: 'How to fetch it across origins.' },
    meta: { charset: 'Character encoding. Always `utf-8`.', name: 'Which metadata this is.',
            content: 'Its value.', property: 'Open Graph property name.' },
    input: { type: 'Which control this is.', name: 'The key it submits under.', value: 'Its starting value.',
             placeholder: 'A hint shown while it is empty. Not a label.', required: 'Must be filled in.',
             disabled: 'Cannot be used or submitted.', checked: 'Starts ticked.', min: 'Lowest allowed value.',
             max: 'Highest allowed value.', step: 'Allowed increment.', pattern: 'A regular expression it must match.',
             autocomplete: 'What the browser may fill in.' },
    button: { type: '`button`, `submit` or `reset`.', disabled: 'Cannot be pressed.',
              form: 'The id of the form it belongs to.' },
    form: { action: 'Where the data goes.', method: '`get` or `post`.',
            novalidate: 'Skip the browser validation.' },
    label: { for: 'The id of the control this labels.' },
    textarea: { rows: 'Visible height in lines.', cols: 'Visible width in characters.',
                placeholder: 'A hint shown while it is empty.' },
    select: { multiple: 'Allow more than one choice.', size: 'How many options to show at once.' },
    option: { value: 'What is submitted.', selected: 'Starts chosen.' },
    video: { src: 'The video file.', controls: 'Show the player controls.', autoplay: 'Start on load — needs `muted`.',
             muted: 'Start silent.', loop: 'Repeat forever.', poster: 'The still shown before it plays.' },
    audio: { src: 'The audio file.', controls: 'Show the player controls.', loop: 'Repeat forever.' },
    iframe: { src: 'The document to embed.', title: 'What it contains, for assistive technology.',
              loading: 'Set `lazy` to defer it.', allow: 'Which features it may use.' },
    td: { colspan: 'How many columns this cell spans.', rowspan: 'How many rows this cell spans.' },
    th: { scope: '`col` or `row` — what this header heads.', colspan: 'Columns spanned.', rowspan: 'Rows spanned.' },
    details: { open: 'Starts expanded.' },
    dialog: { open: 'Starts shown. Prefer `showModal()` from script.' },
    ol: { start: 'The number to count from.', reversed: 'Count downwards.', type: 'The numbering style.' },
    time: { datetime: 'The machine-readable date or time.' }
  };

  /* Values worth offering for attributes that take a fixed set. */
  const ATTR_VALUES = {
    'input.type': ['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'date', 'time',
      'datetime-local', 'month', 'week', 'color', 'range', 'file', 'checkbox', 'radio', 'hidden',
      'submit', 'reset', 'button'],
    'button.type': ['button', 'submit', 'reset'],
    'a.target': ['_self', '_blank', '_parent', '_top'],
    'a.rel': ['noopener', 'noreferrer', 'nofollow', 'external'],
    'link.rel': ['stylesheet', 'icon', 'preconnect', 'preload', 'manifest', 'canonical'],
    'img.loading': ['lazy', 'eager'],
    'iframe.loading': ['lazy', 'eager'],
    'script.type': ['module', 'text/javascript', 'application/json'],
    'form.method': ['get', 'post'],
    'th.scope': ['col', 'row', 'colgroup', 'rowgroup'],
    'meta.charset': ['utf-8'],
    'dir': ['ltr', 'rtl', 'auto']
  };

  /* ── CSS ───────────────────────────────────────────────────────────── */

  const p = (doc, values) => ({ doc, values: values || null });

  const CSS = {
    /* layout */
    display: p('How the box lays itself and its children out.',
      ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'none']),
    position: p('How the box is placed. `static` is the default and ignores offsets.',
      ['static', 'relative', 'absolute', 'fixed', 'sticky']),
    top: p('Offset from the top edge.'), right: p('Offset from the right edge.'),
    bottom: p('Offset from the bottom edge.'), left: p('Offset from the left edge.'),
    inset: p('All four offsets at once.'),
    'z-index': p('Stacking order. Only applies to positioned boxes.'),
    float: p('Take the box out of flow to one side. Rarely needed now.', ['left', 'right', 'none']),
    clear: p('Push below earlier floats.', ['left', 'right', 'both', 'none']),
    overflow: p('What happens to content that does not fit.',
      ['visible', 'hidden', 'scroll', 'auto', 'clip']),
    'overflow-x': p('Horizontal overflow.', ['visible', 'hidden', 'scroll', 'auto', 'clip']),
    'overflow-y': p('Vertical overflow.', ['visible', 'hidden', 'scroll', 'auto', 'clip']),
    visibility: p('`hidden` keeps the space; `display: none` does not.', ['visible', 'hidden', 'collapse']),

    /* box */
    width: p('Box width.', ['auto', 'min-content', 'max-content', 'fit-content', '100%']),
    height: p('Box height.', ['auto', 'min-content', 'max-content', 'fit-content', '100%']),
    'min-width': p('Lower bound on width.'), 'max-width': p('Upper bound on width.'),
    'min-height': p('Lower bound on height.'), 'max-height': p('Upper bound on height.'),
    margin: p('Space outside the border.'), 'margin-top': p('Space above.'),
    'margin-right': p('Space to the right.'), 'margin-bottom': p('Space below.'),
    'margin-left': p('Space to the left.'),
    'margin-inline': p('Left and right margin, writing-direction aware.'),
    'margin-block': p('Top and bottom margin, writing-direction aware.'),
    padding: p('Space inside the border.'), 'padding-top': p('Inner space above.'),
    'padding-right': p('Inner space right.'), 'padding-bottom': p('Inner space below.'),
    'padding-left': p('Inner space left.'),
    'padding-inline': p('Left and right padding.'), 'padding-block': p('Top and bottom padding.'),
    'box-sizing': p('Whether width includes padding and border. `border-box` is almost always what you want.',
      ['content-box', 'border-box']),
    'aspect-ratio': p('Keeps a shape, e.g. `16 / 9`.'),

    /* flex */
    'flex-direction': p('Which way flex children run.', ['row', 'column', 'row-reverse', 'column-reverse']),
    'flex-wrap': p('Whether children wrap onto more lines.', ['nowrap', 'wrap', 'wrap-reverse']),
    flex: p('Shorthand for grow, shrink and basis. `flex: 1` fills the space.'),
    'flex-grow': p('Share of the leftover space.'),
    'flex-shrink': p('How much it gives up when space is short.'),
    'flex-basis': p('Starting size before growing or shrinking.'),
    'justify-content': p('Alignment along the main axis.',
      ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'start', 'end']),
    'align-items': p('Alignment across the cross axis.',
      ['stretch', 'flex-start', 'flex-end', 'center', 'baseline', 'start', 'end']),
    'align-self': p('Overrides align-items for one child.',
      ['auto', 'stretch', 'flex-start', 'flex-end', 'center', 'baseline']),
    'align-content': p('Spacing between wrapped lines.',
      ['stretch', 'flex-start', 'flex-end', 'center', 'space-between', 'space-around']),
    gap: p('Space between rows and columns. Works in flex and grid.'),
    'row-gap': p('Space between rows.'), 'column-gap': p('Space between columns.'),
    order: p('Reorders a flex or grid child visually only.'),

    /* grid */
    'grid-template-columns': p('The column tracks, e.g. `repeat(3, 1fr)`.'),
    'grid-template-rows': p('The row tracks.'),
    'grid-template-areas': p('Names the cells so children can be placed by name.'),
    'grid-column': p('Which columns a child spans, e.g. `1 / 3` or `span 2`.'),
    'grid-row': p('Which rows a child spans.'),
    'grid-area': p('Shorthand for row and column placement, or an area name.'),
    'grid-auto-flow': p('How items that were not placed get placed.', ['row', 'column', 'dense']),
    'grid-auto-rows': p('Size of rows created automatically.'),
    'grid-auto-columns': p('Size of columns created automatically.'),
    'place-items': p('align-items and justify-items together.'),
    'place-content': p('align-content and justify-content together.'),
    'justify-items': p('Alignment of grid items in their cell.',
      ['stretch', 'start', 'end', 'center']),

    /* typography */
    color: p('Text colour.'),
    font: p('Shorthand for the whole font.'),
    'font-family': p('The typeface, with fallbacks after commas.'),
    'font-size': p('Text size.'),
    'font-weight': p('Thickness.', ['100', '200', '300', '400', '500', '600', '700', '800', '900',
      'normal', 'bold', 'lighter', 'bolder']),
    'font-style': p('Slant.', ['normal', 'italic', 'oblique']),
    'line-height': p('Space between lines. Unitless numbers scale with font size.'),
    'letter-spacing': p('Space between characters.'),
    'word-spacing': p('Space between words.'),
    'text-align': p('Horizontal alignment of text.', ['left', 'right', 'center', 'justify', 'start', 'end']),
    'text-decoration': p('Underlines and strikethroughs.',
      ['none', 'underline', 'overline', 'line-through']),
    'text-transform': p('Forces case.', ['none', 'uppercase', 'lowercase', 'capitalize']),
    'text-indent': p('Indent of the first line.'),
    'text-shadow': p('Shadow behind text: `x y blur colour`.'),
    'text-wrap': p('How lines break. `balance` evens out headings.', ['wrap', 'nowrap', 'balance', 'pretty']),
    'white-space': p('How whitespace and wrapping are handled.',
      ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']),
    'word-break': p('Where words may break.', ['normal', 'break-all', 'keep-all']),
    'overflow-wrap': p('Lets long words break rather than overflow.', ['normal', 'break-word', 'anywhere']),
    'text-overflow': p('What to show when text is clipped. Needs `overflow: hidden`.', ['clip', 'ellipsis']),
    'vertical-align': p('Alignment of inline or table-cell content.',
      ['baseline', 'top', 'middle', 'bottom', 'sub', 'super']),
    'font-variant-numeric': p('Digit styles. `tabular-nums` lines numbers up in columns.',
      ['normal', 'tabular-nums', 'oldstyle-nums', 'proportional-nums']),

    /* decoration */
    background: p('Shorthand for every background property.'),
    'background-color': p('Fill colour behind the content.'),
    'background-image': p('An image or gradient behind the content.'),
    'background-size': p('How the background is scaled.', ['auto', 'cover', 'contain']),
    'background-position': p('Where the background sits.', ['center', 'top', 'bottom', 'left', 'right']),
    'background-repeat': p('Whether it tiles.', ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round']),
    'background-attachment': p('Whether it scrolls with the content.', ['scroll', 'fixed', 'local']),
    'background-clip': p('How far the background extends.', ['border-box', 'padding-box', 'content-box', 'text']),
    border: p('Shorthand: `1px solid black`.'),
    'border-width': p('Border thickness.'), 'border-style': p('Border line style.',
      ['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset']),
    'border-color': p('Border colour.'),
    'border-top': p('The top border.'), 'border-right': p('The right border.'),
    'border-bottom': p('The bottom border.'), 'border-left': p('The left border.'),
    'border-radius': p('Corner rounding. `50%` makes a circle of a square.'),
    outline: p('A line outside the border that does not affect layout.'),
    'outline-offset': p('Gap between the outline and the border.'),
    'box-shadow': p('Shadow around the box: `x y blur spread colour`.'),
    opacity: p('Transparency of the element and everything in it, 0 to 1.'),
    filter: p('Visual effects: `blur()`, `brightness()`, `grayscale()`.'),
    'backdrop-filter': p('Applies a filter to whatever is behind the box.'),
    'mix-blend-mode': p('How the box blends with what is behind it.',
      ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference']),

    /* motion */
    transition: p('Shorthand: `property duration easing delay`.'),
    'transition-property': p('Which properties animate when they change.'),
    'transition-duration': p('How long the transition takes.'),
    'transition-timing-function': p('The easing curve.',
      ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'steps(4, end)']),
    'transition-delay': p('Wait before starting.'),
    animation: p('Shorthand for a keyframe animation.'),
    'animation-name': p('Which `@keyframes` to run.'),
    'animation-duration': p('How long one cycle takes.'),
    'animation-iteration-count': p('How many times to run.', ['1', '2', '3', 'infinite']),
    'animation-fill-mode': p('What sticks before and after.', ['none', 'forwards', 'backwards', 'both']),
    'animation-direction': p('Which way each cycle runs.',
      ['normal', 'reverse', 'alternate', 'alternate-reverse']),
    transform: p('Move, rotate, scale or skew without affecting layout.'),
    'transform-origin': p('The pivot for transforms.'),
    translate: p('Offset, as its own property.'),
    rotate: p('Rotation, as its own property.'),
    scale: p('Scale, as its own property.'),
    'will-change': p('Warns the browser something will animate. Use sparingly.'),

    /* interaction */
    cursor: p('Pointer shape.', ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'grabbing',
      'not-allowed', 'wait', 'help', 'crosshair', 'zoom-in']),
    'pointer-events': p('`none` makes the box click-through.', ['auto', 'none']),
    'user-select': p('Whether the text can be selected.', ['auto', 'none', 'text', 'all']),
    resize: p('Whether the user can resize the box.', ['none', 'both', 'horizontal', 'vertical']),
    'scroll-behavior': p('`smooth` animates jumps to anchors.', ['auto', 'smooth']),
    'accent-color': p('Colours checkboxes, radios and range inputs.'),

    /* misc */
    content: p('Generated content for `::before` and `::after`.'),
    'list-style': p('Shorthand for list markers.'),
    'list-style-type': p('The marker.', ['none', 'disc', 'circle', 'square', 'decimal', 'lower-alpha']),
    'object-fit': p('How a replaced element fills its box.',
      ['fill', 'contain', 'cover', 'none', 'scale-down']),
    'object-position': p('How a replaced element is aligned in its box.'),
    'border-collapse': p('Whether table borders merge.', ['collapse', 'separate']),
    'caret-color': p('Colour of the text cursor.'),
    'color-scheme': p('Tells the browser which system colours to use.', ['light', 'dark', 'light dark'])
  };

  const AT_RULES = {
    '@media': 'Applies rules only at certain screen sizes or capabilities.',
    '@keyframes': 'Defines the steps of an animation.',
    '@font-face': 'Loads a font file.',
    '@import': 'Pulls in another stylesheet. Put it first.',
    '@supports': 'Applies rules only if the browser understands a declaration.',
    '@layer': 'Groups rules into cascade layers.',
    '@container': 'Applies rules based on a container size rather than the screen.'
  };

  const PSEUDO = {
    ':hover': 'While the pointer is over it.',
    ':focus': 'While it has keyboard focus.',
    ':focus-visible': 'Focus from the keyboard only — the right one for focus rings.',
    ':active': 'While it is being pressed.',
    ':disabled': 'While the control is disabled.',
    ':checked': 'While a checkbox or radio is ticked.',
    ':first-child': 'The first child of its parent.',
    ':last-child': 'The last child of its parent.',
    ':nth-child()': 'Children by position, e.g. `:nth-child(2n)`.',
    ':not()': 'Anything the selector inside does not match.',
    ':has()': 'A parent that contains something matching.',
    ':is()': 'Shorthand for a list of selectors.',
    ':where()': 'Like `:is()` but adds no specificity.',
    ':root': 'The html element. Where custom properties usually live.',
    '::before': 'A generated box at the start of the element.',
    '::after': 'A generated box at the end of the element.',
    '::placeholder': 'The placeholder text of an input.',
    '::selection': 'The highlighted text.',
    '::marker': 'The bullet or number of a list item.'
  };

  root.WS = root.WS || {};
  root.WS.schema = {
    elements: ELEMENTS,
    isVoid: (name) => VOID.has(String(name).toLowerCase()),
    globalAttrs: GLOBAL_ATTRS,
    attrs: ATTRS,
    attrValues: ATTR_VALUES,
    css: CSS,
    atRules: AT_RULES,
    pseudo: PSEUDO,
    /** Attributes valid on an element, its own first then the global ones. */
    attrsFor(tag) {
      const own = ATTRS[String(tag).toLowerCase()] || {};
      const merged = {};
      for (const key in own) merged[key] = { doc: own[key], own: true };
      for (const key in GLOBAL_ATTRS) if (!merged[key]) merged[key] = { doc: GLOBAL_ATTRS[key], own: false };
      return merged;
    },
    valuesFor(tag, attr) {
      return ATTR_VALUES[String(tag).toLowerCase() + '.' + attr] || ATTR_VALUES[attr] || null;
    }
  };
})(window);
