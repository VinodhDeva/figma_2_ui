# figma2ui: Figma to the user's tech stack with minimum agent credits

Date: 2026-11-09

## Intent

The user gives an AI agent a Figma link and gets a matching UI in the tech stack of
their own project. The agent must spend as few credits as possible. The tool must work on several AI
platforms, not only Claude.

Agent credits are spent on context and output tokens. So the server does all the
conversion in plain code, and the agent sees only short summaries (the "code mode" idea).

## Goals

- Figma URL in, components in the project's stack and assets on disk out.
- The stack is detected from the project, and the user can override it.
- Web stacks get generated code. Every other stack gets a compact spec the agent translates.
- Raw Figma JSON and generated code never enter agent context unless the agent opens a file.
- Large designs split into chunks, so the agent can build and fix one section at a time.
- Repeated designs produce one component, not many copies.
- Runs on any MCP client: Claude Code, Claude Desktop, Cursor, Windsurf, Codex, Gemini CLI.
- Repeat runs on an unchanged file make no full Figma download.

## Non-goals (v1)

- Built-in code generators for non-web stacks (Flutter, SwiftUI, Compose, React Native).
- Prototype interactions, animation, and state logic. The agent adds these.
- Breakpoint-specific responsive output. Only auto-layout fill/hug behaviour carries over.
- Mapping to an existing component library or Figma Code Connect.
- Automatic screenshot comparison.
- Writing back to Figma.

## Anti-goals

- Returning generated code or large JSON in tool results by default.
- Adding more tools or options, since every tool schema costs tokens on every turn.
- Pixel-only output where every element is absolutely positioned, when auto-layout exists.

## Constraints

- Local stdio MCP server, so it can write to the user's project.
- Node 20 or later. Plain ESM JavaScript, no build step.
- Only runtime dependencies: `@modelcontextprotocol/sdk` and `zod` (the SDK needs it).
- Authentication through a Figma personal access token in `FIGMA_TOKEN`.

## Approaches

1. **MCP server plus one instruction file (chosen by the user).** Works on every MCP client.
   Code does the conversion. Costs a small tool schema on each turn.
2. Skill with bundled scripts. No schema cost, but needs skill support and shell access,
   so it is less portable.
3. Wrap the official Figma MCP. Its output goes directly to the agent, so a wrapper cannot
   shrink it, and its calls are limited by Figma plan.

Output format: the user first chose React + Tailwind, then asked that output follow the end
user's tech stack. The design combines both earlier options: generated code for web stacks
(lowest credits) and a compact spec for all others (works everywhere, costs more credits,
because the agent writes the code).

## Design

### Tools

| Tool | Input | Returns |
|------|-------|---------|
| `figma_index` | `url`, `projectDir`, optional `stack` | Detected stack, chunk map (id, name, node count, repeat count). Writes tokens. |
| `figma_chunk` | `url`, `projectDir`, `id` | File path, line count, assets needed, warnings. Writes code or spec. |
| `figma_assets` | `url`, `projectDir`, `ids` | Paths written. Downloads images and SVG icons. |

Results are short JSON. Generated code stays on disk.

### Stack detection

`figma_index` detects the stack, saves it to `<projectDir>/.figma2ui.json`, and later calls
read that file. An explicit `stack` value wins over detection and replaces the saved value.
If nothing is detected, for example in an empty folder, `figma_index` returns an error that
tells the agent to ask the user and call again with `stack`.

| Project signal | Framework | Output |
|----------------|-----------|--------|
| `react`, `next`, `remix` in `package.json` | React | `.tsx`, or `.jsx` without `typescript` |
| `vue`, `nuxt` | Vue | `.vue` single-file components |
| `svelte`, `@sveltejs/kit` | Svelte | `.svelte` |
| `@angular/core` | Angular | Standalone `.component.ts` |
| `index.html` with no framework | HTML | `.html` |
| `react-native`, `pubspec.yaml`, `Package.swift`, `*.xcodeproj`, Gradle, anything else | Other | Compact spec `.md` |

Styling is detected separately. `tailwindcss` in `package.json` gives Tailwind classes.
Any other web project gets one plain `.css` file per chunk, which works beside SCSS and
CSS-in-JS.

### Pipeline

