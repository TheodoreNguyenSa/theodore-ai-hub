// What the Doctor screen shows: each CLI (found? where, version, signed in) and the things on Windows that make or
// break them (Git for Windows for Claude Code, Node for npm-installed CLIs, the Windows build for ConPTY).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_IDS, detect, adapter } from './agents/index.mjs';
import { isWin, relayHome, runQuick, which, searchPath, resetPathCache } from './util.mjs';

export function doctor({ fresh = false } = {}) {
  if (fresh) resetPathCache();
  const checks = [];
  const add = (group, name, ok, detail, fix) => checks.push({ group, name, ok, detail, fix });

  for (const id of AGENT_IDS) {
    const d = detect(id, { fresh });
    const a = adapter(id);
    if (!d.installed) {
      add(a.name, 'installed', false, 'not found on PATH', isWin ? d.install?.win : d.install?.other);
      continue;
    }
    add(a.name, 'installed', true, `${d.version || '?'} · ${d.path}`);
    add(a.name, 'signed in', d.login.ok, `${d.login.state}${d.login.detail ? ` · ${d.login.detail}` : ''}`, d.login.ok === false ? `start a ${a.name} chat and sign in in its screen` : undefined);
  }

  // environment
  const v = process.versions.node;
  add('Theodore AI Hub', 'Node for the server', true, `${v} · ${process.execPath}`);
  const userNode = which('node');
  add('Theodore AI Hub', 'Node on PATH (npm CLIs)', !!userNode || null, userNode ? `${runQuick(userNode, ['--version']).out} · ${userNode}` : 'none: Theodore AI Hub runs npm-installed CLIs with its own Node', undefined);
  add('Theodore AI Hub', 'data folder', true, relayHome());
  if (isWin) {
    const rel = os.release(); // 10.0.<build>
    const build = Number(rel.split('.')[2] || 0);
    add('Windows', 'ConPTY (Windows 10 1809+)', build >= 17763, `Windows ${rel}`, build >= 17763 ? undefined : 'update Windows: agents need ConPTY');
    const gitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH || ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')].find(p => p && fs.existsSync(p)) || (which('git') ? path.join(path.dirname(path.dirname(which('git'))), 'bin', 'bash.exe') : null);
    const okGit = !!gitBash && fs.existsSync(gitBash);
    add('Windows', 'Git for Windows (Claude Code shell)', okGit || null, okGit ? gitBash : 'not found: Claude Code uses PowerShell or asks for Git Bash', okGit ? undefined : 'winget install Git.Git');
    add('Windows', 'PATH entries', true, `${searchPath().length} folders (user + machine registry PATH merged)`);
  } else {
    add('System', 'platform', true, `${process.platform} ${os.release()}`);
  }
  return checks;
}

/** A plain-text report the user can paste into an issue. */
export function doctorText() {
  return doctor({ fresh: true }).map(c => `${c.ok === true ? '✔' : c.ok === false ? '✖' : '•'} ${c.group} · ${c.name}: ${c.detail}${c.fix ? `  → ${c.fix}` : ''}`).join('\n');
}
