import { slug, uniqueNamer } from './names.js';

const VECTOR = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'REGULAR_POLYGON']);
const JUSTIFY = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
const ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };

const round = (n) => +Number(n).toFixed(2);
const px = (n) => `${round(n)}px`;
const visible = (n) => n.visible !== false;
const visiblePaints = (list) => (list ?? []).filter((p) => p.visible !== false);
const ZERO_BOX = { x: 0, y: 0, width: 0, height: 0 };
const box = (n) => n.absoluteBoundingBox ?? ZERO_BOX;

function colorValue({ r, g, b, a = 1 }, opacity = 1) {
  const [R, G, B] = [r, g, b].map((v) => Math.round(v * 255));
  const alpha = round(a * opacity);
  if (alpha < 1) return `rgba(${R},${G},${B},${alpha})`;
  return `#${[R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function createTokens() {
  const byKey = new Map();
  const unique = uniqueNamer();
  const counts = {};
  return {
    list: () => [...byKey.values()],
    add(kind, value, styleName) {
      const key = `${kind}:${value}`;
      if (!byKey.has(key)) {
        const base = slug(styleName ?? '') || String((counts[kind] = (counts[kind] ?? 0) + 1));
        byKey.set(key, { name: unique(`${kind}-${base}`), value });
      }
      return `var(--${byKey.get(key).name})`;
    },
  };
}

function gradient(paint) {
  const stops = paint.gradientStops.map((s) => `${colorValue(s.color, paint.opacity ?? 1)} ${round(s.position * 100)}%`).join(',');
  if (paint.type === 'GRADIENT_LINEAR') {
    const [a, b] = paint.gradientHandlePositions;
    return `linear-gradient(${Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90)}deg,${stops})`;
  }
  return paint.type === 'GRADIENT_ANGULAR' ? `conic-gradient(${stops})` : `radial-gradient(circle,${stops})`;
}

function paintValue(paint, styleName, ctx, el) {
  if (paint.type === 'SOLID') return ctx.tokens.add('color', colorValue(paint.color, paint.opacity ?? 1), styleName);
  if (paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') el.warn.push(`${paint.type} approximated`);
  return gradient(paint);
}

function addAsset(ctx, kind, source) {
  const safe = source.replace(/[^A-Za-z0-9]+/g, '-');
  // shortcut: image fills are always named .png even if Figma stores JPEG; browsers sniff the type, add content-type lookup if a stack needs true extensions.
  const file = kind === 'svg' ? `svg-${safe}.svg` : `img-${safe}.png`;
  ctx.assets.set(file, { id: file, kind, source, file });
  return { file, src: `/figma/${file}` };
}

function hasGenericName(name) {
  return /^(rectangle|image|vector|frame|group|ellipse|union|subtract)\s*\d*$/i.test(name);
}

function imageEl(el, node, asset) {
  el.tag = 'img';
  el.attrs = { src: asset.src, alt: hasGenericName(node.name ?? '') ? '' : node.name };
  el.assets = [asset.file];
  el.children = [];
  return el;
}

function isVectorAsset(node) {
  if (VECTOR.has(node.type)) return true;
  if (!node.children?.length || (node.layoutMode && node.layoutMode !== 'NONE')) return false;
  const leaves = [];
  const walk = (n) => (n.children?.length ? n.children.filter(visible).forEach(walk) : leaves.push(n));
  walk(node);
  return leaves.some((n) => VECTOR.has(n.type)) && leaves.every((n) => VECTOR.has(n.type) || n.type === 'RECTANGLE' || n.type === 'ELLIPSE');
}

function sizing(node, horizontal, parent) {
  const explicit = horizontal ? node.layoutSizingHorizontal : node.layoutSizingVertical;
  if (explicit) return explicit;
  const main = (parent.dir === 'HORIZONTAL') === horizontal;
  if (main && node.layoutGrow === 1) return 'FILL';
  if (!main && node.layoutAlign === 'STRETCH') return 'FILL';
  return 'FIXED';
}

function placeAxis(node, parent, css, prop, horizontal, size) {
  const auto = node.style?.textAutoResize;
  const mode = parent.dir && node.layoutPositioning !== 'ABSOLUTE' ? sizing(node, horizontal, parent) : 'FIXED';
  if (node.type === 'TEXT' && mode === 'FIXED') {
    if (!horizontal && auto && auto !== 'NONE') return;
    if (horizontal && auto === 'WIDTH_AND_HEIGHT') return;
  }
  const main = parent.dir && (parent.dir === 'HORIZONTAL') === horizontal;
  if (mode === 'FIXED') {
    css[prop] = px(size);
    if (main && node.layoutPositioning !== 'ABSOLUTE') css['flex-shrink'] = '0';
  } else if (mode === 'FILL') {
    if (!parent.dir) css[prop] = '100%';
    else if (main) Object.assign(css, { flex: '1 1 0', [`min-${prop}`]: '0' });
    else css['align-self'] = 'stretch';
  } else if (prop === 'width' && node.type !== 'TEXT') {
    css.width = 'fit-content';
  }
}

function place(node, parent, css) {
  if (!parent) return;
  const b = box(node);
  if (!parent.flow && (!parent.dir || node.layoutPositioning === 'ABSOLUTE')) {
    css.position = 'absolute';
    css.left = px(b.x - parent.box.x);
    css.top = px(b.y - parent.box.y);
  }
  placeAxis(node, parent, css, 'width', true, b.width);
  placeAxis(node, parent, css, 'height', false, b.height);
}

function decorate(node, el, ctx) {
  const { css } = el;
  const strokes = visiblePaints(node.strokes);
  if (strokes.length && (node.strokeWeight || node.individualStrokeWeights)) {
    const color = paintValue(strokes.at(-1), ctx.styles[node.styles?.stroke]?.name, ctx, el);
    const w = node.individualStrokeWeights;
    if (w) Object.assign(css, { 'border-style': 'solid', 'border-color': color, 'border-width': [w.top, w.right, w.bottom, w.left].map(px).join(' ') });
    else css.border = `${px(node.strokeWeight)} solid ${color}`;
    css['box-sizing'] = 'border-box';
  }
  if (node.type === 'ELLIPSE') css['border-radius'] = '50%';
  else if (node.rectangleCornerRadii) css['border-radius'] = node.rectangleCornerRadii.map(px).join(' ');
  else if (node.cornerRadius) css['border-radius'] = px(node.cornerRadius);
  if (node.opacity !== undefined && node.opacity < 1) css.opacity = String(round(node.opacity));
  if (node.clipsContent) css.overflow = 'hidden';
  const shadows = [];
  for (const e of (node.effects ?? []).filter((x) => x.visible !== false)) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      shadows.push(`${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(e.offset.x)} ${px(e.offset.y)} ${px(e.radius)} ${px(e.spread ?? 0)} ${colorValue(e.color)}`);
    } else if (e.type === 'LAYER_BLUR') css.filter = `blur(${px(e.radius)})`;
    else if (e.type === 'BACKGROUND_BLUR') css['backdrop-filter'] = `blur(${px(e.radius)})`;
  }
  if (shadows.length) css['box-shadow'] = shadows.join(',');
  if (node.blendMode && !['PASS_THROUGH', 'NORMAL'].includes(node.blendMode)) el.warn.push('blend mode ignored');
  if (Math.abs(node.rotation ?? 0) > 0.01) el.warn.push('rotation ignored');
}

function textTag(size, name, parent) {
  if (parent?.inter) return 'span';
  const named = /\bh([1-6])\b/i.exec(name ?? '');
  if (named) return `h${named[1]}`;
  if (size >= 40) return 'h1';
  if (size >= 24) return 'h2';
  if (size >= 20) return 'h3';
  return 'p';
}

function textEl(node, parent, el, ctx) {
  const s = node.style ?? {};
  const { css } = el;
  const styleName = ctx.styles[node.styles?.text]?.name;
  el.tag = textTag(s.fontSize ?? 16, node.name, parent);
  el.text = node.characters ?? '';
  // shortcut: quotes, backslashes and CSS delimiters are dropped from family names; fonts using them need a manual fix.
  if (s.fontFamily) css['font-family'] = ctx.tokens.add('font', `"${s.fontFamily.replace(/["\\;{}<>\n]/g, '')}", sans-serif`);
  if (s.fontSize) css['font-size'] = ctx.tokens.add('size', px(s.fontSize), styleName);
  if (s.fontWeight) css['font-weight'] = String(s.fontWeight);
  if (s.lineHeightPx && s.lineHeightUnit !== 'INTRINSIC_%') css['line-height'] = px(s.lineHeightPx);
  if (s.letterSpacing) css['letter-spacing'] = px(s.letterSpacing);
  if (s.textAlignHorizontal && s.textAlignHorizontal !== 'LEFT') css['text-align'] = s.textAlignHorizontal === 'JUSTIFIED' ? 'justify' : s.textAlignHorizontal.toLowerCase();
  if (s.italic) css['font-style'] = 'italic';
  if (s.textCase === 'UPPER') css['text-transform'] = 'uppercase';
  if (s.textCase === 'LOWER') css['text-transform'] = 'lowercase';
  if (s.textCase === 'TITLE') css['text-transform'] = 'capitalize';
  if (s.textDecoration === 'UNDERLINE') css['text-decoration'] = 'underline';
  if (s.textDecoration === 'STRIKETHROUGH') css['text-decoration'] = 'line-through';
  if (el.text.includes('\n')) css['white-space'] = 'pre-line';
  const paint = visiblePaints(node.fills).at(-1);
  if (paint?.type === 'SOLID') css.color = paintValue(paint, ctx.styles[node.styles?.fill]?.name, ctx, el);
  if (node.characterStyleOverrides?.some(Boolean)) el.warn.push('mixed text styles flattened');
  return el;
}

