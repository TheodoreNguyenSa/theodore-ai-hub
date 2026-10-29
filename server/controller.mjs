// The app's logic, without any UI: chats (threads) and their agent processes, transcript tailing into the store,
// thread state, approvals (screen prompts + request_approval questions), handoff, artifacts, dropped files.
// The HTTP/WebSocket server (serve.mjs) is a thin layer over this.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Host } from './host.mjs';
import { Store, artifactsDir, attachmentsDir, ensureRelayFolder } from './store.mjs';
import { adapter, detect, withOverrides, AGENTS } from './agents/index.mjs';
import { relayNote, readJsonlFrom } from './agents/common.mjs';
import { detectApproval, riskOf } from './approvals.mjs';
import { buildHandoff, handoffPrompt, agentName, listArtifacts, filesTouched } from './handoff.mjs';
import { sync as syncSkills } from './skills.mjs';
import { cleanEnv, ensureDir, fileHash, isWin, newId, readJson, relayHome, resolveCommand, samePath, short, which } from './util.mjs';

export const SERVER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.mjs');

export class Controller extends EventEmitter {
  constructor(o = {}) {
    super();
    this.store = new Store(o.home);
    this.size = { cols: 120, rows: 36 };
    this.live = new Map();        // threadId → { host, acc, offset, transcript, approval, … }
    this.approvals = new Map();   // approvalId → approval
    this.requestsSeen = new Set();
    this.claimed = new Set();     // transcript files already linked to a thread
    this.maxLive = this.store.state.settings.maxLive || 6;
    this.stateTimer = null;
    // chats from an earlier run have no process any more: they resume when opened
    for (const t of this.store.listThreads()) {
      if (t.transcriptPath) this.claimed.add(t.transcriptPath);
      if (t.state !== 'ended' && t.state !== 'parked') { t.state = 'parked'; this.store.saveThread(t); }
    }
    this.ticker = setInterval(() => this.tick(), o.tickMs || 1000);
    this.ticker.unref?.();
    try { syncSkills(this.store); } catch { /* skills folders not writable: the Skills screen says so */ }
  }

  /** The app is closing: chats are paused, not ended, so they resume when opened next time. */
  close() {
    clearInterval(this.ticker);
    for (const [id, l] of this.live) {
      l.parking = true;
      const t = this.store.getThread(id);
      if (t) {
        try { t.lastScreen = l.host.serializer.serialize({ scrollback: 1000 }).slice(-200_000); } catch { /* */ }
        if (t.state !== 'ended') t.state = 'parked';
        this.store.saveThread(t);
      }
      l.host.kill();
    }
  }

  /* ======================= chats ======================= */

