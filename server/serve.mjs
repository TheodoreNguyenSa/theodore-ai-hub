// `relay serve`: the Controller as a local, token-protected HTTP + WebSocket API on 127.0.0.1, plus the page.
//
// It can start processes and type into agents, so a web page must not be able to drive it:
//   another machine                 → listens on 127.0.0.1 only
//   a local process without token   → 32-byte token on every request (Authorization: Bearer, cookie, or ?token= once)
//   DNS rebinding                   → the Host header must be 127.0.0.1:<port> or localhost:<port>
//   cross-site requests             → writes need the X-Relay: 1 header and our own Origin; the cookie is SameSite=Strict
//   a foreign page opening the WS   → upgrade needs the token and our Origin
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Controller } from './controller.mjs';
import { doctor, doctorText } from './doctor.mjs';
import { createSkill, deleteSkill, foundSkills, importSkill, listSkills, setEnabled, skillTargets, sync as syncSkills } from './skills.mjs';
import { isWin, openPath, samePath } from './util.mjs';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = process.env.RELAY_UI || path.resolve(HERE, '../ui');
const NM = path.resolve(HERE, '../node_modules');

const VENDOR = {
  '/vendor/xterm.js': path.join(NM, '@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': path.join(NM, '@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'),
  '/vendor/addon-unicode11.js': path.join(NM, '@xterm/addon-unicode11/lib/addon-unicode11.js'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.woff2': 'font/woff2' };

export async function serve(o = {}) {
  const token = o.token || crypto.randomBytes(32).toString('hex');
  const ctl = o.controller || new Controller({ home: o.home });
  const server = http.createServer();
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(o.port || 0, '127.0.0.1', ok); });
  const port = server.address().port;
  const cookieName = `relay_token_${port}`;
  const okHost = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const okOrigin = (origin) => !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  const safeEq = (a) => typeof a === 'string' && a.length === token.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(token));

  const authed = (req, url) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
    return safeEq(bearer) || safeEq(cookies[cookieName]) || safeEq(url.searchParams.get('token'));
  };

  const send = (res, code, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': isBuf || typeof body === 'string' ? headers['content-type'] || 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(data);
  };
  const readBody = (req, limit = 1 << 20) => new Promise((ok, bad) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { bad(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
  const json = async (req) => { const b = await readBody(req); try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); } };

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  /* ---------------- API ---------------- */
  route('GET', '/api/state', () => ctl.state());
  // errors from the page land in server.log (the desktop app sends the server's stderr there)
  route('POST', '/api/client-log', async (q, req) => { const b = await json(req); process.stderr.write(`page: ${String(b.message || '').slice(0, 2000)}\n`); return { ok: true }; });
  route('GET', '/api/newchat', (q) => ctl.newChatInfo(q.get('from')));
  route('POST', '/api/chats', async (q, req) => {
    const b = await json(req);
    ctl.store.state.settings.lastAgent = b.agent; ctl.store.saveState();
    const t = ctl.newChat({ agent: b.agent, model: b.model || null, effort: b.effort || null, folder: b.folder, prompt: b.prompt || '', skip: !!b.skip, title: b.title });
    return { id: t.id };
  });
  route('GET', '/api/chats/:id', (q, req, p) => ctl.chatDetail(p.id));
  route('DELETE', '/api/chats/:id', (q, req, p) => { ctl.deleteChat(p.id, { files: q.get('files') === '1' }); return { ok: true }; });
  route('POST', '/api/chats/:id/handoff', async (q, req, p) => { const b = await json(req); const t = ctl.handoff(p.id, b); return { id: t.id }; });
  route('POST', '/api/chats/:id/rename', async (q, req, p) => { ctl.rename(p.id, (await json(req)).title); return { ok: true }; });
  route('POST', '/api/chats/:id/approve', async (q, req, p) => { const b = await json(req); ctl.approve(p.id, b.approval, b.choice); return { ok: true }; });
  route('POST', '/api/chats/:id/answer', async (q, req, p) => { const b = await json(req); ctl.answer(p.id, b.request, b); return { ok: true }; });
  route('POST', '/api/chats/:id/retry', (q, req, p) => { ctl.retryHandoff(p.id); return { ok: true }; });
  route('POST', '/api/chats/:id/restart', (q, req, p) => { ctl.restart(p.id); return { ok: true }; });
  route('POST', '/api/chats/:id/stop', (q, req, p) => { ctl.stop(p.id); return { ok: true }; });
  route('GET', '/api/chats/:id/activity', (q, req, p) => ctl.activity(p.id));
  route('GET', '/api/chats/:id/record', (q, req, p) => ({ text: ctl.record(p.id) }));
  route('POST', '/api/chats/:id/drop', async (q, req, p) => { const b = await json(req); return { pasted: ctl.drop(p.id, b.paths, { copy: !!b.copy }) }; });
  route('POST', '/api/chats/:id/attachments', async (q, req, p) => { const buf = await readBody(req, 50 << 20); return { pasted: ctl.upload(p.id, q.get('name') || 'file', buf) }; });
  route('GET', '/api/memory', (q) => ctl.memory(q.get('q') || ''));

  route('POST', '/api/open', async (q, req) => {
    const b = await json(req);
    if (!b.path || !fs.existsSync(b.path)) throw Object.assign(new Error('Not found'), { status: 404 });
    openPath(b.path, { reveal: !!b.reveal });
    return { ok: true };
  });
  /** Artifact and attachment files for the preview pane: only inside a chat's .theodore folder. */
  route('GET', '/api/file', (q) => {
    const p = path.resolve(q.get('path') || '');
    const inside = ctl.store.listThreads().some(t => { const r = path.relative(path.join(t.project || t.cwd, '.theodore', 'threads', t.id), p); return r && !r.startsWith('..') && !path.isAbsolute(r); });
    if (!inside || !fs.existsSync(p)) throw Object.assign(new Error('Not an artifact'), { status: 403 });
    return { __file: p };
  });

  route('GET', '/api/skills', () => ({ library: listSkills(ctl.store), found: foundSkills(ctl.store), targets: skillTargets().map(t => ({ ...t })), dir: ctl.store.file('skills') }));
  route('POST', '/api/skills', async (q, req) => { const b = await json(req); const file = createSkill(ctl.store, b); return { file }; });
  route('POST', '/api/skills/import', async (q, req) => { const b = await json(req); return { dir: importSkill(ctl.store, b.path) }; });
  route('POST', '/api/skills/sync', () => syncSkills(ctl.store));
  route('POST', '/api/skills/:name/toggle', async (q, req, p) => setEnabled(ctl.store, p.name, !!(await json(req)).on));
  route('POST', '/api/skills/:name/open', (q, req, p) => { openPath(path.join(ctl.store.file('skills'), p.name, 'SKILL.md')); return { ok: true }; });
  route('DELETE', '/api/skills/:name', (q, req, p) => { deleteSkill(ctl.store, p.name); return { ok: true }; });

  route('GET', '/api/doctor', (q) => ({ checks: doctor({ fresh: q.get('fresh') === '1' }) }));
  route('GET', '/api/doctor/text', () => doctorText());

  route('GET', '/api/folders', (q) => listFolders(q.get('path')));
  route('POST', '/api/projects/remove', async (q, req) => { ctl.store.removeProject((await json(req)).path); ctl.pushState(); return { ok: true }; });
  route('POST', '/api/projects/toggle', async (q, req) => {
    const b = await json(req);
    const p = ctl.store.state.projects.find(x => samePath(x.path, b.path));
    if (p) { p.collapsed = !p.collapsed; ctl.store.saveState(); ctl.pushState(); }
    return { ok: true };
  });
  route('POST', '/api/projects/add', async (q, req) => { const b = await json(req); if (!fs.existsSync(b.path)) throw Object.assign(new Error('Folder not found'), { status: 400 }); ctl.store.addProject(path.resolve(b.path)); ctl.pushState(); return { ok: true }; });
  route('GET', '/api/settings', () => ({ ...ctl.store.state.settings, maxLive: ctl.maxLive }));
  route('POST', '/api/settings', async (q, req) => {
    const b = await json(req);
    Object.assign(ctl.store.state.settings, b);
    if (b.maxLive) ctl.maxLive = Math.max(1, Math.min(20, b.maxLive | 0));
    ctl.store.saveState();
    return { ok: true };
  });

  /* ---------------- HTTP ---------------- */
  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!okHost(req.headers.host)) return send(res, 421, { error: 'bad host' });
    // static page and vendor files need the token too (the page is the app)
    if (!authed(req, url)) return send(res, 401, { error: 'token required' });
    const setCookie = url.searchParams.get('token') ? { 'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` } : {};
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && (req.headers['x-relay'] !== '1' || !okOrigin(req.headers.origin))) return send(res, 403, { error: 'cross-site write refused' });
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const out = await r.fn(url.searchParams, req, m.groups || {});
          if (out && out.__file) {
            const ext = path.extname(out.__file).toLowerCase();
            return send(res, 200, fs.readFileSync(out.__file), { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" });
          }
          return send(res, 200, out ?? { ok: true }, setCookie);
        }
        return send(res, 404, { error: 'no route' });
      }
      let file;
      if (VENDOR[url.pathname]) file = VENDOR[url.pathname];
      else {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        file = path.resolve(UI, rel);
        if (!file.startsWith(path.resolve(UI))) return send(res, 403, 'no');
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found');
      const ext = path.extname(file).toLowerCase();
      send(res, 200, fs.readFileSync(file), { 'content-type': TYPES[ext] || 'application/octet-stream', ...setCookie, ...(ext === '.html' ? { 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-src 'self'; object-src 'none'; base-uri 'none'" } : {}) });
    } catch (e) {
      send(res, e.status || 500, { error: String(e.message || e) });
    }
  });

  /* ---------------- WebSocket: agent screens ---------------- */
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== '/ws' || !okHost(req.headers.host) || !authed(req, url) || !okOrigin(req.headers.origin)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  const clients = new Set();
  const out = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  ctl.on('state', (s) => { for (const c of clients) out(c.ws, { t: 'state', state: s }); });
  ctl.on('out', (id, data) => { for (const c of clients) if (c.attached === id && c.ready) out(c.ws, { t: 'out', id, data }); else if (c.attached === id) c.queue.push(data); });
  ctl.on('exit', (id, code) => { for (const c of clients) out(c.ws, { t: 'exit', id, code }); });
  ctl.on('toast', (x) => { for (const c of clients) out(c.ws, { t: 'toast', ...x }); });
  ctl.on('approval', (a) => { for (const c of clients) out(c.ws, { t: 'approval', approval: { ...a, keys: undefined, title: ctl.store.getThread(a.threadId)?.title, agent: ctl.store.getThread(a.threadId)?.agent } }); });
  ctl.on('turnDone', (id) => { const t = ctl.store.getThread(id); for (const c of clients) if (c.attached !== id) out(c.ws, { t: 'done', id, title: t?.title, agent: t?.agent }); });

  wss.on('connection', (ws) => {
    const c = { ws, attached: null, ready: false, queue: [] };
    clients.add(c);
    out(ws, { t: 'state', state: ctl.state() });
    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      try {
        switch (m.t) {
          case 'attach': {
            c.attached = m.id; c.ready = false; c.queue = [];
            if (m.cols && m.rows) ctl.resize(null, m.cols, m.rows);
            try { ctl.ensureLive(m.id); } catch (e) { out(ws, { t: 'toast', kind: 'warn', text: String(e.message || e) }); }
            if (m.cols && m.rows) ctl.resize(m.id, m.cols, m.rows);
            // Everything the agent wrote before this point is in the snapshot (it waits behind an empty write); what it
            // writes from here on is queued and sent right after the replay: no byte lost, none doubled.
            c.queue = [];
            const snap = await ctl.snapshot(m.id);
            if (c.attached !== m.id) return;
            out(ws, { t: 'replay', id: m.id, data: snap.data, live: snap.live, anchor: snap.anchor });
            for (const d of c.queue) out(ws, { t: 'out', id: m.id, data: d });
            c.queue = []; c.ready = true;
            break;
          }
          case 'detach': c.attached = null; c.ready = false; break;
          case 'in': if (m.id === c.attached) ctl.input(m.id, m.data); break;
          case 'resize': ctl.resize(m.id, m.cols, m.rows); break;
          case 'drop': { const pasted = ctl.drop(m.id, m.paths, { copy: !!m.copy }); out(ws, { t: 'dropped', id: m.id, paths: pasted }); break; }
          case 'anchor': { const l = ctl.live.get(m.id); if (l) out(ws, { t: 'anchor', id: m.id, rows: l.host.emptyRowsBelow() }); break; }
        }
      } catch (e) {
        out(ws, { t: 'toast', kind: 'warn', text: String(e.message || e) });
      }
    });
    ws.on('close', () => clients.delete(c));
  });

  const url = `http://127.0.0.1:${port}/?token=${token}`;
  return { server, port, token, url, controller: ctl, close: () => { ctl.close(); wss.close(); server.close(); } };
}

/** Folder browser for the New chat form: drives on Windows, sub-folders elsewhere. */
function listFolders(p) {
  if (!p) {
    if (isWin) {
      const drives = [];
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { fs.accessSync(`${l}:\\`); drives.push({ name: `${l}:\\`, path: `${l}:\\` }); } catch { /* */ } }
      return { path: '', parent: null, dirs: [{ name: 'Home', path: os.homedir() }, ...drives] };
    }
    p = os.homedir();
  }
  const abs = path.resolve(p);
  let dirs = [];
  try {
    dirs = fs.readdirSync(abs, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && !/^(\$RECYCLE\.BIN|System Volume Information|node_modules)$/i.test(e.name))
      .map(e => ({ name: e.name, path: path.join(abs, e.name) })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 400);
  } catch (e) { return { path: abs, parent: path.dirname(abs) !== abs ? path.dirname(abs) : null, dirs: [], error: e.code }; }
  const parent = path.dirname(abs);
  return { path: abs, parent: parent !== abs ? parent : (isWin ? '' : null), dirs };
}
