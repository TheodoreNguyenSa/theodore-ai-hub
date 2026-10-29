#!/usr/bin/env node
// A scripted stand-in for the model APIs that the real CLIs call, so their real transcripts, MCP calls and
// permission prompts can be seen and tested without an account or quota.
//
//   node tools/fake-model.mjs --port 8787 [--log fake-model.log]
//
//   Claude Code : ANTHROPIC_BASE_URL=http://127.0.0.1:8787  ANTHROPIC_API_KEY=sk-ant-fake-...
//   Codex       : -c model_provider=fake -c model_providers.fake.base_url="http://127.0.0.1:8787/v1"
//                 -c model_providers.fake.wire_api="responses" -c model_providers.fake.env_key="FAKE_KEY"
//   Gemini CLI  : GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787  GEMINI_API_KEY=fake
//
// What the "model" does is decided by directives in the user's last message:
//   [[shell:<command>]]    call the agent's shell tool with that command
//   [[write:<path>|<text>]] call the agent's file-write tool
//   [[mcp:<substring>]]    call the first tool whose name contains <substring> (e.g. get_handoff_context)
//   anything else          reply with one line of text
// After a tool result comes back it answers "Done." (with the first line of the result).
import http from 'node:http';
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', process.env.FAKE_MODEL_PORT || 8787));
const logFile = () => arg('--log', process.env.FAKE_MODEL_LOG || '');
let lastBody = '';

function log(o) {
  const f = logFile();
  if (!f) return;
  // which Theodore AI Hub thread note (if any) reached the model in this request
  const relay = (lastBody.match(/Theodore AI Hub thread t_[0-9a-f]+/) || [])[0];
  fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...o, relayNote: relay || null }) + '\n');
}

/** Parse the directive out of a user text. */
export function directive(text) {
  text = String(text || '');
  // Theodore AI Hub's handoff prompt (checked first: it quotes the earlier chat's title, which may hold a directive)
  if (/This chat continues the Theodore AI Hub thread/.test(text)) return { kind: 'mcp', name: 'get_handoff_context' };
  let m = text.match(/\[\[shell:([\s\S]+?)\]\]/);
  if (m) return { kind: 'shell', command: m[1].trim() };
  m = text.match(/\[\[write:([^|\]]+)\|([\s\S]*?)\]\]/);
  if (m) return { kind: 'write', path: m[1].trim(), content: m[2] };
  m = text.match(/\[\[mcp:([^\]]+)\]\]/);
  if (m) return { kind: 'mcp', name: m[1].trim() };
  return { kind: 'text', text: `Fake reply to: ${text.replace(/\s+/g, ' ').slice(0, 80)}` };
}