function firstText(node) {
  if (node.type === 'TEXT') return node.characters ?? '';
  for (const c of (node.children ?? []).filter(visible)) {
    const found = firstText(c);
    if (found !== null) return found;
  }
  return null;
}

function semanticTag(node, parent) {
  if (parent?.inter || !node.children) return null;
  const name = (node.name ?? '').replace(/[_\-/]+/g, ' ');
  if (/\b(button|btn|cta)\b/i.test(name)) return 'button';
  if (/\b(input|text ?field|search ?bar)\b/i.test(name)) return 'input';
  if (/\blink\b/i.test(name)) return 'a';
  return null;
}

function layout(node, el, kids) {
  const { css } = el;
  const dir = node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL' ? node.layoutMode : null;
  const horizontalFill = node.layoutSizingHorizontal === 'FILL';
  const verticalFill = node.layoutSizingVertical === 'FILL';
  if (dir) {
    css.display = 'flex';
    css['flex-direction'] = dir === 'HORIZONTAL' ? 'row' : 'column';
    if (node.layoutWrap === 'WRAP') css['flex-wrap'] = 'wrap';
    const justify = JUSTIFY[node.primaryAxisAlignItems ?? 'MIN'];
    css['justify-content'] = justify;
    css['align-items'] = ALIGN[node.counterAxisAlignItems ?? 'MIN'];
    if (node.itemSpacing && justify !== 'space-between') css.gap = px(node.itemSpacing);
    if (node.layoutWrap === 'WRAP' && node.counterAxisSpacing) css['row-gap'] = px(node.counterAxisSpacing);
    const pads = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((v) => v ?? 0);
    if (pads.some(Boolean)) {
      css.padding = new Set(pads).size === 1 ? px(pads[0]) : pads.map(px).join(' ');
      css['box-sizing'] = 'border-box';
    }
    if (kids.some((k) => k.layoutPositioning === 'ABSOLUTE')) css.position ??= 'relative';
  } else if (kids.length) {
    if (node.layoutMode === 'GRID') el.warn.push('grid layout converted to absolute');
    css.position ??= 'relative';
    const b = box(node);
    if (!horizontalFill) css.width ??= px(b.width);
    if (!verticalFill) css.height ??= px(b.height);
    el.warn.push('no auto-layout, absolute positions used');
  }
  return dir;
}

