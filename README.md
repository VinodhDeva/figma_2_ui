# figma2ui

Turn a Figma design into UI code in your project's own tech stack, while spending as few AI
agent credits as possible.

figma2ui is a local [MCP](https://modelcontextprotocol.io) server, so it works with any AI tool
that supports MCP: Claude Code, Claude Desktop, Cursor, Windsurf, Codex, Gemini CLI, and others.

## Why it uses fewer credits

Most Figma-to-code workflows send large design data through the agent. figma2ui does the
conversion in plain code on your machine instead:

- The agent receives short summaries. Raw Figma data and generated code stay on disk.
- There are only 3 tools, so tool definitions stay small on every turn.
- Large designs are split into chunks of at most 150 nodes, so the agent can open one at a time.
- Repeated designs, such as a grid of cards, become one component with props.
- Colors and font sizes become shared CSS variables.
- Designs are cached by Figma file version, so unchanged designs are not downloaded again.

On a synthetic 601-node test design, 641 KB of Figma-style JSON produced 1.3 KB of tool results,
and the 3 tool definitions total 1.4 KB. Real results depend on your design.

## Supported stacks

The stack is detected from your project files.

| Your project | Output |
|--------------|--------|
| React, Next.js, Remix | `.tsx` or `.jsx` |
| Vue, Nuxt | `.vue` |
| Svelte, SvelteKit | `.svelte` |
| Angular | Standalone `.component.ts` |
| Plain HTML | `.html` |
| React Native, Flutter, SwiftUI, Compose, and any other stack | Compact spec files that the agent translates to native code |

Web projects get Tailwind classes (v3 or v4) if `tailwindcss` is installed, otherwise plain CSS
files. Non-web stacks cost more credits, because the agent writes the final code.

## Setup

You need Node.js 20 or later.

### 1. Install

```bash
git clone https://github.com/VinodhDeva/figma_2_ui.git
```

```bash
cd figma_2_ui && npm install
```

### 2. Create a Figma token

In Figma, open Settings, Security, Personal access tokens. Create a token with read access to
file content and file metadata.

> **Security:** this token gives access to your Figma files. Never commit it or paste it into
> a chat. Keep any config file that contains it out of version control.

### 3. Add the server to your AI tool

Replace `/absolute/path/to/figma_2_ui` with the folder you cloned.

**Claude Code**

```bash
claude mcp add figma2ui -e FIGMA_TOKEN=your_token -- node /absolute/path/to/figma_2_ui/src/server.js
```

**Claude Desktop, Cursor, Windsurf, Gemini CLI**

| Tool | Config file |
|------|-------------|
| Claude Desktop | `claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |

```json
{
  "mcpServers": {
    "figma2ui": {
      "command": "node",
      "args": ["/absolute/path/to/figma_2_ui/src/server.js"],
      "env": { "FIGMA_TOKEN": "your_token" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.figma2ui]
command = "node"
args = ["/absolute/path/to/figma_2_ui/src/server.js"]
env = { FIGMA_TOKEN = "your_token" }
```

### 4. Give the agent the workflow

[skill/SKILL.md](skill/SKILL.md) tells the agent how to use the tools cheaply.

| Tool | What to do |
|------|------------|
| Claude | Copy the `skill` folder to `~/.claude/skills/figma-to-ui` |
| Codex and tools that read `AGENTS.md` | Paste its body into `AGENTS.md` |
| Cursor | Paste its body into a file in `.cursor/rules/` |

## Usage

Select a frame in Figma, copy its link, and ask your agent:

```text
Build this design in my app: https://www.figma.com/design/KEY/Name?node-id=1-2
```

The link should be a `figma.com/design/...` link with a `node-id`. Without a `node-id`, the first
page is used.

A web project needs 3 tool calls:

| Tool | Input | What it does |
|------|-------|--------------|
| `figma_index` | `url`, `projectDir`, optional `stack` | Fetches and caches the design, detects the stack, returns the chunk map |
| `figma_chunk` | `projectDir`, optional `ids` | Writes code or spec files. Returns paths and warnings |
| `figma_assets` | `projectDir`, optional `ids` | Downloads images and icons |

To override the detected stack, ask the agent to pass `stack`, for example `vue+tailwind`,
`react+css`, or `flutter`.

### Generated files

```text
.figma2ui.json                    Detected stack and generation state
src/figma/<design>/               Components, Page, and figma-tokens.css
public/figma/                     Images and icons (SvelteKit: static/figma/)
figma2ui/<design>/                Non-web stacks: index.md, specs, tokens.css
figma2ui/assets/                  Non-web stacks: images and icons
```

Render `Page` from your app's route or entry file. A generated file is replaced only if it has
not changed since it was generated, so your edits are kept. Delete a file to regenerate it.

## Figma plans and rate limits

Figma limits REST API calls by seat type, and the limit follows the plan of the file.

| Seat | Limit on file reads |
|------|---------------------|
| Dev or Full, on a paid plan | Per-minute limits, which are ample for this tool |
| View or Collab | A small monthly quota, up to 20 and sometimes far fewer |

Each new design version uses 1 limited call, plus 1 more for `figma_assets` if the design has
icons. Unchanged designs use the cache.

For regular use, a Professional plan with a Dev seat is enough. Choose a Full seat if you also
edit designs. Keep the file in the paid team, and create the token from the account holding that
seat. See [Figma's rate limits](https://developers.figma.com/docs/rest-api/rate-limits/) for
current values.

## Limitations

- Figma Make files and Make code layers cannot be converted, because they have no design layers.
- Interactions, animation, and state logic are left to the agent.
- Breakpoint-specific layouts are not generated. Only auto-layout fill and hug carry over.
- Frames without auto-layout use absolute positions and are listed in `warnings`.
- Existing project components are not reused.
- Some Figma effects are approximated or ignored, and are listed in `warnings`.

## Troubleshooting

| Message | What to do |
|---------|------------|
| `FIGMA_TOKEN is not set` | Add the token to the `env` of this server in your AI tool's config |
| `Figma returned 403` | Check the token, and that its account can open the file |
| `Figma rate limit reached` | Wait for the stated time, or see [Figma plans and rate limits](#figma-plans-and-rate-limits) |
| `Figma Make links are not supported` | Use a link to a Figma Design file |
| `no design layers to convert` | The frame is a Make code layer. Link to a frame with normal layers |
| `Could not detect the tech stack` | Tell the agent your stack, so it can pass `stack` |
| `skipped` in a result | Those files were edited after generation. Delete one to regenerate it |

## Project status

This is an early version. Automated tests use a mocked Figma API, and generated output has been
compiled with the React (esbuild), Vue, Svelte, Angular, and Tailwind toolchains. A full run on a
real layered Figma design and a visual comparison have not been completed yet.

## Development

```bash
npm test
```

| Path | Purpose |
|------|---------|
| `src/server.js` | MCP wiring |
| `src/tools.js` | The 3 tools |
| `src/figma.js` | Figma API client and cache |
| `src/tree.js` | Converts Figma nodes to a neutral element tree |
| `src/chunk.js` | Deduplication and chunking |
| `src/stack.js` | Stack detection |
| `src/emit.js` | Code and spec output for each target |
| `src/project.js` | Guarded file writes |
| `docs/superpowers/` | Original design and implementation plan |
