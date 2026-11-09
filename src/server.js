#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { figmaAssets, figmaChunk, figmaIndex } from './tools.js';

const server = new McpServer({ name: 'figma2ui', version: '0.1.0' });
const projectDir = z.string().describe('Absolute project path');
const ids = z.array(z.string()).optional().describe('Omit for all');

function register(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await handler(args)) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
}

register('figma_index', 'Start here. Reads a Figma link, detects the stack, returns the chunk map.', {
  url: z.string(),
  projectDir,
  stack: z.string().optional().describe('Override, e.g. react+tailwind, vue, flutter'),
}, figmaIndex);
register('figma_chunk', 'Writes chunks to disk as code or spec files. Returns paths and warnings.', { projectDir, ids }, figmaChunk);
register('figma_assets', 'Downloads images and icons to the project.', { projectDir, ids }, figmaAssets);

await server.connect(new StdioServerTransport());
