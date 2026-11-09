# figma2ui MCP Implementation Plan

**Goal:** Build the local MCP server in the spec, with a portable instruction file.

**Architecture:** Figma JSON is cached on disk, turned into a neutral element tree, split into
chunks, and emitted per stack. Tools return short JSON. Generated code stays on disk.

**Tech Stack:** Node 20+, ESM JavaScript, `@modelcontextprotocol/sdk`, `zod`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-09-figma2ui-mcp-design.md`

## Files

| File | Responsibility |
|------|----------------|
| `src/names.js` | Safe slugs, component names, prop names |
| `src/figma.js` | URL parsing, REST calls, cache |
| `src/tree.js` | Figma node to element, tokens, assets |
| `src/chunk.js` | Dedupe and chunk split, `analyze(design)` |
| `src/stack.js` | Detect and parse the stack, output directories |
| `src/emit.js` | Emitters for each target |
| `src/project.js` | Project state and guarded writes |
| `src/tools.js` | `figmaIndex`, `figmaChunk`, `figmaAssets` |
| `src/server.js` | MCP wiring only |
| `skill/SKILL.md`, `README.md` | Agent workflow and platform setup |

## Refinements to the spec, made while planning

These lower credits or protect work, and do not change the approved behaviour.

- `figma_chunk` and `figma_assets` take `projectDir` and optional `ids`. The URL and version come
  from project state. Omitting `ids` processes everything, so a web build needs 3 tool calls.
- Output goes in a per-design folder, `src/figma/<design>/`, so several screens can coexist.
- Dedupe uses the structural hash only. Same-component instances with overrides differ in
  structure and cannot share one template.
- A generated file is overwritten only if it is unchanged since generation.

## Review Focus

1. Layer text containing `{`, `<`, `@`, or backticks must render as literal text on every target.
2. Layer names such as `../../evil` must not escape the output folders.
3. Re-running must not overwrite a generated file the user or agent edited.
4. A flat frame with over 150 leaf children must still generate, over the limit.
5. A missing token or unknown chunk id must return an error that says what to do.

## Tasks

1. Names, Figma client: tests for URL forms, cache hit, 429 retry, missing token.
2. Tree and chunker: tests for flex mapping, absolute fallback, tokens, dedupe, props, limit.
3. Stack and emitters: tests for detection and output of each target, with escaping.
4. Project writes and tools: tests for traversal, edit protection, full tool flow with mocked fetch.
5. Server, skill, README: stdio smoke test with `tools/list`.
6. Verify: compile generated output with real framework compilers, report byte savings.
