import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WEB = new Set(['react', 'vue', 'svelte', 'angular', 'html']);
const ALIASES = { next: 'react', nextjs: 'react', remix: 'react', nuxt: 'vue', sveltekit: 'svelte' };

function readDeps(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}

function make(framework, dir, deps, styling, label = framework) {
  if (!WEB.has(framework)) return { framework: 'other', label, styling: null, ext: 'md', assets: 'figma2ui/assets', root: 'figma2ui' };
  return {
    framework,
    label,
    styling: styling ?? (deps.tailwindcss ? 'tailwind' : 'css'),
    ext: deps.typescript || existsSync(join(dir, 'tsconfig.json')) ? 'tsx' : 'jsx',
    assets: deps['@sveltejs/kit'] ? 'static/figma' : 'public/figma',
    root: 'src/figma',
  };
}

// Accepts "react", "vue+tailwind", "flutter". Any non-web name uses the compact spec.
export function parseStack(value, dir) {
  const [rawName, styling] = value.trim().toLowerCase().split('+');
  if (styling && !['tailwind', 'css'].includes(styling)) throw new Error(`Unknown styling "${styling}". Use "tailwind" or "css".`);
  return make(ALIASES[rawName] ?? rawName, dir, readDeps(dir), styling);
}

export function detectStack(dir) {
  const deps = readDeps(dir);
  const has = (...names) => names.some((n) => deps[n]);
  if (has('react-native', 'expo')) return make('react-native', dir, deps);
  if (has('react', 'next')) return make('react', dir, deps);
  if (has('@angular/core')) return make('angular', dir, deps);
  if (has('vue', 'nuxt')) return make('vue', dir, deps);
  if (has('svelte', '@sveltejs/kit')) return make('svelte', dir, deps);
  if (existsSync(join(dir, 'pubspec.yaml'))) return make('flutter', dir, deps);
  if (existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts'))) return make('android', dir, deps);
  if (existsSync(join(dir, 'Package.swift')) || readdirSync(dir).some((f) => f.endsWith('.xcodeproj'))) return make('swift', dir, deps);
  if (existsSync(join(dir, 'index.html'))) return make('html', dir, deps);
  return null;
}
