// OpenAI Codex CLI. Verified with codex-cli 0.165.0 against tools/fake-model.mjs:
//   transcript  ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl (Codex picks the id; we find the file by
//               the "Theodore AI Hub thread <id>" marker in developer_instructions, then by cwd and start time)
//   events      event_msg task_started / task_complete (busy), item_completed UserMessage / AgentMessage / CommandExecution,
//               response_item function_call / custom_tool_call (apply_patch), token_count (usage, rate_limits)
//   MCP         -c mcp_servers.theodore.command=… -c mcp_servers.theodore.args=[…]   (per session, ~/.codex/config.toml untouched)
//   note        -c developer_instructions=…
//   skip        --dangerously-bypass-approvals-and-sandbox, else -a on-request ; effort: -c model_reasoning_effort="…"
//   MCP tools   reach the model as a namespace tool mcp__theodore (its description is our server's instructions)
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, samePath } from '../util.mjs';
import { classifyTool, finishAcc, headOf, isInjected, newAcc, newFiles, patchFiles, pushTurn, textOf, tomlArr, tomlStr, unwrapShell, upsertTool } from './common.mjs';

const home = () => process.env.CODEX_HOME || path.join(HOME_DIR, '.codex');

export default {
  id: 'codex',
  name: 'Codex',
  letter: 'X',
  bins: ['codex'],
  skipFlag: '--dangerously-bypass-approvals-and-sandbox',
  models: ['', 'gpt-5.5', 'gpt-5.5-codex', 'gpt-5.5-mini'],
  efforts: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  install: { win: 'npm install -g @openai/codex', other: 'npm install -g @openai/codex', npm: 'npm install -g @openai/codex' },
  promptMode: 'arg',
  home,

  login() {
    if (process.env.OPENAI_API_KEY) return { state: 'api key', ok: true };
    if (fs.existsSync(path.join(home(), 'auth.json'))) return { state: 'logged in', ok: true };
    return { state: 'not logged in', ok: false, detail: 'run: codex login (or start a chat and sign in)' };
  },

  launch(o) {
    const args = [];
    if (o.resumeId) args.push('resume');
    // one inline table: separate -c keys for command and args left a half-built server entry in some config loads
    args.push('-c', `mcp_servers.theodore={command=${tomlStr(o.mcp.command)},args=${tomlArr(o.mcp.args)},startup_timeout_sec=30}`,
      '-c', `developer_instructions=${tomlStr(o.note)}`);
    if (o.model) args.push('-m', o.model);
    if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
    // Codex 0.165 without a config defaults to a "granular" policy that rejects escalation requests without asking;
    // on-request makes it ask, so the request reaches Theodore AI Hub's approvals inbox
    if (o.skip) args.push('--dangerously-bypass-approvals-and-sandbox'); else args.push('-a', o.approvalPolicy || 'on-request');
    if (o.resumeId) args.push(o.resumeId);
    if (o.prompt) args.push(o.prompt);
    return { args, env: {}, sessionId: o.resumeId || null };
  },

  /** Claim the rollout whose developer instructions name this thread; else the newest unclaimed one in this cwd. */
  findTranscript(t, claimed = new Set()) {
    if (t.transcriptPath && fs.existsSync(t.transcriptPath)) return t.transcriptPath;
    const root = path.join(home(), 'sessions');
    const since = (t.startedAt || t.created) - 10_000;
    // only the day folders around the start (local and UTC dates): a heavy user has thousands of rollouts
    const days = new Set();
    for (const ms of [since, Date.now()]) for (const d of [new Date(ms), new Date(ms - 86_400_000)]) {
      days.add(path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
      days.add(path.join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')));
    }
    const files = [...days].flatMap(d => newFiles(path.join(root, d), p => /rollout-.*\.jsonl$/.test(p), since, 0)).filter(f => !claimed.has(f.path));
    if (t.nativeSessionId) {
      const byId = files.find(f => f.path.includes(t.nativeSessionId));
      if (byId) return byId.path;
    }
    const marker = `Theodore AI Hub thread ${t.id}`;
    let fallback = null;
    for (const f of files) {
      const head = headOf(f.path, 200_000);
      if (head.includes(marker)) return f.path;
      if (!fallback && f.birth >= since && !/Theodore AI Hub thread t_/.test(head)) {
        const meta = head.split('\n')[0];
        try { const m = JSON.parse(meta); if (samePath(m.payload?.cwd, t.cwd)) fallback = f.path; } catch { /* */ }
      }
    }
    return t.resumeId ? null : fallback && (Date.now() - since > 15_000 ? fallback : null);
  },

  newAcc,
  reduce(acc, o) {
    const p = o.payload || {};
    if (o.type === 'session_meta') { acc.sessionId = p.id || p.session_id; acc.cliVersion = p.cli_version; return; }
    if (o.type === 'event_msg') {
      switch (p.type) {
        case 'task_started': case 'turn_started': acc.busy = true; break;
        case 'task_complete': case 'turn_complete': case 'turn_aborted': acc.busy = false; break;
        case 'user_message': if (!isInjected(p.message)) pushTurn(acc, 'user', p.message, o.timestamp); break;
        case 'agent_message': pushTurn(acc, 'assistant', p.message, o.timestamp); break;
        case 'item_completed': {
          const it = p.item || {};
          if (it.type === 'UserMessage') { const tx = textOf(it.content); if (!isInjected(tx)) pushTurn(acc, 'user', tx, o.timestamp); }
          else if (it.type === 'AgentMessage') pushTurn(acc, 'assistant', textOf(it.content), o.timestamp);
          else if (it.type === 'CommandExecution') {
            upsertTool(acc, it.id, { name: 'exec_command', kind: 'command', target: Array.isArray(it.command) ? unwrapShell(it.command) : String(it.command || ''), status: it.exit_code === 0 || it.status === 'completed' && it.exit_code == null ? 'ok' : 'error', result: it.aggregated_output || `exit ${it.exit_code}` });
          } else if (it.type === 'FileChange') {
            const files = Object.keys(it.changes || {}).join(', ') || (it.changes || []).map?.(c => c.path).join(', ');
            upsertTool(acc, it.id, { name: 'apply_patch', kind: 'edit', target: files || '', status: it.status === 'failed' ? 'error' : 'ok' });
          } else if (it.type === 'McpToolCall') {
            upsertTool(acc, it.id, { name: `${it.server || 'mcp'}.${it.tool || ''}`, kind: 'mcp', target: `${it.server || ''}.${it.tool || ''}`, status: it.status === 'failed' ? 'error' : 'ok' });
          }
          break;
        }
        case 'exec_command_end': upsertTool(acc, p.call_id, { status: p.exit_code === 0 ? 'ok' : 'error', result: p.aggregated_output || p.stdout || `exit ${p.exit_code}` }); break;
        case 'token_count': {
          const i = p.info || {};
          const last = i.last_token_usage || {};
          acc.usage = { ...acc.usage, input: i.total_token_usage?.input_tokens, output: i.total_token_usage?.output_tokens, context: last.input_tokens, window: i.model_context_window };
          const prim = p.rate_limits?.primary;
          if (prim && prim.used_percent != null) acc.usage.limit = { pct: Math.round(prim.used_percent), windowMin: prim.window_minutes, resetsAt: prim.resets_at || prim.resets_in_seconds && Date.now() + prim.resets_in_seconds * 1000 };
          break;
        }
        case 'thread_name_updated': case 'session_title': if (p.name || p.title) acc.title = p.name || p.title; break;
      }
      return;
    }
    if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'local_shell_call') {
        // MCP tools come as a namespace (mcp__theodore) plus the tool name
        const c = classifyTool(p.namespace ? `${p.namespace}__${p.name}` : p.name || 'shell', p.arguments ?? p.action);
        upsertTool(acc, p.call_id || p.id, { ...c, status: 'running', ts: Date.parse(o.timestamp) || Date.now() });
      } else if (p.type === 'custom_tool_call') {
        const files = p.name === 'apply_patch' ? patchFiles(p.input) : [];
        upsertTool(acc, p.call_id || p.id, files.length ? { name: p.name, kind: 'edit', target: files.join(', '), status: 'running' } : { ...classifyTool(p.name, p.input), status: 'running' });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
        const code = /exited with code (\d+)/.exec(out)?.[1] ?? /"exit_code":\s*(\d+)/.exec(out)?.[1];
        const failed = code != null ? code !== '0' : /^(error|failed)/i.test(out);
        const t = upsertTool(acc, p.call_id, { status: failed ? 'error' : 'ok' });
        if (!t.result) t.result = out.replace(/^Chunk ID:.*\n|^Wall time:.*\n|^Original token count:.*\n|^Output:\n?/gm, '').trim() || (code != null ? `exit ${code}` : '');
      } else if (p.type === 'message' && p.role === 'assistant') {
        // the same text as the AgentMessage item (deduplicated), or the only copy in older rollouts
        pushTurn(acc, 'assistant', textOf(p.content), o.timestamp);
      }
    }
  },
  finish: finishAcc,
};
