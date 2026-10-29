// `relay mcp --thread <id>`: the stdio MCP server each agent starts for its chat. Stateless: every call reads the store,
// so any number of these (one per agent process) can run beside the app. Read-only except for request_approval, which
// leaves a question for the app to show. Every call is logged to events/<thread>.jsonl so the app sees it (e.g. "the
// handoff context was loaded").
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Store, artifactsDir } from './store.mjs';
import { buildHandoff, listArtifacts, agentName } from './handoff.mjs';
import { appendLine, newId, samePath, short, writeJson } from './util.mjs';
import { listSkills, readSkill } from './skills.mjs';
import { relayNote } from './agents/common.mjs';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const TOOLS = [
  {
    name: 'get_handoff_context',
    description: 'Load what happened in the Relay chat this one continues (or the given thread): first request, files changed, commands and results, artifacts, recent turns, last answer. Call it first when a chat says it continues another Relay thread.',
    inputSchema: { type: 'object', properties: { thread_id: { type: 'string', description: 'Optional. Defaults to the chat this one continues.' } } },
    annotations: { readOnlyHint: true, title: 'Load handoff context' },
  },
  {
    name: 'get_thread_turns',
    description: 'Older turns of a Relay thread, page by page (newest first before `before`).',
    inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, before: { type: 'number', description: 'Turn number to page back from' }, limit: { type: 'number', description: 'At most 50, default 20' } }, required: ['thread_id'] },
    annotations: { readOnlyHint: true, title: 'Older turns' },
  },
  {
    name: 'list_threads',
    description: 'Relay chats in this project folder (or every project), with agent, state and title.',
    inputSchema: { type: 'object', properties: { all_projects: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, title: 'List chats' },
  },
  {
    name: 'list_artifacts',
    description: 'Files made for the user in a Relay thread (default: this chat). Read them with your own file tools.',
    inputSchema: { type: 'object', properties: { thread_id: { type: 'string' } } },
    annotations: { readOnlyHint: true, title: 'List artifacts' },
  },
  {
    name: 'list_skills',
    description: "The user's Relay skills library: name and description of each skill.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, title: 'List skills' },
  },
  {
    name: 'get_skill',
    description: 'The full SKILL.md of one skill from the Relay library.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    annotations: { readOnlyHint: true, title: 'Read a skill' },
  },
  {
    name: 'request_approval',
    description: 'Ask the user to decide something (a choice between options, a go/no-go) through Relay\'s approvals inbox, even when this chat is in the background. Their answer arrives as your next user message starting with "Answer:" (it may also be "Other: <their words>"). After calling this, end your turn and wait.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, details: { type: 'string', description: 'Short context the user needs to decide' }, options: { type: 'array', items: { type: 'string' }, description: 'Up to 5 answers to choose from' } }, required: ['question'] },
    annotations: { readOnlyHint: false, title: 'Ask the user' },
  },
];

