import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { analyze, CHUNK_LIMIT } from '../src/chunk.js';
import { esc, twClass } from '../src/emit.js';
import { parseFigmaUrl } from '../src/figma.js';
import { writeGenerated } from '../src/project.js';
import { detectStack, parseStack } from '../src/stack.js';
import { figmaAssets, figmaBuild, figmaChunk, figmaIndex } from '../src/tools.js';
import { auto, design, flat, landing, text, vector } from './fixture.js';

const temp = () => mkdtempSync(join(tmpdir(), 'figma2ui-'));
const URL_ = 'https://www.figma.com/design/KEY123/My-File?node-id=1-2';
const project = (pkg) => {
  const dir = temp();
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: pkg }));
  return dir;
};

function mockFigma(document) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.endsWith('/meta')) return json({ file: { version: '7' } });
    if (url.includes('/nodes?')) return json({ name: 'File', version: '7', nodes: { '1:2': { document, styles: {} } } });
    if (url.includes('/v1/images/')) {
      const ids = decodeURIComponent(new URL(url).searchParams.get('ids')).split(',');
      return json({ images: Object.fromEntries(ids.map((i) => [i, 'https://cdn.test/svg'])) });
    }
    if (url.endsWith('/images')) return json({ meta: { images: { aaa: 'https://cdn.test/a', bbb: 'https://cdn.test/b', ccc: 'https://cdn.test/c' } } });
    return new Response('BYTES');
  };
  return calls;
}

beforeEach(() => {
  process.env.FIGMA_TOKEN = 'test';
  process.env.FIGMA2UI_CACHE = temp();
});

test('parses design, file, and branch links', () => {
  assert.deepEqual(parseFigmaUrl(URL_), { fileKey: 'KEY123', nodeId: '1:2' });
  assert.equal(parseFigmaUrl('https://figma.com/file/ABC/x').nodeId, null);
  assert.equal(parseFigmaUrl('https://figma.com/design/ABC/branch/BR/x').fileKey, 'BR');
  assert.throws(() => parseFigmaUrl('https://evil.com/design/ABC'), /Not a Figma/);
  assert.throws(() => parseFigmaUrl('https://www.figma.com/make/ABC/x'), /Make links are not supported/);
});

test('auto-layout maps to flex and hidden nodes are dropped', () => {
  const { page, chunks } = analyze(design(landing()));
  assert.equal(page.el.css['max-width'], '1440px');
  assert.equal(page.el.css.display, 'flex');
  const header = chunks.find((c) => c.name === 'Header');
  assert.equal(header.el.css['justify-content'], 'space-between');
  assert.equal(header.el.css.gap, undefined);
  assert.equal(JSON.stringify(page.el).includes('nope'), false);
});

test('frames without auto-layout become absolute with a warning', () => {
  const { chunks } = analyze(design(landing()));
  const free = chunks.find((c) => c.name === 'Evil');
  assert.equal(free.el.css.position, 'relative');
  assert.equal(free.el.children[0].css.left, '10px');
  assert.ok(free.warnings.some((w) => w.includes('absolute')));
});

test('repeats become one chunk with props for differing content', () => {
  const { chunks } = analyze(design(landing()));
  const c = chunks.find((x) => x.name === 'Card');
  assert.equal(c.repeat, 3);
  assert.deepEqual(c.props, ['photoSrc', 'titleText']);
  assert.equal(chunks.filter((x) => x.name.startsWith('Card') && x.name !== 'Cards').length, 1);
});

test('repeated lists dedupe the item, not the whole list', () => {
  const list = (s) => auto('List', 'VERTICAL', Array.from({ length: 8 }, (_, i) => auto('Row', 'HORIZONTAL', [text('A', `${s}a${i}`), text('B', `${s}b${i}`)])));
  const { chunks } = analyze(design(auto('Root', 'VERTICAL', [list('x'), list('y')])));
  const row = chunks.find((c) => c.name === 'Row');
  assert.equal(row.repeat, 16);
  assert.deepEqual(row.props, ['aText', 'bText']);
});

