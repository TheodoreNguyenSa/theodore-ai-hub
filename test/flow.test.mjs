// End-to-end with the fake agent (tools/fake-tui.mjs) in real PTYs: a new chat streams its screen, typing reaches it,
// a permission prompt lands in the approvals inbox and is answered from there, an artifact is listed, a handoff chat
// loads the context through the real `relay mcp` server, and the API refuses requests without the token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-work-'));
process.env.RELAY_HOME = HOME;
process.env.RELAY_FAKE_AGENTS = '1';
process.env.RELAY_SKILLS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-uh-'));
const { serve } = await import('../server/serve.mjs');

let s, base, ws, screens = {}, msgs = [];
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${s.token}`, 'x-relay': '1', 'content-type': 'application/json', origin: base }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
};
const until = async (fn, ms = 15000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for ${what}`);
};
const lastState = () => [...msgs].reverse().find(m => m.t === 'state')?.state;
const chat = (id) => lastState()?.projects.flatMap(p => p.chats).find(c => c.id === id);

before(async () => {
  s = await serve({ port: 0 });
  base = `http://127.0.0.1:${s.port}`;
  ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { authorization: `Bearer ${s.token}`, origin: base } });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    msgs.push(m);
    if (m.t === 'replay') screens[m.id] = m.data;
    if (m.t === 'out') screens[m.id] = (screens[m.id] || '') + m.data;
  });
  await new Promise(r => ws.once('open', r));
});
after(() => { ws?.close(); s?.close(); });

test('the API needs the token, our Host and (for writes) X-Relay + Origin', async () => {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  // fetch() cannot forge Host: use a raw request, as a DNS-rebinding page would arrive
  const rebound = await new Promise(r => http.get({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { host: 'evil.example', authorization: `Bearer ${s.token}` } }, res => r(res.statusCode)));
  assert.equal(rebound, 421);
  assert.equal((await fetch(base + '/api/chats', { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: `Bearer ${s.token}` } })).status, 200);
  const bad = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { origin: 'http://evil.example' } });
  await new Promise(r => { bad.on('error', r); bad.on('unexpected-response', r); });
});

let first;
test('new chat: the agent starts in a PTY, its screen streams, typing reaches it', async () => {
  const { id } = await api('POST', '/api/chats', { agent: 'claude', folder: WORK, prompt: 'hello there' });
  first = id;
  ws.send(JSON.stringify({ t: 'attach', id, cols: 100, rows: 30 }));
  await until(() => /Fake agent|Claude Code/.test(screens[id] || ''), 10000, 'banner');
  await until(() => /Fake reply: hello there/.test(screens[id] || ''), 10000, 'reply to the first message');
  await until(async () => { const d = await api('GET', `/api/chats/${id}`); return d.turns >= 2 && d; }, 10000, 'transcript turns');
  await until(() => chat(id)?.state === 'waiting', 6000, 'state waiting after the turn');
  ws.send(JSON.stringify({ t: 'in', id, data: 'second message\r' }));
  await until(() => /Fake reply: second message/.test(screens[id] || ''), 10000, 'typed message');
});

test('a permission prompt becomes an approval; answering it types the agent key', async () => {
  ws.send(JSON.stringify({ t: 'in', id: first, data: 'please approve this\r' }));
  const ap = await until(() => lastState()?.approvals.find(a => a.threadId === first), 10000, 'approval in the inbox');
  assert.equal(ap.question, 'Do you want to proceed?');
  assert.match(ap.what, /touch approved\.txt/);
  assert.equal(chat(first).state, 'approval');
  await api('POST', `/api/chats/${first}/approve`, { approval: ap.id, choice: 'approve' });
  await until(() => fs.existsSync(path.join(WORK, 'approved.txt')), 10000, 'approved command ran');
  await until(() => !lastState()?.approvals.length, 10000, 'inbox empty');
  const decided = lastState().decided;
  assert.ok(decided.some(d => d.choice === 'approve'));
});

