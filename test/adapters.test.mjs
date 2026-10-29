// The transcript readers against real transcripts (trimmed) written by Claude Code 2.1.312, Codex 0.165.0 and
// Gemini CLI 0.66.0 in tools/live-probe.mjs runs, and the Windows helpers (npm shims, cmd quoting, TOML for codex -c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import claude from '../server/agents/claude.mjs';
import codex from '../server/agents/codex.mjs';
import gemini from '../server/agents/gemini.mjs';
import { classifyTool, tomlStr, tomlArr, unwrapShell, patchFiles } from '../server/agents/common.mjs';
import { cmdQuote, shimTarget } from '../server/util.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (a, f) => {
  const acc = a.newAcc();
  for (const l of fs.readFileSync(path.join(FIX, f), 'utf8').split('\n').filter(Boolean)) a.reduce(acc, JSON.parse(l));
  return a.finish(acc);
};

test('Claude Code transcript: user turns, the Bash call with its result, the relay MCP call, not busy at the end', () => {
  const r = read(claude, 'claude-2.1.312-transcript.jsonl');
  assert.equal(r.turns[0].role, 'user');
  assert.match(r.turns[0].text, /relay-probe/);
  assert.ok(r.turns.some(t => t.role === 'assistant' && /^Done\./.test(t.text)));
  const bash = r.tools.find(t => t.kind === 'command');
  assert.equal(bash.target, 'echo relay-probe > probe.txt');
  assert.equal(bash.status, 'ok');
  assert.ok(r.tools.some(t => t.kind === 'mcp' && /get_handoff_context/.test(t.name)));
  assert.equal(r.busy, false);
  assert.match(r.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(r.cliVersion, '2.1.312');
});

test('Codex rollout: turns from item events (no duplicates), exec_command, the MCP namespace call, usage', () => {
  const r = read(codex, 'codex-0.165.0-rollout.jsonl');
  const users = r.turns.filter(t => t.role === 'user');
  assert.ok(users.some(t => /relay-probe/.test(t.text)));
  for (let i = 1; i < r.turns.length; i++) assert.ok(!(r.turns[i].role === r.turns[i - 1].role && r.turns[i].text === r.turns[i - 1].text), 'no doubled turn');
  const cmd = r.tools.find(t => t.kind === 'command');
  assert.equal(cmd.target, 'echo relay-probe > probe.txt');
  assert.equal(cmd.status, 'ok');
  assert.ok(r.tools.some(t => t.kind === 'mcp' && /get_handoff_context/.test(t.name)), JSON.stringify(r.tools.map(t => t.name)));
  assert.equal(r.cliVersion, '0.165.0');
  assert.ok(r.usage.window > 0);
  assert.equal(r.busy, false);
});

test('Gemini CLI session: rewritten messages read once, run_shell_command, the MCP call, injected context skipped', () => {
  const r = read(gemini, 'gemini-0.66.0-session.jsonl');
  assert.ok(!r.turns.some(t => /session_context/.test(t.text)));
  assert.match(r.turns[0].text, /relay-probe/);
  const sh = r.tools.find(t => t.kind === 'command');
  assert.equal(sh.target, 'echo relay-probe > probe.txt');
  assert.equal(sh.status, 'ok');
  assert.ok(r.tools.some(t => t.kind === 'mcp'));
  assert.equal(r.tools.filter(t => t.kind === 'command').length, 1, 'one call even though the message was written twice');
  assert.match(r.sessionId, /^[0-9a-f-]{36}$/);
});

test('tool names from every CLI are classified', () => {
  assert.equal(classifyTool('Write', { file_path: 'C:\\app\\a.ts' }).kind, 'edit');
  assert.equal(classifyTool('replace', { file_path: 'a.ts' }).kind, 'edit');
  assert.deepEqual(classifyTool('apply_patch', '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch').target, 'src/x.ts');
  assert.equal(classifyTool('PowerShell', { command: 'Get-ChildItem' }).target, 'Get-ChildItem');
  assert.equal(classifyTool('mcp__theodore__get_handoff_context', {}).kind, 'mcp');
  assert.equal(classifyTool('mcp_theodore_list_threads', {}).kind, 'mcp');
  assert.equal(unwrapShell(['powershell.exe', '-Command', 'npm test']), 'npm test');
  assert.equal(unwrapShell(['cmd.exe', '/c', 'dir', '/b']), 'dir /b');
  assert.deepEqual(patchFiles('*** Add File: a.md\n+x\n*** Delete File: b.md'), ['a.md', 'b.md']);
});

test('Windows: npm shims run their real program; cmd and TOML quoting keep backslashes and spaces', () => {
  const shim = '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  assert.equal(shimTarget(shim, 'C:\\Users\\Nguyễn Văn A\\AppData\\Roaming\\npm', () => true), 'C:\\Users\\Nguyễn Văn A\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
  const exeShim = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  assert.match(shimTarget(exeShim, 'C:\\npm', () => true), /claude\.exe$/);
  assert.equal(cmdQuote('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  assert.equal(cmdQuote('a&b'), '"a^&b"');
  assert.equal(tomlStr('C:\\Program Files\\Theodore AI Hub\\node\\node.exe'), "'C:\\Program Files\\Theodore AI Hub\\node\\node.exe'");
  assert.equal(tomlStr("it's"), '"it\'s"');
  assert.equal(tomlArr(['a', 'C:\\b']), "['a','C:\\b']");
});

test('Codex launch: the MCP server as one inline table, approvals on request unless skipped', () => {
  const t = { id: 't_1', cwd: 'C:\\code\\app', title: 'x' };
  const l = codex.launch({ thread: t, mcp: { command: 'C:\\Theodore AI Hub\\node\\node.exe', args: ['C:\\Theodore AI Hub\\app\\server\\index.mjs', 'mcp', '--thread', 't_1'] }, note: 'This chat is Theodore AI Hub thread t_1.', files: '.' });
  const mcp = l.args[l.args.indexOf('-c') + 1];
  assert.equal(mcp, "mcp_servers.theodore={command='C:\\Theodore AI Hub\\node\\node.exe',args=['C:\\Theodore AI Hub\\app\\server\\index.mjs','mcp','--thread','t_1'],startup_timeout_sec=30}");
  assert.deepEqual(l.args.slice(l.args.indexOf('-a'), l.args.indexOf('-a') + 2), ['-a', 'on-request']);
  const s = codex.launch({ thread: t, mcp: { command: 'n', args: [] }, note: 'n', files: '.', skip: true, resumeId: 'abc' });
  assert.ok(s.args.includes('--dangerously-bypass-approvals-and-sandbox') && !s.args.includes('-a'));
  assert.equal(s.args[0], 'resume');
  assert.equal(s.args[s.args.length - 1], 'abc');
});