const sse = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  return (event, data) => res.write((event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`);
};

const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
let seq = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

/* ---------------- Anthropic Messages API (Claude Code) ---------------- */
function claudePlan(body) {
  const msgs = body.messages || [];
  // every user message after the last assistant one (Claude Code can split reminders and the prompt)
  let i = msgs.length; while (i > 0 && msgs[i - 1].role !== 'assistant') i--;
  const blocks = msgs.slice(i).flatMap(m => typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []));
  const result = blocks.find(b => b.type === 'tool_result');
  const tools = (body.tools || []).map(t => t.name).filter(Boolean);
  // the directive is in the newest real user text (it may be several requests back, behind tool calls)
  const userTexts = msgs.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content || []).filter(b => b.type === 'text').map(b => b.text));
  const lastDirective = [...userTexts].reverse().map(directive).find(x => x.kind !== 'text');
  if (result) {
    const prev = msgs[i - 1];
    const use = (prev?.content || []).find?.(b => b.type === 'tool_use' && b.id === result.tool_use_id);
    // Claude Code defers MCP tools behind ToolSearch: after the search, the tool is in the list; call it now
    if (use?.name === 'ToolSearch' && lastDirective?.kind === 'mcp') {
      const n = tools.find(t => t.includes(lastDirective.name));
      if (n) return { tool: { name: n, input: {} } };
    }
    const txt = typeof result.content === 'string' ? result.content : (result.content || []).map(c => c.text || '').join('\n');
    return { text: `Done. ${txt.split('\n').find(Boolean)?.slice(0, 120) || ''}`.trim() };
  }
  const userText = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
  // Claude Code sends side requests without tools (titles, summaries): answer them plainly
  if (!tools.length) return { text: 'Fake title' };
  const d = directive(userText);
  if (d.kind === 'mcp' && !tools.some(t => t.includes(d.name)) && tools.includes('ToolSearch')) {
    return { tool: { name: 'ToolSearch', input: { query: `select:mcp__theodore__${d.name}`, max_results: 5 } } };
  }
  if (d.kind === 'shell' && tools.includes('Bash')) return { tool: { name: 'Bash', input: { command: d.command, description: 'Run the requested command' } } };
  if (d.kind === 'shell' && tools.includes('PowerShell')) return { tool: { name: 'PowerShell', input: { command: d.command } } };
  if (d.kind === 'write' && tools.includes('Write')) return { tool: { name: 'Write', input: { file_path: d.path, content: d.content } } };
  if (d.kind === 'mcp') { const n = tools.find(t => t.includes(d.name)); if (n) return { tool: { name: n, input: {} } }; }
  return { text: d.text || 'ok' };
}

function anthropic(req, res, body) {
  const plan = claudePlan(body);
  log({ api: 'anthropic', path: req.url, model: body.model, tools: (body.tools || []).map(t => t.name), stream: !!body.stream, plan, last: JSON.stringify((body.messages || []).slice(-1)).slice(0, 1500) });
  const msgId = id('msg');
  const usage = { input_tokens: 120, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const content = plan.tool ? [{ type: 'tool_use', id: id('toolu'), name: plan.tool.name, input: plan.tool.input }] : [{ type: 'text', text: plan.text }];
  const stop = plan.tool ? 'tool_use' : 'end_turn';
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: msgId, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage }));
  }
  const send = sse(res);
  send('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  content.forEach((c, i) => {
    if (c.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } });
    } else {
      send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    }
    send('content_block_stop', { type: 'content_block_stop', index: i });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

/* ---------------- OpenAI Responses API (Codex) ---------------- */
function textOf(item) {
  if (!item) return '';
  if (typeof item.content === 'string') return item.content;
  return (item.content || []).map(c => c.text || '').join('\n');
}
function codexPlan(body) {
  const input = body.input || [];
  const last = input[input.length - 1] || {};
  const tools = (body.tools || []).map(t => t.name || t.type).filter(Boolean);
  // MCP servers arrive as namespace tools: {type:'namespace', name:'mcp__theodore', tools:[{name:'get_handoff_context'}…]}
  const nsTools = (body.tools || []).filter(t => t.type === 'namespace').flatMap(ns => (ns.tools || []).map(f => ({ ns: ns.name, name: f.name })));
  if (/_output$/.test(last.type || '')) {
    const out = typeof last.output === 'string' ? last.output : JSON.stringify(last.output);
    return { text: `Done. ${String(out).split('\n').find(Boolean)?.slice(0, 120) || ''}`.trim() };
  }
  const user = [...input].reverse().find(i => i.role === 'user' && !/^<(environment_context|user_instructions|permissions)/.test(textOf(i).trim()));
  const d = directive(textOf(user));
  if (d.kind === 'shell') {
    // ask for unsandboxed execution, so Codex shows its approval prompt (the case Theodore AI Hub must catch)
    if (tools.includes('exec_command')) return { call: { name: 'exec_command', arguments: { cmd: d.command, sandbox_permissions: 'require_escalated', justification: 'Do you want to let the probe write a file?' } } };
    if (tools.includes('shell_command')) return { call: { name: 'shell_command', arguments: { command: d.command } } };
    if (tools.includes('shell')) return { call: { name: 'shell', arguments: { command: ['bash', '-lc', d.command] } } };
  }
  if (d.kind === 'mcp') {
    const f = nsTools.find(t => t.name.includes(d.name));
    if (f) return { call: { name: process.env.FAKE_CODEX_MCP_NAME === 'joined' ? `${f.ns}__${f.name}` : f.name, namespace: f.ns, arguments: {} } };
    const n = tools.find(t => t.includes(d.name)); if (n) return { call: { name: n, arguments: {} } };
  }
  if (d.kind === 'write' && tools.includes('apply_patch')) {
    return { custom: { name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${d.path}\n${d.content.split('\n').map(l => '+' + l).join('\n')}\n*** End Patch\n` } };
  }
  return { text: d.text || 'ok' };
}

