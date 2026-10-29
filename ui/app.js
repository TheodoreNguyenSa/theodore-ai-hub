/* Relay — the page. No framework: state comes from the server over one WebSocket, every screen is a function that
   returns HTML, clicks are handled by data-act attributes. The agent's own screen is one xterm.js terminal that is
   re-attached to whichever chat is open. */
'use strict';

// report page errors to the server log: the desktop window has no console to look at
const reportError = (message) => { try { fetch('/api/client-log', { method: 'POST', credentials: 'same-origin', headers: { 'x-relay': '1', 'content-type': 'application/json' }, body: JSON.stringify({ message }) }); } catch { /* */ } };
window.addEventListener('error', (e) => reportError(`${e.message} at ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', (e) => reportError(`unhandled: ${e.reason?.stack || e.reason}`));

const AGENT = {
  claude: { name: 'Claude Code', letter: 'C', color: 'var(--a-claude)' },
  codex: { name: 'Codex', letter: 'X', color: 'var(--a-codex)' },
  gemini: { name: 'Gemini CLI', letter: 'G', color: 'var(--a-gemini)' },
  agy: { name: 'Antigravity', letter: 'A', color: 'var(--a-agy)' },
};
const STATE_LABEL = { working: 'working', waiting: 'waiting for you', approval: 'asks permission', starting: 'starting', parked: 'paused', ended: 'ended' };
const IS_TAURI = !!window.__TAURI_INTERNALS__ || !!window.__TAURI__;

const S = {
  state: null,
  route: { name: 'boot' },
  drawer: null,          // 'artifacts' | 'activity' | 'record'
  drawerData: null,
  nc: null,              // New chat / hand off form
  ncInfo: null,
  memory: { q: '', list: [], sel: null },
  skills: null,
  doctor: null,
  approvalsScope: 'all',
  connected: false,
  sideOpen: true,
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (s, n = 60) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('relay.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('relay.' + k, JSON.stringify(v)); } catch { /* storage off */ } },
};
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
};
const chip = (agent) => `<span class="chip ${esc(agent)}" aria-hidden="true">${esc(AGENT[agent]?.letter || '?')}</span>`;
const tagAgent = (agent) => `<span class="tag">${chip(agent)}${esc(AGENT[agent]?.name || agent)}</span>`;
const icon = {
  plus: '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M8 4.5v7M4.5 8h7" stroke="var(--rail)" stroke-width="1.6" stroke-linecap="round"/></svg>',
  flag: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 14V2.5M3.5 3h8l-2 3 2 3h-8"/></svg>',
  book: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3h4a1.5 1.5 0 0 1 1.5 1.5V13a1.2 1.2 0 0 0-1.2-1.2H2.5zM13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1.2 1.2 0 0 1 1.2-1.2h4.3z"/></svg>',
  spark: '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z"/></svg>',
  side: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
  more: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  gear: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6"/></svg>',
  logo: '<svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lg" x1="0" x2="1"><stop offset="0" stop-color="#b65a35"/><stop offset="1" stop-color="#3346d3"/></linearGradient></defs><path d="M10 42 C 20 42, 22 22, 32 22 S 44 42, 54 42" fill="none" stroke="url(#lg)" stroke-width="8" stroke-linecap="round"/><circle cx="10" cy="42" r="6.5" fill="#b65a35"/><circle cx="54" cy="42" r="6.5" fill="#3346d3"/></svg>',
};

/* =============================== server =============================== */

async function api(method, path, body, raw) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: raw ? { 'x-relay': '1', 'content-type': 'application/octet-stream' } : { 'x-relay': '1', 'content-type': 'application/json' },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || `${r.status} ${r.statusText}`);
  return data;
}
const act = async (fn) => { try { return await fn(); } catch (e) { toast({ kind: 'warn', text: e.message || String(e) }); } };

let ws, wsTimer, wsDelay = 500;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { S.connected = true; wsDelay = 500; if (attachedId) { const id = attachedId; attachedId = null; attach(id); } renderChrome(); };
  ws.onclose = () => { S.connected = false; renderChrome(); clearTimeout(wsTimer); wsTimer = setTimeout(connect, wsDelay = Math.min(wsDelay * 2, 5000)); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
}
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function onMessage(m) {
  switch (m.t) {
    case 'state': {
      const first = !S.state;
      S.state = m.state;
      if (first && S.route.name === 'boot') route();
      else {
        renderChrome();
        if (S.route.name === 'chat') renderChatHead();
        // the approvals page has inputs: redraw it only when the set of requests changed
        const sig = S.state.approvals.map(a => a.id).join() + '|' + S.state.decided.length;
        if (S.route.name === 'approvals' && sig !== S.apSig) renderMain();
        S.apSig = sig;
      }
      break;
    }
    case 'replay': if (m.id === attachedId) onReplay(m); break;
    case 'out': if (m.id === attachedId && !awaitingReplay) term.write(m.data); break;
    case 'exit': if (m.id === attachedId) setTimeout(renderChatHead, 50); break;
    case 'toast': toast({ kind: m.kind === 'artifact' ? 'done' : m.kind, text: m.text, actions: m.chat && m.chat !== currentChatId() ? [{ label: 'Open', go: `#/chat/${m.chat}` }] : m.path ? [{ label: 'Open file', open: m.path }] : [] }); break;
    case 'approval': onApproval(m.approval); break;
    case 'done': onDone(m); break;
    case 'dropped': if (m.paths?.length) toast({ kind: 'done', text: `Added to the message: ${m.paths.map(p => p.split(/[\\/]/).pop()).join(', ')}` }); break;
  }
}

const allChats = () => (S.state?.projects || []).flatMap(p => p.chats);
const chatById = (id) => allChats().find(c => c.id === id);
const currentChatId = () => (S.route.name === 'chat' ? S.route.id : null);

/* =============================== router =============================== */

window.addEventListener('hashchange', route);
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [name, a, b] = h.split('/');
  const prev = S.route;
  if (!name) {
    const last = store.get('lastChat');
    const target = last && chatById(last) ? `#/chat/${last}` : allChats().length ? `#/chat/${allChats()[allChats().length - 1].id}` : '#/new';
    return location.replace(target);
  }
  if (name === 'chat') S.route = { name: 'chat', id: a };
  else if (name === 'new') S.route = { name: 'new', folder: a === 'in' ? h.slice('new/in/'.length) : null };
  else if (name === 'handoff') S.route = { name: 'handoff', id: a };
  else if (name === 'memory') S.route = { name: 'memory', id: a };
  else S.route = { name };
  if (prev.name !== S.route.name || prev.id !== S.route.id) S.drawer = null;
  if (S.route.name !== 'chat') detach();
  if (S.route.name === 'new' || S.route.name === 'handoff') S.nc = null;
  renderChrome();
  renderMain();
}
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };

/* =============================== sidebar =============================== */

function renderChrome() {
  const side = $('#side');
  if (!S.state) { side.innerHTML = `<div class="brand">${icon.logo}<b>Relay</b></div>`; return; }
  const r = S.route;
  const asks = S.state.approvals.length;
  const frontProject = r.name === 'chat' ? chatById(r.id)?.project : r.name === 'new' ? (S.nc?.folder || r.folder) : null;
  const projects = S.state.projects;
  side.innerHTML = `
    <div class="brand">${icon.logo}<b>Relay</b><span class="grow"></span>
      <button class="icon-btn" data-act="toggle-side" title="Hide the sidebar (Ctrl+Shift+B)" aria-label="Hide the sidebar">${icon.side}</button></div>
    <nav class="nav" aria-label="Main">
      <button class="primary ${r.name === 'new' ? 'on' : ''}" data-act="go" data-to="#/new"><span class="ic">${icon.plus}</span>New chat<span class="kbd">Ctrl+Shift+N</span></button>
      <button class="${r.name === 'approvals' ? 'on' : ''}" data-act="go" data-to="#/approvals"><span class="ic">${icon.flag}</span>Approvals${asks ? `<span class="count" aria-label="${asks} waiting">${asks}</span>` : ''}</button>
      <button class="${r.name === 'memory' ? 'on' : ''}" data-act="go" data-to="#/memory"><span class="ic">${icon.book}</span>Memory</button>
      <button class="${r.name === 'skills' ? 'on' : ''}" data-act="go" data-to="#/skills"><span class="ic">${icon.spark}</span>Skills</button>
    </nav>
    <div class="projects-head"><span>Projects</span><button data-act="add-project" title="Add a project folder">+ Add</button></div>
    <div class="tree">${projects.length ? projects.map(p => projectHtml(p, frontProject)).join('') : `<div class="empty" style="padding:16px 8px"><b>No chats yet</b>Start one with New chat.</div>`}</div>
    <div class="side-foot">
      <div class="agents">${['claude', 'codex', 'gemini', 'agy'].map(a => `<span title="${esc(AGENT[a].name)}">${chip(a)}</span>`).join('')}</div>
      ${S.connected ? '' : '<span class="bad" style="font-size:12px">offline…</span>'}
      <button data-act="go" data-to="#/doctor" class="${r.name === 'doctor' ? 'on' : ''}">Doctor</button>
      <button data-act="go" data-to="#/settings" title="Settings" aria-label="Settings">${icon.gear}</button>
    </div>`;
  document.title = asks ? `(${asks}) Relay` : 'Relay';
  $('#app').classList.toggle('no-side', !S.sideOpen);
}