test('Make code layers fail clearly at the root and warn when nested', () => {
  const code = { id: '9:1', type: 'CODE_INSTANCE', name: 'Embed', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } };
  assert.throws(() => analyze(design(code)), /no design layers/);
  assert.ok(analyze(design(auto('Root', 'VERTICAL', [code]))).page.warnings.some((w) => w.includes('code layer')));
});

test('big sections split under the limit', () => {
  const sections = Array.from({ length: 4 }, (_, i) => auto(`Row${i}`, 'VERTICAL', Array.from({ length: 60 }, (_, j) => text(`T${j}`, `Unique ${i}`, 10 + j))));
  const { chunks } = analyze(design(auto('Root', 'VERTICAL', [auto('Big', 'VERTICAL', sections)])));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.nodes <= CHUNK_LIMIT));
});

test('flat frame over the limit still generates and warns', () => {
  const { chunks } = analyze(design(flat(200)));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].warnings.some((w) => w.includes('limit')));
});

test('detects stacks from project files', () => {
  assert.equal(detectStack(project({ next: '1', tailwindcss: '4' })).styling, 'tailwind');
  assert.equal(detectStack(project({ vue: '3' })).framework, 'vue');
  assert.equal(detectStack(project({ '@sveltejs/kit': '2' })).assets, 'static/figma');
  assert.equal(detectStack(project({ 'react-native': '1' })).framework, 'other');
  const flutter = temp();
  writeFileSync(join(flutter, 'pubspec.yaml'), '');
  assert.equal(detectStack(flutter).label, 'flutter');
  assert.equal(detectStack(temp()), null);
  assert.equal(parseStack('nuxt+tailwind', temp()).framework, 'vue');
  assert.throws(() => parseStack('react+foo', temp()), /Unknown styling/);
});

test('escape covers every template syntax', () => {
  assert.equal(esc('{a}<@`\\'), '&#123;a&#125;&#60;&#64;&#96;&#92;');
});

test('tailwind classes use type hints', () => {
  assert.equal(twClass('color', 'var(--c)'), 'text-[color:var(--c)]');
  assert.equal(twClass('font-size', 'var(--s)'), 'text-[length:var(--s)]');
  assert.equal(twClass('padding', '1px 2px'), 'p-[1px_2px]');
  assert.equal(twClass('box-shadow', '0px 1px red'), '[box-shadow:0px_1px_red]');
});

const CARD_CHECK = {
  react: ['Card.jsx', 'titleText}'], vue: ['Card.vue', '{{ titleText }}'], svelte: ['Card.svelte', '{titleText}'], angular: ['Card.component.ts', '{{ titleText }}'],
};

for (const [framework, [file, marker]] of Object.entries(CARD_CHECK)) {
  test(`full flow generates ${framework} with props and escaped text`, async () => {
    mockFigma(landing());
    const dep = { react: 'react', vue: 'vue', svelte: 'svelte', angular: '@angular/core' }[framework];
    const dir = project({ [dep]: '1', tailwindcss: '4' });
    const index = await figmaIndex({ url: URL_, projectDir: dir });
    assert.equal(index.stack, `${framework}+tailwind`);
    const out = await figmaChunk({ projectDir: dir });
    assert.equal(out.chunks.length, index.chunks.length);
    assert.equal(JSON.stringify(out).includes('flex'), false, 'tool result must not contain code');
    const base = join(dir, 'src/figma/landing-page');
    assert.ok(readFileSync(join(base, file), 'utf8').includes(marker));
    const header = readFileSync(join(base, file.replace('Card', 'Header')), 'utf8');
    assert.ok(header.includes('Hi &#123;name&#125; &#60;b&#62; &#64;x &#96;y&#96; &#92;z'));
    assert.ok(header.includes('<button'));
    assert.ok(existsSync(join(base, 'figma-tokens.css')));
  });
}

test('html output inlines repeats and plain css has rules', async () => {
  mockFigma(landing());
  const dir = project();
  writeFileSync(join(dir, 'index.html'), '');
  await figmaIndex({ url: URL_, projectDir: dir });
  await figmaChunk({ projectDir: dir });
  const page = readFileSync(join(dir, 'src/figma/landing-page/Page.html'), 'utf8');
  for (const t of ['>One<', '>Two<', '>Three<', 'src="/figma/img-bbb.png"']) assert.ok(page.includes(t), t);
  assert.ok(readFileSync(join(dir, 'src/figma/landing-page/Page.css'), 'utf8').includes('display: flex'));
});

