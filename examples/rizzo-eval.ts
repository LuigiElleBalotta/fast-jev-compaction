import { compactMessages, reductionRatio, type Message } from '../src/index.js';

const BASE_URL = 'http://127.0.0.1:8017/v1/systemone';
let n = 0;
function call(tool: string, input: Record<string, unknown>, output: string, isError = false): Message[] {
  const tool_use_id = `toolu_${++n}`;
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id, tool, input, text: output, isError }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id, text: output, isError }] },
  ];
}
const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const assistant = (text: string): Message => ({ role: 'assistant', text, toolUses: [] });
const filler = (label: string, lines: number) => `// ${label}\n${'const x = 1; // filler line\n'.repeat(lines)}`;

function scenario(extraNoise: number): Message[] {
  n = 0;
  const msgs: Message[] = [
    user('Fix the failing parser test in the checkout service. Do not touch legacy/. Keep the public parser API backward compatible.'),
    assistant('Inspecting the test and the parser first.'),
    ...call('Glob', { pattern: 'src/**/*.ts' }, 'src/parser.ts\nsrc/parser.test.ts\nsrc/legacy/parser.ts\nsrc/checkout.ts'),
    ...call('Read', { file_path: 'src/legacy/parser.ts' }, filler('legacy parser, do not touch', 150)),
    ...call('Read', { file_path: 'README.md' }, filler('project readme marketing text', 120)),
    ...call('Bash', { command: 'git status' }, 'On branch main\nnothing to commit, working tree clean'),
    ...call('Read', { file_path: 'src/parser.ts' }, `export function parse(tokens) {\n${'  // loop body\n'.repeat(120)}}`),
    ...call('Bash', { command: 'npx vitest run src/parser.test.ts' },
      'FAIL src/parser.test.ts\n  parser > accepts a trailing comma\n    Expected: true\n    Received: false\n    at src/parser.test.ts:42:11', true),
    ...call('Bash', { command: 'ls node_modules | head -200' }, Array.from({ length: 200 }, (_, i) => `pkg-${i}`).join('\n')),
    ...call('Grep', { pattern: 'COMMA', path: 'src' }, 'src/parser.ts:31: if (token === COMMA) advance();\nsrc/legacy/parser.ts:12: COMMA'),
    assistant('The token loop stops too early on a trailing comma. Adding a transition.'),
    ...call('Edit', { file_path: 'src/parser.ts', old_string: 'if (token === COMMA) advance();', new_string: 'if (token === COMMA) { if (next === CLOSE_BRACE) continue; advance(); }' },
      'The file src/parser.ts has been updated.'),
    ...call('Read', { file_path: 'package.json' }, filler('package.json contents', 60)),
  ];
  for (let i = 0; i < extraNoise; i++) {
    if (process.env.BULK) msgs.push(assistant(('Reasoning about module ' + i + ' and its dependencies. ').repeat(Number(process.env.BULK))));
    msgs.push(...call('Read', { file_path: `src/unrelated/module${i}.ts` }, filler(`unrelated module ${i}`, 80)));
  }
  msgs.push(
    ...call('Bash', { command: 'npx vitest run src/parser.test.ts' }, 'PASS src/parser.test.ts\n  ✓ accepts a trailing comma (4 ms)'),
    ...call('Bash', { command: 'npm test' }, 'PASS src/parser.test.ts\nPASS src/checkout.test.ts\nTest Suites: 2 passed, 2 total'),
    assistant('Everything passes; change isolated to the parser.'),
    user('Great. Next, add a changelog entry for this fix.'),
  );
  return msgs;
}

const [, , label = 'run', noise = '0', stateTok, reqTok] = process.argv;
const options: Record<string, number> = {};
if (stateTok) options.maxStateTokens = Number(stateTok);
if (reqTok) options.maxRequestTokens = Number(reqTok);

const log: string[] = [];
const loggingFetch: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  const t0 = Date.now();
  const res = await fetch(url, init);
  const clone = res.clone();
  const text = await clone.text();
  let extra = '';
  try {
    const j = JSON.parse(text);
    extra = j.x_rizzo ? ` infer=${j.x_rizzo.timing.inference_seconds.toFixed(2)}s in_tok=${j.usage?.input_tokens}` : ` body=${text.slice(0, 160)}`;
  } catch { extra = ` body=${text.slice(0, 160)}`; }
  log.push(`[req] http=${res.status} questions=${Object.keys(body.questions).length} model=${body.model} wall=${Date.now() - t0}ms${extra}`);
  return res;
};

const messages = scenario(Number(noise));
console.log(`== ${label}: ${messages.length} messages, options=${JSON.stringify(options)}`);
try {
  const result = await compactMessages(messages, {
    baseUrl: BASE_URL,
    model: 'rizzo-latest',
    apiKey: 'dummy-not-a-real-key',
    fetch: loggingFetch,
    preserveRecentMessages: 4,
    ...options,
  });
  log.forEach((l) => console.log(l));
  const byId = new Map<string, string>();
  for (const m of messages) for (const t of m.toolUses) byId.set(`t${byId.size + 1}`, `${t.tool} ${JSON.stringify(t.input).slice(0, 60)}`);
  console.log('id | action | keepCall | keepResult | call');
  for (const d of result.decisions) {
    console.log(`${d.id} | ${d.action}(${d.reason}) | ${d.keepCall.toFixed(2)} | ${d.keepResult.toFixed(2)} | ${byId.get(d.id)}`);
  }
  console.log('stats:', JSON.stringify(result.stats));
  console.log(`chars saved: ${(reductionRatio(result) * 100).toFixed(1)}%`);
} catch (e) {
  log.forEach((l) => console.log(l));
  console.log('ERROR:', (e as Error).message);
}
