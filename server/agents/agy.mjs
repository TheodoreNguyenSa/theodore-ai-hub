// Antigravity CLI (agy). NOT verified on Windows: the facts below come from what the Chorus project documented for agy 1.4.x
// on macOS, and the reducer is deliberately tolerant. Everything here can be overridden in ~/.relay/agents.json
// (see server/agents/index.mjs) without rebuilding Relay.
//   MCP         workspace .agents/mcp_config.json (agy reads it from the chat folder; Relay adds its server, keeps yours)
//   session     agy picks it; --log-file <per-thread file> names it; transcript ~/.gemini/antigravity-cli/brain/<id>/…/transcript.jsonl
//   prompt      typed into the screen once it is ready
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, readJson, writeJson } from '../util.mjs';
import { classifyTool, finishAcc, isInjected, newAcc, newFiles, pushTurn, textOf, upsertTool } from './common.mjs';

const home = () => process.env.AGY_HOME || path.join(HOME_DIR, '.gemini', 'antigravity-cli');

function logFileOf(o) { return path.join(o.files, `${o.thread.id}.agy.log`); }

export default {
  id: 'agy',
  name: 'Antigravity',
  letter: 'A',
  bins: ['agy', 'antigravity'],
  skipFlag: '--yolo',
  models: [''],
  efforts: ['', 'low', 'medium', 'high'],
  install: { win: 'Install Antigravity from https://antigravity.google and enable its command line tool (agy)', other: 'https://antigravity.google', npm: '' },
  promptMode: 'type',
  anchorBottom: true, // agy draws from the top of the screen; the page shows it against the bottom
  home,

  login() {
    if (fs.existsSync(home())) return { state: 'installed', ok: null, detail: 'agy signs in on first start' };
    return { state: 'not set up', ok: null, detail: 'start a chat: agy signs in on its first start' };
  },

  launch(o) {
    // .agents/mcp_config.json in the chat folder: merge, never drop the user's own servers
    const cfgFile = path.join(o.thread.cwd, '.agents', 'mcp_config.json');
    const cfg = readJson(cfgFile, {}) || {};
    cfg.mcpServers = { ...(cfg.mcpServers || {}), relay: { command: o.mcp.command, args: o.mcp.agyArgs || o.mcp.args } };
    writeJson(cfgFile, cfg);
    const args = ['--log-file', logFileOf(o)];
    if (o.resumeId) args.push('--resume', o.resumeId);
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.skip) args.push('--yolo');
    return { args, env: {}, sessionId: o.resumeId || null, logFile: logFileOf(o) };
  },

  findTranscript(t, claimed = new Set(), files) {
    if (t.transcriptPath && fs.existsSync(t.transcriptPath)) return t.transcriptPath;
    const brain = path.join(home(), 'brain');
    let id = t.nativeSessionId;
    if (!id && files) {
      try {
        const log = fs.readFileSync(path.join(files, `${t.id}.agy.log`), 'utf8');
        id = /brain[\\/]([0-9a-zA-Z-]{8,})/.exec(log)?.[1] || /(?:conversation|session|cascade)[ _-]?id["':= ]+([0-9a-f-]{16,})/i.exec(log)?.[1] || null;
      } catch { /* no log yet */ }
    }
    if (id) {
      const found = newFiles(path.join(brain, id), p => /transcript\.jsonl$/.test(p), 0, 4);
      if (found.length) return found[found.length - 1].path;
    }
    const since = (t.startedAt || t.created) - 5000;
    const fresh = newFiles(brain, p => /transcript\.jsonl$/.test(p), since, 5).filter(f => !claimed.has(f.path) && f.birth >= since);
    return fresh.length === 1 ? fresh[0].path : null;
  },

  newAcc,
  reduce(acc, o) {
    // tolerant: look for a role and a text in the common shapes, then for tool calls
    const r = o.step || o.message || o.data || o;
    const role = String(r.role || r.type || r.author || r.source || '').toLowerCase();
    const text = textOf(r.content ?? r.text ?? r.message ?? r.parts);
    if (/user/.test(role)) { if (!isInjected(text)) { pushTurn(acc, 'user', text, o.timestamp || r.timestamp); acc.busy = true; } }
    else if (/assistant|model|planner|agent|gemini|response/.test(role)) {
      if (text) pushTurn(acc, 'assistant', text, o.timestamp || r.timestamp);
      const calls = r.toolCalls || r.tool_calls || r.functionCalls || [];
      for (const c of calls) {
        const name = c.name || c.function?.name || c.toolName || 'tool';
        upsertTool(acc, c.id || c.call_id, { ...classifyTool(name, c.args || c.arguments || c.function?.arguments || c.input), status: c.status === 'error' ? 'error' : c.status === 'success' || c.result ? 'ok' : 'running' });
      }
      acc.busy = calls.length > 0 && calls.some(c => !c.result && c.status !== 'success');
    } else if (/tool/.test(role) && (r.toolCallId || r.tool_call_id || r.id)) {
      upsertTool(acc, r.toolCallId || r.tool_call_id || r.id, { status: r.error || r.isError ? 'error' : 'ok', result: textOf(r.output ?? r.result ?? r.content) });
    }
    if (o.sessionId || o.conversationId) acc.sessionId = o.sessionId || o.conversationId;
  },
  finish: finishAcc,
};
