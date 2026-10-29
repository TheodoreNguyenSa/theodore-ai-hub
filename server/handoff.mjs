// What the next agent reads when it continues a chat: a compact digest of the earlier thread, built from Theodore AI Hub's own
// record (not from the old agent, which may have hit its plan limit). A few thousand tokens at most.
import path from 'node:path';
import fs from 'node:fs';
import { artifactsDir } from './store.mjs';
import { short } from './util.mjs';
import { AGENTS } from './agents/index.mjs';

const MAX = 14000;

export function agentName(id) { return AGENTS[id]?.name || id; }

export function handoffPrompt(src) {
  return `This chat continues the Theodore AI Hub thread "${short(src.title, 60)}", worked on by ${agentName(src.agent)}. Call the theodore MCP tool get_handoff_context first (no arguments: it knows which chat this one continues). Then reply with at most 5 bullets: what was done, decisions, open work, and your next step. Wait for my OK before changing anything.`;
}

/** Files the thread changed, with how often. */
export function filesTouched(t) {
  const m = new Map();
  for (const x of t.tools) {
    if (x.kind !== 'edit' || !x.target) continue;
    for (const f of String(x.target).split(/,\s*/)) {
      if (/[\\/]\.theodore[\\/]threads[\\/]/.test(f)) continue; // artifacts are listed on their own
      const rel = relTo(t.cwd, f);
      const e = m.get(rel) || { file: rel, n: 0, tool: x.name };
      e.n++; m.set(rel, e);
    }
  }
  return [...m.values()];
}

const relTo = (cwd, f) => {
  try { const r = path.relative(cwd, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : f; } catch { return f; }
};

export function commandsRun(t) {
  return t.tools.filter(x => x.kind === 'command' && x.target).map(x => ({ cmd: x.target, status: x.status, result: x.result }));
}

export function listArtifacts(t) {
  const dir = artifactsDir(t);
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const st = fs.statSync(p); out.push({ path: p, name: path.relative(dir, p), size: st.size, mtime: st.mtimeMs }); } catch { /* */ } }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The digest. `t` is the thread to describe (usually the parent of the caller). */
export function buildHandoff(t, { recent = 8 } = {}) {
  const lines = [];
  const turns = t.turns || [];
  const firstUser = turns.find(x => x.role === 'user');
  const lastAssistant = [...turns].reverse().find(x => x.role === 'assistant');
  lines.push(`# Theodore AI Hub thread "${t.title}" (${t.id})`);
  lines.push(`Agent: ${agentName(t.agent)}${t.model ? ` · model ${t.model}` : ''} · folder ${t.cwd}`);
  lines.push(`Started ${new Date(t.created).toISOString()} · ${turns.length} turns · ${t.tools.length} tool calls · state ${t.state}`);
  if (t.parentId) lines.push(`It continued thread ${t.parentId}.`);
  lines.push('');
  if (firstUser) { lines.push('## First request'); lines.push(clip(firstUser.text, 1500)); lines.push(''); }
  const files = filesTouched(t);
  if (files.length) { lines.push('## Files changed'); for (const f of files.slice(0, 40)) lines.push(`- ${f.file}${f.n > 1 ? ` (×${f.n})` : ''}`); lines.push(''); }
  const cmds = commandsRun(t);
  if (cmds.length) {
    lines.push('## Commands run (latest last)');
    for (const c of cmds.slice(-15)) lines.push(`- ${c.status === 'ok' ? '✓' : c.status === 'error' ? '✗' : '…'} \`${short(c.cmd, 160)}\`${c.result ? ` → ${short(c.result, 120)}` : ''}`);
    lines.push('');
  }
  const arts = listArtifacts(t);
  if (arts.length) { lines.push('## Artifacts (files made for the user)'); for (const a of arts.slice(0, 20)) lines.push(`- ${a.path}`); lines.push(''); }
  if (t.attachments?.length) { lines.push('## Files the user gave'); for (const a of t.attachments.slice(-10)) lines.push(`- ${a.path}`); lines.push(''); }
  const mcp = (t.tools || []).filter(x => x.kind === 'mcp');
  if (mcp.length) { lines.push(`Other tools used: ${[...new Set(mcp.map(x => x.target || x.name))].slice(0, 10).join(', ')}`); lines.push(''); }
  const tail = turns.slice(-recent);
  if (tail.length) {
    lines.push(`## Recent turns (last ${tail.length} of ${turns.length})`);
    for (const x of tail) lines.push(`**${x.role === 'user' ? 'User' : agentName(t.agent)}:** ${clip(x.text, 900)}`);
    lines.push('');
  }
  if (lastAssistant && !tail.includes(lastAssistant)) { lines.push('## Last answer'); lines.push(clip(lastAssistant.text, 1500)); lines.push(''); }
  if (turns.length > recent) lines.push(`Older turns: call get_thread_turns with thread_id "${t.id}".`);
  let s = lines.join('\n');
  if (s.length > MAX) s = s.slice(0, MAX - 200) + `\n…(cut; call get_thread_turns with thread_id "${t.id}" for the rest)`;
  return s;
}

function clip(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n) + ' …' : s;
}