function projectHtml(p, front) {
  const closed = p.collapsed && !(front && samePath(front, p.path));
  const asks = p.chats.filter(c => c.state === 'approval').length;
  // a chat that continues another hangs under it (same project); depth 2 is enough to read a relay
  const byId = new Map(p.chats.map(c => [c.id, c]));
  const kids = new Map();
  for (const c of p.chats) if (c.parentId && byId.has(c.parentId)) (kids.get(c.parentId) || kids.set(c.parentId, []).get(c.parentId)).push(c);
  const rows = [];
  const walk = (c, depth, parent) => {
    rows.push(chatRow(c, depth, parent));
    for (const k of kids.get(c.id) || []) walk(k, Math.min(depth + 1, 2), c);
  };
  for (const c of p.chats) if (!c.parentId || !byId.has(c.parentId)) walk(c, 0, null);
  return `<div class="proj ${closed ? 'closed' : ''} ${front && samePath(front, p.path) ? 'front' : ''}">
    <div class="proj-row" data-act="toggle-project" data-path="${esc(p.path)}" title="${esc(p.path)}">
      <span class="chev">▾</span><span class="name">${esc(p.name)}</span>${asks ? `<span class="badge-ask" title="${asks} asking">!${asks}</span>` : ''}
      ${p.path ? `<button class="add" data-act="new-in" data-path="${esc(p.path)}" title="New chat in ${esc(p.name)}" aria-label="New chat in ${esc(p.name)}">+</button>` : ''}
    </div>
    <div class="chats">${rows.join('')}</div>
  </div>`;
}

function chatRow(c, depth, parent) {
  const on = S.route.name === 'chat' && S.route.id === c.id;
  const style = parent ? ` style="--from:${AGENT[parent.agent]?.color};--to:${AGENT[c.agent]?.color}"` : '';
  return `<div class="chat ${depth ? 'child' : ''} ${depth > 1 ? 'child2' : ''} ${on ? 'on' : ''}"${style} data-act="go" data-to="#/chat/${c.id}" role="link" tabindex="0" title="${esc(c.title)} · ${esc(STATE_LABEL[c.state] || c.state)}">
    <span class="lamp ${esc(c.state)}" aria-label="${esc(STATE_LABEL[c.state] || c.state)}"></span><span class="title">${esc(c.title)}</span>${chip(c.agent)}
  </div>`;
}

function samePath(a, b) { if (!a || !b) return false; const n = (x) => x.replace(/[\\/]+$/, '').toLowerCase(); return n(a) === n(b); }

/* =============================== main =============================== */

function renderMain() {
  const r = S.route;
  if (r.name === 'chat') return renderChat();
  const main = $('#main');
  const page = { new: pageNew, handoff: pageNew, approvals: pageApprovals, memory: pageMemory, skills: pageSkills, doctor: pageDoctor, settings: pageSettings }[r.name];
  if (!page) { main.innerHTML = topBar('Relay') + '<div class="page"><div class="page-inner"><p class="muted">Loading…</p></div></div>'; return; }
  page(main);
}

function topBar(title, crumb = '', right = '') {
  const asks = S.state?.approvals.length || 0;
  return `<div class="top">
    ${S.sideOpen ? '' : `<button class="icon-btn" data-act="toggle-side" title="Show the sidebar" aria-label="Show the sidebar">${icon.side}</button>`}
    <div class="crumb">${crumb ? `<span class="p">${esc(crumb)}</span><span class="sep">›</span>` : ''}<b>${esc(title)}</b></div>
    <span class="grow"></span>${right}
    ${asks && S.route.name !== 'approvals' ? `<button class="waiting" data-act="go" data-to="#/approvals">${asks} waiting</button>` : ''}
  </div>`;
}

/* ---------------- chat ---------------- */

let term, fitAddon, attachedId = null, awaitingReplay = false, resizeTimer, anchorRows = 0;

function ensureTerm() {
  if (term) return;
  const T = window.Terminal;
  term = new T({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'Consolas, monospace',
    fontSize: store.get('fontSize', 13.5),
    lineHeight: 1.12,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    ...(S.state?.platform === 'win32' ? { windowsPty: { backend: 'conpty', buildNumber: 22000 } } : {}),
    theme: {
      background: '#0e131a', foreground: '#d8dee8', cursor: '#9aa8ff', cursorAccent: '#0e131a', selectionBackground: 'rgba(124,142,255,0.32)',
      black: '#1b222c', red: '#f0716a', green: '#5fc794', yellow: '#e6b450', blue: '#7aa2ff', magenta: '#c49bff', cyan: '#5ccfe6', white: '#c9d1dc',
      brightBlack: '#5c6773', brightRed: '#ff8f87', brightGreen: '#86e1b0', brightYellow: '#ffd173', brightBlue: '#9dbbff', brightMagenta: '#dbbcff', brightCyan: '#8be6f5', brightWhite: '#f2f5f9',
    },
  });
  fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try { term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch { /* addon missing */ }
  // The server's virtual screen already answers the agent's terminal queries; ours must not answer them again
  const p = term.parser;
  const swallow = () => true;
  for (const id of [{ final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, { final: 'n' }, { prefix: '?', final: 'n' }, { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }, { prefix: '?', final: 'u' }, { prefix: '>', final: 'q' }]) p.registerCsiHandler(id, swallow);
  p.registerCsiHandler({ final: 't' }, (params) => [11, 13, 14, 16, 18, 19, 20, 21].includes(params[0]));
  for (const n of [4, 10, 11, 12, 17, 19]) p.registerOscHandler(n, (data) => data.includes('?'));
  p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);
  p.registerDcsHandler({ intermediates: '+', final: 'q' }, swallow);

  term.onData((d) => { if (attachedId) send({ t: 'in', id: attachedId, data: d }); });
  term.onBinary((d) => { if (attachedId) send({ t: 'in', id: attachedId, data: d }); });
  term.onResize(({ cols, rows }) => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => attachedId && send({ t: 'resize', id: attachedId, cols, rows }), 80); });
  term.onRender(() => anchorBottom());
  term.attachCustomKeyEventHandler(keyInTerminal);
}

/** Windows Terminal habits: Ctrl+C copies when text is selected, Ctrl+V / Ctrl+Shift+V paste, app shortcuts first. */
function keyInTerminal(e) {
  if (e.type !== 'keydown') return true;
  if (appShortcut(e)) { e.preventDefault(); return false; }
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey && k === 'c' && (term.hasSelection() || e.shiftKey)) { copyText(term.getSelection()); term.clearSelection(); e.preventDefault(); return false; }
  if (e.ctrlKey && !e.altKey && k === 'v') return false; // let the browser's own paste event reach xterm (bracketed paste)
  if (e.ctrlKey && (k === '=' || k === '+' || k === '-' || k === '0') && !e.shiftKey) {
    const size = k === '0' ? 13.5 : Math.max(9, Math.min(24, term.options.fontSize + (k === '-' ? -1 : 1)));
    term.options.fontSize = size; store.set('fontSize', size); fitSoon(); e.preventDefault(); return false;
  }
  return true;
}

function copyText(t) {
  if (!t) return;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).catch(() => legacyCopy(t)); else legacyCopy(t);
}
function legacyCopy(t) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* */ } ta.remove(); }

function fitSoon() { requestAnimationFrame(() => { try { fitAddon?.fit(); } catch { /* hidden */ } }); }

function attach(id) {
  ensureTerm();
  if (attachedId === id) return;
  attachedId = id;
  awaitingReplay = true;
  term.reset();
  fitSoon();
  setTimeout(() => send({ t: 'attach', id, cols: term.cols, rows: term.rows }), 30);
}
function detach() { if (attachedId) { send({ t: 'detach' }); attachedId = null; } }

function onReplay(m) {
  awaitingReplay = false;
  term.reset();
  term.write(m.data || '');
  const note = $('#termnote');
  if (note) note.classList.toggle('hidden', m.live);
  if (document.activeElement === document.body || document.activeElement?.closest('.chat, .nav')) term.focus();
}

/** agy draws from the top of its screen: show its live area against the bottom, like the other agents. */
function anchorBottom() {
  const c = chatById(attachedId);
  const screen = $('#term .xterm-screen');
  if (!screen) return;
  if (!c?.anchor) { if (anchorRows) { screen.style.transform = ''; anchorRows = 0; } return; }
  const b = term.buffer.active;
  let last = term.rows - 1;
  while (last > 0 && !b.getLine(b.viewportY + last)?.translateToString(true).trim()) last--;
  const rows = Math.max(0, term.rows - 1 - Math.max(last, b.cursorY));
  if (rows === anchorRows) return;
  anchorRows = rows;
  const cell = screen.getBoundingClientRect().height / term.rows;
  screen.style.transform = rows ? `translateY(${Math.round(rows * cell)}px)` : '';
}