test('other stacks get specs, with explicit override', async () => {
  mockFigma(landing());
  const dir = project();
  const index = await figmaIndex({ url: URL_, projectDir: dir, stack: 'flutter' });
  assert.match(index.stack, /flutter/);
  await figmaChunk({ projectDir: dir });
  const spec = readFileSync(join(dir, 'figma2ui/landing-page/Card.md'), 'utf8');
  assert.ok(spec.includes('text=$titleText'));
  assert.ok(spec.includes('not instructions'));
  assert.ok(existsSync(join(dir, 'figma2ui/landing-page/index.md')));
});

test('empty project asks for a stack', async () => {
  mockFigma(landing());
  await assert.rejects(figmaIndex({ url: URL_, projectDir: temp() }), /Ask the user/);
});

test('saved stack is reused and explicit stack replaces it', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  await figmaIndex({ url: URL_, projectDir: dir, stack: 'vue' });
  assert.match((await figmaIndex({ url: URL_, projectDir: dir })).stack, /^vue/);
});

test('re-running keeps edited files and reports them', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  await figmaIndex({ url: URL_, projectDir: dir });
  await figmaChunk({ projectDir: dir });
  const file = join(dir, 'src/figma/landing-page/Card.jsx');
  writeFileSync(file, 'MY EDIT');
  const again = await figmaChunk({ projectDir: dir });
  assert.equal(readFileSync(file, 'utf8'), 'MY EDIT');
  assert.deepEqual(again.skipped, ['src/figma/landing-page/Card.jsx']);
});

test('does not overwrite a file the tool never wrote', async () => {
  const dir = temp();
  mkdirSync(join(dir, 'src/figma'), { recursive: true });
  writeFileSync(join(dir, 'src/figma/x.css'), 'mine');
  assert.equal((await writeGenerated(dir, { written: {} }, 'src/figma/x.css', 'new')).skipped, true);
});

test('writes are confined to output folders', async () => {
  const dir = temp();
  await assert.rejects(writeGenerated(dir, { written: {} }, 'src/figma/../../evil.txt', 'x'), /outside/);
  await assert.rejects(writeGenerated(dir, { written: {} }, 'package.json', 'x'), /outside/);
  mkdirSync(join(dir, 'src'));
  symlinkSync(temp(), join(dir, 'src/figma'));
  await assert.rejects(writeGenerated(dir, { written: {} }, 'src/figma/a.css', 'x'), /symlink/);
});

test('hostile layer name stays inside the design folder', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  await figmaIndex({ url: URL_, projectDir: dir });
  const out = await figmaChunk({ projectDir: dir });
  assert.ok(out.chunks.every((c) => c.file.startsWith('src/figma/landing-page/') && !c.file.includes('..')));
});

test('assets download once, and the token is not sent to the CDN', async () => {
  const calls = mockFigma(landing());
  const seen = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (u, o) => { seen.push([String(u), o?.headers]); return inner(u, o); };
  const dir = project({ react: '1' });
  await figmaIndex({ url: URL_, projectDir: dir });
  const first = await figmaAssets({ projectDir: dir });
  assert.equal(first.written, 4);
  assert.equal(readFileSync(join(dir, 'public/figma/img-aaa.png'), 'utf8'), 'BYTES');
  assert.ok(seen.filter(([u]) => u.startsWith('https://cdn.test')).every(([, h]) => !h));
  const second = await figmaAssets({ projectDir: dir });
  assert.equal(second.alreadyPresent, 4);
  assert.equal(calls.filter((c) => c.includes('/v1/images/')).length, 1);
});

test('token without the meta scope still works with one download', async () => {
  const calls = mockFigma(landing());
  const inner = globalThis.fetch;
  globalThis.fetch = (u, o) => (u.endsWith('/meta') ? Promise.resolve(new Response('{}', { status: 403 })) : inner(u, o));
  const dir = project({ react: '1' });
  await figmaIndex({ url: URL_, projectDir: dir });
  await figmaChunk({ projectDir: dir });
  assert.equal(calls.filter((c) => c.includes('/nodes?')).length, 1);
});

