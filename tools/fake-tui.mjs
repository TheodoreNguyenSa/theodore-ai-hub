#!/usr/bin/env node
// The fake agent's screen. Types like a terminal app: a banner, an input line, a spinner while "working".
//   a message containing "approve"  → a Claude-style permission prompt (Enter = yes, Esc = no)
//   "artifact"                      → writes notes.md into the thread's artifacts folder
//   "handoff" / "get_handoff_context" → calls the relay MCP server's get_handoff_context and prints the first lines
//   "slow"                          → works for 6 s
// It writes a Claude Code-format transcript, so Relay's Claude reducer reads it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const SESSION = arg('--session');
const TRANSCRIPT = arg('--transcript');
const NAME = arg('--name') || 'Fake agent';
const FIRST = arg('--prompt');
fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });

const out = (s) => process.stdout.write(s);
const rec = (o) => fs.appendFileSync(TRANSCRIPT, JSON.stringify({ ...o, sessionId: SESSION, timestamp: new Date().toISOString(), version: 'fake-1.0', cwd: process.cwd() }) + '\n');
const user = (text) => rec({ type: 'user', message: { role: 'user', content: text }, uuid: crypto.randomUUID() });
const say = (text) => rec({ type: 'assistant', message: { id: 'msg_' + crypto.randomBytes(4).toString('hex'), role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 40 } } });

let input = '';
let busy = false;
let pendingApproval = null;

function banner() {
  out('\x1b[2J\x1b[H');
  out(`\x1b[1;35m✻ ${NAME}\x1b[0m \x1b[2m(fake agent for tests)\x1b[0m\r\n`);
  out(`\x1b[2m${process.cwd()}\x1b[0m\r\n\r\n`);
}
function prompt() { out(`\r\n\x1b[36m>\x1b[0m ${input}`); }

async function spin(ms) {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) { out(`\r\x1b[33m${frames[i++ % frames.length]} Working…\x1b[0m`); await new Promise(r => setTimeout(r, 120)); }
  out('\r\x1b[2K');
}

function askApproval(cmd) {
  return new Promise((resolve) => {
    out('\r\n\x1b[2K╭──────────────────────────────────────────────╮\r\n');
    out(`│ Bash command                                 │\r\n│   ${cmd.padEnd(43)}│\r\n│                                              │\r\n`);
    out('│ Do you want to proceed?                      │\r\n│ ❯ 1. Yes                                     │\r\n│   2. No, and tell Claude what to do (esc)    │\r\n');
    out('╰──────────────────────────────────────────────╯\r\n');
    pendingApproval = resolve;
  });
}

function callMcp(tool) {
  return new Promise((resolve) => {
    let mcp;
    try { mcp = JSON.parse(process.env.RELAY_FAKE_MCP || 'null'); } catch { /* */ }
    if (!mcp) return resolve('(no MCP server configured)');
    const p = spawn(mcp.command, mcp.args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: {} } }); }
        if (m.id === 2) { p.kill(); resolve(m.result?.content?.[0]?.text || JSON.stringify(m.error)); }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-tui', version: '1' } } });
    setTimeout(() => { p.kill(); resolve('(MCP timeout)'); }, 8000);
  });
}

async function handle(text) {
  busy = true;
  out('\r\n');
  user(text);
  await spin(/slow/.test(text) ? 6000 : 900);
  let reply = `Fake reply: ${text.slice(0, 60)}`;
  if (/approve/i.test(text) && !process.env.RELAY_SKIP) {
    const cmd = 'touch approved.txt';
    const id = 'toolu_' + crypto.randomBytes(4).toString('hex');
    rec({ type: 'assistant', message: { id: 'msg_' + id, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }], stop_reason: 'tool_use' } });
    const ok = await askApproval(cmd);
    if (ok) fs.writeFileSync('approved.txt', 'yes\n');
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ok ? '' : 'The user denied this', is_error: !ok }] } });
    reply = ok ? 'Ran touch approved.txt.' : 'Okay, I did not run it.';
  }
  if (/artifact/i.test(text) && process.env.RELAY_ARTIFACTS) {
    fs.mkdirSync(process.env.RELAY_ARTIFACTS, { recursive: true });
    const f = path.join(process.env.RELAY_ARTIFACTS, 'notes.md');
    fs.writeFileSync(f, `# Notes\n\nWritten by the fake agent at ${new Date().toISOString()}.\n`);
    const id = 'toolu_' + crypto.randomBytes(4).toString('hex');
    rec({ type: 'assistant', message: { id: 'msg_' + id, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: f, content: '…' } }], stop_reason: 'tool_use' } });
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
    reply = `Wrote ${f}`;
  }
  if (/handoff|get_handoff_context/i.test(text)) {
    const id = 'toolu_' + crypto.randomBytes(4).toString('hex');
    rec({ type: 'assistant', message: { id: 'msg_' + id, role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__relay__get_handoff_context', input: {} }], stop_reason: 'tool_use' } });
    const ctx = await callMcp('get_handoff_context');
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ctx }] } });
    out(`\x1b[32m● Called relay.get_handoff_context\x1b[0m\r\n`);
    reply = `Loaded the handoff context:\r\n${ctx.split('\n').slice(0, 6).map(l => '  ' + l).join('\r\n')}`;
  }
  say(reply.replace(/\r/g, ''));
  out(`\x1b[37m● ${reply}\x1b[0m\r\n`);
  busy = false;
  prompt();
}

banner();
if (process.argv.includes('--resume')) out('\x1b[2m(resumed)\x1b[0m\r\n');
prompt();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (pendingApproval) {
    // like the real agents, the prompt box goes away once it is answered
    const clearBox = () => out('\x1b[9A\r\x1b[J');
    if (d === '\r' || d === '1' || d === 'y') { const r = pendingApproval; pendingApproval = null; clearBox(); r(true); }
    else if (d === '\x1b' || d === '2' || d === 'n') { const r = pendingApproval; pendingApproval = null; clearBox(); r(false); }
    return;
  }
  if (busy) return;
  if (d === '\x03') process.exit(0);
  // bracketed paste wrapper from Relay
  d = d.replace(/\x1b\[20[01]~/g, '');
  for (const ch of d) {
    if (ch === '\r' || ch === '\n') { const t = input.trim(); input = ''; if (t) handle(t); else prompt(); return; }
    if (ch === '\x7f' || ch === '\b') { if (input) { input = input.slice(0, -1); out('\b \b'); } continue; }
    if (ch < ' ' && ch !== '\t') continue;
    input += ch; out(ch);
  }
});
process.stdout.on('resize', () => { /* redraw not needed */ });
if (FIRST) setTimeout(() => handle(FIRST), 300);
