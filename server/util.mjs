// Small helpers shared by the server, the MCP server and the tests. Windows comes first: paths, PATH lookup,
// npm .cmd shims, atomic writes that survive another process holding the file open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const isWin = process.platform === 'win32';
export const HOME_DIR = os.homedir();

/** Where Relay keeps its own data: threads, events, skills library, logs. */
export function relayHome() {
  return process.env.RELAY_HOME || path.join(HOME_DIR, '.relay');
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const now = () => Date.now();
export const newId = (prefix = 't_') => prefix + crypto.randomBytes(4).toString('hex');
export const uuid = () => crypto.randomUUID();

/** Write JSON atomically. On Windows a rename onto a file another process is reading can fail with EPERM/EBUSY: retry. */
export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); return; } catch { /* fall through */ }
        throw e;
      }
      const until = Date.now() + 15 * (i + 1); while (Date.now() < until) { /* short spin: sync API */ }
    }
  }
}

export function readJson(file, fallback = null) {
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      // a half-written file from a reader racing a non-atomic copy: try again
    }
  }
  return fallback;
}

export function appendLine(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export const short = (s, n = 120) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/** ~/x for display. */
export function tildify(p) {
  if (!p) return p;
  const h = HOME_DIR;
  return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return isWin ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/* ---------------- PATH lookup (Windows: PATHEXT, registry PATH, common install folders) ---------------- */

let freshPath = null;
/**
 * On Windows the app may have been started before the user installed a CLI, so the process PATH is stale.
 * Rebuild it from the registry (user + machine), expanded, plus the process PATH.
 */
export function searchPath() {
  if (freshPath) return freshPath;
  const parts = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  if (isWin) {
    for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
      try {
        const r = spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(r.stdout || '');
        if (m) parts.push(...m[1].trim().split(';').map(expandWinVars));
      } catch { /* no reg.exe: keep the process PATH */ }
    }
    const la = process.env.LOCALAPPDATA || path.join(HOME_DIR, 'AppData', 'Local');
    const ra = process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming');
    parts.push(
      path.join(HOME_DIR, '.local', 'bin'),          // Claude Code native installer
      path.join(ra, 'npm'),                           // npm -g
      path.join(la, 'Programs', 'Antigravity', 'bin'),
      path.join(la, 'Microsoft', 'WinGet', 'Links'),
      path.join(la, 'pnpm'),
      path.join(HOME_DIR, 'scoop', 'shims'),
    );
  } else {
    parts.push(path.join(HOME_DIR, '.local', 'bin'), path.join(HOME_DIR, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin');
  }
  const seen = new Set();
  freshPath = parts.filter(p => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
  return freshPath;
}
export function resetPathCache() { freshPath = null; }

function expandWinVars(s) {
  return s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? process.env[v.toUpperCase()] ?? m);
}

/** Find an executable by name, like `where` on Windows / `which` elsewhere. */
export function which(name) {
  if (!name) return null;
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const exts = isWin ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)] : [''];
  for (const dir of searchPath()) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (isWin && ext === '' && !/\.(exe|cmd|bat|com)$/i.test(p)) continue; // the extensionless bash shim npm also writes
        if (!isWin) { try { fs.accessSync(p, fs.constants.X_OK); } catch { continue; } }
        return p;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Node to run npm shims with: the user's own, else the one running this server (the bundled node.exe). */
export function nodeExe() {
  return process.env.RELAY_NODE || which('node') || process.execPath;
}

/**
 * Turn a command into something node-pty can start on Windows without cmd.exe quoting trouble:
 * an npm .cmd shim becomes `node <script.js>` or the .exe it points to; other .cmd/.bat go through cmd.exe.
 */
/**
 * The program an npm .cmd shim runs: … "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 * or "%dp0%\node_modules\…\claude.exe" %*. The shim also names "%dp0%\node.exe" (the Node it would prefer): skipped.
 */
export function shimTarget(src, dir, exists = fs.existsSync) {
  for (const m of String(src).matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:js|cjs|mjs|exe))"/gi)) {
    if (/(^|\\)node\.exe$/i.test(m[1])) continue;
    const target = path.win32.join(dir, m[1]);
    if (exists(target)) return target;
  }
  return null;
}

export function resolveCommand(file, args) {
  if (!isWin || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  try {
    const target = shimTarget(fs.readFileSync(file, 'utf8'), path.dirname(file));
    if (target) return /\.exe$/i.test(target) ? { file: target, args } : { file: nodeExe(), args: [target, ...args] };
  } catch { /* fall back to cmd.exe */ }
  // cmd.exe /c with the whole line as one string (node-pty passes a string argument through as-is on Windows)
  // cmd.exe cannot carry a newline inside an argument: a multi-line first message becomes one line
  const line = [file, ...args.map(a => String(a).replace(/\r?\n/g, ' '))].map(cmdQuote).join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${line}"` };
}

/** Quote one argument for a cmd.exe command line. */
export function cmdQuote(a) {
  a = String(a);
  if (a === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/[%!^&|<>()]/g, '^$&') + '"';
}

/** Run a command with a timeout and return its stdout+stderr (for --version and such). */
export function runQuick(file, args, opts = {}) {
  const r0 = resolveCommand(file, args);
  let r;
  if (typeof r0.args === 'string') r = spawnSync(r0.file, [r0.args], { encoding: 'utf8', timeout: opts.timeout ?? 8000, windowsHide: true, windowsVerbatimArguments: true, env: opts.env ?? cleanEnv() });
  else r = spawnSync(r0.file, r0.args, { encoding: 'utf8', timeout: opts.timeout ?? 8000, windowsHide: true, env: opts.env ?? cleanEnv(), cwd: opts.cwd });
  return { ok: r.status === 0, code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error?.message };
}

/** Variables an agent must not inherit when Relay itself was started from inside one (e.g. a Claude Code terminal). */
export const SCRUB_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'GEMINI_CLI', 'RELAY_TOKEN'];

export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SCRUB_ENV) delete env[k];
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(REMOTE|CCR|MESSAGING|SESSION)/.test(k)) delete env[k];
  env.PATH = searchPath().join(path.delimiter);
  if (isWin) { delete env.Path; env.Path = env.PATH; delete env.PATH; }
  env.TERM = env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.FORCE_COLOR = env.FORCE_COLOR ?? '1';
  return { ...env, ...extra };
}

export function fileHash(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12); } catch { return null; }
}

export function listFilesRec(dir, max = 500) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= max || depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** Open a file or folder with the system's default app. */
export function openPath(p, { reveal = false } = {}) {
  if (isWin) {
    // Explorer opens a file with its default app, a folder in a window, and a URL in the default browser
    spawn('explorer.exe', reveal ? [`/select,${p}`] : [p], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: reveal }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', reveal ? ['-R', p] : [p], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [reveal ? path.dirname(p) : p], { detached: true, stdio: 'ignore' }).unref();
  }
}
