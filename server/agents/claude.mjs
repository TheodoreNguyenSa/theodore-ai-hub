// Claude Code. Verified with 2.1.312 against tools/fake-model.mjs (headless and in a PTY):
//   transcript  ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<session-id>.jsonl  (we choose the id: --session-id)
//   MCP         --mcp-config <file>; our tools pre-allowed through --settings permissions.allow ["mcp__relay"]
//   prompts     --permission-mode manual (2.1.30x starts in auto mode, which rarely asks); skip = --dangerously-skip-permissions
//   note        --append-system-prompt
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, uuid, writeJson } from '../util.mjs';
import { classifyTool, finishAcc, isInjected, newAcc, pushTurn, textOf, upsertTool } from './common.mjs';

const home = () => process.env.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude');

export default {
  id: 'claude',
  name: 'Claude Code',
  letter: 'C',
  bins: ['claude'],
  skipFlag: '--dangerously-skip-permissions',
  models: ['', 'fable', 'opus', 'sonnet', 'haiku'],
  efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  install: { win: 'irm https://claude.ai/install.ps1 | iex', other: 'curl -fsSL https://claude.ai/install.sh | bash', npm: 'npm install -g @anthropic-ai/claude-code' },
  promptMode: 'arg',
  home,

  login() {
    const h = home();
    if (process.env.ANTHROPIC_API_KEY) return { state: 'api key', ok: true };
    if (fs.existsSync(path.join(h, '.credentials.json'))) return { state: 'logged in', ok: true };
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(h), '.claude.json'), 'utf8'));
      if (cfg.oauthAccount) return { state: 'logged in', ok: true, detail: cfg.oauthAccount.emailAddress ? 'account' : '' };
    } catch { /* none */ }
    if (process.platform === 'darwin') return { state: 'unknown', ok: null, detail: 'keychain' };
    return { state: 'not logged in', ok: false, detail: 'start a chat: Claude Code asks you to sign in' };
  },

  /** Command line for one thread. `o.files` is where per-thread config files go. */
  launch(o) {
    const sessionId = o.resumeId || uuid();
    const mcpFile = path.join(o.files, `${o.thread.id}.claude-mcp.json`);
    const settingsFile = path.join(o.files, `${o.thread.id}.claude-settings.json`);
    writeJson(mcpFile, { mcpServers: { relay: { type: 'stdio', command: o.mcp.command, args: o.mcp.args } } });
    writeJson(settingsFile, { permissions: { allow: ['mcp__relay'] } });
    const args = [];
    if (o.prompt) args.push(o.prompt); // positional first: --mcp-config is variadic
    if (o.resumeId) args.push('--resume', sessionId); else args.push('--session-id', sessionId);
    args.push('--mcp-config', mcpFile, '--settings', settingsFile, '--append-system-prompt', o.note);
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.skip) args.push('--dangerously-skip-permissions'); else args.push('--permission-mode', o.permissionMode || 'manual');
    if (o.thread.title && o.thread.title !== 'New chat') args.push('--name', o.thread.title.slice(0, 60));
    return { args, env: {}, sessionId };
  },

  findTranscript(t) {
    if (t.transcriptPath && fs.existsSync(t.transcriptPath)) return t.transcriptPath;
    if (!t.nativeSessionId) return null;
    const root = path.join(home(), 'projects');
    // the folder is the cwd with every non-alphanumeric as '-' (C:\Users\me\app → C--Users-me-app); look in all of them anyway
    const guess = path.join(root, String(t.cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${t.nativeSessionId}.jsonl`);
    if (fs.existsSync(guess)) return guess;
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return null; }
    for (const d of dirs) {
      const p = path.join(root, d, `${t.nativeSessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  },

  newAcc,
  reduce(acc, o) {
    if (o.version) acc.cliVersion = o.version;
    if (o.sessionId) acc.sessionId = o.sessionId;
    if (o.type === 'summary' && o.summary) acc.title = o.summary;
    if ((o.type === 'custom-title' || o.type === 'ai-title') && (o.customTitle || o.aiTitle || o.title)) acc.title = o.customTitle || o.aiTitle || o.title;
    if (o.isSidechain) return; // subagent chatter
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') {
        if (!o.isMeta && !o.isCompactSummary && !isInjected(c)) { pushTurn(acc, 'user', c, o.timestamp); acc.busy = true; }
        return;
      }
      for (const b of c || []) {
        if (b.type === 'text' && !o.isMeta && !isInjected(b.text)) { pushTurn(acc, 'user', b.text, o.timestamp, o.uuid); acc.busy = true; }
        if (b.type === 'tool_result') {
          const res = textOf(b.content);
          upsertTool(acc, b.tool_use_id, { status: b.is_error ? 'error' : 'ok', result: res });
        }
      }
      return;
    }
    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      for (const b of m.content || []) {
        if (b.type === 'text') pushTurn(acc, 'assistant', b.text, o.timestamp, m.id);
        if (b.type === 'tool_use') {
          const c = classifyTool(b.name, b.input);
          upsertTool(acc, b.id, { ...c, status: 'running', ts: Date.parse(o.timestamp) || Date.now() });
        }
      }
      if (m.usage) {
        const u = m.usage;
        acc.usage = { ...acc.usage, input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, context: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), model: m.model };
      }
      if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence' || m.stop_reason === 'max_tokens') acc.busy = false;
      else if (m.stop_reason === 'tool_use') acc.busy = true;
    }
    if (o.type === 'system' && /api_error|error/.test(o.subtype || '') && o.content) pushTurn(acc, 'assistant', `⚠ ${textOf(o.content)}`, o.timestamp);
  },
  finish: finishAcc,
};