function renderChat() {
  const id = S.route.id;
  const c = chatById(id);
  const main = $('#main');
  if (!c) { main.innerHTML = topBar('Chat not found') + `<div class="page"><div class="page-inner"><div class="empty"><b>This chat is not in Relay any more.</b><button class="btn" data-act="go" data-to="#/new">Start a new chat</button></div></div></div>`; return; }
  store.set('lastChat', id);
  if (!$('#termwrap') || main.dataset.chat !== id) {
    main.dataset.chat = id;
    main.innerHTML = `<div id="chattop"></div><div id="chathead"></div><div id="banners"></div>
      <div class="termwrap" id="termwrap"><div id="term"></div>
        <div class="term-note hidden" id="termnote"></div>
        <div id="drawer"></div><div id="drops"></div></div>`;
    ensureTerm();
    if (!term.element) term.open($('#term'));
    else $('#term').appendChild(term.element);
    new ResizeObserver(() => fitSoon()).observe($('#term'));
    const el = $('#term');
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (term.hasSelection()) { copyText(term.getSelection()); term.clearSelection(); }
      else if (navigator.clipboard?.readText) navigator.clipboard.readText().then(t => t && term.paste(t)).catch(() => toast({ kind: 'warn', text: 'Paste with Ctrl+V.' }));
    });
    attach(id);
  }
  renderChatHead();
  renderDrawer();
}

function renderChatHead() {
  const c = chatById(S.route.id);
  if (!c || !$('#chathead')) return;
  const parent = c.parentId ? chatById(c.parentId) : null;
  const proj = (S.state.projects.find(p => p.chats.some(x => x.id === c.id)) || {}).name || '';
  $('#chattop').innerHTML = topBar(c.title, proj, '');
  const u = c.usage || {};
  const meter = u.limit ? `<span class="meter" title="Plan usage in the current ${u.limit.windowMin ? Math.round(u.limit.windowMin / 60) + ' h' : ''} window"><i><b style="width:${Math.min(100, u.limit.pct)}%"></b></i>${u.limit.pct}%</span>`
    : u.context && u.window ? `<span class="meter" title="Context used"><i><b style="width:${Math.min(100, Math.round(u.context / u.window * 100))}%"></b></i>${Math.round(u.context / 1000)}k</span>` : u.context ? `<span class="meter" title="Context tokens">${u.context < 1000 ? '<1k' : `${Math.round(u.context / 1000)}k`} tokens</span>` : '';
  $('#chathead').innerHTML = `${parent ? `<div class="relay-bar" style="--from:${AGENT[parent.agent].color};--to:${AGENT[c.agent].color}"></div>` : ''}
    <div class="chathead">
      <div class="meta">
        ${tagAgent(c.agent)}
        <span class="state"><span class="lamp ${esc(c.state)}"></span>${esc(STATE_LABEL[c.state] || c.state)}</span>
        ${c.model || c.effort ? `<span>${esc([c.model, c.effort].filter(Boolean).join(', '))}</span>` : ''}
        ${c.skip ? '<span class="skip" title="Started without permission prompts">no prompts</span>' : ''}
        ${meter}
        ${parent ? `<a class="continues" href="#/chat/${parent.id}" title="This chat continues ${esc(parent.title)}">continues ${esc(parent.title)}</a>` : ''}
        <span class="folder" title="${esc(c.cwd)}">\u200e${esc(c.cwd)}</span>
      </div>
      <div class="actions">
        <button class="btn small" data-act="go" data-to="#/handoff/${c.id}" title="Continue this chat with another agent (Ctrl+Shift+H)">Hand off</button>
        <button class="btn small ${S.drawer === 'artifacts' ? 'on' : ''}" data-act="drawer" data-which="artifacts">Artifacts${c.artifacts ? ` ${c.artifacts}` : ''}</button>
        <button class="btn small ${S.drawer === 'activity' ? 'on' : ''}" data-act="drawer" data-which="activity">Activity</button>
        <button class="btn small ${S.drawer === 'record' ? 'on' : ''}" data-act="drawer" data-which="record" title="What another agent reads when it continues this chat">Record</button>
        <button class="icon-btn" data-act="chat-menu" data-id="${c.id}" title="More" aria-label="More actions">${icon.more}</button>
      </div>
    </div>`;
  // banners: an approval for this chat, a handoff that did not load, an agent that is not running
  const aps = S.state.approvals.filter(a => a.threadId === c.id);
  let html = aps.map(a => a.kind === 'ask' ? askBanner(a) : `<div class="banner ask"><span class="lamp approval"></span>
      <div class="what"><div class="q">${esc(AGENT[c.agent].name)} asks: ${esc(a.question)}</div><code title="${esc(a.what)}">${esc(a.what)}</code></div>
      <button class="btn small primary" data-act="approve" data-chat="${c.id}" data-ap="${a.id}" data-choice="approve">Approve</button>
      ${a.options?.some(o => /always|don.?t ask|session/i.test(o.label)) ? `<button class="btn small" data-act="approve" data-chat="${c.id}" data-ap="${a.id}" data-choice="always" title="${esc(a.options.find(o => /always|don.?t ask|session/i.test(o.label))?.label)}">Always</button>` : ''}
      <button class="btn small danger" data-act="approve" data-chat="${c.id}" data-ap="${a.id}" data-choice="deny">Deny</button></div>`).join('');
  if (c.handoffMissing) html += `<div class="banner warn"><div class="what">${esc(AGENT[c.agent].name)} answered without loading the earlier chat.</div><button class="btn small" data-act="retry" data-id="${c.id}">Ask again</button></div>`;
  $('#banners').innerHTML = html;
  const note = $('#termnote');
  if (note) {
    const off = c.state === 'ended' || (c.state === 'parked' && !c.canResume);
    note.classList.toggle('hidden', !off);
    if (off) note.innerHTML = `<b>${c.state === 'ended' ? `${esc(AGENT[c.agent].name)} has stopped${c.exitCode ? ` (exit code ${c.exitCode})` : ''}.` : 'This chat has no session to resume.'}</b>
      <p>${c.error ? esc(c.error) : 'Its last screen stays above. Restart picks up the same conversation.'}</p>
      <button class="btn primary" data-act="restart" data-id="${c.id}">Restart ${esc(AGENT[c.agent].name)}</button>`;
  }
}

function askBanner(a) {
  return `<div class="banner ask"><span class="lamp approval"></span><div class="what"><div class="q">${esc(a.question)}</div>${a.what ? `<code>${esc(a.what)}</code>` : ''}</div>
    ${(a.options || []).map(o => `<button class="btn small" data-act="answer" data-chat="${a.threadId}" data-ap="${a.id}" data-choice="${esc(o.label)}">${esc(short(o.label, 30))}</button>`).join('')}
    <button class="btn small" data-act="go" data-to="#/approvals">Other…</button></div>`;
}

/* drawers: artifacts, activity, record */
async function openDrawer(which) {
  const id = S.route.id;
  S.drawer = S.drawer === which ? null : which;
  S.drawerData = null;
  renderChatHead(); renderDrawer();
  if (!S.drawer) return;
  try {
    if (which === 'artifacts') S.drawerData = await api('GET', `/api/chats/${id}`);
    if (which === 'activity') S.drawerData = await api('GET', `/api/chats/${id}/activity`);
    if (which === 'record') S.drawerData = await api('GET', `/api/chats/${id}/record`);
  } catch (e) { S.drawerData = { error: e.message }; }
  if (S.route.id === id) renderDrawer();
}