test('long rate limits fail at once with a readable wait', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 429, headers: { 'retry-after': '188594', 'x-figma-rate-limit-type': 'low' } });
  await assert.rejects(figmaIndex({ url: URL_, projectDir: project({ react: '1' }) }), /about 53 hours.*View and Collab/);
});

test('second index uses the cache', async () => {
  const calls = mockFigma(landing());
  const dir = project({ react: '1' });
  await figmaIndex({ url: URL_, projectDir: dir });
  await figmaIndex({ url: URL_, projectDir: dir });
  assert.equal(calls.filter((c) => c.includes('/nodes?')).length, 1);
});

test('clear errors for missing token, unknown id, no index', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  await assert.rejects(figmaChunk({ projectDir: dir }), /figma_index first/);
  await figmaIndex({ url: URL_, projectDir: dir });
  await assert.rejects(figmaChunk({ projectDir: dir, ids: ['zzz'] }), /Unknown chunk/);
  delete process.env.FIGMA_TOKEN;
  await assert.rejects(figmaIndex({ url: URL_, projectDir: dir }), /FIGMA_TOKEN/);
  await assert.rejects(figmaIndex({ url: URL_, projectDir: 'relative/path' }), /absolute/);
});

test('usage report counts Figma calls and tokens per step', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  const index = await figmaIndex({ url: URL_, projectDir: dir });
  assert.equal(index.usage.figmaApiCalls, 2);
  const chunk = await figmaChunk({ projectDir: dir });
  assert.equal(chunk.usage.figmaApiCalls, 0);
  const assets = await figmaAssets({ projectDir: dir });
  assert.equal(assets.usage.figmaApiCalls, 2);
  assert.deepEqual({ ...assets.usage.designTotal, tokens: 0 }, { figmaApiCalls: 4, tier1: 2, tokens: 0 });
  assert.ok(assets.usage.designTotal.tokens > assets.usage.tokens);
  const report = readFileSync(join(dir, 'figma2ui/usage-report.md'), 'utf8');
  for (const t of [
    '**Landing Page**, Figma file version 7',
    '| MCP tool calls | 3 |',
    '| Figma API calls | 4 (Tier 1: 2, Tier 2: 1, Tier 3: 1) |',
    '| Cache hits (design and assets) | 2 |',
    "| Asset downloads from Figma's CDN | 4 |",
    '| `GET /v1/files/:key/nodes` | 1 | 200 | 1 |',
  ]) assert.ok(report.includes(t), t);
  assert.ok(!report.includes('cdn.test') && !report.includes('KEY123'), 'no signed URLs or file keys in the report');
});

test('failed steps are still counted and reported', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 429, headers: { 'retry-after': '188594' } });
  const dir = project({ react: '1' });
  await assert.rejects(figmaIndex({ url: URL_, projectDir: dir }), /Figma API calls in this step: 1\. Report: figma2ui\/usage-report\.md/);
  const report = readFileSync(join(dir, 'figma2ui/usage-report.md'), 'utf8');
  assert.ok(report.includes('| `GET /v1/files/:key/meta` | 3 | 429 | 1 |'));
  assert.ok(report.includes('failed: Figma rate limit'));
});

test('text keeps Figma line height and does not wrap when auto-width', () => {
  const t = { ...text('T', 'Hello'), style: { fontSize: 13, lineHeightPx: 15.73, lineHeightUnit: 'INTRINSIC_%', textAutoResize: 'WIDTH_AND_HEIGHT' } };
  const { page } = analyze(design(auto('Root', 'VERTICAL', [t])));
  assert.equal(page.el.children[0].css['line-height'], '15.73px');
  assert.equal(page.el.children[0].css['white-space'], 'nowrap');
});

test('ellipse arcs become SVG ring segments', () => {
  const arc = { id: '5:1', type: 'ELLIPSE', name: 'Enterprise', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, fills: [{ type: 'SOLID', color: { r: 0.4, g: 0.2, b: 0.8, a: 1 } }], arcData: { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0.5 } };
  const { page } = analyze(design(auto('Root', 'VERTICAL', [arc])));
  const svg = page.el.children[0];
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.attrs.viewBox, '0 0 100 100');
  assert.equal(svg.children[0].attrs.d, 'M100 50 A50 50 0 0 1 50 100 L50 75 A25 25 0 0 0 75 50 Z');
  assert.ok(svg.children[0].css.fill.startsWith('var(--color-'));
  assert.equal(svg.css['border-radius'], undefined);
});