export async function runMcp(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (get('--home')) process.env.RELAY_HOME = get('--home');
  const store = new Store();
  let threadId = get('--thread');
  const agent = get('--agent');
  const cwd = get('--cwd') || process.cwd();

  /** A shared config file (agy's .agents/mcp_config.json) cannot name one thread: find the live chat of that agent here. */
  const resolveThread = () => {
    if (threadId && threadId !== 'auto') return store.getThread(threadId, { fresh: true });
    const cands = store.listThreads().filter(t => (!agent || t.agent === agent) && samePath(t.cwd, cwd)).sort((a, b) => (b.startedAt || b.created) - (a.startedAt || a.created));
    return cands.find(t => t.state !== 'ended') || cands[0] || null;
  };
  // started by Gemini outside a Relay chat (the extension passes "none"): offer nothing
  const inert = threadId === 'none' || threadId === '' || threadId === '${RELAY_THREAD:-none}';
  const self = () => (inert ? null : resolveThread());
  const log = (tool, extra = {}) => { const t = self(); if (t) appendLine(store.file('events', `${t.id}.jsonl`), { type: 'mcp', tool, ts: Date.now(), ...extra }); };

  const text = (s) => ({ content: [{ type: 'text', text: s }] });
  const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

  const call = async (name, a = {}) => {
    const me = self();
    switch (name) {
      case 'get_handoff_context': {
        const id = a.thread_id || me?.parentId;
        if (!id) {
          const others = store.listThreads().filter(t => t.id !== me?.id && samePath(t.project, me?.project)).slice(-8);
          log(name, { none: true });
          return text(`This chat does not continue another Relay thread.${others.length ? ` Recent threads in this project:\n${others.map(t => `- ${t.id} · ${agentName(t.agent)} · ${t.title}`).join('\n')}\nCall get_handoff_context with one of these thread_id values to load it.` : ''}`);
        }
        const t = store.getThread(id, { fresh: true });
        if (!t) return fail(`No Relay thread ${id}.`);
        log(name, { target: id });
        return text(buildHandoff(t));
      }
      case 'get_thread_turns': {
        const t = store.getThread(a.thread_id, { fresh: true });
        if (!t) return fail(`No Relay thread ${a.thread_id}.`);
        const limit = Math.min(50, Math.max(1, a.limit || 20));
        const before = a.before || Infinity;
        const page = t.turns.filter(x => x.seq < before).slice(-limit);
        log(name, { target: t.id });
        if (!page.length) return text('No older turns.');
        return text(page.map(x => `#${x.seq} ${x.role === 'user' ? 'User' : agentName(t.agent)}: ${x.text}`).join('\n\n') + (page[0].seq > 1 ? `\n\n(older: before=${page[0].seq})` : ''));
      }
      case 'list_threads': {
        const all = store.listThreads().filter(t => a.all_projects || !me || samePath(t.project, me.project));
        log(name);
        return text(all.map(t => `- ${t.id} · ${agentName(t.agent)} · ${t.state} · "${t.title}" · ${t.cwd}${t.parentId ? ` · continues ${t.parentId}` : ''}${t.id === me?.id ? ' (this chat)' : ''}`).join('\n') || 'No threads.');
      }
      case 'list_artifacts': {
        const t = a.thread_id ? store.getThread(a.thread_id, { fresh: true }) : me;
        if (!t) return fail('No such thread.');
        const arts = listArtifacts(t);
        log(name, { target: t.id });
        return text(arts.length ? arts.map(x => `- ${x.path} (${x.size} bytes)`).join('\n') : `No artifacts yet. Folder: ${artifactsDir(t)}`);
      }
      case 'list_skills': {
        log(name);
        const s = listSkills(store).filter(x => x.enabled);
        return text(s.length ? s.map(x => `- ${x.name}: ${x.description}`).join('\n') : 'The Relay skills library is empty.');
      }
      case 'get_skill': {
        const s = readSkill(store, a.name);
        log(name, { target: a.name });
        return s ? text(s) : fail(`No skill named ${a.name}.`);
      }
      case 'request_approval': {
        if (!me) return fail('This MCP server is not bound to a Relay chat.');
        const id = newId('q_');
        const opts = Array.isArray(a.options) ? a.options.slice(0, 5).map(x => short(x, 120)) : [];
        writeJson(store.file('requests', `${id}.json`), { id, threadId: me.id, question: short(a.question, 400), details: short(a.details || '', 1200), options: opts, ts: Date.now() });
        log(name, { request: id });
        return text('Shown to the user in Relay. Their answer will arrive as your next user message, starting with "Answer:" (or "Other:"). End your turn now and wait for it.');
      }
      default: return fail(`Unknown tool ${name}`);
    }
  };

  const write = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const reply = (result) => m.id !== undefined && write({ jsonrpc: '2.0', id: m.id, result });
    const error = (code, message) => m.id !== undefined && write({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    try {
      switch (m.method) {
        case 'initialize': {
          const want = m.params?.protocolVersion;
          const me = self();
          const note = me ? relayNote(me, artifactsDir(me)) : inert ? '' : 'Relay MCP server.';
          reply({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'relay', title: 'Relay', version: '0.1.0' }, instructions: note });
          break;
        }
        case 'notifications/initialized': case 'notifications/cancelled': break;
        case 'ping': reply({}); break;
        case 'tools/list': reply({ tools: inert ? [] : TOOLS }); break;
        case 'tools/call': reply(await call(m.params?.name, m.params?.arguments || {})); break;
        case 'resources/list': reply({ resources: [] }); break;
        case 'prompts/list': reply({ prompts: [] }); break;
        default: if (m.id !== undefined) error(-32601, `Method not found: ${m.method}`);
      }
    } catch (e) {
      error(-32603, String(e?.message || e));
    }
  });
  rl.on('close', () => process.exit(0));
}
