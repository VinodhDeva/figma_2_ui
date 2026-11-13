import { createHash } from 'node:crypto';
import { camel, pascal, uniqueNamer } from './names.js';
import { buildTree } from './tree.js';

export const CHUNK_LIMIT = 150;
const MIN_CHUNK = 3;
const MAX_SLOTS = 12;

const size = (el) => (el.ref ? 1 : 1 + el.children.reduce((n, c) => n + size(c), 0));

function shape(el, counts, sizes) {
  const key = createHash('sha1')
    .update(JSON.stringify([el.tag, el.css, el.text === undefined, el.attrs ? Object.keys(el.attrs) : 0, el.children.map((c) => shape(c, counts, sizes))]))
    .digest('hex');
  el.hash = key;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  sizes.set(key, size(el));
  return key;
}

function slots(el, out = []) {
  if (el.text !== undefined) out.push({ el, key: 'text', value: el.text, suffix: 'Text' });
  for (const [key, suffix] of [['src', 'Src'], ['alt', 'Alt'], ['placeholder', 'Placeholder']]) {
    if (el.attrs?.[key] !== undefined) out.push({ el, key, value: el.attrs[key], suffix });
  }
  el.children.forEach((c) => slots(c, out));
  return out;
}

const assetsIn = (el, out = []) => {
  out.push(...(el.assets ?? []));
  el.children?.forEach((c) => assetsIn(c, out));
  return out;
};

function makeRepeat(instances, chunks, nameFor) {
  const template = structuredClone(instances[0]);
  const id = `c${chunks.length + 1}`;
  const name = nameFor(pascal(template.name));
  const names = uniqueNamer();
  const tplSlots = slots(template);
  const all = instances.map((i) => slots(i));
  const varying = tplSlots.flatMap((slot, i) => {
    if (all.every((s) => s[i].value === slot.value)) return [];
    const prop = names(camel(slot.el.name) + slot.suffix);
    (slot.el.props ??= {})[slot.key] = prop;
    return [{ prop, i }];
  });
  chunks.push({ id, name, el: template, repeat: instances.length, props: varying.map((v) => v.prop) });
  instances.forEach((inst, n) => {
    const values = Object.fromEntries(varying.map((v) => [v.prop, all[n][v.i].value]));
    const assets = assetsIn(inst);
    for (const k of Object.keys(inst)) delete inst[k];
    Object.assign(inst, { ref: id, values, assets, children: [] });
  });
}

function dedupe(root, chunks, nameFor) {
  const counts = new Map();
  const sizes = new Map();
  shape(root, counts, sizes);
  const groups = new Map();
  const walk = (el) => {
    for (const child of el.children) {
      // A template with too many text or image slots is really a list, so look inside it for the repeated item.
      if (counts.get(child.hash) > 1 && sizes.get(child.hash) >= MIN_CHUNK && slots(child).length <= MAX_SLOTS) {
        if (!groups.has(child.hash)) groups.set(child.hash, []);
        groups.get(child.hash).push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  for (const instances of groups.values()) makeRepeat(instances, chunks, nameFor);
}

function extract(el, chunks, nameFor) {
  const id = `c${chunks.length + 1}`;
  const chunk = { id, name: nameFor(pascal(el.name)), el: { ...el }, repeat: 1, props: [] };
  chunks.push(chunk);
  for (const k of Object.keys(el)) delete el[k];
  Object.assign(el, { ref: id, values: {}, assets: [], children: [] });
  return chunk;
}

// Post-order, so a child's size is already reduced when its parent decides whether to extract it.
function split(el, chunks, nameFor) {
  let total = 1;
  for (const child of el.children) {
    if (child.ref) {
      total += 1;
      continue;
    }
    const childSize = split(child, chunks, nameFor);
    // shortcut: a frame with more than CHUNK_LIMIT direct leaf children stays over the limit, since leaves cannot be extracted.
    if (total + childSize > CHUNK_LIMIT && childSize >= MIN_CHUNK) {
      extract(child, chunks, nameFor);
      total += 1;
    } else {
      total += childSize;
    }
  }
  return total;
}

function summarize(chunk) {
  const counts = new Map();
  const assets = new Set();
  const walk = (el) => {
    el.assets?.forEach((a) => assets.add(a));
    el.warn?.forEach((w) => counts.set(w, (counts.get(w) ?? 0) + 1));
    el.children.forEach(walk);
  };
  walk(chunk.el);
  chunk.nodes = size(chunk.el);
  chunk.assets = [...assets];
  if (chunk.nodes > CHUNK_LIMIT) counts.set(`over ${CHUNK_LIMIT}-node limit`, 1);
  chunk.warnings = [...counts].map(([w, n]) => (n > 1 ? `${w} (x${n})` : w));
}

export function analyze(design, assetUrl) {
  const { root, tokens, assets, fonts } = buildTree(design.document, design.styles, assetUrl);
  const chunks = [];
  const nameFor = uniqueNamer(['Page']);
  dedupe(root, chunks, nameFor);
  // shortcut: repeated templates are not split further, because split parts could not receive props; an oversized one is reported in warnings.
  for (const child of root.children) {
    if (child.ref || size(child) < MIN_CHUNK) continue;
    const chunk = extract(child, chunks, nameFor);
    split(chunk.el, chunks, nameFor);
  }
  const page = { id: 'page', name: 'Page', el: root, repeat: 1, props: [] };
  [...chunks, page].forEach(summarize);
  return { name: design.name, version: design.version, rawBytes: design.rawBytes, page, chunks, tokens, assets, fonts };
}
