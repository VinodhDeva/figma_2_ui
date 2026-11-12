import { apiLog, parseFigmaUrl } from './figma.js';
import { loadState, requireProject, saveState, writeGenerated } from './project.js';

export const REPORT = 'figma2ui/usage-report.md';
const KEEP = 100;
// Measured with tools/list: the 3 tool definitions are about 1.4 KB, sent to the AI on every turn.
const TOOL_DEFS_TOKENS = 350;

// shortcut: tokens are estimated as bytes / 4, which is close for English and JSON; use a real tokenizer if exact counts are needed.
const tokens = (text) => Math.ceil(Buffer.byteLength(text) / 4);
const keyOf = (fileKey, nodeId) => `${fileKey}:${nodeId ?? 'page'}`;
const cell = (s) => String(s).replace(/[|\r\n]+/g, ' ');
const num = (n) => n.toLocaleString('en-US');

function designKey(tool, args, state) {
  if (tool === 'figma_index') {
    try {
      const { fileKey, nodeId } = parseFigmaUrl(args.url);
      return keyOf(fileKey, nodeId);
    } catch {
      return null;
    }
  }
  return state.current ? keyOf(state.current.fileKey, state.current.nodeId) : null;
}

function totals(entries) {
  const calls = entries.flatMap((e) => e.calls);
  const api = calls.filter((c) => c.tier);
  const tier = (n) => api.filter((c) => c.tier === n).length;
  return {
    toolCalls: entries.length,
    figmaApiCalls: api.length,
    tier1: tier(1),
    tier2: tier(2),
    tier3: tier(3),
    cacheHits: calls.filter((c) => c.status === 'hit').length,
    downloads: calls.filter((c) => c.call.startsWith('asset')).length,
    tokens: entries.reduce((n, e) => n + e.tokensIn + e.tokensOut, 0),
  };
}

function render(state, key) {
  const cur = state.current && keyOf(state.current.fileKey, state.current.nodeId) === key ? state.current : null;
  const rows = state.usage.filter((e) => e.design === key);
  const t = totals(rows);
  const grouped = new Map();
  for (const c of rows.flatMap((e) => e.calls)) {
    const k = `| \`${c.call}\` | ${c.tier ?? '-'} | ${c.status} |`;
    grouped.set(k, (grouped.get(k) ?? 0) + 1);
  }
  return [
    '# figma2ui usage report',
    '',
    `Design: ${cur?.name ? `**${cell(cur.name)}**, Figma file version ${cell(cur.version)}` : 'not indexed yet'}`,
    `Updated: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    '',
    '## Totals for this design',
    '',
    '| Measure | Value |',
    '|---|---|',
    `| MCP tool calls | ${t.toolCalls} |`,
    `| Figma API calls | ${t.figmaApiCalls} (Tier 1: ${t.tier1}, Tier 2: ${t.tier2}, Tier 3: ${t.tier3}) |`,
    `| Design cache hits | ${t.cacheHits} |`,
    `| Asset downloads from Figma's CDN | ${t.downloads} |`,
    `| AI tokens spent on MCP inputs and results | ~${num(t.tokens)} |`,
    ...(cur?.rawBytes ? [`| Design data kept out of the AI | ~${num(Math.ceil(cur.rawBytes / 4))} tokens |`] : []),
    '',
    'Tier 1 calls are the scarce ones. View and Collab seats get only a small monthly quota of them.',
    'CDN downloads and cache hits do not count toward Figma rate limits.',
    '',
    `Token counts are estimates (bytes / 4). They cover only what passes between the AI and this MCP. Not included: the tool definitions (about ${TOOL_DEFS_TOKENS} tokens on every AI turn), the AI's own reasoning, and any files the AI opens. Your AI tool's usage screen shows the full session.`,
    '',
    '## Tool calls',
    '',
    '| Time (UTC) | Tool | Result | Figma API calls | Tokens in | Tokens out |',
    '|---|---|---|---|---|---|',
    ...rows.map((e) => `| ${e.at.slice(0, 19).replace('T', ' ')} | ${e.tool} | ${e.ok ? 'ok' : `failed: ${cell(e.error)}`} | ${e.calls.filter((c) => c.tier).length} | ${e.tokensIn} | ${e.tokensOut} |`),
    '',
    '## Figma API calls and cache',
    '',
    '| Request | Tier | Status | Count |',
    '|---|---|---|---|',
    ...[...grouped].map(([k, n]) => `${k} ${n} |`),
    '',
    `Only the last ${KEEP} tool calls in this project are kept.`,
    '',
  ].join('\n');
}

async function record(tool, args, calls, result, error) {
  requireProject(args.projectDir);
  const state = await loadState(args.projectDir);
  const entry = { at: new Date().toISOString(), tool, ok: !error, design: designKey(tool, args, state), tokensIn: tokens(JSON.stringify(args)), tokensOut: 0, calls };
  if (error) entry.error = error.message.slice(0, 120);
  state.usage = [...(state.usage ?? []), entry].slice(-KEEP);
  let usage;
  // Two passes: the usage block is part of what the AI reads, so its own size belongs in tokensOut.
  for (let pass = 0; pass < 2; pass++) {
    const d = totals(state.usage.filter((e) => e.design === entry.design));
    usage = {
      figmaApiCalls: calls.filter((c) => c.tier).length,
      tokens: entry.tokensIn + entry.tokensOut,
      designTotal: { figmaApiCalls: d.figmaApiCalls, tier1: d.tier1, tokens: d.tokens },
      report: REPORT,
    };
    entry.tokensOut = tokens(error ? error.message : JSON.stringify({ ...result, usage }));
  }
  state.written ??= {};
  await writeGenerated(args.projectDir, state, REPORT, render(state, entry.design));
  await saveState(args.projectDir, state);
  return usage;
}

export async function tracked(tool, args, run) {
  const start = apiLog.length;
  let result;
  let error;
  try {
    result = await run(args);
  } catch (e) {
    error = e;
  }
  // shortcut: overlapping tool calls would mix their log entries; MCP clients normally call tools one at a time.
  const calls = apiLog.splice(start);
  let usage;
  try {
    usage = await record(tool, args, calls, result, error);
  } catch {
    // A failed report must never break the tool itself.
  }
  if (error) {
    if (usage) error.message += ` [Figma API calls in this step: ${usage.figmaApiCalls}. Report: ${REPORT}]`;
    throw error;
  }
  return usage ? { ...result, usage } : result;
}
