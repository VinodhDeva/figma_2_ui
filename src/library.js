import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Layers detected as button, input or link become these components. React projects only.
const LIBRARIES = {
  mui: { pkg: '@mui/material', peers: ['@emotion/react', '@emotion/styled'], components: { button: 'Button', input: 'InputBase', a: 'Link' } },
  antd: { pkg: 'antd', peers: [], components: { button: 'Button', input: 'Input' } },
  chakra: { pkg: '@chakra-ui/react', peers: ['@emotion/react'], components: { button: 'Button', input: 'Input', a: 'Link' } },
  mantine: { pkg: '@mantine/core', peers: ['@mantine/hooks'], components: { button: 'Button', input: 'TextInput', a: 'Anchor' } },
};
const ALIASES = { 'material-ui': 'mui', '@mui/material': 'mui', 'ant-design': 'antd', '@chakra-ui/react': 'chakra', '@mantine/core': 'mantine' };

// Node resolves packages from the project folder upwards, so hoisted monorepo installs count too.
function installed(projectDir, pkg) {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function installCommand(projectDir, pkgs) {
  const has = (f) => existsSync(join(projectDir, f));
  const cmd = has('pnpm-lock.yaml') ? 'pnpm add' : has('yarn.lock') ? 'yarn add' : has('bun.lockb') || has('bun.lock') ? 'bun add' : 'npm install';
  return `${cmd} ${pkgs.join(' ')}`;
}

const missingOf = (projectDir, lib) => [lib.pkg, ...lib.peers].filter((p) => !installed(projectDir, p));
const ready = (name) => ({ name, used: true, pkg: LIBRARIES[name].pkg, components: LIBRARIES[name].components });

/**
 * Resolves FIGMA2UI_UI_LIBRARY from the MCP server's env. Returns null when it is not set.
 * - A library name that cannot be used throws, and figma_index calls this before any Figma API
 *   request, so a wrong setup costs no Figma quota.
 * - "none" uses the supported library the project already has installed, or plain elements.
 */
export function uiLibrary(projectDir, framework) {
  const raw = process.env.FIGMA2UI_UI_LIBRARY?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'none') {
    if (framework !== 'react') return { name: 'none', used: false, note: 'UI libraries apply to React projects only, so plain elements were generated.' };
    const found = Object.keys(LIBRARIES).find((n) => !missingOf(projectDir, LIBRARIES[n]).length);
    return found ? { ...ready(found), detected: true } : { name: 'none', used: false, note: 'No supported UI library is installed in the project, so plain elements were generated.' };
  }
  const name = ALIASES[raw] ?? raw;
  const lib = LIBRARIES[name];
  if (!lib) {
    throw new Error(
      `FIGMA2UI_UI_LIBRARY="${raw}" is not a supported library. ` +
      `Supported values: ${Object.keys(LIBRARIES).join(', ')}, or none to use the library the project already has. ` +
      `Fix the value in your MCP config env, then try again.`
    );
  }
  if (framework !== 'react') {
    throw new Error(
      `FIGMA2UI_UI_LIBRARY="${raw}" only works with React projects, but this project uses ${framework}. ` +
      `Set it to none, or remove it from your MCP config env.`
    );
  }
  const missing = missingOf(projectDir, lib);
  if (missing.length) {
    throw new Error(
      `FIGMA2UI_UI_LIBRARY="${raw}" is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed in ${projectDir}. ` +
      `Install it with: ${installCommand(projectDir, missing)} — then try again. No Figma API call was made.`
    );
  }
  return ready(name);
}

// The part of the library status the AI needs to see.
export const libraryStatus = ({ pkg, components, ...rest }) => rest;