function renderDrawer() {
  const el = $('#drawer');
  if (!el) return;
  if (!S.drawer) { el.innerHTML = ''; return; }
  const d = S.drawerData;
  const title = { artifacts: 'Artifacts', activity: 'Activity', record: 'Record' }[S.drawer];
  let body = '<p class="muted">Loading…</p>';
  if (d?.error) body = `<p class="bad">${esc(d.error)}</p>`;
  else if (d && S.drawer === 'artifacts') {
    body = `<p class="muted" style="margin-top:0">Files the agent made for you. Folder: <code>${esc(d.artifactsDir)}</code></p>` +
      (d.artifactsList.length ? d.artifactsList.map(a => `<div class="row"><div class="main-col"><div class="t">${esc(a.name)}</div><div class="sub">${(a.size / 1024).toFixed(1)} KB, ${ago(a.mtime)}</div></div>
        <button class="btn small" data-act="open" data-path="${esc(a.path)}">Open</button><button class="btn small ghost" data-act="reveal" data-path="${esc(a.path)}">Show in folder</button></div>`).join('')
        : '<div class="empty"><b>Nothing yet</b>When the agent writes notes, plans or reports for you, they appear here.</div>') +
      (d.files?.length ? `<h4 style="margin:18px 0 6px">Project files it changed</h4>` + d.files.map(f => `<div class="row"><div class="main-col"><code>${esc(f.file)}</code></div><span class="muted">${f.n > 1 ? `${f.n} edits` : ''}</span></div>`).join('') : '');
  } else if (d && S.drawer === 'activity') {
    body = d.length ? d.slice().reverse().map(a => `<div class="row"><span class="kindtag">${esc(a.kind)}</span><div class="main-col"><div class="t mono">${esc(short(a.text, 220))}</div>${a.result ? `<div class="sub">${esc(short(a.result, 160))}</div>` : ''}</div>
      <span class="${a.status === 'ok' ? 'ok' : a.status === 'error' ? 'bad' : 'run'}" title="${esc(a.status || '')}">${a.status === 'ok' ? '✓' : a.status === 'error' ? '✗' : a.status ? '…' : ''}</span></div>`).join('')
      : '<div class="empty"><b>No activity yet</b>Tool calls, approvals and dropped files show up here.</div>';
  } else if (d && S.drawer === 'record') {
    body = `<p class="muted" style="margin-top:0">This is exactly what <code>get_handoff_context</code> gives the next agent.</p><pre>${esc(d.text)}</pre>
      <div style="margin-top:10px"><button class="btn small" data-act="copy" data-text="${esc(d.text)}">Copy</button></div>`;
  }
  el.innerHTML = `<aside class="drawer" aria-label="${esc(title)}"><header><h3>${esc(title)}</h3>
    ${S.drawer !== 'record' ? `<button class="btn small ghost" data-act="drawer-refresh">Refresh</button>` : ''}<button class="icon-btn" data-act="drawer-close" aria-label="Close">✕</button></header><div class="body">${body}</div></aside>`;
}

/* ---------------- new chat / hand off ---------------- */