function buildNode(node, parent, ctx) {
  const el = { tag: 'div', name: node.name || node.type, css: {}, children: [], warn: [] };
  place(node, parent, el.css);
  decorate(node, el, ctx);
  if (node.type === 'CODE_INSTANCE') el.warn.push('Figma Make code layer has no design data, left empty');
  if (node.type !== 'TEXT' && isVectorAsset(node)) return imageEl(el, node, addAsset(ctx, 'svg', node.id));
  if (node.type === 'TEXT') return textEl(node, parent, el, ctx);

  const paints = visiblePaints(node.fills);
  const top = paints.at(-1);
  if (paints.length > 1) el.warn.push('multiple fills, top fill used');
  const kids = (node.children ?? []).filter(visible);
  if (top?.type === 'IMAGE') {
    const asset = addAsset(ctx, 'image', top.imageRef);
    if (!kids.length) return imageEl(el, node, asset);
    Object.assign(el.css, { 'background-image': `url(${asset.src})`, 'background-size': 'cover', 'background-position': 'center' });
    el.assets = [asset.file];
  } else if (top) {
    el.css.background = paintValue(top, ctx.styles[node.styles?.fill]?.name, ctx, el);
  }

  const dir = layout(node, el, kids);
  const tag = semanticTag(node, parent);
  if (tag) el.tag = tag;
  if (tag === 'input') {
    el.attrs = { placeholder: firstText(node) ?? '' };
    return el;
  }
  if (tag === 'a') el.attrs = { href: '#' };
  const self = { dir, box: box(node), inter: !!tag || parent?.inter };
  el.children = kids.map((k) => buildNode(k, self, ctx));
  return el;
}

export function buildTree(document, styles = {}) {
  const ctx = { tokens: createTokens(), assets: new Map(), styles };
  let node = document;
  if (node.type === 'CANVAS') {
    const kids = (node.children ?? []).filter(visible);
    if (kids.length === 1) node = kids[0];
  }
  if (node.type === 'CODE_INSTANCE') {
    throw new Error('This frame is a Figma Make code layer, so it has no design layers to convert. Link to a frame built with normal Figma layers.');
  }
  let root;
  if (node.type === 'CANVAS') {
    root = { tag: 'div', name: node.name || 'Page', warn: [], css: { display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-start' } };
    root.children = (node.children ?? []).filter(visible).map((k) => buildNode(k, { flow: true }, ctx));
  } else {
    root = buildNode(node, null, ctx);
    delete root.css.width;
    delete root.css.height;
    Object.assign(root.css, { width: '100%', 'max-width': px(box(node).width), margin: '0 auto' });
    if (!root.css.display && root.children.length) root.css.height = px(box(node).height);
  }
  return { root, tokens: ctx.tokens.list(), assets: [...ctx.assets.values()] };
}
