import { analyze } from './chunk.js';
import { contextFor, emitChunk, tokensFile } from './emit.js';
import { fetchBytes, fetchVersion, getDesign, imageFillUrls, parseFigmaUrl, svgUrls } from './figma.js';
import { slug } from './names.js';
import { fileExists, loadState, requireProject, saveState, writeGenerated } from './project.js';
import { detectStack, parseStack } from './stack.js';
import { tracked } from './usage.js';

const MAX_WARNINGS = 5;

function capWarnings(warnings) {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS), `+${warnings.length - MAX_WARNINGS} more`];
}

async function current(projectDir) {
  requireProject(projectDir);
  const state = await loadState(projectDir);
  if (!state.current || !state.stack) throw new Error('No design is indexed for this project. Call figma_index first.');
  const { fileKey, nodeId, version, dir, slug: designSlug } = state.current;
  const analysis = analyze(await getDesign(fileKey, nodeId, version));
  return { state, analysis, fileKey, ctx: contextFor(analysis, state.stack, dir, designSlug) };
}

async function indexDesign({ url, projectDir, stack }) {
  requireProject(projectDir);
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const state = await loadState(projectDir);
  const resolved = stack ? parseStack(stack, projectDir) : state.stack ?? detectStack(projectDir);
  if (!resolved) {
    throw new Error('Could not detect the tech stack. Ask the user for it, then call figma_index again with stack, for example "react+tailwind", "vue", or "flutter".');
  }
  const version = await fetchVersion(fileKey);
  const design = await getDesign(fileKey, nodeId, version);
  const analysis = analyze(design);
  const rootName = design.document.name || design.name;
  const designSlug = slug(rootName) || 'design';
  const dir = `${resolved.root}/${designSlug}`;
  state.stack = resolved;
  state.current = { fileKey, nodeId, version: design.version, dir, slug: designSlug, name: rootName, rawBytes: design.rawBytes };
  state.written ??= {};
  await writeGenerated(projectDir, state, tokensFile(analysis.tokens, resolved, dir).rel, tokensFile(analysis.tokens, resolved, dir).content);
  await saveState(projectDir, state);
  return {
    design: rootName,
    stack: resolved.styling ? `${resolved.label}+${resolved.styling}` : `${resolved.label} (spec files, agent writes code)`,
    dir,
    chunks: analysis.chunks.map((c) => ({ id: c.id, name: c.name, nodes: c.nodes, ...(c.repeat > 1 ? { repeat: c.repeat } : {}) })),
    assets: analysis.assets.length,
    tokens: analysis.tokens.length,
  };
}

async function writeChunks({ projectDir, ids }) {
  const { state, analysis, ctx } = await current(projectDir);
  const known = new Map(analysis.chunks.map((c) => [c.id, c]));
  const unknown = (ids ?? []).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown chunk ids: ${unknown.join(', ')}. Call figma_index for the current list.`);
  const selected = ids?.length ? ids.map((id) => known.get(id)) : analysis.chunks;
  const skipped = [];
  const results = [];
  const writeAll = async (files) => {
    for (const f of files) {
      const r = await writeGenerated(projectDir, state, f.rel, f.content);
      if (r.skipped) skipped.push(f.rel);
    }
  };
  for (const chunk of selected) {
    const files = emitChunk(chunk, ctx);
    await writeAll(files);
    const out = { id: chunk.id, file: files[0].rel, lines: files[0].content.split('\n').length, assets: chunk.assets.length };
    if (chunk.warnings.length) out.warnings = capWarnings(chunk.warnings);
    results.push(out);
  }
  const pageFiles = emitChunk(analysis.page, ctx);
  await writeAll(pageFiles);
  await saveState(projectDir, state);
  return {
    page: pageFiles[0].rel,
    chunks: results,
    ...(skipped.length ? { skipped, skippedReason: 'Changed since generation, so left as is. Delete a file to regenerate it.' } : {}),
  };
}

async function downloadAssets({ projectDir, ids }) {
  const { state, analysis, fileKey } = await current(projectDir);
  const known = new Map(analysis.assets.map((a) => [a.id, a]));
  const unknown = (ids ?? []).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown asset ids: ${unknown.join(', ')}.`);
  const selected = ids?.length ? ids.map((id) => known.get(id)) : analysis.assets;
  const relOf = (a) => `${state.stack.assets}/${a.file}`;
  // Image fills are named by content hash, so an existing file is always current. SVGs change with the file version.
  const { version } = state.current;
  const needed = selected.filter((a) => !fileExists(projectDir, relOf(a)) || (a.kind === 'svg' && state.assetsVersion !== version));
  const svgIds = needed.filter((a) => a.kind === 'svg').map((a) => a.source);
  const svg = svgIds.length ? await svgUrls(fileKey, svgIds) : {};
  const images = needed.some((a) => a.kind === 'image') ? await imageFillUrls(fileKey) : {};
  const failed = [];
  const skipped = [];
  let written = 0;
  for (const a of needed) {
    try {
      const bytes = await fetchBytes(a.kind === 'svg' ? svg[a.source] : images[a.source]);
      const r = await writeGenerated(projectDir, state, relOf(a), bytes);
      if (r.skipped) skipped.push(a.id);
      else written += 1;
    } catch (e) {
      failed.push({ id: a.id, error: e.message });
    }
  }
  if (!failed.length) state.assetsVersion = version;
  await saveState(projectDir, state);
  return { dir: state.stack.assets, total: selected.length, written, alreadyPresent: selected.length - needed.length, ...(skipped.length ? { skipped } : {}), ...(failed.length ? { failed } : {}) };
}

export const figmaIndex = (args) => tracked('figma_index', args, indexDesign);
export const figmaChunk = (args) => tracked('figma_chunk', args, writeChunks);
export const figmaAssets = (args) => tracked('figma_assets', args, downloadAssets);
