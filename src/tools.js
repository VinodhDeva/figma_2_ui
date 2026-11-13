import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyze } from './chunk.js';
import { contextFor, emitChunk, tokensFile } from './emit.js';
import { cacheAsset, fetchBytes, fetchVersion, getDesign, imageFillUrls, parseFigmaUrl, readCachedAsset, svgUrls } from './figma.js';
import { slug } from './names.js';
import { fileExists, loadState, requireProject, saveState, writeGenerated } from './project.js';
import { detectStack, parseStack } from './stack.js';
import { libraryStatus, uiLibrary } from './library.js';
import { tracked } from './usage.js';

const MAX_WARNINGS = 5;

function capWarnings(warnings) {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS), `+${warnings.length - MAX_WARNINGS} more`];
}

const withLibrary = (library) => (library ? { uiLibrary: libraryStatus(library) } : {});

async function current(projectDir) {
  requireProject(projectDir);
  const state = await loadState(projectDir);
  if (!state.current || !state.stack) throw new Error('No design is indexed for this project. Call figma_index first.');
  const { fileKey, nodeId, version, dir, slug: designSlug } = state.current;
  const analysis = analyze(await getDesign(fileKey, nodeId, version), state.stack.assetUrl);
  const library = uiLibrary(projectDir, state.stack.framework);
  return { state, analysis, fileKey, ctx: contextFor(analysis, state.stack, dir, designSlug, library) };
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
  const analysis = analyze(design, resolved.assetUrl);
  const rootName = design.document.name || design.name;
  const designSlug = slug(rootName) || 'design';
  const dir = `${resolved.root}/${designSlug}`;
  state.stack = resolved;
  state.current = { fileKey, nodeId, version: design.version, dir, slug: designSlug, name: rootName, rawBytes: design.rawBytes };
  state.written ??= {};
  const tokens = tokensFile(analysis.tokens, resolved, dir, designSlug);
  await writeGenerated(projectDir, state, tokens.rel, tokens.content);
  await saveState(projectDir, state);
  return {
    design: rootName,
    stack: resolved.styling ? `${resolved.label}+${resolved.styling}` : `${resolved.label} (spec files, agent writes code)`,
    dir,
    chunks: analysis.chunks.map((c) => ({ id: c.id, name: c.name, nodes: c.nodes, ...(c.repeat > 1 ? { repeat: c.repeat } : {}) })),
    assets: analysis.assets.length,
    tokens: analysis.tokens.length,
    fonts: analysis.fonts,
    ...withLibrary(uiLibrary(projectDir, resolved.framework)),
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
  await writeAll([...pageFiles, tokensFile(analysis.tokens, ctx.stack, ctx.dir, ctx.slug)]);
  await saveState(projectDir, state);
  return {
    page: pageFiles[0].rel,
    ...(ctx.library && !ctx.library.used ? withLibrary(ctx.library) : {}),
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
  // Images are named by Figma's content hash and icons by a fingerprint of their look, so an existing file is always current.
  const missing = selected.filter((a) => !fileExists(projectDir, relOf(a)));
  const cached = [];
  const needed = [];
  // One-time migration: icons used to be named by node id. Reusing those files spares a render call.
  const legacy = (a) => `${state.stack.assets}/svg-${a.source.replace(/[^A-Za-z0-9]+/g, '-')}.svg`;
  for (const a of missing) {
    let bytes = await readCachedAsset(a.file);
    if (!bytes && a.kind === 'svg' && fileExists(projectDir, legacy(a))) bytes = await readFile(resolve(projectDir, legacy(a)));
    if (bytes) cached.push([a, bytes]);
    else needed.push(a);
  }
  const svgIds = needed.filter((a) => a.kind === 'svg').map((a) => a.source);
  const svg = svgIds.length ? await svgUrls(fileKey, svgIds) : {};
  const images = needed.some((a) => a.kind === 'image') ? await imageFillUrls(fileKey) : {};
  const failed = [];
  const skipped = [];
  let written = 0;
  const save = async (a, bytes) => {
    const r = await writeGenerated(projectDir, state, relOf(a), bytes);
    if (r.skipped) skipped.push(a.id);
    else written += 1;
  };
  for (const [a, bytes] of cached) await save(a, bytes);
  for (const a of needed) {
    try {
      const bytes = await fetchBytes(a.kind === 'svg' ? svg[a.source] : images[a.source]);
      await cacheAsset(a.file, bytes);
      await save(a, bytes);
    } catch (e) {
      failed.push({ id: a.id, error: e.message });
    }
  }
  await saveState(projectDir, state);
  return {
    dir: state.stack.assets,
    total: selected.length,
    written,
    alreadyPresent: selected.length - missing.length,
    ...(cached.length ? { fromCache: cached.length } : {}),
    ...(skipped.length ? { skipped } : {}),
    ...(failed.length ? { failed } : {}),
  };
}

export const figmaIndex = (args) => tracked('figma_index', args, indexDesign);
export const figmaChunk = (args) => tracked('figma_chunk', args, writeChunks);
export const figmaAssets = (args) => tracked('figma_assets', args, downloadAssets);

// Code mode: the whole index, chunk and assets workflow runs here as code, so the AI makes one call
// and reads one merged summary instead of three results.
async function build({ url, projectDir, stack }) {
  const index = await indexDesign({ url, projectDir, stack });
  const written = await writeChunks({ projectDir });
  let assets;
  try {
    const a = await downloadAssets({ projectDir });
    assets = { total: a.total, written: a.written, ...(a.failed ? { failed: a.failed.length } : {}) };
  } catch (e) {
    // The code is already on disk, so an asset problem (such as a rate limit) is reported, not thrown.
    assets = { error: e.message };
  }
  const files = new Map(written.chunks.map((c) => [c.id, c]));
  return {
    design: index.design,
    stack: index.stack,
    fonts: index.fonts,
    ...(index.uiLibrary ? { uiLibrary: index.uiLibrary } : {}),
    page: written.page,
    chunks: index.chunks.map(({ id, name, repeat }) => {
      const { file, warnings } = files.get(id);
      return { id, name, file, ...(repeat ? { repeat } : {}), ...(warnings ? { warnings } : {}) };
    }),
    assets,
    ...(written.skipped ? { skipped: written.skipped, skippedReason: written.skippedReason } : {}),
  };
}

export const figmaBuild = (args) => tracked('figma_build', args, build);