test('plain CSS output resets browser defaults, Tailwind output does not', async () => {
  mockFigma(landing());
  const css = project({ react: '1' });
  await figmaIndex({ url: URL_, projectDir: css });
  assert.ok(readFileSync(join(css, 'src/figma/landing-page/figma-tokens.css'), 'utf8').includes(':where([class^="landing-page-"])'));
  const tw = project({ react: '1', tailwindcss: '4' });
  await figmaIndex({ url: URL_, projectDir: tw });
  assert.ok(!readFileSync(join(tw, 'src/figma/landing-page/figma-tokens.css'), 'utf8').includes(':where'));
});

test('code mode builds everything in one call with one merged result', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  const out = await figmaBuild({ url: URL_, projectDir: dir });
  assert.equal(out.page, 'src/figma/landing-page/Page.jsx');
  const card = out.chunks.find((c) => c.name === 'Card');
  assert.equal(card.file, 'src/figma/landing-page/Card.jsx');
  assert.equal(card.repeat, 3);
  assert.deepEqual(out.assets, { total: 4, written: 4 });
  assert.equal(out.usage.figmaApiCalls, 4);
  assert.ok(existsSync(join(dir, 'public/figma/img-aaa.png')));
  assert.equal(JSON.stringify(out).includes('flex'), false, 'no code in the result');
  const state = JSON.parse(readFileSync(join(dir, '.figma2ui.json'), 'utf8'));
  assert.deepEqual(state.usage.map((e) => e.tool), ['figma_build']);
});

test('code mode keeps the generated code when assets fail', async () => {
  mockFigma(landing());
  const inner = globalThis.fetch;
  globalThis.fetch = (u, o) => (String(u).includes('/v1/images/') ? Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '9999' } })) : inner(u, o));
  const dir = project({ react: '1' });
  const out = await figmaBuild({ url: URL_, projectDir: dir });
  assert.match(out.assets.error, /rate limit/);
  assert.ok(existsSync(join(dir, 'src/figma/landing-page/Page.jsx')));
});

test('icons are named by content, so copies share a file and moved or renamed icons keep it', () => {
  const at = (name, x, y, extra = {}) => ({ ...vector(name), absoluteBoundingBox: { x, y, width: 24, height: 24 }, ...extra });
  const red = { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] };
  const icons = (list) => analyze(design(auto('Root', 'HORIZONTAL', list))).assets.filter((a) => a.kind === 'svg').map((a) => a.file);
  const [first] = icons([at('Bell', 0, 0)]);
  assert.deepEqual(icons([at('Alarm', 300, 40)]), [first]);
  assert.equal(icons([at('A', 0, 0), at('B', 50, 0), at('C', 0, 0, red)]).length, 2);
  assert.notEqual(icons([at('Bell', 0, 0, { fillGeometry: [{ path: 'M0 0 L1 1' }] })])[0], first);
});

test('a new file version re-renders no unchanged icons, and other projects reuse the asset cache', async () => {
  const calls = mockFigma(landing());
  const renders = () => calls.filter((c) => c.includes('/v1/images/')).length;
  const dir = project({ react: '1' });
  await figmaBuild({ url: URL_, projectDir: dir });
  assert.equal(renders(), 1);
  const inner = globalThis.fetch;
  globalThis.fetch = (u, o) => (String(u).endsWith('/meta') ? Promise.resolve(new Response(JSON.stringify({ file: { version: '8' } }))) : inner(u, o));
  await figmaBuild({ url: URL_, projectDir: dir });
  assert.equal(renders(), 1, 'no icon re-render after a version change');
  const other = project({ react: '1' });
  const out = await figmaAssets({ projectDir: other }).catch(() => null);
  assert.equal(out, null, 'figma_assets still needs figma_index first');
  await figmaIndex({ url: URL_, projectDir: other });
  const assets = await figmaAssets({ projectDir: other });
  assert.equal(assets.fromCache, 4);
  assert.equal(renders(), 1, 'second project downloads nothing');
  assert.equal(readFileSync(join(other, 'public/figma/img-aaa.png'), 'utf8'), 'BYTES');
});