async function pageNew(main) {
  const isHandoff = S.route.name === 'handoff';
  const fromId = isHandoff ? S.route.id : null;
  if (!S.nc) {
    main.innerHTML = topBar(isHandoff ? 'Hand off' : 'New chat') + '<div class="page"><div class="page-inner"><p class="muted">Looking for your agents…</p></div></div>';
    let info;
    try { info = await api('GET', `/api/newchat${fromId ? `?from=${fromId}` : ''}`); } catch (e) { main.innerHTML = topBar('New chat') + `<div class="page"><div class="page-inner"><p class="bad">${esc(e.message)}</p></div></div>`; return; }
    S.ncInfo = info;
    const installed = info.agents.filter(a => a.installed).map(a => a.id);
    let agent = isHandoff ? (installed.find(a => a !== info.from?.agent) || installed[0]) : (installed.includes(info.lastAgent) ? info.lastAgent : installed[0]);
    S.nc = { agent: agent || 'claude', model: '', effort: '', folder: S.route.folder || info.defaultFolder || '', prompt: '', skip: isHandoff ? !!info.from?.skip : false, note: '' };
    if (S.route.name !== (isHandoff ? 'handoff' : 'new')) return;
  }
  const info = S.ncInfo, f = S.nc;
  const a = info.agents.find(x => x.id === f.agent) || info.agents[0];
  const src = info.from;
  const anyInstalled = info.agents.some(x => x.installed);
  main.innerHTML = topBar(isHandoff ? 'Hand off' : 'New chat', isHandoff && src ? short(src.title, 40) : '') + `<div class="page"><div class="page-inner">
    <h1>${isHandoff ? `Continue “${esc(short(src?.title, 50))}” with another agent` : 'Start a chat'}</h1>
    <p class="lede">${isHandoff ? `A new chat opens in the same folder. Its first message asks the agent to load what ${esc(AGENT[src?.agent]?.name || '')} did through Relay, sum it up in five bullets, and wait for your OK. The earlier chat keeps running.` : 'Pick an agent and a project folder. You work in the agent’s own screen; Relay keeps the chat, its approvals and its files in one place.'}</p>
    <form class="panel pad" id="ncform" autocomplete="off">
      <div class="field"><div class="label">Agent</div>
        <div class="agent-pick" role="radiogroup">${info.agents.map(x => `<button type="button" role="radio" aria-checked="${x.id === f.agent}" class="${x.id === f.agent ? 'on' : ''}" style="--agent:${AGENT[x.id].color}" data-act="nc-agent" data-agent="${x.id}" ${x.installed ? '' : 'disabled'}>
          <span class="n">${chip(x.id)}${esc(x.name)}</span>
          <span class="v ${x.installed && x.login?.ok === false ? 'bad' : ''}">${x.installed ? `${esc(x.version || 'installed')}${x.login?.state ? `, ${esc(x.login.state)}` : ''}` : 'not installed'}</span></button>`).join('')}</div>
        ${!anyInstalled ? `<p class="bad" style="margin:10px 0 0">No agent CLI found on this computer. <a href="#/doctor">Doctor</a> shows how to install one.</p>` : !a.installed ? '' : a.login?.ok === false ? `<p class="muted" style="margin:8px 0 0">${esc(a.name)} is not signed in yet: it asks you to sign in on its own screen when the chat starts.</p>` : ''}
      </div>
      <div class="grid2">
        <div class="field"><label for="nc-model">Model</label><select id="nc-model" class="input" data-change="nc-model">${(a.models || ['']).map(m => `<option value="${esc(m)}" ${m === f.model ? 'selected' : ''}>${m ? esc(m) : 'Agent default'}</option>`).join('')}</select></div>
        <div class="field"><label for="nc-effort">Effort</label><select id="nc-effort" class="input" data-change="nc-effort" ${(a.efforts || ['']).length < 2 ? 'disabled' : ''}>${(a.efforts || ['']).map(m => `<option value="${esc(m)}" ${m === f.effort ? 'selected' : ''}>${m ? esc(m) : 'Agent default'}</option>`).join('')}</select></div>
      </div>
      ${isHandoff ? `<div class="field"><div class="label">Folder</div><code>${esc(src?.cwd)}</code></div>
        <div class="field"><label for="nc-note">Also tell it <span class="hint">(optional)</span></label><input id="nc-note" class="input" data-input="nc-note" value="${esc(f.note)}" placeholder="For example: focus on the failing tests first"></div>`
      : `<div class="field"><label for="nc-folder">Project folder</label>
        <div class="inline"><input id="nc-folder" class="input mono" data-input="nc-folder" value="${esc(f.folder)}" placeholder="C:\\Users\\you\\code\\project" spellcheck="false"><button type="button" class="btn" data-act="browse">Browse…</button></div>
        ${info.recent.length ? `<div class="chips">${info.recent.filter(r => !samePath(r, f.folder)).slice(0, 6).map(r => `<button type="button" data-act="nc-folder" data-path="${esc(r)}" title="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="field"><label for="nc-prompt">First message <span class="hint">(optional: you can also type it in the agent)</span></label>
        <textarea id="nc-prompt" class="input" data-input="nc-prompt" rows="4" placeholder="What should the agent do? Drop files here to add their paths.">${esc(f.prompt)}</textarea></div>`}
      <div class="field"><label class="check"><input type="checkbox" data-change="nc-skip" ${f.skip ? 'checked' : ''}>
        <span><b>Skip permission prompts</b> <span class="muted">starts ${esc(a.name)} with <code>${esc(a.skipFlag)}</code></span><br>
        <span class="muted" style="font-size:12.5px">${f.skip ? 'Nothing reaches the approvals inbox: the agent runs commands and edits files without asking.' : 'Off: the agent asks, and Relay shows each request in Approvals.'}</span></span></label></div>
      <div class="formfoot"><span class="muted" style="font-size:12.5px">Ctrl+Enter starts the chat</span>
        <button class="btn primary" type="submit" ${a.installed ? '' : 'disabled'}>${isHandoff ? `Continue in ${esc(a.name)}` : 'Start chat'}</button></div>
    </form></div></div>`;
  const pr = $('#nc-prompt');
  if (pr && !isHandoff) pr.focus();
}

async function submitNew() {
  const f = S.nc;
  const isHandoff = S.route.name === 'handoff';
  if (!isHandoff && !f.folder.trim()) return toast({ kind: 'warn', text: 'Choose a project folder first.' });
  const body = { agent: f.agent, model: f.model || null, effort: f.effort || null, skip: f.skip };
  const r = await act(() => isHandoff ? api('POST', `/api/chats/${S.route.id}/handoff`, { ...body, note: f.note }) : api('POST', '/api/chats', { ...body, folder: f.folder.trim(), prompt: f.prompt.trim() }));
  if (r?.id) { S.nc = null; await waitForChat(r.id); go(`#/chat/${r.id}`); }
}
const waitForChat = (id) => new Promise(res => { const t0 = Date.now(); const tick = () => (chatById(id) || Date.now() - t0 > 2000 ? res() : setTimeout(tick, 60)); tick(); });

/* folder picker: the native dialog in the desktop app, else a folder browser over the API */
async function browseFolder(start) {
  const dlg = window.__TAURI__?.dialog;
  if (dlg?.open) {
    try { const p = await dlg.open({ directory: true, multiple: false, defaultPath: start || undefined, title: 'Choose a project folder' }); return p || null; } catch { /* fall back */ }
  }
  return new Promise((resolve) => {
    let cur = start || '';
    const render = async () => {
      let d;
      try { d = await api('GET', `/api/folders?path=${encodeURIComponent(cur)}`); } catch (e) { d = { dirs: [], error: e.message, path: cur }; }
      modal(`<div class="dialog"><h3>Choose a project folder</h3>
        <div class="folders-cur cur mono" style="font-size:12.5px;color:var(--ink-2);margin-bottom:8px;overflow-wrap:anywhere">${esc(d.path || 'This computer')}</div>
        <div class="folders">${d.parent !== null && d.parent !== undefined ? `<button data-fold="${esc(d.parent)}">⬑ Up</button>` : ''}${d.dirs.map(x => `<button data-fold="${esc(x.path)}">▸ ${esc(x.name)}</button>`).join('') || `<div class="empty">${d.error ? esc(d.error) : 'No folders here'}</div>`}</div>
        <div class="foot"><button class="btn" data-fold-cancel>Cancel</button><button class="btn primary" data-fold-pick ${d.path ? '' : 'disabled'}>Use this folder</button></div></div>`, (el) => {
        el.onclick = (e) => {
          const b = e.target.closest('[data-fold],[data-fold-cancel],[data-fold-pick]');
          if (!b) return;
          if (b.hasAttribute('data-fold')) { cur = b.dataset.fold; render(); }
          else if (b.hasAttribute('data-fold-cancel')) { closeModal(); resolve(null); }
          else { closeModal(); resolve(d.path); }
        };
      });
    };
    render();
  });
}

/* ---------------- approvals ---------------- */

function pageApprovals(main) {
  const st = S.state;
  const lastProject = chatById(store.get('lastChat'))?.project;
  const list = st.approvals.filter(a => S.approvalsScope === 'all' || samePath(a.project, lastProject));
  main.innerHTML = topBar('Approvals') + `<div class="page"><div class="page-inner">
    <h1>Approvals</h1>
    <p class="lede">What your agents are waiting on, from every chat: their own permission prompts (answering types the agent’s key for you) and questions they asked through Relay (your choice becomes your next message to that agent). You don’t have to switch to the chat.</p>
    <div class="inline" style="justify-content:space-between;margin-bottom:12px">
      <div class="tabs" role="tablist"><button role="tab" class="${S.approvalsScope === 'all' ? 'on' : ''}" data-act="scope" data-scope="all">All projects</button><button role="tab" class="${S.approvalsScope === 'project' ? 'on' : ''}" data-act="scope" data-scope="project" ${lastProject ? '' : 'disabled'}>This project</button></div>
      <span class="muted">${list.length} waiting</span></div>
    ${list.length ? list.map(approvalCard).join('') : '<div class="panel"><div class="empty"><b>Nothing is waiting</b>When an agent asks for permission or asks you a question, it shows up here.</div></div>'}
    <h2>Decided today</h2>
    <div class="panel">${st.decided.length ? st.decided.map(d => `<div class="row" style="padding:9px 16px">${chip(d.agent)}<div class="main-col"><div class="t">${esc(short(d.what, 140))}</div><div class="sub">${esc(d.title || '')}, ${ago(d.ts)}</div></div><span class="${d.choice === 'deny' ? 'bad' : 'ok'}">${esc(d.choice)}</span></div>`).join('') : '<div class="empty">No answers yet today.</div>'}</div>
  </div></div>`;
}

function approvalCard(a) {
  const c = chatById(a.threadId);
  const head = `<div class="who"><span class="lamp approval"></span><b>${esc(short(a.title, 50))}</b>${tagAgent(a.agent)}<span>${esc((S.state.projects.find(p => samePath(p.path, a.project)) || {}).name || '')}</span><span>waiting ${ago(a.since).replace(' ago', '')}</span><span class="risk l${a.risk?.level || 0}">${esc(a.risk?.tag || '')}</span></div>`;
  if (a.kind === 'ask') {
    return `<div class="panel card" data-ap="${a.id}">${head}<div class="q">${esc(a.question)}</div>${a.what ? `<div class="reason">${esc(a.what)}</div>` : ''}
      <div class="acts">${(a.options || []).map(o => `<button class="btn" data-act="answer" data-chat="${a.threadId}" data-ap="${a.id}" data-choice="${esc(o.label)}">${esc(o.label)}</button>`).join('')}</div>
      <div class="acts"><input class="input" style="flex:1;min-width:200px" placeholder="Other answer, or a note to add" data-note="${a.id}">
        <button class="btn" data-act="answer-other" data-chat="${a.threadId}" data-ap="${a.id}">Send</button><span class="grow"></span><button class="btn ghost" data-act="go" data-to="#/chat/${a.threadId}">Open chat</button></div></div>`;
  }
  const always = a.options?.find(o => /always|don.?t ask|session/i.test(o.label));
  return `<div class="panel card" data-ap="${a.id}">${head}<div class="q">${esc(a.question)}</div><div class="what">${esc(a.what)}</div>${a.reason ? `<div class="reason">Reason given: ${esc(a.reason)}</div>` : ''}
    <div class="acts"><button class="btn primary" data-act="approve" data-chat="${a.threadId}" data-ap="${a.id}" data-choice="approve">Approve</button>
      ${always ? `<button class="btn" data-act="approve" data-chat="${a.threadId}" data-ap="${a.id}" data-choice="always" title="${esc(always.label)}">${esc(short(always.label, 48))}</button>` : ''}
      <button class="btn danger" data-act="approve" data-chat="${a.threadId}" data-ap="${a.id}" data-choice="deny">Deny</button>
      <span class="grow"></span>${c ? `<button class="btn ghost" data-act="go" data-to="#/chat/${a.threadId}">Open chat</button>` : ''}</div></div>`;
}

function onApproval(a) {
  if (currentChatId() === a.threadId && document.hasFocus()) return;
  const name = AGENT[a.agent]?.name || a.agent;
  const text = a.kind === 'ask' ? `${name} in “${short(a.title, 36)}” asks: ${short(a.question, 90)}` : `${name} in “${short(a.title, 36)}” asks to: ${short(a.what, 90)}`;
  const actions = a.kind === 'ask' ? [{ label: 'Answer', go: '#/approvals' }, { label: 'Open', go: `#/chat/${a.threadId}` }]
    : [{ label: 'Approve', approve: [a.threadId, a.id, 'approve'] }, { label: 'Deny', approve: [a.threadId, a.id, 'deny'] }, { label: 'Open', go: `#/chat/${a.threadId}` }];
  toast({ kind: 'ask', text, actions, sticky: true, key: a.id });
  notifyOS(`${name} asks`, a.kind === 'ask' ? a.question : a.what);
}

function onDone(m) {
  if (currentChatId() === m.id && document.hasFocus()) return;
  toast({ kind: 'done', text: `${AGENT[m.agent]?.name || m.agent} is waiting for you in “${short(m.title, 40)}”.`, actions: [{ label: 'Open', go: `#/chat/${m.id}` }] });
  if (!document.hasFocus()) notifyOS(`${AGENT[m.agent]?.name || m.agent} finished`, m.title);
}

async function notifyOS(title, body) {
  if (!store.get('notify', true) || document.hasFocus()) return;
  const n = window.__TAURI__?.notification;
  try {
    if (n?.sendNotification) {
      let ok = await n.isPermissionGranted?.();
      if (!ok) ok = (await n.requestPermission?.()) === 'granted';
      if (ok) n.sendNotification({ title, body: short(body, 140) });
      return;
    }
    if ('Notification' in window) {
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body: short(body, 140), icon: 'icon.svg' });
    }
  } catch { /* notifications are a convenience */ }
}

/* ---------------- memory ---------------- */

