// Runs the hook's real code path (resolveHookConfig -> compactSession) over a real
// Claude Code transcript (.jsonl) against a local Jev-compatible server.
//   npx tsx examples/transcript-eval.ts <transcript.jsonl> [lastN] [preserveRecent]
import { readFileSync } from 'node:fs';
import { resolveHookConfig, compactSession, summarize, decisionLogLines } from '../hooks/fast-jev.js';

type Block = { type: string; [k: string]: unknown };
const [, , file, lastN = '0', preserve = '6'] = process.argv;
if (!file) throw new Error('usage: transcript-eval.ts <transcript.jsonl> [lastN] [preserveRecent]');

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b as Block).text ?? '').join('\n') : '';

const messages: any[] = [];
const uses = new Map<string, any>();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let row: any;
  try { row = JSON.parse(line); } catch { continue; }
  if (row.type !== 'user' && row.type !== 'assistant') continue;
  if (row.isSidechain) continue;
  const content: Block[] | string = row.message?.content ?? [];
  if (row.type === 'assistant' && Array.isArray(content)) {
    const toolUses = content.filter((b) => b.type === 'tool_use').map((b) => {
      const u = { tool_use_id: b.id as string, tool: b.name as string, input: (b.input ?? {}) as Record<string, unknown> };
      uses.set(u.tool_use_id, u);
      return u;
    });
    const text = content.filter((b) => b.type === 'text').map((b) => b.text as string).join('\n');
    if (text || toolUses.length) messages.push({ role: 'assistant', text, toolUses });
  } else if (row.type === 'user') {
    if (typeof content === 'string') { messages.push({ role: 'user', text: content, toolUses: [] }); continue; }
    const results = content.filter((b) => b.type === 'tool_result').map((b) => {
      const r = { tool_use_id: b.tool_use_id as string, text: textOf(b.content), isError: Boolean(b.is_error) };
      const u = uses.get(r.tool_use_id);
      if (u) { u.text = r.text; u.isError = r.isError; }
      return r;
    });
    const text = content.filter((b) => b.type === 'text').map((b) => b.text as string).join('\n');
    if (results.length || text) messages.push({ role: 'user', text, toolUses: [], ...(results.length ? { toolResults: results } : {}) });
  }
}
const slice = Number(lastN) > 0 ? messages.slice(-Number(lastN)) : messages;
// a slice must not start with a tool_result whose tool_use was cut off
while (slice.length && slice[0].toolResults && !slice[0].text) slice.shift();
const chars = slice.reduce((n, m) => n + m.text.length + (m.toolResults ?? []).reduce((a: number, r: any) => a + r.text.length, 0)
  + m.toolUses.reduce((a: number, u: any) => a + JSON.stringify(u.input).length, 0), 0);
console.log(`transcript: ${messages.length} messages, using ${slice.length} (${(chars / 1024).toFixed(0)} KiB of text/tool data)`);

// exactly the userConfig the user set in Claude Code
const config = {
  ...resolveHookConfig({
    baseUrl: 'http://127.0.0.1:8017/v1/systemone', model: 'rizzo-latest', apiKey: 'rizzo-local',
    maxStateTokens: Number(process.env.STATE ?? 12000), maxRequestTokens: Number(process.env.REQ ?? 14000), maxQuestionsPerRequest: 64,
    preserveRecentMessages: Number(preserve),
  }),
  apiKey: 'rizzo-local',
};
const log: string[] = [];
const fetchFn = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const t0 = Date.now();
  const res = await fetch(url, init as RequestInit);
  const text = await res.text();
  log.push(`  request: http=${res.status} questions=${Object.keys(JSON.parse(init?.body ?? '{}').questions ?? {}).length} ${Date.now() - t0} ms`);
  return { status: res.status, ok: res.ok, text };
};
const t0 = Date.now();
try {
  const { result } = await compactSession(slice as any, config as any, fetchFn);
  log.forEach((l) => console.log(l));
  console.log('summary:', summarize(result), `| total ${Date.now() - t0} ms`);
  const byTool = new Map<string, Record<string, number>>();
  for (const d of result.decisions) {
    const row = byTool.get(d.tool) ?? {}; row[d.action] = (row[d.action] ?? 0) + 1; byTool.set(d.tool, row);
  }
  console.log('per tool:', JSON.stringify(Object.fromEntries(byTool)));
  const callById = new Map<string, any>();
  let i = 0; for (const m of slice) for (const u of m.toolUses) callById.set(`t${++i}`, u);
  const show = (d: any) => `${d.id} ${d.tool} ${d.action} call=${d.keepCall.toFixed(2)} res=${d.keepResult.toFixed(2)} ${JSON.stringify(callById.get(d.id)?.input ?? {}).slice(0, 90)}`;
  const sorted = [...result.decisions].filter((d) => d.reason !== 'pinned');
  console.log('--- lowest keepCall (dropped first):'); sorted.sort((a, b) => a.keepCall - b.keepCall).slice(0, 8).forEach((d) => console.log(' ', show(d)));
  console.log('--- highest keepCall (kept):'); sorted.slice(-8).reverse().forEach((d) => console.log(' ', show(d)));
  console.log('ui log lines:', decisionLogLines(result).length);
} catch (e) {
  log.forEach((l) => console.log(l));
  console.log('ERROR:', (e as Error).message);
}