test('design downloads request vector paths', async () => {
  const calls = mockFigma(landing());
  await figmaIndex({ url: URL_, projectDir: project({ react: '1' }) });
  assert.ok(calls.some((c) => c.includes('/nodes?') && c.includes('geometry=paths')));
});

test('icons saved under old node-id names are reused instead of rendered again', async () => {
  const doc = landing();
  const calls = mockFigma(doc);
  const dir = project({ react: '1' });
  const logo = doc.children[0].children[0].id.replace(/[^A-Za-z0-9]+/g, '-');
  mkdirSync(join(dir, 'public/figma'), { recursive: true });
  writeFileSync(join(dir, `public/figma/svg-${logo}.svg`), '<svg>old</svg>');
  await figmaIndex({ url: URL_, projectDir: dir });
  const out = await figmaAssets({ projectDir: dir });
  assert.equal(out.fromCache, 1);
  assert.equal(calls.filter((c) => c.includes('/v1/images/')).length, 0);
});

test('older Angular gets assets in src/assets with matching URLs', async () => {
  mockFigma(landing());
  const dir = project({ '@angular/core': '^16.2.0' });
  assert.equal(detectStack(dir).assets, 'src/assets/figma');
  assert.equal(detectStack(project({ '@angular/core': '^19.0.0' })).assets, 'public/figma');
  await figmaIndex({ url: URL_, projectDir: dir });
  await figmaChunk({ projectDir: dir });
  await figmaAssets({ projectDir: dir });
  assert.ok(existsSync(join(dir, 'src/assets/figma/img-aaa.png')));
  const page = readFileSync(join(dir, 'src/figma/landing-page/Cards.component.ts'), 'utf8');
  assert.ok(page.includes('photoSrc="/assets/figma/img-aaa.png"'), page);
});

test('results list the fonts and weights the app must load', async () => {
  mockFigma(landing());
  const index = await figmaIndex({ url: URL_, projectDir: project({ react: '1' }) });
  assert.deepEqual(index.fonts, ['Inter:400']);
});

const withLibrary = async (name, fn) => {
  process.env.FIGMA2UI_UI_LIBRARY = name;
  try {
    return await fn();
  } finally {
    delete process.env.FIGMA2UI_UI_LIBRARY;
  }
};
const fakeInstall = (dir, ...pkgs) => pkgs.forEach((p) => {
  mkdirSync(join(dir, 'node_modules', p), { recursive: true });
  writeFileSync(join(dir, 'node_modules', p, 'package.json'), '{}');
});

test('configured UI library components replace plain buttons when installed', () => withLibrary('mui', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  fakeInstall(dir, '@mui/material', '@emotion/react', '@emotion/styled');
  const index = await figmaIndex({ url: URL_, projectDir: dir });
  assert.deepEqual(index.uiLibrary, { name: 'mui', used: true });
  const out = await figmaChunk({ projectDir: dir });
  assert.equal(out.uiLibrary, undefined);
  const header = readFileSync(join(dir, 'src/figma/landing-page/Header.jsx'), 'utf8');
  assert.ok(header.startsWith("import { Button } from '@mui/material';"), header);
  assert.ok(header.includes('<Button className=') && !header.includes('<button'));
}));

test('missing UI library fails fast before hitting the Figma API — no quota consumed', () => withLibrary('mui', async () => {
  const calls = mockFigma(landing());
  const dir = project({ react: '1' });
  writeFileSync(join(dir, 'yarn.lock'), '');
  fakeInstall(dir, '@mui/material'); // only one of three peers installed
  const apiBefore = calls.length;
  await assert.rejects(
    figmaIndex({ url: URL_, projectDir: dir }),
    /FIGMA2UI_UI_LIBRARY="mui" is set but @emotion\/react, @emotion\/styled are not installed/
  );
  assert.equal(calls.length, apiBefore, 'no Figma API call was made');
}));