  /** New chat: agent, folder, optional first message. Returns the thread. */
  newChat(o) {
    const a = adapter(o.agent);
    if (!a) throw new Error(`Unknown agent ${o.agent}`);
    const folder = path.resolve(o.folder || process.env.RELAY_PROJECT || process.cwd());
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Folder not found: ${folder}`);
    const n = this.store.listThreads().filter(t => t.agent === o.agent).length + 1;
    const t = this.store.createThread({
      agent: o.agent, model: o.model || null, effort: o.effort || null, cwd: folder, project: o.project || folder,
      parentId: o.parentId || null, skip: !!o.skip, prompt: o.prompt || '',
      title: o.title || (o.prompt ? short(o.prompt, 48) : `${a.name} chat ${n}`),
    });
    t.titleAuto = !o.title;
    this.store.saveThread(t);
    this.start(t, { prompt: o.prompt || '' });
    return t;
  }

  /** Continue a chat with another agent: a new thread whose first message makes it load the old one. */
  handoff(fromId, o) {
    const src = this.need(fromId);
    const prompt = handoffPrompt(src) + (o.note ? ` Also: ${String(o.note).replace(/\s+/g, ' ').trim()}` : '');
    const t = this.newChat({ agent: o.agent, model: o.model, effort: o.effort, skip: o.skip ?? src.skip, folder: src.cwd, project: src.project, parentId: src.id, prompt, title: `${short(src.title, 36)} → ${agentName(o.agent)}` });
    t.titleAuto = false; t.handoffFrom = src.id; this.store.saveThread(t);
    return t;
  }

  need(id) {
    const t = this.store.getThread(id);
    if (!t) throw Object.assign(new Error(`No chat ${id}`), { status: 404 });
    return t;
  }

  mcpFor(t) {
    const base = [SERVER_ENTRY, 'mcp', '--home', this.store.home];
    return {
      command: process.execPath,
      args: [...base, '--thread', t.id],
      // agy's MCP config is one file per folder, shared by its chats there: the server finds the chat by agent + folder
      agyArgs: [...base, '--thread', 'auto', '--agent', 'agy', '--cwd', t.cwd],
    };
  }

  /** Start (or resume) the agent of a thread in a PTY. */
  start(t, { prompt = '', resume = false } = {}) {
    if (this.live.has(t.id)) return this.live.get(t.id);
    const a = adapter(t.agent);
    const files = ensureDir(this.store.file('tmp'));
    ensureRelayFolder(t.project || t.cwd);
    const arts = artifactsDir(t);
    const resumeId = resume ? t.nativeSessionId : null;
    if (resume && !resumeId) throw new Error('This chat has no session to resume yet.');
    const base = a.launch({
      thread: t, cwd: t.cwd, prompt: resume ? '' : prompt, resumeId, model: t.model, effort: t.effort, skip: t.skip,
      mcp: this.mcpFor(t), note: relayNote(t, arts), files, artifacts: arts, agentName: a.name,
      permissionMode: readJson(this.store.file('agents.json'), {})?.[t.agent]?.permissionMode,
    });
    const launch = withOverrides(t.agent, base, { prompt: resume ? '' : prompt, skip: t.skip });
    let file = launch.file;
    if (!file) {
      const info = detect(t.agent);
      file = launch.command || info.path;
      if (!file) throw Object.assign(new Error(`${a.name} is not installed (not found on PATH). See Doctor.`), { status: 400 });
    }
    const cmd = resolveCommand(file, launch.args);
    const env = cleanEnv({ ...launch.env, RELAY_THREAD: t.id, RELAY_HOME: this.store.home });
    const host = new Host({ file: cmd.file, args: cmd.args, cwd: t.cwd, env, cols: this.size.cols, rows: this.size.rows, rawLog: this.store.file('raw', `${t.id}.log`) });
    const l = { host, acc: a.newAcc(), offset: 0, transcript: null, approval: null, lastApprovalCheck: 0, eventsOffset: 0, parking: false, attached: 0, adapter: a, pending: launch.promptMode === 'type' && prompt && !resume ? prompt : '' };
    this.live.set(t.id, l);
    if (launch.sessionId && !t.nativeSessionId) t.nativeSessionId = launch.sessionId;
    t.state = 'starting'; t.startedAt = Date.now(); t.exitCode = null; t.cmdline = [cmd.file, ...(Array.isArray(cmd.args) ? cmd.args : [cmd.args])].map(String).join(' ').slice(0, 2000);
    t.cliVersion = detect(t.agent).version || t.cliVersion || null;
    this.store.saveThread(t);
    host.on('data', (d) => { this.emit('out', t.id, d); this.checkApproval(t.id, false); });
    host.on('exit', ({ exitCode }) => this.onExit(t.id, exitCode));
    try { host.start(); } catch (e) { this.live.delete(t.id); t.state = 'ended'; t.error = String(e.message || e); this.store.saveThread(t); throw e; }
    this.parkIfNeeded(t.id);
    this.pushState();
    return l;
  }

  onExit(id, code) {
    const l = this.live.get(id);
    if (!l) return;
    this.tailOne(id, l); // last lines of the transcript
    const t = this.store.getThread(id);
    this.live.delete(id);
    for (const [aid, ap] of this.approvals) if (ap.threadId === id && ap.kind === 'prompt') this.approvals.delete(aid);
    if (t) {
      l.host.snapshot().then(s => { t.lastScreen = s.slice(-200_000); this.store.saveThread(t); });
      t.state = l.parking ? 'parked' : 'ended';
      t.exitCode = code;
      this.store.saveThread(t);
      if (!l.parking) this.emit('toast', { kind: code ? 'warn' : 'info', text: `${agentName(t.agent)} in "${short(t.title, 40)}" exited${code ? ` (code ${code})` : ''}.`, chat: id });
    }
    this.emit('exit', id, code);
    this.pushState();
  }

  /** Keep at most maxLive agents running: stop the longest-unused waiting one; it resumes when opened. */
  parkIfNeeded(keepId) {
    if (this.live.size <= this.maxLive) return;
    const cands = [...this.live.entries()].filter(([id]) => id !== keepId).map(([id, l]) => ({ id, l, t: this.store.getThread(id) }))
      .filter(x => x.t && x.t.state === 'waiting' && x.t.nativeSessionId && !x.l.approval).sort((a, b) => a.l.attached - b.l.attached);
    const v = cands[0];
    if (!v) return;
    v.l.parking = true;
    v.l.host.kill();
  }

  /** Opening a chat: resume it if its agent is not running. */
  ensureLive(id) {
    const t = this.need(id);
    if (this.live.has(id)) return this.live.get(id);
    if (t.state === 'parked' && t.nativeSessionId) return this.start(t, { resume: true });
    return null;
  }

  restart(id) {
    const t = this.need(id);
    if (this.live.has(id)) return this.live.get(id);
    if (t.nativeSessionId) return this.start(t, { resume: true });
    return this.start(t, { prompt: t.firstPrompt || '' });
  }

  stop(id) {
    const l = this.live.get(id);
    if (l) l.host.kill();
  }

  deleteChat(id, { files = false } = {}) {
    const t = this.need(id);
    const l = this.live.get(id);
    if (l) { l.parking = true; l.host.kill(); this.live.delete(id); }
    for (const [aid, ap] of this.approvals) if (ap.threadId === id) this.approvals.delete(aid);
    if (files) fs.rmSync(path.join(t.project || t.cwd, '.theodore', 'threads', id), { recursive: true, force: true });
    if (t.transcriptPath) this.claimed.delete(t.transcriptPath);
    this.store.deleteThread(id);
    this.pushState();
  }

  rename(id, title) {
    const t = this.need(id);
    t.title = short(title, 120) || t.title; t.titleAuto = false;
    this.store.saveThread(t); this.pushState();
  }

  input(id, data) {
    const l = this.live.get(id);
    if (l) l.host.write(data);
  }

  resize(id, cols, rows) {
    this.size = { cols: cols | 0 || this.size.cols, rows: rows | 0 || this.size.rows };
    const l = id && this.live.get(id);
    if (l) l.host.resize(this.size.cols, this.size.rows);
  }

  async snapshot(id) {
    const l = this.live.get(id);
    if (l) { l.attached = Date.now(); return { data: await l.host.snapshot(), live: true, anchor: l.adapter.anchorBottom ? l.host.emptyRowsBelow() : 0 }; }
    const t = this.store.getThread(id);
    return { data: t?.lastScreen || '', live: false, anchor: 0 };
  }

  /* ======================= ticks: transcripts, state, events, artifacts ======================= */

  tick() {
    for (const [id, l] of this.live) {
      this.tailOne(id, l);
      this.typePending(id, l);
      this.checkApproval(id, true);
    }
    this.readRequests();
    this.readEventsAll();
    this.scanArtifacts();
    this.pushState();
  }

  tailOne(id, l) {
    const t = this.store.getThread(id);
    if (!t) return;
    if (!l.transcript) {
      const p = l.adapter.findTranscript(t, this.claimed, this.store.file('tmp'));
      if (p) {
        l.transcript = p; this.claimed.add(p);
        if (t.transcriptPath !== p) { t.transcriptPath = p; }
      }
    }
    let changed = false;
    if (l.transcript) {
      const r = readJsonlFrom(l.transcript, l.offset);
      if (r.offset < l.offset) { l.acc = l.adapter.newAcc(); }
      l.offset = r.offset;
      if (r.records.length) {
        for (const rec of r.records) { try { l.adapter.reduce(l.acc, rec); } catch { /* one odd record */ } }
        changed = true;
      }
    }
    if (changed || l.dirty) {
      const res = l.adapter.finish(l.acc);
      l.dirty = false;
      // a resumed chat reads its transcript again from the start; never replace a record with an empty one
      if (res.turns.length || !t.turns.length) t.turns = res.turns;
      if (res.tools.length || !t.tools.length) t.tools = res.tools;
      t.usage = { ...t.usage, ...res.usage };
      if (res.sessionId && !t.nativeSessionId) t.nativeSessionId = res.sessionId;
      if (res.cliVersion) t.cliVersion = res.cliVersion;
      if (res.title && t.titleAuto) t.title = short(res.title, 80);
      if (t.titleAuto && !res.title && !t.firstPrompt && / chat \d+$/.test(t.title)) {
        const firstUser = res.turns.find(x => x.role === 'user');
        if (firstUser) t.title = short(firstUser.text, 48);
      }
      l.busy = res.busy;
    }
    const prev = t.state;
    t.state = this.stateOf(t, l);
    if (changed || prev !== t.state) {
      if (prev === 'working' && t.state === 'waiting') {
        this.emit('turnDone', id);
        if (t.parentId && !t.handoffLoaded && t.turns.filter(x => x.role === 'assistant').length >= 1) t.handoffMissing = true;
      }
      this.store.saveThread(t);
    }
  }

  stateOf(t, l) {
    if (!l.host.alive) return 'ended';
    if (l.approval) return 'approval';
    const quietFor = Date.now() - l.host.lastOutput;
    if (l.busy === true) return 'working';
    if (l.busy === false) return quietFor < 1500 && t.state === 'working' ? 'working' : 'waiting';
    if (!l.host.bytes) return 'starting';
    if (!t.turns.length && !l.pending) return 'waiting';
    return quietFor < 2000 ? 'working' : 'waiting';
  }

  /** Agents that cannot take the first message on their command line get it typed once their screen settles. */
  typePending(id, l) {
    if (!l.pending) return;
    const h = l.host;
    const settled = h.bytes > 0 && Date.now() - h.lastOutput > 1200 && Date.now() - h.started > 1500;
    if (!settled && Date.now() - h.started < 20000) return;
    const text = l.pending; l.pending = '';
    h.paste(text);
    setTimeout(() => h.write('\r'), 250);
  }

  /** Watch the screen for a permission prompt (throttled). */
  checkApproval(id, force) {
    const l = this.live.get(id);
    if (!l) return;
    const nowMs = Date.now();
    if (!force && nowMs - l.lastApprovalCheck < 250) { l.approvalDue = true; return; }
    if (force && !l.approvalDue && nowMs - l.lastApprovalCheck < 900) return;
    l.lastApprovalCheck = nowMs; l.approvalDue = false;
    const t = this.store.getThread(id);
    if (!t) return;
    let found = detectApproval(t.agent, l.host.lines());
    let sig = found ? `${found.question}|${found.what}` : '';
    // the prompt we just answered stays on screen until the agent redraws: not a new request
    if (found && sig === l.answeredSig && nowMs - l.answeredAt < 2500) { found = undefined; sig = ''; }
    if (sig === (l.approval?.sig || '')) { l.missSince = 0; return; }
    // a redraw can hide the prompt for a moment: only drop it once it has been gone for a while
    if (!found && l.approval) {
      l.missSince ||= nowMs;
      if (nowMs - l.missSince < 700) { l.approvalDue = true; return; }
    }
    l.missSince = 0;
    if (l.approval) { this.approvals.delete(l.approval.id); l.approval = null; }
    if (found) {
      const ap = { id: newId('a_'), kind: 'prompt', threadId: id, sig, ...found, risk: riskOf(found.what), since: nowMs };
      this.approvals.set(ap.id, ap); l.approval = ap;
      this.emit('approval', ap);
    }
    t.state = this.stateOf(t, l);
    this.pushState();
  }

  /** Answer a screen prompt: type the agent's own key. */
  approve(id, approvalId, choice = 'approve') {
    const l = this.live.get(id);
    const ap = this.approvals.get(approvalId);
    if (!l || !ap || ap.threadId !== id) throw Object.assign(new Error('That request is no longer waiting.'), { status: 409 });
    const key = choice === 'deny' ? ap.keys.deny : choice === 'always' && ap.keys.always ? ap.keys.always : ap.keys.approve;
    l.host.write(key);
    l.answeredSig = ap.sig; l.answeredAt = Date.now();
    this.decided(ap, choice);
    this.approvals.delete(approvalId); l.approval = null;
    setTimeout(() => this.checkApproval(id, true), 400);
    this.pushState();
  }

  /** request_approval questions written by the MCP servers. */
  readRequests() {
    let files = [];
    try { files = fs.readdirSync(this.store.file('requests')); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.json') || this.requestsSeen.has(f)) continue;
      const q = readJson(this.store.file('requests', f), null);
      if (!q?.threadId) continue;
      this.requestsSeen.add(f);
      const t = this.store.getThread(q.threadId);
      if (!t) continue;
      const ap = { id: q.id, kind: 'ask', threadId: q.threadId, question: q.question, what: q.details, options: (q.options || []).map((label, i) => ({ key: String(i + 1), label })), since: q.ts, risk: { tag: 'question', level: 0 }, file: f };
      this.approvals.set(ap.id, ap);
      this.emit('approval', ap);
    }
  }

  /** The answer to a request_approval question becomes the next message to that agent. */
  answer(id, requestId, { choice, note }) {
    const ap = this.approvals.get(requestId);
    if (!ap || ap.kind !== 'ask') throw Object.assign(new Error('That question is no longer waiting.'), { status: 409 });
    const l = this.live.get(id) || this.ensureLive(id);
    const text = `${/^Other:/.test(choice || '') ? choice : `Answer: ${choice || 'ok'}`}${note ? ` — Note: ${note}` : ''}`.replace(/\s+/g, ' ');
    const send = () => { const ll = this.live.get(id); if (!ll) return; ll.host.paste(text); setTimeout(() => ll.host.write('\r'), 250); };
    if (l && l.host.bytes > 0) send(); else setTimeout(send, 4000);
    try { fs.unlinkSync(this.store.file('requests', ap.file)); } catch { /* */ }
    this.decided(ap, choice || 'answered');
    this.approvals.delete(requestId);
    this.pushState();
  }

  decided(ap, choice) {
    const t = this.store.getThread(ap.threadId);
    const day = new Date().toDateString();
    this.store.state.decided = [{ threadId: ap.threadId, title: t?.title, agent: t?.agent, what: ap.what || ap.question, choice, ts: Date.now() }, ...this.store.state.decided.filter(d => new Date(d.ts).toDateString() === day)].slice(0, 100);
    this.store.saveState();
    if (t) { t.activity = [...(t.activity || []), { kind: 'approval', text: `${choice} · ${short(ap.what || ap.question, 140)}`, ts: Date.now() }].slice(-200); this.store.saveThread(t); }
  }

  /** MCP calls the agents made (logged by `relay mcp`). */
  readEventsAll() {
    for (const [id, l] of this.live) {
      const file = this.store.file('events', `${id}.jsonl`);
      const r = readJsonlFrom(file, l.eventsOffset);
      l.eventsOffset = r.offset;
      if (!r.records.length) continue;
      const t = this.store.getThread(id);
      for (const e of r.records) {
        t.mcpCalls = [...(t.mcpCalls || []), { tool: e.tool, target: e.target, ts: e.ts }].slice(-200);
        if (e.tool === 'get_handoff_context' && !e.none) { t.handoffLoaded = true; t.handoffMissing = false; }
      }
      this.store.saveThread(t);
    }
  }

  /** Ask a handoff chat again to load the context (it answered without calling the tool). */
  retryHandoff(id) {
    const t = this.need(id);
    const l = this.live.get(id) || this.ensureLive(id);
    if (!l) throw new Error('The agent is not running.');
    const text = 'Please call the theodore MCP tool get_handoff_context now (no arguments), then summarise it in at most 5 bullets.';
    l.host.paste(text); setTimeout(() => l.host.write('\r'), 250);
    t.handoffMissing = false; this.store.saveThread(t);
  }

  scanArtifacts() {
    const nowMs = Date.now();
    if (nowMs - (this.lastArtScan || 0) < 2000) return;
    this.lastArtScan = nowMs;
    for (const [id] of this.live) {
      const t = this.store.getThread(id);
      if (!t) continue;
      const arts = listArtifacts(t);
      const known = new Map((t.artifacts || []).map(a => [a.path, a]));
      let changed = false;
      const next = arts.map(a => {
        const k = known.get(a.path);
        if (k && k.mtime === a.mtime) return k;
        const hash = fileHash(a.path);
        changed = true;
        if (!k) this.emit('toast', { kind: 'artifact', text: `+ ${a.name} in "${short(t.title, 36)}"`, chat: id, path: a.path });
        return { path: a.path, name: a.name, size: a.size, mtime: a.mtime, hash, versions: (k?.versions || 0) + 1 };
      });
      if (changed || next.length !== known.size) { t.artifacts = next; this.store.saveThread(t); }
    }
  }

  /* ======================= dropped files ======================= */

  /** Paste dropped files into the agent's input as paths (optionally copied into the chat folder first). */
  drop(id, paths, { copy = false } = {}) {
    const t = this.need(id);
    const l = this.live.get(id) || this.ensureLive(id);
    const out = [];
    for (const p of paths || []) {
      if (!fs.existsSync(p)) { this.emit('toast', { kind: 'warn', text: `Not found: ${p}` }); continue; }
      if (copy && fs.statSync(p).isFile()) out.push(this.copyIn(t, path.basename(p), fs.readFileSync(p)));
      else out.push(p);
    }
    if (!out.length) return [];
    t.attachments = [...(t.attachments || []), ...out.map(p => ({ path: p, ts: Date.now() }))];
    t.activity = [...(t.activity || []), ...out.map(p => ({ kind: 'drop', text: p, ts: Date.now() }))].slice(-200);
    this.store.saveThread(t);
    const text = out.map(quotePath).join(' ') + ' ';
    if (l) l.host.paste(text);
    return out;
  }

  /** Save uploaded bytes into <project>/.theodore/threads/<id>/attachments/ (a second file of the same name gets " (2)"). */
  copyIn(t, name, buf) {
    const dir = ensureDir(attachmentsDir(t));
    name = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
    let dest = path.join(dir, name);
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${stem} (${i})${ext}`);
    fs.writeFileSync(dest, buf);
    return dest;
  }

  upload(id, name, buf) {
    const t = this.need(id);
    const dest = this.copyIn(t, name, buf);
    return this.drop(id, [dest], { copy: false });
  }

  /* ======================= views ======================= */

  /** Send the state to the windows, at most every 120 ms and only when it changed (ticks run every second). */
  pushState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const st = this.state();
      const sig = JSON.stringify(st);
      if (sig === this.lastStateSig) return;
      this.lastStateSig = sig;
      this.emit('state', st);
    }, 120);
  }

  chatRow(t) {
    const l = this.live.get(t.id);
    return {
      id: t.id, title: t.title, agent: t.agent, state: t.state, cwd: t.cwd, project: t.project, parentId: t.parentId,
      model: t.model, effort: t.effort, skip: t.skip, live: !!l, created: t.created, updated: t.updated,
      usage: t.usage, handoffMissing: !!t.handoffMissing && !t.handoffLoaded, handoffLoaded: !!t.handoffLoaded,
      artifacts: (t.artifacts || []).length, exitCode: t.exitCode, error: t.error, turns: t.turns.length,
      canResume: !!t.nativeSessionId, anchor: !!adapter(t.agent)?.anchorBottom,
    };
  }

  state() {
    const threads = this.store.listThreads();
    const approvals = [...this.approvals.values()].map(a => {
      const t = this.store.getThread(a.threadId);
      return { ...a, title: t?.title, agent: t?.agent, project: t?.project, keys: undefined };
    }).sort((a, b) => a.since - b.since);
    const projects = this.store.state.projects.map(p => ({ ...p, chats: threads.filter(t => samePath(t.project, p.path)).map(t => this.chatRow(t)) }));
    const loose = threads.filter(t => !this.store.state.projects.some(p => samePath(t.project, p.path))).map(t => this.chatRow(t));
    if (loose.length) projects.push({ path: '', name: 'Other', chats: loose });
    return { projects, approvals, decided: this.store.state.decided.filter(d => new Date(d.ts).toDateString() === new Date().toDateString()), live: this.live.size, maxLive: this.maxLive, home: this.store.home, platform: process.platform };
  }

  chatDetail(id) {
    const t = this.need(id);
    return {
      ...this.chatRow(t),
      firstPrompt: t.firstPrompt, nativeSessionId: t.nativeSessionId, transcriptPath: t.transcriptPath, cliVersion: t.cliVersion, cmdline: t.cmdline,
      artifactsDir: artifactsDir(t), artifactsList: listArtifacts(t), files: filesTouched(t),
      approval: [...this.approvals.values()].filter(a => a.threadId === id).map(a => ({ ...a, keys: undefined })),
      parent: t.parentId ? (({ id, title, agent }) => ({ id, title, agent }))(this.store.getThread(t.parentId) || {}) : null,
      children: this.store.childrenOf(id).map(c => ({ id: c.id, title: c.title, agent: c.agent })),
    };
  }

  activity(id) {
    const t = this.need(id);
    const rows = [
      ...t.tools.map(x => ({ kind: x.kind, ts: x.ts, text: `${x.name}${x.target ? ` · ${x.target}` : ''}`, status: x.status, result: x.result })),
      ...(t.mcpCalls || []).map(x => ({ kind: 'mcp', ts: x.ts, text: `theodore.${x.tool}${x.target ? ` · ${x.target}` : ''}`, status: 'ok' })),
      ...(t.activity || []),
      ...(t.artifacts || []).map(a => ({ kind: 'artifact', ts: a.mtime, text: a.name, status: 'ok' })),
    ];
    return rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  record(id) { return buildHandoff(this.need(id)); }

  memory(q) {
    return this.store.search(q).map(t => {
      const firstUser = t.turns.find(x => x.role === 'user');
      const last = [...t.turns].reverse().find(x => x.role === 'assistant');
      const tools = {};
      for (const x of t.tools) tools[x.name] = (tools[x.name] || 0) + 1;
      return { ...this.chatRow(t), asked: short(firstUser?.text || t.firstPrompt || '', 300), lastAnswer: short(last?.text || '', 400), files: filesTouched(t).slice(0, 12), tools, recent: t.tools.slice(-5).map(x => ({ name: x.name, target: x.target, status: x.status })) };
    });
  }

  /** What the New chat form needs. */
  newChatInfo(fromId) {
    const src = fromId ? this.store.getThread(fromId) : null;
    const agents = Object.keys(AGENTS).map(id => {
      const d = detect(id);
      const a = AGENTS[id];
      return { id, name: a.name, letter: a.letter, installed: d.installed, version: d.version, login: d.login, models: a.models, efforts: a.efforts, skipFlag: a.skipFlag, install: d.install };
    });
    return {
      agents,
      recent: this.store.state.recentFolders.filter(p => fs.existsSync(p)),
      home: process.env.USERPROFILE || process.env.HOME,
      defaultFolder: src?.cwd || this.store.state.recentFolders[0] || process.env.RELAY_PROJECT || process.env.USERPROFILE || process.env.HOME,
      from: src ? { id: src.id, title: src.title, agent: src.agent, skip: !!src.skip, cwd: src.cwd } : null,
      lastAgent: this.store.state.settings.lastAgent || 'claude',
    };
  }
}

/** A path the way a terminal pastes a dropped file. */
export function quotePath(p) {
  if (isWin) return /\s/.test(p) ? `"${p}"` : p;
  return p.replace(/([ \\'"()&;|<>$`!*?[\]{}])/g, '\\$1');
}

export { which };