let memTimer;
async function loadMemory() {
  try { S.memory.list = await api('GET', `/api/memory?q=${encodeURIComponent(S.memory.q)}`); } catch (e) { toast({ kind: 'warn', text: e.message }); }
  if (S.route.name === 'memory') renderMemory();
}
function pageMemory(main) {
  S.memory.sel = S.route.id || S.memory.sel;
  main.innerHTML = topBar('Memory') + `<div class="page"><div class="page-inner wide">
    <h1>Memory</h1>
    <p class="lede">Every chat Relay recorded, in every project: what was asked, the last answer, files and tools. It is what an agent gets from <code>get_handoff_context</code> when it continues a chat. Stored in <code>${esc(S.state.home)}</code>.</p>
    <div class="inline" style="margin-bottom:14px"><div class="search" style="flex:1;max-width:460px">${icon.search}<input class="input" id="memq" data-input="mem-q" value="${esc(S.memory.q)}" placeholder="Search chats, answers, files, commands" aria-label="Search memory"></div><span class="muted" id="memcount"></span></div>
    <div id="memory"></div></div></div>`;
  $('#memq').focus();
  renderMemory();
  loadMemory();
}
function renderMemory() {
  const el = $('#memory');
  if (!el) return;
  const list = S.memory.list;
  $('#memcount').textContent = `${list.length} chat${list.length === 1 ? '' : 's'}`;
  const sel = list.find(x => x.id === S.memory.sel) || list[0];
  el.innerHTML = `<div class="memory"><div class="mlist"><div class="panel">${list.length ? list.map(x => `<div class="mitem ${sel && x.id === sel.id ? 'on' : ''}" data-act="mem-sel" data-id="${x.id}" tabindex="0">
      <div class="l1">${chip(x.agent)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.title)}</span><span class="when">${ago(x.updated)}</span></div>
      <div class="l2">${esc((S.state.projects.find(p => samePath(p.path, x.project)) || {}).name || x.cwd)}, ${x.turns} turns</div></div>`).join('') : '<div class="empty"><b>No chats match</b>Try fewer words.</div>'}</div></div>
    <div>${sel ? `<div class="panel pad">
      <div class="inline" style="margin-bottom:14px">${tagAgent(sel.agent)}<b style="font-size:15px">${esc(sel.title)}</b></div>
      <dl class="facts">
        <dt>Project</dt><dd><code>${esc(sel.cwd)}</code></dd>
        <dt>Asked</dt><dd>${esc(sel.asked) || '<span class="muted">nothing yet</span>'}</dd>
        <dt>Last answer</dt><dd>${esc(sel.lastAnswer) || '<span class="muted">none</span>'}</dd>
        <dt>Files</dt><dd>${sel.files.length ? sel.files.map(f => `<code>${esc(f.file)}</code>`).join('<br>') : '<span class="muted">none changed</span>'}</dd>
        <dt>Tools</dt><dd>${Object.entries(sel.tools).map(([k, v]) => `<code>${esc(k)}</code> ×${v}`).join(', ') || '<span class="muted">none</span>'}</dd>
        <dt>Recent calls</dt><dd>${sel.recent.map(r => `<div><span class="${r.status === 'ok' ? 'ok' : r.status === 'error' ? 'bad' : 'run'}">${r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '…'}</span> <code>${esc(r.name)} ${esc(short(r.target, 80))}</code></div>`).join('') || '<span class="muted">none</span>'}</dd>
      </dl>
      <div class="acts" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px">
        <button class="btn primary" data-act="go" data-to="#/chat/${sel.id}">Open chat</button>
        <button class="btn" data-act="go" data-to="#/handoff/${sel.id}">Continue with another agent</button>
        <button class="btn" data-act="show-record" data-id="${sel.id}">What an agent reads</button>
        <button class="btn danger" data-act="delete-chat" data-id="${sel.id}">Delete</button></div></div>` : ''}</div></div>`;
}

/* ---------------- skills ---------------- */

async function pageSkills(main) {
  main.innerHTML = topBar('Skills') + `<div class="page"><div class="page-inner"><h1>Skills</h1><p class="muted">Reading the library…</p></div></div>`;
  try { S.skills = await api('GET', '/api/skills'); } catch (e) { S.skills = { error: e.message }; }
  if (S.route.name !== 'skills') return;
  const s = S.skills;
  if (s.error) { main.querySelector('.page-inner').innerHTML += `<p class="bad">${esc(s.error)}</p>`; return; }
  main.innerHTML = topBar('Skills') + `<div class="page"><div class="page-inner">
    <h1>Skills</h1>
    <p class="lede">One library for all four agents. A skill that is on is linked into each agent’s own skills folder, so Claude Code, Codex, Gemini CLI and Antigravity all find it: ${s.targets.map(t => `<code>${esc(t.dir)}</code>`).join(' and ')}. Library: <code>${esc(s.dir)}</code>.</p>
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn" data-act="new-skill">New skill</button></div>
    <div class="panel">${s.library.length ? s.library.map(k => `<div class="skill">
        <label class="switch" title="${k.enabled ? 'On for every agent' : 'Off'}"><input type="checkbox" data-change="skill-toggle" data-name="${esc(k.name)}" ${k.enabled ? 'checked' : ''} aria-label="Use ${esc(k.name)}"><span></span></label>
        <div class="main-col"><div class="nm">${esc(k.name)}</div><div class="ds">${esc(k.description) || '<span class="muted">No description: agents decide when to use a skill from it.</span>'}</div></div>
        <button class="btn small" data-act="skill-open" data-name="${esc(k.name)}">Edit</button><button class="icon-btn" data-act="skill-delete" data-name="${esc(k.name)}" title="Delete ${esc(k.name)}" aria-label="Delete ${esc(k.name)}">${icon.trash}</button></div>`).join('')
      : '<div class="empty"><b>The library is empty</b>Create a skill, or import one an agent already has below.</div>'}</div>
    <h2>Found in the agents’ own folders</h2>
    <div class="panel">${s.found.length ? s.found.map(k => `<div class="skill"><div style="display:flex;gap:3px">${k.agents.map(chip).join('')}</div>
        <div class="main-col"><div class="nm">${esc(k.name)}</div><div class="ds"><code>${esc(k.path)}</code></div></div>
        <button class="btn small" data-act="skill-import" data-path="${esc(k.path)}">Import</button></div>`).join('') : '<div class="empty">Nothing else found.</div>'}</div>
  </div></div>`;
}

/* ---------------- doctor ---------------- */

async function pageDoctor(main) {
  main.innerHTML = topBar('Doctor') + `<div class="page"><div class="page-inner"><h1>Doctor</h1><p class="muted">Checking your agents and this computer…</p></div></div>`;
  try { S.doctor = await api('GET', '/api/doctor?fresh=1'); } catch (e) { S.doctor = { error: e.message }; }
  if (S.route.name !== 'doctor') return;
  const groups = {};
  for (const c of S.doctor.checks || []) (groups[c.group] ||= []).push(c);
  main.innerHTML = topBar('Doctor') + `<div class="page"><div class="page-inner">
    <h1>Doctor</h1>
    <p class="lede">Which agent CLIs Relay can start on this computer, their versions, and whether they are signed in. Install one, then press Check again.</p>
    <div class="inline" style="margin-bottom:12px"><button class="btn" data-act="go-doctor">Check again</button><button class="btn ghost" data-act="copy-doctor">Copy report</button></div>
    ${S.doctor.error ? `<p class="bad">${esc(S.doctor.error)}</p>` : Object.entries(groups).map(([g, list]) => `<h2>${esc(g)}</h2><div class="panel">${list.map(c => `<div class="check-row"><span class="${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'muted'}">${c.ok === true ? '✔' : c.ok === false ? '✖' : '•'}</span><span>${esc(c.name)}</span>
      <span class="d">${esc(c.detail)}${c.fix ? `<span class="fix">${esc(c.fix)}<button class="btn small ghost" data-act="copy" data-text="${esc(c.fix)}">Copy</button></span>` : ''}</span></div>`).join('')}</div>`).join('')}
  </div></div>`;
}

/* ---------------- settings ---------------- */

async function pageSettings(main) {
  let st = {};
  try { st = await api('GET', '/api/settings'); } catch { /* defaults */ }
  const theme = store.get('theme', 'system');
  main.innerHTML = topBar('Settings') + `<div class="page"><div class="page-inner">
    <h1>Settings</h1>
    <div class="panel pad">
      <div class="field"><label for="set-theme">Theme</label><select id="set-theme" class="input" data-change="set-theme" style="max-width:260px">${['system', 'light', 'dark'].map(t => `<option value="${t}" ${t === theme ? 'selected' : ''}>${{ system: 'Follow Windows', light: 'Light', dark: 'Dark' }[t]}</option>`).join('')}</select></div>
      <div class="field"><label for="set-live">Agents kept running</label><input id="set-live" type="number" min="1" max="20" class="input" style="max-width:120px" value="${esc(st.maxLive || 6)}" data-change="set-live">
        <p class="muted" style="margin:6px 0 0;font-size:12.5px">One agent CLI can use 250 MB of memory or more. Past this number, the chat you used longest ago is paused and resumes when you open it.</p></div>
      <div class="field"><label class="check"><input type="checkbox" data-change="set-notify" ${store.get('notify', true) ? 'checked' : ''}><span><b>Windows notifications</b><br><span class="muted" style="font-size:12.5px">When Relay is in the background and an agent asks for permission or finishes.</span></span></label></div>
      <div class="field"><div class="label">Data folder</div><div class="inline"><code style="flex:1">${esc(S.state.home)}</code><button class="btn small" data-act="open" data-path="${esc(S.state.home)}">Open</button></div>
        <p class="muted" style="margin:6px 0 0;font-size:12.5px">Per-agent overrides (path to the CLI, extra arguments, environment) go in <code>agents.json</code> there.</p></div>
    </div>
    <h2>Keyboard</h2>
    <div class="panel">${[['Ctrl+Shift+N', 'New chat'], ['Ctrl+Shift+H', 'Hand off the open chat'], ['Ctrl+Shift+A', 'Approvals'], ['Ctrl+Shift+M', 'Memory'], ['Ctrl+Shift+B', 'Show or hide the sidebar'], ['Ctrl+Alt+1 … 9', 'Open the first … ninth chat'], ['Ctrl+C', 'Copy, when text is selected in an agent’s screen'], ['Ctrl+V, right-click', 'Paste into the agent'], ['Ctrl+= / Ctrl+- / Ctrl+0', 'Terminal text size'], ['Esc', 'Close a dialog or drawer']].map(([k, v]) => `<div class="check-row" style="grid-template-columns:200px 1fr"><code>${k}</code><span>${v}</span></div>`).join('')}</div>
  </div></div>`;
}

