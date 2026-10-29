// Shared pieces of the CLI adapters: normalised tool calls, text extraction, the note every agent gets.
import fs from 'node:fs';
import path from 'node:path';
import { short } from '../util.mjs';

/** What every chat is told at start (not in the user's prompt): where files for the user go, how to ask. */
export function relayNote(t, artifactsPath) {
  return `This chat is Relay thread ${t.id}. Files meant for the user (notes, plans, reports, mockups, anything that is not source code of the project) go in ${artifactsPath} (create it if missing); Relay shows them in its Artifacts view. To continue work from another Relay chat, call the relay MCP tool get_handoff_context. To ask the user to choose between options, you may call the relay tool request_approval and then end your turn.`;
}

/** TOML string for codex -c overrides: a literal string when possible (no escaping of Windows backslashes). */
export function tomlStr(s) {
  s = String(s);
  if (!/['\n\r]/.test(s)) return `'${s}'`;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
}
export const tomlArr = (a) => '[' + a.map(tomlStr).join(',') + ']';

/** Plain text out of the many content shapes the CLIs use (string, [{type:'text',text}], [{text}], {parts}). */
export function textOf(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(textOf).filter(Boolean).join('\n');
  if (typeof c === 'object') {
    if (typeof c.text === 'string') return c.text;
    if (c.parts) return textOf(c.parts);
    if (c.content) return textOf(c.content);
    if (typeof c.message === 'string') return c.message;
  }
  return '';
}

/** Text the CLI injected itself (environment blocks, reminders, slash-command echoes): not a real user turn. */
export function isInjected(text) {
  const s = String(text || '').trim();
  return !s || /^<(system-reminder|environment_context|user_instructions|session_context|command-|local-command|permissions|skills_instructions|user-prompt-submit-hook|turn_aborted|bash-|task-notification)/i.test(s) || /^Caveat: The messages below were generated/.test(s);
}

const FILE_TOOLS = /^(write|edit|multiedit|notebookedit|write_file|replace|edit_file|create_file|str_replace|apply_patch|create|modify)$/i;
const CMD_TOOLS = /^(bash|powershell|shell|shell_command|exec_command|local_shell|run_shell_command|run_command|terminal|command)$/i;
const READ_TOOLS = /^(read|read_file|read_many_files|view|glob|grep|grep_search|list_directory|ls|search_file_content|view_image|cat)$/i;

/** Normalise one tool call into {name, kind, target}. */
export function classifyTool(name, input) {
  const n = String(name || 'tool');
  const i = input && typeof input === 'object' ? input : safeJson(input) || {};
  const base = n.replace(/^mcp__[^_]+__/, '').replace(/^functions\./, '');
  if (/^mcp__|^mcp_|\//.test(n) || /relay/.test(n)) return { name: n, kind: 'mcp', target: n.replace(/^mcp__/, '').replace('__', '.') };
  if (FILE_TOOLS.test(base)) {
    const files = i.file_path || i.path || i.notebook_path || i.filename || i.target_file || (typeof i.input === 'string' ? patchFiles(i.input).join(', ') : '') || (typeof input === 'string' ? patchFiles(input).join(', ') : '');
    return { name: n, kind: 'edit', target: String(files || '') };
  }
  if (CMD_TOOLS.test(base)) {
    const c = i.command ?? i.cmd ?? i.script ?? i.CommandLine;
    return { name: n, kind: 'command', target: Array.isArray(c) ? unwrapShell(c) : String(c ?? '') };
  }
  if (READ_TOOLS.test(base)) return { name: n, kind: 'read', target: String(i.file_path || i.path || i.pattern || i.absolute_path || i.dir_path || '') };
  const first = Object.values(i).find(v => typeof v === 'string');
  return { name: n, kind: 'other', target: short(first || '', 100) };
}

/** ["bash","-lc","npm test"] → "npm test"; ["powershell.exe","-Command","x"] → "x". */
export function unwrapShell(arr) {
  const a = arr.map(String);
  if (a.length >= 3 && /(^|[\\/])(bash|sh|zsh|pwsh|powershell)(\.exe)?$/i.test(a[0]) && /^-(l?c|Command|NoProfile)$/i.test(a[a.length - 2])) return a[a.length - 1];
  if (a.length >= 3 && /cmd(\.exe)?$/i.test(a[0]) && /^\/c$/i.test(a[1])) return a.slice(2).join(' ');
  return a.join(' ');
}

/** Files named in an apply_patch body. */
export function patchFiles(p) {
  const out = [];
  for (const m of String(p).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  return out;
}

export function safeJson(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Read a JSONL file from a byte offset; returns new records and the next offset (a half-written last line waits). */
export function readJsonlFrom(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < offset) offset = 0; // truncated or replaced: start again
    if (size === offset) return { records: [], offset, reset: false };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { records: [], offset };
    const records = [];
    for (const line of text.slice(0, lastNl).split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { records.push(JSON.parse(l)); } catch { /* not JSON: skip */ }
    }
    return { records, offset: offset + Buffer.byteLength(text.slice(0, lastNl + 1)) };
  } catch {
    return { records: [], offset };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
}

/** Newest files under `dir` matching `test`, modified after `since` (ms). Depth-limited walk. */
export function newFiles(dir, test, since, depth = 4) {
  const out = [];
  const walk = (d, lv) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (lv < depth) walk(p, lv + 1); continue; }
      if (!test(p)) continue;
      try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push({ path: p, mtime: st.mtimeMs, birth: st.birthtimeMs || st.ctimeMs, size: st.size }); } catch { /* */ }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.birth - b.birth);
}

export function headOf(file, bytes = 65536) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

/** The accumulator every adapter's reducer fills. */
export function newAcc() {
  return { turns: [], tools: [], toolIndex: new Map(), usage: {}, busy: null, sessionId: null, cliVersion: null, title: null, seq: 0, lastAssistantId: null };
}

export function pushTurn(acc, role, text, ts, mergeKey) {
  text = String(text || '').trim();
  if (!text) return;
  const last = acc.turns[acc.turns.length - 1];
  if (mergeKey && last && last.role === role && last.key === mergeKey) { if (!last.text.endsWith(text)) last.text += '\n' + text; return; }
  // several CLIs write the same message twice in a row (an event and a response item): keep one
  if (last && last.role === role && last.text === text) return;
  acc.turns.push({ seq: ++acc.seq, role, text, ts: ts ? Date.parse(ts) || ts : Date.now(), key: mergeKey });
}

export function upsertTool(acc, id, patch) {
  let t = id ? acc.toolIndex.get(id) : null;
  if (!t) {
    t = { seq: ++acc.seq, id: id || `x${acc.seq}`, name: 'tool', kind: 'other', target: '', status: 'running', result: '', ts: Date.now() };
    acc.tools.push(t);
    if (id) acc.toolIndex.set(id, t);
  }
  Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  if (t.result) t.result = short(t.result, 160);
  return t;
}

/** Strip the private fields before storing. */
export function finishAcc(acc) {
  return {
    turns: acc.turns.map(({ key, ...t }) => t),
    tools: acc.tools,
    usage: acc.usage,
    busy: acc.busy,
    sessionId: acc.sessionId,
    cliVersion: acc.cliVersion,
    title: acc.title,
  };
}