test('an artifact written by the agent is listed', async () => {
  ws.send(JSON.stringify({ t: 'in', id: first, data: 'write an artifact\r' }));
  const d = await until(async () => { const x = await api('GET', `/api/chats/${first}`); return x.artifactsList.length && x; }, 10000, 'artifact');
  assert.equal(d.artifactsList[0].name, 'notes.md');
  await until(() => msgs.some(m => m.t === 'toast' && /notes\.md/.test(m.text)), 5000, 'artifact toast');
});

test('handoff: a new chat for another agent loads the context through the theodore MCP server', async () => {
  const { id } = await api('POST', `/api/chats/${first}/handoff`, { agent: 'codex' });
  ws.send(JSON.stringify({ t: 'attach', id, cols: 100, rows: 30 }));
  await until(() => /Called theodore\.get_handoff_context/.test(screens[id] || ''), 15000, 'MCP call');
  await until(() => /Theodore AI Hub thread/.test(screens[id] || ''), 5000, 'context printed');
  const d = await until(async () => { const x = await api('GET', `/api/chats/${id}`); return x.handoffLoaded && x; }, 10000, 'handoff marked loaded');
  assert.equal(d.parent.id, first);
  const rec = await api('GET', `/api/chats/${first}/record`);
  assert.match(rec.text, /hello there/);
  assert.match(rec.text, /touch approved\.txt/);
});

test('memory search finds the chat; activity lists tool calls', async () => {
  const m = await api('GET', '/api/memory?q=approve');
  assert.ok(m.some(x => x.id === first));
  const act = await api('GET', `/api/chats/${first}/activity`);
  assert.ok(act.some(a => a.kind === 'command' && /touch/.test(a.text)));
  assert.ok(act.some(a => a.kind === 'approval'));
});

test('dropped files are pasted as paths (copied into the chat when asked)', async () => {
  const f = path.join(WORK, 'my file.txt');
  fs.writeFileSync(f, 'data');
  const r = await api('POST', `/api/chats/${first}/drop`, { paths: [f], copy: true });
  assert.match(r.pasted[0], /attachments/);
  assert.ok(fs.existsSync(r.pasted[0]));
});

test('stop, then reopening resumes the chat with its session', async () => {
  await api('POST', `/api/chats/${first}/stop`);
  await until(() => chat(first)?.state === 'ended', 8000, 'ended');
  await api('POST', `/api/chats/${first}/restart`);
  ws.send(JSON.stringify({ t: 'attach', id: first, cols: 100, rows: 30 }));
  await until(() => /resumed/.test(screens[first] || ''), 8000, 'resumed screen');
  const d = await api('GET', `/api/chats/${first}`);
  assert.ok(d.turns >= 6, `turns kept after resume: ${d.turns}`);
});

test('skills: create, link into both agents folders, import a found one, turning off removes only our links', async () => {
  const { createSkill, setEnabled, skillTargets, foundSkills, importSkill, listSkills } = await import('../server/skills.mjs');
  const st = s.controller.store;
  createSkill(st, { name: 'kiwi-test', description: 'answer kiwi-42' });
  for (const t of skillTargets()) {
    const p = path.join(t.dir, 'kiwi-test');
    assert.ok(fs.existsSync(path.join(p, 'SKILL.md')), `linked into ${t.dir}`);
  }
  // a skill the user made in Claude's own folder shows up to import
  const own = path.join(skillTargets()[0].dir, 'release-notes');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), '---\nname: release-notes\ndescription: write release notes\n---\nbody');
  assert.ok(foundSkills(st).some(f => f.name === 'release-notes'));
  importSkill(st, own);
  assert.ok(listSkills(st).some(x => x.name === 'release-notes'));
  assert.ok(fs.existsSync(path.join(skillTargets()[1].dir, 'release-notes', 'SKILL.md')), 'imported skill reaches the other agents');
  setEnabled(st, 'kiwi-test', false);
  for (const t of skillTargets()) assert.ok(!fs.existsSync(path.join(t.dir, 'kiwi-test')));
  setEnabled(st, 'release-notes', false);
  assert.ok(fs.existsSync(path.join(own, 'SKILL.md')), "the user's own folder is never removed");
});
