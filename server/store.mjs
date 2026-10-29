// The shared store: plain JSON files under ~/.theodore, so the app, every `relay mcp` process the agents start and
// a person with a text editor can all read it. One file per thread; writes are atomic.
//
//   ~/.theodore/
//     state.json                 projects in the sidebar, recent folders, decided approvals, settings
//     threads/<id>.json          one chat: agent, folder, native session, turns, tool calls, usage, artifacts
//     events/<id>.jsonl          what the thread's MCP server saw (tool calls), appended by `relay mcp`
//     requests/<id>.json         questions an agent asked through request_approval, waiting for an answer
//     skills/<name>/SKILL.md     the skills library
//     raw/<id>.log               the agent's terminal output, size-capped (debugging)
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, newId, now, readJson, relayHome, samePath, writeJson } from './util.mjs';

export class Store {
  constructor(home = relayHome()) {
    this.home = home;
    for (const d of ['threads', 'events', 'requests', 'skills', 'raw', 'tmp']) ensureDir(path.join(home, d));
    this.cache = new Map();
    this.state = readJson(this.file('state.json'), null) || { projects: [], recentFolders: [], decided: [], settings: {} };
    this.state.projects ??= []; this.state.recentFolders ??= []; this.state.decided ??= []; this.state.settings ??= {};
  }

  file(...p) { return path.join(this.home, ...p); }
  threadFile(id) { return this.file('threads', `${id}.json`); }
  saveState() { writeJson(this.file('state.json'), this.state); }

  /* ---------- threads ---------- */
  listThreads() {
    const out = [];
    for (const f of fs.readdirSync(this.file('threads'))) {
      if (!f.endsWith('.json')) continue;
      const t = this.getThread(f.slice(0, -5));
      if (t) out.push(t);
    }
    return out.sort((a, b) => a.created - b.created);
  }

  getThread(id, { fresh = false } = {}) {
    if (!/^t_[0-9a-z]+$/i.test(id || '')) return null;
    if (!fresh && this.cache.has(id)) return this.cache.get(id);
    const t = readJson(this.threadFile(id), null);
    if (t) this.cache.set(id, normalize(t));
    return t;
  }

  saveThread(t) {
    t.updated = now();
    this.cache.set(t.id, t);
    writeJson(this.threadFile(t.id), t);
    return t;
  }

  createThread(o) {
    const t = normalize({
      id: newId('t_'),
      title: o.title || 'New chat',
      agent: o.agent,
      model: o.model || null,
      effort: o.effort || null,
      cwd: o.cwd,
      project: o.project || o.cwd,
      parentId: o.parentId || null,
      skip: !!o.skip,
      firstPrompt: o.prompt || '',
      nativeSessionId: o.nativeSessionId || null,
      state: 'starting',
      created: now(),
    });
    this.addProject(t.project);
    return this.saveThread(t);
  }

  deleteThread(id) {
    this.cache.delete(id);
    for (const f of [this.threadFile(id), this.file('events', `${id}.jsonl`), this.file('raw', `${id}.log`)]) {
      try { fs.unlinkSync(f); } catch { /* gone */ }
    }
    for (const f of fs.readdirSync(this.file('tmp'))) if (f.startsWith(id + '.')) { try { fs.unlinkSync(this.file('tmp', f)); } catch { /* */ } }
  }

  childrenOf(id) { return this.listThreads().filter(t => t.parentId === id); }

  /* ---------- events written by the MCP servers ---------- */
  readEvents(id) {
    try {
      return fs.readFileSync(this.file('events', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  /* ---------- projects ---------- */
  addProject(p) {
    if (!p) return;
    if (!this.state.projects.some(x => samePath(x.path, p))) {
      this.state.projects.push({ path: p, name: path.basename(p) || p, collapsed: false, added: now() });
    }
    this.state.recentFolders = [p, ...this.state.recentFolders.filter(x => !samePath(x, p))].slice(0, 8);
    this.saveState();
  }

  removeProject(p) {
    this.state.projects = this.state.projects.filter(x => !samePath(x.path, p));
    this.saveState();
  }

  /* ---------- memory search ---------- */
  search(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = this.listThreads();
    if (!words.length) return all.sort((a, b) => b.updated - a.updated);
    return all.filter(t => {
      const hay = [t.title, t.agent, t.cwd, ...t.turns.map(x => x.text), ...t.tools.map(x => `${x.name} ${x.target}`)].join('\n').toLowerCase();
      return words.every(w => hay.includes(w));
    }).sort((a, b) => b.updated - a.updated);
  }
}

function normalize(t) {
  t.turns ??= []; t.tools ??= []; t.artifacts ??= []; t.attachments ??= []; t.usage ??= {};
  t.mcpCalls ??= []; t.updated ??= t.created;
  return t;
}

/** The artifacts folder of a thread: inside the project, git-ignored by its own .gitignore. */
export function artifactsDir(t) {
  return path.join(t.project || t.cwd, '.theodore', 'threads', t.id, 'artifacts');
}
export function attachmentsDir(t) {
  return path.join(t.project || t.cwd, '.theodore', 'threads', t.id, 'attachments');
}

/** Make sure `<project>/.theodore/` never ends up in the user's git history. */
export function ensureRelayFolder(project) {
  const dir = ensureDir(path.join(project, '.theodore'));
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Theodore AI Hub keeps chat files here (artifacts, attachments). Not part of the project.\n*\n');
  return dir;
}