function openai(req, res, body) {
  const plan = codexPlan(body);
  log({ api: 'openai', path: req.url, model: body.model, tools: (body.tools || []).map(t => t.name || t.type), plan, lastInput: (body.input || []).slice(-1), toolSpecs: process.env.FAKE_MODEL_SPECS ? body.tools : undefined });
  const respId = id('resp');
  const send = sse(res);
  const base = { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'in_progress', output: [] };
  send('response.created', { type: 'response.created', sequence_number: 0, response: base });
  let item;
  if (plan.call) item = { type: 'function_call', id: id('fc'), call_id: id('call'), name: plan.call.name, ...(plan.call.namespace ? { namespace: plan.call.namespace } : {}), arguments: JSON.stringify(plan.call.arguments), status: 'completed' };
  else if (plan.custom) item = { type: 'custom_tool_call', id: id('ctc'), call_id: id('call'), name: plan.custom.name, input: plan.custom.input, status: 'completed' };
  else item = { type: 'message', id: id('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: plan.text, annotations: [] }] };
  send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : {}) } });
  if (item.type === 'message') send('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: plan.text });
  send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
  send('response.completed', { type: 'response.completed', response: { ...base, status: 'completed', output: [item], usage: { input_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 160 } } });
  res.end();
}

/* ---------------- Gemini API (Gemini CLI) ---------------- */
function geminiPlan(body) {
  const contents = body.contents || [];
  const last = contents[contents.length - 1] || {};
  const parts = last.parts || [];
  const decl = (body.tools || []).flatMap(t => t.functionDeclarations || []).map(f => f.name);
  if (body.generationConfig?.responseMimeType === 'application/json' || body.generationConfig?.responseJsonSchema || body.generationConfig?.responseSchema) {
    return { json: { next_speaker: 'user', reasoning: 'fake', model_choice: 'flash', complexity_reasoning: 'fake', complexity_score: 1 } };
  }
  const fr = parts.find(p => p.functionResponse);
  if (fr) return { text: `Done. ${JSON.stringify(fr.functionResponse.response || {}).slice(0, 120)}` };
  const text = parts.map(p => p.text || '').join('\n');
  const d = directive(text);
  if (d.kind === 'shell' && decl.includes('run_shell_command')) return { call: { name: 'run_shell_command', args: { command: d.command, description: 'Run the requested command' } } };
  if (d.kind === 'write' && decl.includes('write_file')) return { call: { name: 'write_file', args: { file_path: d.path, content: d.content } } };
  if (d.kind === 'mcp') { const n = decl.find(t => t.includes(d.name)); if (n) return { call: { name: n, args: {} } }; }
  return { text: d.text || 'ok' };
}

function gemini(req, res, body) {
  const plan = geminiPlan(body);
  log({ api: 'gemini', path: req.url, tools: (body.tools || []).flatMap(t => t.functionDeclarations || []).map(f => f.name), plan });
  const parts = plan.call ? [{ functionCall: { name: plan.call.name, args: plan.call.args } }] : [{ text: plan.json ? JSON.stringify(plan.json) : plan.text }];
  const chunk = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 8, totalTokenCount: 108 }, modelVersion: 'fake' };
  if (/countTokens/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ totalTokens: 100 })); }
  if (/streamGenerateContent/.test(req.url)) { const send = sse(res); send(null, chunk); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(chunk));
}

export function startFakeModel(port = PORT) {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    if (req.method === 'GET') {
      log({ api: 'get', path: url });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (/models/.test(url)) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }], models: [] }));
      return res.end('{}');
    }
    const body = await readBody(req);
    lastBody = JSON.stringify(body);
    if (/\/messages\/count_tokens/.test(url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 100 })); }
    if (/\/v1\/messages/.test(url)) return anthropic(req, res, body);
    if (/\/responses/.test(url)) return openai(req, res, body);
    if (/:(stream)?[gG]enerateContent|:countTokens/.test(url)) return gemini(req, res, body);
    log({ api: 'unknown', method: req.method, path: url });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not faked"}');
  });
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fake-model.mjs')) {
  startFakeModel().then(s => console.log(`fake model on http://127.0.0.1:${s.address().port}`));
}
