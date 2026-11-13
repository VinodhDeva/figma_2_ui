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

// Reads FIGMA2UI_UI_LIBRARY from the MCP server's env. Returns null when it is not set.
export function uiLibrary(projectDir, framework) {
  const raw = process.env.FIGMA2UI_UI_LIBRARY?.trim().toLowerCase();
  if (!raw) return null;
  const name = ALIASES[raw] ?? raw;
  const lib = LIBRARIES[name];
  if (!lib) return { name: raw, used: false, note: `Unsupported UI library. Use one of: ${Object.keys(LIBRARIES).join(', ')}.` };
  if (framework !== 'react') return { name, used: false, note: 'UI libraries apply to React projects only, so plain elements were generated.' };
  const missing = [lib.pkg, ...lib.peers].filter((p) => !installed(projectDir, p));
  if (missing.length) {
    return { name, used: false, install: installCommand(projectDir, missing), note: 'Not installed, so plain elements were generated. Install it, then run figma_chunk again.' };
  }
  return { name, used: true, pkg: lib.pkg, components: lib.components };
}

/**
 * Throws an actionable error when FIGMA2UI_UI_LIBRARY is set but the packages
 * are not installed. Called before any Figma API request so no quota is consumed.
 */
export function requireUiLibrary(projectDir, framework) {
  const raw = process.env.FIGMA2UI_UI_LIBRARY?.trim().toLowerCase();
  if (!raw) return; // env var not set → nothing to enforce
  const name = ALIASES[raw] ?? raw;
  const lib = LIBRARIES[name];
  if (!lib) {
    throw new Error(
      `FIGMA2UI_UI_LIBRARY="${raw}" is not a supported library. ` +
      `Supported values: ${Object.keys(LIBRARIES).join(', ')}. ` +
      `Fix the value in your MCP config env, then try again.`
    );
  }
  if (framework && framework !== 'react') {
    throw new Error(
      `FIGMA2UI_UI_LIBRARY="${raw}" only works with React projects, but this project uses ${framework}. ` +
      `Remove FIGMA2UI_UI_LIBRARY from your MCP config env, or switch to a React project.`
    );
  }
  const missing = [lib.pkg, ...lib.peers].filter((p) => !installed(projectDir, p));
  if (missing.length) {
    throw new Error(
      `FIGMA2UI_UI_LIBRARY="${raw}" is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed in ${projectDir}. ` +
      `Run: ${installCommand(projectDir, missing)} — then try again.`
    );
  }
}

// The part of the library status the AI needs to see.
export const libraryStatus = ({ pkg, components, ...rest }) => rest;
