// Gemini CLI. Verified with 0.66.0 against tools/fake-model.mjs:
//   session     --session-id <uuid> (we choose it); transcript ~/.gemini/tmp/<project name>/chats/session-<time>-<id first 8>.jsonl
//               JSONL: a header {sessionId, projectHash}, then messages {id, type: user|gemini, content, toolCalls, tokens};
//               a message is written again (same id) when it changes; {"$set": …} lines carry metadata
//   MCP         a small extension, ~/.gemini/extensions/theodore/gemini-extension.json, whose relay server takes the thread from
//               the environment: --thread ${RELAY_THREAD:-none} (Gemini expands env vars in extension files; verified 0.66).
//               Outside Theodore AI Hub RELAY_THREAD is unset, the server starts with "none" and offers no tools. trust: true, so our
//               read-only tools never prompt. ~/.gemini/settings.json is not touched.
//               (Not GEMINI_CLI_SYSTEM_SETTINGS_PATH: Gemini skips a system settings file that is not admin-owned, which on
//               Windows is any file Theodore AI Hub could write.)
//   policy      --policy <per-thread .toml> allowing mcp_theodore_* (extension policies cannot allow)
//   prompt      -i "<prompt>" (runs it, stays interactive); skip: --approval-mode yolo
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, readJson, uuid, writeJson } from '../util.mjs';
import { classifyTool, finishAcc, isInjected, newAcc, pushTurn, textOf, upsertTool } from './common.mjs';

const home = () => path.join(process.env.GEMINI_CLI_HOME || HOME_DIR, '.gemini');

/** Write (or refresh) Theodore AI Hub's Gemini extension: paths change when Theodore AI Hub is reinstalled or moved. */
export function ensureExtension(mcp) {
  const dir = path.join(home(), 'extensions', 'theodore');
  const file = path.join(dir, 'gemini-extension.json');
  const args = mcp.args.map(a => a);
  const at = args.indexOf('--thread');
  if (at >= 0) args[at + 1] = '${RELAY_THREAD:-none}';
  const want = {
    name: 'theodore',
    version: '0.1.0',
    description: 'Theodore AI Hub desktop app: handoff context, threads, artifacts and skills shared with your other coding agents. Only active in chats started by Theodore AI Hub.',
    mcpServers: { theodore: { command: mcp.command, args, trust: true, timeout: 60000 } },
  };
  const cur = readJson(file, null);
  if (JSON.stringify(cur) !== JSON.stringify(want)) writeJson(file, want);
  return file;
}

export default {
  id: 'gemini',
  name: 'Gemini CLI',
  letter: 'G',
  bins: ['gemini'],
  skipFlag: '--approval-mode yolo',
  models: ['', 'gemini-3.8-pro', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  efforts: [''],
  install: { win: 'npm install -g @google/gemini-cli', other: 'npm install -g @google/gemini-cli', npm: 'npm install -g @google/gemini-cli' },
  promptMode: 'arg',
  home,

  login() {
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return { state: 'api key', ok: true };
    const h = home();
    if (fs.existsSync(path.join(h, 'oauth_creds.json'))) return { state: 'logged in', ok: true };
    const s = readJson(path.join(h, 'settings.json'), {});
    if (s?.security?.auth?.selectedType) return { state: 'configured', ok: true, detail: s.security.auth.selectedType };
    return { state: 'not logged in', ok: false, detail: 'start a chat: Gemini CLI asks how to sign in' };
  },

  launch(o) {
    const sessionId = o.resumeId || uuid();
    ensureExtension(o.mcp);
    // our tools are read-only (request_approval only shows a question): allow them for this session only.
    // An extension cannot allow tools (Gemini ignores "allow" in extension policies), a --policy file can.
    const policy = path.join(o.files, `${o.thread.id}.gemini-policy.toml`);
    fs.writeFileSync(policy, '# Theodore AI Hub: let this chat call the theodore MCP tools without asking\n[[rule]]\ntoolName = "mcp_theodore_*"\ndecision = "allow"\npriority = 900\n');
    const args = o.resumeId ? ['--resume', sessionId] : ['--session-id', sessionId];
    args.push('--policy', policy);
    if (o.model) args.push('-m', o.model);
    if (o.skip) args.push('--approval-mode', 'yolo');
    if (o.prompt) args.push('-i', o.prompt);
    return { args, env: {}, sessionId };
  },

  findTranscript(t) {
    if (t.transcriptPath && fs.existsSync(t.transcriptPath)) return t.transcriptPath;
    if (!t.nativeSessionId) return null;
    const root = path.join(home(), 'tmp');
    const tag = t.nativeSessionId.slice(0, 8);
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return null; }
    for (const d of dirs) {
      const chats = path.join(root, d, 'chats');
      let files = [];
      try { files = fs.readdirSync(chats); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith('session-') || !f.includes(tag)) continue;
        const p = path.join(chats, f);
        try { if (fs.readFileSync(p, 'utf8').slice(0, 400).includes(t.nativeSessionId)) return p; } catch { /* */ }
      }
    }
    return null;
  },

  newAcc() { const a = newAcc(); a.msgs = new Map(); return a; },
  reduce(acc, o) {
    if (o.sessionId && o.projectHash) { acc.sessionId = o.sessionId; return; }
    if (o.$set || !o.id || !o.type) return;
    acc.msgs.set(o.id, o); // a later copy of a message replaces the earlier one; Map keeps first-insertion order
  },
  finish(acc) {
    acc.turns = []; acc.tools = []; acc.toolIndex = new Map(); acc.seq = 0;
    let last = null;
    for (const m of acc.msgs.values()) {
      if (m.type === 'user') {
        const parts = Array.isArray(m.content) ? m.content : [{ text: textOf(m.content) }];
        if (parts.every(p => p.functionResponse)) continue;
        const tx = parts.map(p => p.text || '').join('\n');
        if (!isInjected(tx)) { pushTurn(acc, 'user', tx, m.timestamp); last = m; }
      } else if (m.type === 'gemini') {
        for (const tc of m.toolCalls || []) {
          const c = classifyTool(tc.name, tc.args);
          const res = textOf((tc.result || []).map(r => r.functionResponse?.response?.output ?? r.functionResponse?.response?.error ?? JSON.stringify(r.functionResponse?.response || '')));
          upsertTool(acc, tc.id, { ...c, status: tc.status === 'success' ? 'ok' : tc.status === 'error' || tc.status === 'cancelled' ? 'error' : 'running', result: res, ts: Date.parse(tc.timestamp || m.timestamp) || Date.now() });
        }
        pushTurn(acc, 'assistant', textOf(m.content), m.timestamp);
        if (m.tokens) acc.usage = { input: m.tokens.input, output: m.tokens.output, context: (m.tokens.input || 0) + (m.tokens.cached || 0), model: m.model };
        last = m;
      } else if (m.type === 'error' || m.type === 'warning') {
        pushTurn(acc, 'assistant', `⚠ ${textOf(m.content)}`, m.timestamp);
      }
    }
    // busy while the last thing is the user's message or a tool call still running
    if (last) acc.busy = last.type === 'user' || (last.toolCalls || []).some(tc => !['success', 'error', 'cancelled'].includes(tc.status)) || (last.type === 'gemini' && !textOf(last.content) && (last.toolCalls || []).length > 0);
    return finishAcc(acc);
  },
};
