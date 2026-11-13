import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const STATE = '.figma2ui.json';
const ALLOWED = ['src/figma', 'src/assets/figma', 'public/figma', 'static/figma', 'figma2ui'];

export function requireProject(projectDir) {
  if (!isAbsolute(projectDir)) throw new Error('projectDir must be an absolute path.');
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) throw new Error(`projectDir does not exist: ${projectDir}`);
}

export async function loadState(projectDir) {
  try {
    return JSON.parse(await readFile(join(projectDir, STATE), 'utf8'));
  } catch {
    return { written: {} };
  }
}

export const saveState = (projectDir, state) => writeFile(join(projectDir, STATE), `${JSON.stringify(state, null, 2)}\n`);

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
};

async function safePath(projectDir, rel) {
  const target = resolve(projectDir, rel);
  const area = ALLOWED.map((a) => resolve(projectDir, a)).find((a) => inside(a, target));
  if (!area) throw new Error(`Refusing to write outside the output folders: ${rel}`);
  await mkdir(dirname(target), { recursive: true });
  // A symlinked output folder could otherwise redirect writes out of the project.
  const realDir = await realpath(dirname(target));
  const realRoot = await realpath(projectDir);
  if (realDir !== join(realRoot, relative(projectDir, dirname(target)))) throw new Error(`Refusing to write through a symlink: ${rel}`);
  return target;
}

const sha = (data) => createHash('sha256').update(data).digest('hex');

// Overwrites only a file this tool wrote and nobody has changed since, so edits are never lost.
export async function writeGenerated(projectDir, state, rel, content) {
  const target = await safePath(projectDir, rel);
  const newHash = sha(content);
  if (existsSync(target)) {
    const current = sha(await readFile(target));
    if (current !== newHash && current !== state.written[rel]) return { rel, skipped: true };
  }
  await writeFile(`${target}.tmp`, content);
  await rename(`${target}.tmp`, target);
  state.written[rel] = newHash;
  return { rel, skipped: false };
}

export const fileExists = (projectDir, rel) => existsSync(resolve(projectDir, rel));