/* =============================== dialogs & toasts =============================== */

function modal(html, wire) {
  const m = $('#modal');
  m.innerHTML = `<div class="scrim" data-scrim>${html}</div>`;
  const scrim = m.firstElementChild;
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
  wire?.(scrim);
  setTimeout(() => (scrim.querySelector('input, textarea, button.primary, button') || scrim).focus(), 20);
}
function closeModal() { $('#modal').innerHTML = ''; if (S.route.name === 'chat') term?.focus(); }

function confirmBox({ title, text, ok = 'OK', danger = false, check }) {
  return new Promise((resolve) => {
    modal(`<div class="dialog" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${text}</p>${check ? `<label class="check"><input type="checkbox" id="cfcheck"><span>${esc(check)}</span></label>` : ''}
      <div class="foot"><button class="btn" data-x="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="yes">${esc(ok)}</button></div></div>`, (el) => {
      el.onclick = (e) => { const b = e.target.closest('[data-x]'); if (!b) return; const c = $('#cfcheck')?.checked; closeModal(); resolve(b.dataset.x === 'yes' ? { ok: true, check: c } : null); };
    });
  });
}
function promptBox({ title, label, value = '', ok = 'Save', fields }) {
  return new Promise((resolve) => {
    const fs = fields || [{ id: 'v', label, value }];
    modal(`<form class="dialog" role="dialog" aria-modal="true"><h3>${esc(title)}</h3>${fs.map(f => `<div class="field"><label for="pf-${f.id}">${esc(f.label)}</label>${f.area ? `<textarea id="pf-${f.id}" class="input" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>` : `<input id="pf-${f.id}" class="input" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}">`}${f.hint ? `<div class="muted" style="font-size:12.5px;margin-top:4px">${esc(f.hint)}</div>` : ''}</div>`).join('')}
      <div class="foot"><button type="button" class="btn" data-x="no">Cancel</button><button class="btn primary" type="submit">${esc(ok)}</button></div></form>`, (el) => {
      const form = el.querySelector('form');
      form.onsubmit = (e) => { e.preventDefault(); const out = Object.fromEntries(fs.map(f => [f.id, $(`#pf-${f.id}`).value])); closeModal(); resolve(fields ? out : out.v); };
      el.querySelector('[data-x="no"]').onclick = () => { closeModal(); resolve(null); };
    });
  });
}

const toastKeys = new Map();
function toast({ kind = 'info', text, actions = [], sticky = false, key }) {
  const box = $('#toasts');
  if (key && toastKeys.has(key)) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="tx">${esc(text)}${actions.length ? `<div class="ta">${actions.map((a, i) => `<button class="btn small ${i === 0 && a.approve ? 'primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div><button class="x" aria-label="Dismiss">×</button>`;
  const close = () => { el.remove(); if (key) toastKeys.delete(key); };
  el.querySelector('.x').onclick = close;
  el.querySelectorAll('[data-i]').forEach(b => b.onclick = async () => {
    const a = actions[Number(b.dataset.i)];
    if (a.go) go(a.go);
    if (a.open) act(() => api('POST', '/api/open', { path: a.open }));
    if (a.approve) { const [chat, ap, choice] = a.approve; await act(() => api('POST', `/api/chats/${chat}/approve`, { approval: ap, choice })); }
    close();
  });
  box.appendChild(el);
  if (key) toastKeys.set(key, el);
  while (box.children.length > 5) box.firstElementChild.remove();
  if (!sticky) setTimeout(close, 6500);
}
// an approval answered elsewhere takes its toast with it
setInterval(() => { if (!S.state) return; for (const [k, el] of toastKeys) if (k.startsWith('a_') || k.startsWith('q_')) if (!S.state.approvals.some(a => a.id === k)) { el.remove(); toastKeys.delete(k); } }, 1000);

/* =============================== events =============================== */

const ACTIONS = {
  go: (b) => go(b.dataset.to),
  'toggle-side': () => { S.sideOpen = !S.sideOpen; store.set('side', S.sideOpen); renderChrome(); renderMain(); fitSoon(); },
  'toggle-project': (b, e) => { if (e.target.closest('.add')) return; act(() => api('POST', '/api/projects/toggle', { path: b.dataset.path })); },
  'new-in': (b, e) => { e.stopPropagation(); go(`#/new/in/${encodeURIComponent(b.dataset.path)}`); },
  'add-project': async () => { const p = await browseFolder(''); if (p) act(() => api('POST', '/api/projects/add', { path: p })); },
  'nc-agent': (b) => { const a = S.ncInfo.agents.find(x => x.id === b.dataset.agent); S.nc.agent = a.id; S.nc.model = ''; S.nc.effort = ''; renderMain(); },
  'nc-folder': (b) => { S.nc.folder = b.dataset.path; renderMain(); },
  browse: async () => { const p = await browseFolder(S.nc.folder); if (p) { S.nc.folder = p; renderMain(); } },
  drawer: (b) => openDrawer(b.dataset.which),
  'drawer-close': () => { S.drawer = null; renderChatHead(); renderDrawer(); term?.focus(); },
  'drawer-refresh': () => { const w = S.drawer; S.drawer = null; openDrawer(w); },
  open: (b) => act(() => api('POST', '/api/open', { path: b.dataset.path })),
  reveal: (b) => act(() => api('POST', '/api/open', { path: b.dataset.path, reveal: true })),
  copy: (b) => { copyText(b.dataset.text); toast({ kind: 'done', text: 'Copied.' }); },
  approve: (b) => act(() => api('POST', `/api/chats/${b.dataset.chat}/approve`, { approval: b.dataset.ap, choice: b.dataset.choice })),
  answer: (b) => { const note = document.querySelector(`[data-note="${b.dataset.ap}"]`)?.value || ''; act(() => api('POST', `/api/chats/${b.dataset.chat}/answer`, { request: b.dataset.ap, choice: b.dataset.choice, note })); },
  'answer-other': (b) => { const v = document.querySelector(`[data-note="${b.dataset.ap}"]`)?.value.trim(); if (!v) return toast({ kind: 'warn', text: 'Type your answer first.' }); act(() => api('POST', `/api/chats/${b.dataset.chat}/answer`, { request: b.dataset.ap, choice: `Other: ${v}` })); },
  scope: (b) => { S.approvalsScope = b.dataset.scope; renderMain(); },
  retry: (b) => act(() => api('POST', `/api/chats/${b.dataset.id}/retry`)),
  restart: (b) => act(async () => { await api('POST', `/api/chats/${b.dataset.id}/restart`); attachedId = null; attach(b.dataset.id); }),
  'chat-menu': (b) => chatMenu(b.dataset.id),
  'mem-sel': (b) => { S.memory.sel = b.dataset.id; renderMemory(); },
  'show-record': async (b) => { const r = await act(() => api('GET', `/api/chats/${b.dataset.id}/record`)); if (r) modal(`<div class="dialog wide"><h3>What an agent reads</h3><p>The answer of <code>get_handoff_context</code> for this chat.</p><pre>${esc(r.text)}</pre><div class="foot"><button class="btn" data-x>Close</button></div></div>`, (el) => { el.querySelector('[data-x]').onclick = closeModal; }); },
  'delete-chat': (b) => deleteChat(b.dataset.id),
  'new-skill': async () => {
    const v = await promptBox({ title: 'New skill', ok: 'Create', fields: [{ id: 'name', label: 'Name', placeholder: 'release-notes', hint: 'Lowercase letters, digits and dashes.' }, { id: 'description', label: 'When should an agent use it?', area: true, placeholder: 'Write release notes from the git log in our house style' }] });
    if (!v) return;
    const r = await act(() => api('POST', '/api/skills', v));
    if (r) { toast({ kind: 'done', text: `Created ${v.name}. Write its instructions in SKILL.md.` }); act(() => api('POST', `/api/skills/${encodeURIComponent(v.name)}/open`)); renderMain(); }
  },
  'skill-open': (b) => act(() => api('POST', `/api/skills/${encodeURIComponent(b.dataset.name)}/open`)),
  'skill-delete': async (b) => { const ok = await confirmBox({ title: `Delete ${b.dataset.name}?`, text: 'It is removed from the library and from every agent’s skills folder.', ok: 'Delete', danger: true }); if (ok) { await act(() => api('DELETE', `/api/skills/${encodeURIComponent(b.dataset.name)}`)); renderMain(); } },
  'skill-import': async (b) => { const r = await act(() => api('POST', '/api/skills/import', { path: b.dataset.path })); if (r) { toast({ kind: 'done', text: 'Imported: every agent has it now.' }); renderMain(); } },
  'go-doctor': () => renderMain(),
  'copy-doctor': async () => { const t = await act(() => api('GET', '/api/doctor/text')); if (t) { copyText(t); toast({ kind: 'done', text: 'Doctor report copied.' }); } },
};

async function chatMenu(id) {
  const c = chatById(id);
  if (!c) return;
  modal(`<div class="dialog" role="dialog" aria-modal="true"><h3>${esc(c.title)}</h3>
    <div style="display:grid;gap:8px">
      <button class="btn" data-m="rename">Rename</button>
      ${c.live ? '<button class="btn" data-m="stop">Stop the agent</button>' : `<button class="btn" data-m="restart">Restart ${esc(AGENT[c.agent].name)}</button>`}
      <button class="btn" data-m="folder">Open the project folder</button>
      <button class="btn danger" data-m="delete">Delete chat</button>
    </div><div class="foot"><button class="btn" data-m="close">Close</button></div></div>`, (el) => {
    el.onclick = async (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      closeModal();
      if (b.dataset.m === 'rename') { const t = await promptBox({ title: 'Rename chat', label: 'Name', value: c.title }); if (t) act(() => api('POST', `/api/chats/${id}/rename`, { title: t })); }
      if (b.dataset.m === 'stop') act(() => api('POST', `/api/chats/${id}/stop`));
      if (b.dataset.m === 'restart') ACTIONS.restart({ dataset: { id } });
      if (b.dataset.m === 'folder') act(() => api('POST', '/api/open', { path: c.cwd }));
      if (b.dataset.m === 'delete') deleteChat(id);
    };
  });
}

async function deleteChat(id) {
  const c = chatById(id);
  const r = await confirmBox({ title: 'Delete this chat?', text: `The agent stops and Relay forgets this chat’s record. ${esc(AGENT[c?.agent]?.name || 'The agent')}’s own transcript stays where it keeps it.`, ok: 'Delete chat', danger: true, check: 'Also delete its artifacts and attached files' });
  if (!r) return;
  await act(() => api('DELETE', `/api/chats/${id}${r.check ? '?files=1' : ''}`));
  if (currentChatId() === id) go('#/new');
  if (S.route.name === 'memory') loadMemory();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = ACTIONS[b.dataset.act];
  if (fn) { e.preventDefault(); fn(b, e); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('[data-act][role="link"], .mitem')) { e.target.click(); return; }
  if (e.key === 'Escape') {
    if ($('#modal').innerHTML) { closeModal(); e.preventDefault(); return; }
    if (S.drawer) { ACTIONS['drawer-close'](); e.preventDefault(); return; }
  }
  if (e.ctrlKey && e.key === 'Enter' && e.target.closest('#ncform')) { e.preventDefault(); submitNew(); return; }
  if (!e.target.closest('.xterm') && appShortcut(e)) e.preventDefault();
});
document.addEventListener('submit', (e) => { if (e.target.id === 'ncform') { e.preventDefault(); submitNew(); } });
document.addEventListener('input', (e) => {
  const k = e.target.dataset.input;
  if (!k) return;
  if (k === 'nc-folder') S.nc.folder = e.target.value;
  if (k === 'nc-prompt') S.nc.prompt = e.target.value;
  if (k === 'nc-note') S.nc.note = e.target.value;
  if (k === 'mem-q') { S.memory.q = e.target.value; clearTimeout(memTimer); memTimer = setTimeout(loadMemory, 200); }
});
document.addEventListener('change', (e) => {
  const k = e.target.dataset.change;
  if (!k) return;
  if (k === 'nc-model') S.nc.model = e.target.value;
  if (k === 'nc-effort') S.nc.effort = e.target.value;
  if (k === 'nc-skip') { S.nc.skip = e.target.checked; renderMain(); }
  if (k === 'skill-toggle') act(() => api('POST', `/api/skills/${encodeURIComponent(e.target.dataset.name)}/toggle`, { on: e.target.checked }));
  if (k === 'set-theme') { store.set('theme', e.target.value); applyTheme(); }
  if (k === 'set-live') act(() => api('POST', '/api/settings', { maxLive: Number(e.target.value) }));
  if (k === 'set-notify') store.set('notify', e.target.checked);
});