test('missing UI library also blocks figma_chunk — no files written', () => withLibrary('mui', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  // Index succeeds when library is not yet set, then we set it for chunk.
  delete process.env.FIGMA2UI_UI_LIBRARY;
  await figmaIndex({ url: URL_, projectDir: dir });
  process.env.FIGMA2UI_UI_LIBRARY = 'mui'; // set after index, packages still missing
  await assert.rejects(
    figmaChunk({ projectDir: dir }),
    /FIGMA2UI_UI_LIBRARY="mui" is set but @mui\/material, @emotion\/react, @emotion\/styled are not installed/
  );
  // No chunk files should exist yet
  assert.ok(!existsSync(join(dir, 'src/figma/landing-page/Header.jsx')));
}));

test('unsupported UI library name fails fast with actionable message', () => withLibrary('bootstrap', async () => {
  mockFigma(landing());
  const calls = mockFigma(landing());
  const apiBefore = calls.length;
  await assert.rejects(
    figmaIndex({ url: URL_, projectDir: project({ react: '1' }) }),
    /not a supported library.*mui, antd, chakra, mantine/
  );
  assert.equal(calls.length, apiBefore, 'no Figma API call was made');
}));

test('UI library on a non-React stack fails fast with actionable message', () => withLibrary('antd', async () => {
  mockFigma(landing());
  const calls = mockFigma(landing());
  const apiBefore = calls.length;
  await assert.rejects(
    figmaIndex({ url: URL_, projectDir: project({ vue: '3' }) }),
    /only works with React projects.*vue/
  );
  assert.equal(calls.length, apiBefore, 'no Figma API call was made');
}));

test('library components are aliased when a chunk has the same name', () => withLibrary('chakra', async () => {
  const btn = (t) => auto('Button', 'HORIZONTAL', [text('Label', t), text('Hint', `${t}!`)]);
  mockFigma(auto('Toolbar', 'HORIZONTAL', [btn('Save'), btn('Cancel')]));
  const dir = project({ react: '1' });
  fakeInstall(dir, '@chakra-ui/react', '@emotion/react');
  await figmaIndex({ url: URL_, projectDir: dir });
  await figmaChunk({ projectDir: dir });
  const file = readFileSync(join(dir, 'src/figma/toolbar/Button.jsx'), 'utf8');
  assert.ok(file.includes("import { Button as UiButton } from '@chakra-ui/react';"), file);
  assert.ok(file.includes('export function Button(') && file.includes('<UiButton className='));
}));

test('none uses the UI library the project already has installed', () => withLibrary('none', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  fakeInstall(dir, '@mantine/core', '@mantine/hooks');
  const index = await figmaIndex({ url: URL_, projectDir: dir });
  assert.deepEqual(index.uiLibrary, { name: 'mantine', used: true, detected: true });
  await figmaChunk({ projectDir: dir });
  const header = readFileSync(join(dir, 'src/figma/landing-page/Header.jsx'), 'utf8');
  assert.ok(header.startsWith("import { Button } from '@mantine/core';"), header);
}));

test('none with no library installed generates plain elements without an error', () => withLibrary('none', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  fakeInstall(dir, '@mui/material');
  const index = await figmaIndex({ url: URL_, projectDir: dir });
  assert.equal(index.uiLibrary.used, false);
  assert.match(index.uiLibrary.note, /No supported UI library is installed/);
  const out = await figmaChunk({ projectDir: dir });
  assert.match(out.uiLibrary.note, /plain elements/);
  assert.ok(readFileSync(join(dir, 'src/figma/landing-page/Header.jsx'), 'utf8').includes('<button'));
}));

test('none is safe in a global config: non-React projects are not blocked', () => withLibrary('none', async () => {
  mockFigma(landing());
  const index = await figmaIndex({ url: URL_, projectDir: project({ vue: '3' }) });
  assert.match(index.uiLibrary.note, /React projects only/);
}));

test('a missing UI library does not block figma_assets', async () => {
  mockFigma(landing());
  const dir = project({ react: '1' });
  await figmaIndex({ url: URL_, projectDir: dir });
  await withLibrary('mui', async () => {
    await assert.rejects(figmaChunk({ projectDir: dir }), /not installed/);
    const assets = await figmaAssets({ projectDir: dir });
    assert.equal(assets.written, 4);
  });
});
