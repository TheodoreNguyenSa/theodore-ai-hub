// One agent in one pseudo-terminal (ConPTY on Windows), with a virtual screen in memory so a window that opens the chat
// later gets the exact screen (replay) and then the live bytes. The virtual screen also answers the agent's terminal
// queries (cursor position, device attributes), so the window's own terminal must not.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { isWin } from './util.mjs';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const RAW_CAP = 2 * 1024 * 1024;

export class Host extends EventEmitter {
  /**
   * @param {object} o  { file, args, cwd, env, cols, rows, rawLog }
   */
  constructor(o) {
    super();
    this.o = o;
    this.cols = o.cols || 120;
    this.rows = o.rows || 36;
    this.alive = false;
    this.exitCode = null;
    this.lastOutput = 0;
    this.started = Date.now();
    this.bytes = 0;
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 3000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.rawFd = null;
    if (o.rawLog) { try { this.rawFd = fs.openSync(o.rawLog, 'a'); } catch { /* no debug log */ } }
    this.rawBytes = 0;
  }

  start() {
    const opts = { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.o.cwd, env: this.o.env };
    // the ConPTY that ships with node-pty (newer than Windows 10's own); RELAY_CONPTY_DLL=0 uses the system one
    if (isWin) Object.assign(opts, { useConpty: true, useConptyDll: process.env.RELAY_CONPTY_DLL !== '0' });
    try {
      this.p = pty.spawn(this.o.file, this.o.args, opts);
    } catch (e) {
      if (isWin && opts.useConptyDll) { // the bundled conpty.dll could not load: use the system's ConPTY
        delete opts.useConptyDll;
        this.p = pty.spawn(this.o.file, this.o.args, opts);
      } else throw e;
    }
    this.alive = true;
    this.pid = this.p.pid;
    // answers to the agent's terminal queries come from the virtual screen
    this.term.onData((d) => { if (this.alive) this.p.write(d); });
    this.p.onData((d) => {
      this.lastOutput = Date.now();
      this.bytes += d.length;
      this.term.write(d);
      this.emit('data', d);
      if (this.rawFd !== null && this.rawBytes < RAW_CAP) { try { fs.writeSync(this.rawFd, d); this.rawBytes += d.length; } catch { /* */ } }
    });
    this.p.onExit(({ exitCode, signal }) => {
      this.alive = false;
      this.exitCode = exitCode;
      if (this.rawFd !== null) { try { fs.closeSync(this.rawFd); } catch { /* */ } this.rawFd = null; }
      this.emit('exit', { exitCode, signal });
    });
    return this;
  }

  write(data) { if (this.alive) this.p.write(data); }

  /** Paste text the way a terminal does: inside bracketed-paste markers when the agent turned that mode on. */
  paste(text) {
    const bp = this.term.modes.bracketedPasteMode;
    this.write(bp ? `\x1b[200~${text}\x1b[201~` : text);
  }

  resize(cols, rows) {
    cols = Math.max(20, Math.min(500, cols | 0)); rows = Math.max(5, Math.min(200, rows | 0));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    this.term.resize(cols, rows);
    if (this.alive) { try { this.p.resize(cols, rows); } catch { /* exited */ } }
  }

  kill() {
    if (!this.alive) return;
    try { this.p.kill(); } catch { /* */ }
  }

  /**
   * The screen as bytes that rebuild it in a fresh terminal, plus the modes the serializer leaves out.
   * Waits for the virtual screen to have parsed everything written so far (an empty write is a barrier).
   */
  snapshot() {
    return new Promise((resolve) => {
      this.term.write('', () => {
        let s = this.serializer.serialize({ scrollback: 1000 });
        const m = this.term.modes;
        const core = this.term._core;
        const extra = [];
        if (m.applicationCursorKeysMode) extra.push('\x1b[?1h');
        if (m.applicationKeypadMode) extra.push('\x1b=');
        if (m.bracketedPasteMode) extra.push('\x1b[?2004h');
        if (m.sendFocusMode) extra.push('\x1b[?1004h');
        const mouse = { x10: '\x1b[?9h', vt200: '\x1b[?1000h', drag: '\x1b[?1002h', any: '\x1b[?1003h' }[m.mouseTrackingMode];
        if (mouse) extra.push(mouse);
        try { if (core.coreMouseService.activeEncoding === 'SGR') extra.push('\x1b[?1006h'); } catch { /* private API moved */ }
        try { if (core.coreService.isCursorHidden) extra.push('\x1b[?25l'); } catch { /* */ }
        resolve(s + extra.join(''));
      });
    });
  }

  /** The visible screen as text lines (for the approval detector). */
  lines() {
    const b = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < this.rows; i++) {
      const l = b.getLine(b.viewportY + i);
      out.push(l ? l.translateToString(true) : '');
    }
    return out;
  }

  /** Rows of empty space under the last drawn line (agy draws top-down; the page anchors it at the bottom). */
  emptyRowsBelow() {
    const ls = this.lines();
    const b = this.term.buffer.active;
    let last = ls.length - 1;
    while (last > 0 && !ls[last].trim()) last--;
    return Math.max(0, this.rows - 1 - Math.max(last, b.cursorY));
  }
}