/** App shortcuts; Ctrl+Shift so they never collide with keys the agents use. */
function appShortcut(e) {
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'n') { go('#/new'); return true; }
    if (k === 'a') { go('#/approvals'); return true; }
    if (k === 'm') { go('#/memory'); return true; }
    if (k === 'b') { ACTIONS['toggle-side'](); return true; }
    if (k === 'h' && currentChatId()) { go(`#/handoff/${currentChatId()}`); return true; }
  }
  if (e.ctrlKey && e.altKey && /^[1-9]$/.test(e.key)) {
    const list = allChats();
    const c = list[Number(e.key) - 1];
    if (c) go(`#/chat/${c.id}`);
    return true;
  }
  return false;
}

function applyTheme() {
  const t = store.get('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}

/* =============================== dropped files =============================== */

// The desktop app (Tauri) hands us full paths: two zones, "Add the path" and "Copy into the chat".
let dropKind = null;
window.relayDrop = (ev) => {
  const where = S.route.name;
  if (ev.kind === 'leave' || (ev.kind === 'drop' && !ev.paths?.length)) return hideDrops();
  if (where === 'new' && S.nc) {
    if (ev.kind === 'drop') { S.nc.prompt = `${S.nc.prompt}${S.nc.prompt && !/\s$/.test(S.nc.prompt) ? ' ' : ''}${ev.paths.map(quotePath).join(' ')} `; renderMain(); }
    return;
  }
  if (where !== 'chat') return;
  const zone = zoneAt(ev.x, ev.y);
  if (ev.kind === 'enter' || ev.kind === 'over') return showDrops(true, zone);
  if (ev.kind === 'drop') { hideDrops(); send({ t: 'drop', id: currentChatId(), paths: ev.paths, copy: zone === 'copy' }); term?.focus(); }
};
function zoneAt(x, y) {
  const r = $('#termwrap')?.getBoundingClientRect();
  if (!r) return 'path';
  // Tauri reports physical pixels: divide by the display scale (150% on many Windows laptops)
  const px = x / (window.devicePixelRatio || 1);
  return px > r.left + r.width / 2 ? 'copy' : 'path';
}
function showDrops(two, zone) {
  const el = $('#drops');
  if (!el) return;
  el.innerHTML = `<div class="dropzones ${two ? '' : 'one'}">${two ? `<div class="${zone === 'path' ? 'hot' : ''}"><b>Add the path</b><span>The agent reads the file where it is.</span></div>` : ''}
    <div class="${zone === 'copy' || !two ? 'hot' : ''}"><b>Copy into the chat</b><span>A copy goes in the chat’s folder (.relay\\threads\\…\\attachments), so the agent can read it without asking.</span></div></div>`;
}
function hideDrops() { const el = $('#drops'); if (el) el.innerHTML = ''; }
function quotePath(p) { return /\s/.test(p) ? `"${p}"` : p; }

// In a plain browser (relay serve --open) we only get the bytes: one zone, the file is uploaded into the chat.
if (!IS_TAURI) {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types?.includes('Files') || S.route.name !== 'chat') return; depth++; showDrops(false); });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; hideDrops(); } });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); depth = 0; hideDrops();
    const id = currentChatId();
    if (!id) return;
    for (const f of e.dataTransfer.files) {
      if (f.size > 50 * 1024 * 1024) { toast({ kind: 'warn', text: `${f.name} is over 50 MB.` }); continue; }
      await act(async () => { const r = await api('POST', `/api/chats/${id}/attachments?name=${encodeURIComponent(f.name)}`, await f.arrayBuffer(), true); if (r.pasted?.length) toast({ kind: 'done', text: `Added ${f.name} to the message.` }); });
    }
    term?.focus();
  });
}

/* =============================== boot =============================== */

(function boot() {
  window.__relayStarted = true;
  // the first URL carries the token; the server answered with a cookie, so drop it from the address
  if (location.search.includes('token=')) history.replaceState(null, '', location.pathname + location.hash);
  S.sideOpen = store.get('side', true);
  applyTheme();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  renderChrome();
  renderMain();
  connect();
  setInterval(() => { if (S.route.name === 'approvals' && !document.activeElement?.matches('input')) renderMain(); }, 15000);
})();
