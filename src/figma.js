import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'https://api.figma.com';
// Every Figma request and cache hit, so tools can report what each step cost.
export const apiLog = [];
const tierOf = (path) => (/\/meta$/.test(path) ? 3 : /^\/v1\/files\/[^/]+\/images$/.test(path) ? 2 : 1);
const labelOf = (path) => `GET ${path.replace(/^\/v1\/(files|images)\/[^/]+/, '/v1/$1/:key')}`;

const cacheDir = () => process.env.FIGMA2UI_CACHE || join(homedir(), '.cache', 'figma2ui');

export function parseFigmaUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (u.pathname.startsWith('/make/')) {
    throw new Error('Figma Make links are not supported, because the Figma REST API cannot read Make files. Put the design in a Figma Design file and share a link to its frame.');
  }
  const m = u.pathname.match(/^\/(?:design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (u.protocol !== 'https:' || !/^(www\.)?figma\.com$/.test(u.hostname) || !m) {
    throw new Error(`Not a Figma design link: ${url}`);
  }
  const nodeId = u.searchParams.get('node-id');
  return { fileKey: m[2] || m[1], nodeId: nodeId ? nodeId.replace('-', ':') : null };
}

async function api(path, retries = 3) {
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error('FIGMA_TOKEN is not set. Add a Figma personal access token to this MCP server\'s env.');
  const bare = path.split('?')[0];
  let res;
  try {
    res = await fetch(API + path, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    apiLog.push({ call: labelOf(bare), tier: tierOf(bare), status: 'network error' });
    throw e;
  }
  apiLog.push({ call: labelOf(bare), tier: tierOf(bare), status: res.status });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after')) || 5;
    if (retries === 0 || wait > 60) {
      const seat = res.headers.get('x-figma-rate-limit-type') === 'low' ? ' View and Collab seats have a small monthly quota; Dev and Full seats have per-minute limits.' : '';
      throw new Error(`Figma rate limit reached. Retry in ${wait < 3600 ? `${wait} seconds` : `about ${Math.ceil(wait / 3600)} hours`}.${seat}`);
    }
    await sleep(wait * 1000);
    return api(path, retries - 1);
  }
  if (res.status === 403) throw Object.assign(new Error('Figma returned 403. FIGMA_TOKEN is invalid or cannot read this file.'), { status: 403 });
  if (res.status === 404) throw new Error('Figma returned 404. Check the file link.');
  if (!res.ok) throw new Error(`Figma API error ${res.status}.`);
  return res;
}

// The meta endpoint has a far higher limit than file reads. A token without its scope skips the check and downloads once.
export async function fetchVersion(fileKey) {
  try {
    return (await (await api(`/v1/files/${fileKey}/meta`)).json()).file?.version ?? null;
  } catch (e) {
    if (e.status === 403) return null;
    throw e;
  }
}

async function download(fileKey, nodeId) {
  const path = nodeId ? `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}` : `/v1/files/${fileKey}`;
  const text = await (await api(path)).text();
  const raw = JSON.parse(text);
  const entry = nodeId ? raw.nodes?.[nodeId] : { document: raw.document?.children?.[0], styles: raw.styles };
  if (!entry?.document) throw new Error(`Node ${nodeId ?? '(first page)'} was not found in this file.`);
  return { name: raw.name, version: raw.version, document: entry.document, styles: entry.styles ?? {}, rawBytes: text.length };
}

export async function getDesign(fileKey, nodeId, version) {
  const fileFor = (v) => join(cacheDir(), `${`${fileKey}-${nodeId ?? 'page'}-${v}`.replace(/[^A-Za-z0-9-]/g, '-')}.json`);
  if (version) {
    try {
      const cached = JSON.parse(await readFile(fileFor(version), 'utf8'));
      apiLog.push({ call: 'design cache', tier: null, status: 'hit' });
      return cached;
    } catch {
      // Missing or corrupt cache: download again.
    }
  }
  const design = await download(fileKey, nodeId);
  if (version) design.version = version;
  const file = fileFor(design.version);
  await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, JSON.stringify(design), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return design;
}

export async function svgUrls(fileKey, nodeIds) {
  const urls = {};
  for (let i = 0; i < nodeIds.length; i += 100) {
    const ids = encodeURIComponent(nodeIds.slice(i, i + 100).join(','));
    Object.assign(urls, (await (await api(`/v1/images/${fileKey}?ids=${ids}&format=svg`)).json()).images);
  }
  return urls;
}

export const imageFillUrls = async (fileKey) =>
  (await (await api(`/v1/files/${fileKey}/images`)).json()).meta?.images ?? {};

// Asset URLs are presigned, so the Figma token must not be sent with them.
export async function fetchBytes(url) {
  if (!url?.startsWith('https://')) throw new Error('Figma returned no usable download URL.');
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  // The presigned URL carries a signature, so it is never logged.
  apiLog.push({ call: 'asset download (CDN)', tier: null, status: res.status });
  if (!res.ok) throw new Error(`Download failed with ${res.status}.`);
  return Buffer.from(await res.arrayBuffer());
}