1. **Fetch.** Parse file key and `node-id` from the URL. Read the file version cheaply, then
   use the cache at `~/.cache/figma2ui/<fileKey>-<version>.json`, or download. Honour
   `Retry-After` on HTTP 429.
2. **Simplify.** Drop hidden nodes and fields the generator does not use.
3. **Tokens.** Collect colors, font sizes, and font families. Use Figma style names when they
   exist, else `color-1`, `color-2`. Write them as CSS variables on `:root`, so Tailwind v3,
   Tailwind v4, and plain CSS share one file. The spec output lists the same tokens.
4. **Chunk.** Walk from the root frame. A child becomes a chunk when it is a top-level section
   or when its parent is over the limit of 150 nodes. Oversized children split recursively.
5. **Dedupe.** Group by Figma component id, else by a structural hash that ignores text and
   image content. A group becomes one component. Differing text becomes props.
6. **Build tree.** Map each node to a neutral element: tag, CSS declarations, text, props,
   and children (below).
7. **Emit.** One small emitter per target serializes the tree: React, Vue, Svelte, Angular,
   HTML, or spec. Styles are written as Tailwind arbitrary classes or plain CSS.
8. **Compose.** Write a page file that renders chunks in order. HTML has no components, so
   its page contains the chunks inline. The spec output writes the order into an index file.

### Node mapping

The table shows Tailwind output. Plain CSS gets the same declarations, and the spec output
lists them in short form.

| Figma | Output |
|-------|--------|
| Auto-layout | `flex`, direction, `gap-[..]`, padding, align and justify |
| Fill / Hug / Fixed sizing | `flex-1` or `w-full` / `w-fit` / `w-[..px]` |
| No auto-layout | `relative` parent, `absolute` children, with a warning |
| Solid fill, stroke, radius, opacity | token class or arbitrary value |
| Linear gradient, drop shadow, blur | arbitrary value |
| Text | Tag from font size and layer name, typography classes |
| Image fill | `<img src="/figma/..." alt="layer name">` |
| Vector or icon group | Exported SVG through `<img>` |
| Layer named like button, input, link | `button`, `input`, `a` |

Anything without a mapping (for example angular gradients or blend modes) is approximated
and listed in the chunk's `warnings`.

### Files written

```
<projectDir>/.figma2ui.json
<projectDir>/src/figma/figma-tokens.css
<projectDir>/src/figma/Page.<ext>
<projectDir>/src/figma/<Chunk>.<ext>
<projectDir>/public/figma/<asset>.png|svg      (SvelteKit: static/figma/)
<projectDir>/figma2ui/                         (non-web: index, specs, tokens, assets)
```

For non-web stacks, the agent writes native code and moves assets to the platform's location.

### Portable agent instructions

One `skill/SKILL.md` holds the workflow: call `figma_index`, then `figma_chunk` for each id,
then `figma_assets`, open a file only when a warning needs a fix, and add behaviour last.
For non-web stacks, it tells the agent to translate one spec file at a time.
The README shows how to use it as a Claude skill, or copy it into `AGENTS.md` or Cursor rules.
The README also has MCP config snippets for each platform.

### Security and error handling

- Layer names and text come from the design file and are untrusted. Escape them in JSX and
  sanitize names used as file names or identifiers.
- `projectDir` must be absolute. Writes are allowed only to `.figma2ui.json` and under its
  `src/figma`, `public/figma`, `static/figma`, and `figma2ui` directories. Resolved paths are
  checked to block traversal.
- Project files read for detection are used only to match known names, and are never executed.
- The token is sent only to `api.figma.com` and is never logged or cached.
- Clear errors for a missing token, HTTP 403, a node that does not exist, and an unknown chunk id.

### Testing

- `node:test` with a fixture Figma JSON: chunk limits, dedupe, class mapping, escaping,
  path checks, stack detection, and expected output for each emitter.
- Report raw Figma bytes against bytes returned to the agent, as an estimate of savings.
- One live run on a real Figma file once a token is available.

## Calls made by the builder, open to correction

- Web generators cover React, Vue, Svelte, Angular, and HTML, each with Tailwind or plain CSS.
- React Native, Flutter, SwiftUI, Compose, and any other stack use the compact spec.
- Chunk limit is 150 nodes, a fixed constant.
- Generated web code goes to `src/figma/` and assets to `public/figma/`.
- Tool results never include code. The agent opens files only when needed.
