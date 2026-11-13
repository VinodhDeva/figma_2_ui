# figma2ui

Turn a Figma design into UI code in your project's own tech stack, with as few AI credits and
as few Figma API calls as possible.

figma2ui is a local [MCP](https://modelcontextprotocol.io) server. It works with any AI tool that
supports MCP: Kiro, Claude Code, Claude Desktop, Cursor, Windsurf, Codex, Gemini CLI, and others.

- **Low AI cost.** The conversion runs as plain code on your machine. The AI gets short
  summaries; raw Figma data and generated code stay on disk.
- **Few Figma calls.** Designs, images, and icons are cached. An unchanged design costs no
  rate-limited call.
- **Close to Figma.** Positions, sizes, line heights, colors, and charts are taken from the
  design, not guessed by the AI.
- **Your stack.** React, Vue, Svelte, Angular, or HTML, with Tailwind or plain CSS. Other stacks
  get a compact blueprint.

## Quick start

You need Node.js 20 or later and a Figma account.

### 1. Create a Figma token

In Figma, open Settings, Security, Personal access tokens. Create a token with read access to
**file content** and **file metadata**. The metadata scope matters: without it the design cache
cannot be used, and every run spends a rate-limited call.

> **Security:** this token gives access to your Figma files. Never commit it or paste it into a
> chat. Keep any config file that contains it out of version control.

### 2. Add the server to your AI tool

No clone or install is needed. `npx` downloads and runs the server.

```json
{
  "mcpServers": {
    "figma2ui": {
      "command": "npx",
      "args": ["-y", "figma2ui-mcp"],
      "env": { "FIGMA_TOKEN": "your_token" }
    }
  }
}
```

| Tool | Where this goes |
|------|-----------------|
| Kiro | `~/.kiro/settings/mcp.json`, or `.kiro/settings/mcp.json` in one project |
| Cursor | `.cursor/mcp.json` |
| Claude Desktop | `claude_desktop_config.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |

**Claude Code**

```bash
claude mcp add figma2ui -e FIGMA_TOKEN=your_token -- npx -y figma2ui-mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.figma2ui]
command = "npx"
args = ["-y", "figma2ui-mcp"]
env = { FIGMA_TOKEN = "your_token" }
```

The first start takes a little longer while `npx` downloads the server.

### 3. Give the AI the workflow

[skill/SKILL.md](skill/SKILL.md) tells the AI how to use the tools cheaply and how to keep the
result matching Figma. Copy its body, without the top `---` block.

| Tool | What to do |
|------|------------|
| Kiro | Paste it into `.kiro/steering/figma-to-ui.md` |
| Claude | Copy the `skill` folder to `~/.claude/skills/figma-to-ui` |
| Cursor | Paste it into a file in `.cursor/rules/` |
| Codex and tools that read `AGENTS.md` | Paste it into `AGENTS.md` |

### 4. Use it

Select a frame in Figma, copy its link, and ask your AI tool:

```text
Build this design in my app: https://www.figma.com/design/KEY/Name?node-id=1-2
```

Use a `figma.com/design/...` link with a `node-id`. Without a `node-id`, the first page is used.

## Tools

| Tool | Input | What it does |
|------|-------|--------------|
| `figma_index` | `url`, `projectDir`, optional `stack` | Fetches and caches the design, detects the stack, returns the chunk map and fonts |
| `figma_chunk` | `projectDir`, optional `ids` | Writes code or blueprint files. Returns paths and warnings |
| `figma_assets` | `projectDir`, optional `ids` | Downloads images and icons |

A web project needs these 3 calls, once each.

## Code mode (optional)

In code mode the server exposes one tool, `figma_build`, instead of three. It runs the whole
workflow as code inside the server and returns one merged summary.

| | Default | Code mode |
|---|---|---|
| Tools the AI sees | 3 | 1 (`figma_build`) |
| Tool definitions sent on every AI turn | about 340 tokens | about 130 tokens |
| Tool calls per design | 3 | 1 |
| Re-run only some chunks or assets | yes, with `ids` | no, rebuilds everything |

Turn it on by adding `FIGMA2UI_CODE_MODE` to the server's `env`, then restart the server:

```json
"env": { "FIGMA_TOKEN": "your_token", "FIGMA2UI_CODE_MODE": "1" }
```

If an asset download fails in code mode, for example on a rate limit, the generated code is kept
and the error is reported under `assets`. Rebuilding everything is cheap, because unchanged
designs, images, and icons come from the cache.

## UI component library (optional)

React projects can use a component library for the interactive parts of a design. Layers whose
names say button, input, or link become that library's components instead of plain HTML
elements. Everything else stays as generated layout code.

| Value | Package | Button | Input | Link |
|-------|---------|--------|-------|------|
| `mui` | `@mui/material` | `Button` | `InputBase` | `Link` |
| `antd` | `antd` | `Button` | `Input` | plain `a` |
| `chakra` | `@chakra-ui/react` | `Button` | `Input` | `Link` |
| `mantine` | `@mantine/core` | `Button` | `TextInput` | `Anchor` |

Turn it on by adding `FIGMA2UI_UI_LIBRARY` to the server's `env`, then restart the server:

```json
"env": { "FIGMA_TOKEN": "your_token", "FIGMA2UI_UI_LIBRARY": "mui" }
```

The library must be installed in your project, including its required peer packages. The server
checks `node_modules` in the project folder and its parent folders, so monorepo installs count.

- **Installed:** components are imported, for example `import { Button } from '@mui/material';`.
- **Not installed:** plain elements are generated, so the code still runs, and the result shows
  the install command for your package manager, for example
  `npm install @mui/material @emotion/react @emotion/styled`. Install it, then run `figma_chunk`
  again.
- **Unknown value or a non-React project:** plain elements are generated, and the result explains
  why.

Your app still needs the library's own setup, such as `MantineProvider` or Chakra's `Provider`.

Library components bring their own default styles, which can override the Figma styles on those
elements. For MUI, wrap the app in `<StyledEngineProvider injectFirst>` so the generated styles
win.

## Supported stacks

The stack is detected from your project files and saved in `.figma2ui.json`.

| Your project | Output |
|--------------|--------|
| React, Next.js, Remix | `.tsx` or `.jsx` |
| Vue, Nuxt | `.vue` |
| Svelte, SvelteKit | `.svelte` |
| Angular | Standalone `.component.ts` |
| Plain HTML | `.html` |
| React Native, Flutter, SwiftUI, Compose, and any other stack | Compact blueprint files that the AI translates to native code |

Web projects get Tailwind classes (v3 or v4) if `tailwindcss` is installed, otherwise plain CSS
files. Non-web stacks cost more credits, because the AI writes the final code.

To override detection, ask the AI to pass `stack`, for example `vue+tailwind`, `react+css`, or
`flutter`.

## Generated files

```text
.figma2ui.json                    Detected stack and generation state
src/figma/<design>/               Components, Page, and figma-tokens.css
public/figma/                     Images and icons
figma2ui/usage-report.md          Figma API calls and token estimates
figma2ui/<design>/                Non-web stacks: index.md, blueprints, tokens.css
figma2ui/assets/                  Non-web stacks: images and icons
```

Images and icons go where your framework serves static files, so generated code can use plain
paths with no imports:

| Project | Folder | Path in code |
|---------|--------|--------------|
| Most web projects | `public/figma/` | `/figma/...` |
| SvelteKit | `static/figma/` | `/figma/...` |
| Angular 16 or older, or Angular with `src/assets` and no `public` folder | `src/assets/figma/` | `/assets/figma/...` |

A generated file is replaced only if it has not changed since it was generated, so your edits are
kept. Delete a file to regenerate it.

## How it keeps Figma calls low

Figma limits its scarcest "Tier 1" calls by seat, so the server avoids them where it can.

| Situation | Tier 1 calls |
|-----------|--------------|
| Design unchanged since the last run | 0 |
| Design edited, no new icons | 1 |
| Design edited, with new or changed icons | 2 |

- **Design cache.** A cheap metadata call checks the file version. The design is downloaded only
  when the version changed.
- **Images** are named by Figma's content hash and downloaded once.
- **Icons** are named by a fingerprint of how they look, including their vector paths. Moved,
  renamed, or copied icons are reused, and identical icons become one file.
- **Shared cache.** `~/.cache/figma2ui` serves designs and assets to every project on your
  machine.
- **Later steps make no design calls.** `figma_chunk` always reads the cache.

## How it matches Figma

What the server does:

- Uses each layer's exact position, size, color, radius, border, shadow, and opacity.
- Converts auto-layout to flexbox, with the same gaps, padding, and alignment.
- Keeps Figma's line height for every text, and never lets single-line text wrap.
- Draws donut and pie segments as real vector shapes.
- For plain CSS projects, resets browser default margins and button styles that would shift
  layers. Tailwind projects already have this reset.

What your app must do:

- **Render the generated `Page` as it is.** Wrapping chunks in your own containers with other
  widths, borders, or padding shifts everything inside. The skill file tells the AI this.
- **Load the fonts** listed under `fonts` in the tool result, for example `Inter:400,500,600,700`.
  A missing weight makes text render in a different width.
- **Check at the design's width.** Frames without auto-layout use fixed positions. They match
  Figma at the frame's width and do not adapt to smaller screens. Such frames are listed in
  `warnings`.

## Usage report

Every tool result ends with a short `usage` block: Figma API calls in that step, estimated tokens
for that step, and running totals for the design. The full report is written to
`figma2ui/usage-report.md` after every call:

- Figma API calls by request, rate-limit tier, and status, including failed calls
- Cache hits and asset downloads, which do not count toward Figma limits
- Estimated tokens for each tool call's input and result
- How much design data was kept out of the AI

Token counts are estimates (bytes / 4) of what passes between the AI and this server. They do not
include the AI's own reasoning, the tool definitions, or files the AI opens. Your AI tool's usage
screen shows the full session.

## Figma plans and rate limits

The limit follows the plan of the file, and the seat of the account that created the token.

| Seat | Limit on file reads |
|------|---------------------|
| Dev or Full, on a paid plan | Per-minute limits, which are ample for this tool |
| View or Collab | A small monthly quota, up to 20 and sometimes far fewer |

For regular use, a Professional plan with a Dev seat is enough. Choose a Full seat if you also
edit designs. Keep the file in the paid team. See
[Figma's rate limits](https://developers.figma.com/docs/rest-api/rate-limits/) for current values.

## Settings

| Environment variable | Purpose |
|----------------------|---------|
| `FIGMA_TOKEN` | Required. Figma personal access token |
| `FIGMA2UI_CODE_MODE` | Set to `1` for the single `figma_build` tool |
| `FIGMA2UI_UI_LIBRARY` | `mui`, `antd`, `chakra`, or `mantine`. See [UI component library](#ui-component-library-optional) |
| `FIGMA2UI_CACHE` | Cache folder. Default `~/.cache/figma2ui` |

## Limitations

- Figma Make files and Make code layers cannot be converted, because they have no design layers.
- Interactions, animation, and state logic are left to the AI.
- Breakpoint-specific layouts are not generated. Only auto-layout fill and hug carry over.
- Existing project components are not reused. Only buttons, inputs, and links can use a UI library.
- Rotation, blend modes, mixed styles inside one text, and angular gradients are approximated or
  ignored, and are listed in `warnings`.

## Troubleshooting

| Message or problem | What to do |
|--------------------|------------|
| `FIGMA_TOKEN is not set` | Add the token to the `env` of this server in your AI tool's config |
| `Figma returned 403` | Check the token, and that its account can open the file |
| `Figma rate limit reached` | Wait for the stated time, or see [Figma plans and rate limits](#figma-plans-and-rate-limits) |
| `Figma Make links are not supported` | Use a link to a Figma Design file |
| `no design layers to convert` | The frame is a Make code layer. Link to a frame with normal layers |
| `Could not detect the tech stack` | Tell the AI your stack, so it can pass `stack` |
| `skipped` in a result | Those files were edited after generation. Delete one to regenerate it |
| Layout is shifted compared with Figma | See [How it matches Figma](#how-it-matches-figma): render `Page` as it is, and load the listed fonts |
| Images do not show | Check that the assets folder in [Generated files](#generated-files) is the one your framework serves |
| An icon looks outdated | Delete it from the assets folder and run `figma_assets` again |

## Project status

This is an early version. Automated tests use a mocked Figma API. Generated output has been
compiled with the React (esbuild), Vue, Svelte, Angular, and Tailwind toolchains. One real
dashboard design was generated for React with plain CSS and compared with Figma at the frame's
width: sampled text positions were within 1px. Other stacks and designs have not been compared
visually yet.

## Development

```bash
git clone https://github.com/VinodhDeva/figma_2_ui.git
```

```bash
cd figma_2_ui && npm install && npm test
```

To run a local checkout in your AI tool, use `"command": "node"` with
`"args": ["/absolute/path/to/figma_2_ui/src/server.js"]`.

| Path | Purpose |
|------|---------|
| `src/server.js` | MCP wiring |
| `src/tools.js` | The 3 tools, and `figma_build` for code mode |
| `src/figma.js` | Figma API client and caches |
| `src/tree.js` | Converts Figma nodes to a neutral element tree |
| `src/chunk.js` | Deduplication and chunking |
| `src/stack.js` | Stack detection |
| `src/emit.js` | Code and blueprint output for each target |
| `src/project.js` | Guarded file writes |
| `src/usage.js` | Usage tracking and report |
| `src/library.js` | UI component library config and install check |
| `docs/system-design.html` | Animated overview for stakeholders |
| `docs/low-level-design.html` | Detailed design for engineers |

### Releasing a new version

The package is published on npm as [`figma2ui-mcp`](https://www.npmjs.com/package/figma2ui-mcp).
npm never lets a published version be overwritten, so raise the version first:

```bash
npm version patch
```

```bash
npm publish
```

To try unreleased code from GitHub, use `"args": ["-y", "github:VinodhDeva/figma_2_ui"]`.

## License

[MIT](LICENSE)
