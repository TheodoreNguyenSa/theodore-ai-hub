#!/usr/bin/env node
// Put together what the installer ships, in build/:
//   build/app/   the server, the page, the tools, and only the runtime node_modules (node-pty with this platform's
//                native files, xterm, ws)
//   build/node/  the Node runtime the app starts the server with (node.exe on Windows): scripts/fetch-node.mjs puts it
//                there in CI; locally the Node running this script is copied when nothing is there yet
//
//   node scripts/stage.mjs [--platform win32] [--arch x64]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const platform = arg('--platform', process.platform);
const arch = arg('--arch', process.arch);
const OUT = path.join(ROOT, 'build');
const APP = path.join(OUT, 'app');
const NODE = path.join(OUT, 'node');

fs.rmSync(APP, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
fs.mkdirSync(NODE, { recursive: true });

const copy = (rel, dest = rel, filter) => fs.cpSync(path.join(ROOT, rel), path.join(APP, dest), { recursive: true, filter: filter || (() => true) });
copy('server');
copy('ui');
fs.mkdirSync(path.join(APP, 'tools'), { recursive: true });
for (const f of ['fake-tui.mjs', 'fake-model.mjs', 'live-probe.mjs']) copy(`tools/${f}`);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', dependencies: pkg.dependencies }, null, 2));
for (const f of ['README.md', 'LICENSE']) if (fs.existsSync(path.join(ROOT, f))) copy(f);

// runtime modules only
const RUNTIME = ['node-pty', '@xterm/xterm', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-fit', '@xterm/addon-unicode11', 'ws'];
for (const m of RUNTIME) {
  const src = path.join(ROOT, 'node_modules', m);
  if (!fs.existsSync(src)) throw new Error(`missing node_modules/${m}: run npm install first`);
  fs.cpSync(src, path.join(APP, 'node_modules', m), { recursive: true });
}
// node-pty: keep lib/ and the native files for the target only
const pty = path.join(APP, 'node_modules', 'node-pty');
for (const d of ['src', 'deps', 'third_party', 'scripts', 'node-addon-api', 'typings', 'binding.gyp']) fs.rmSync(path.join(pty, d), { recursive: true, force: true });
const pre = path.join(pty, 'prebuilds');
if (fs.existsSync(pre)) for (const d of fs.readdirSync(pre)) if (d !== `${platform}-${arch}`) fs.rmSync(path.join(pre, d), { recursive: true, force: true });
const rel = path.join(pty, 'build');
if (fs.existsSync(rel)) {
  // a local compile (Linux, or Windows without prebuilds): keep only the .node files and spawn-helper
  const keep = new Set();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.node$|spawn-helper$|\.dll$|\.exe$/.test(e.name) && /Release/.test(p)) keep.add(p); } };
  walk(rel);
  const tmp = path.join(OUT, 'pty-keep');
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of keep) { const r = path.relative(rel, p); fs.mkdirSync(path.dirname(path.join(tmp, r)), { recursive: true }); fs.copyFileSync(p, path.join(tmp, r)); }
  fs.rmSync(rel, { recursive: true, force: true });
  if (keep.size) fs.renameSync(tmp, rel); else fs.rmSync(tmp, { recursive: true, force: true });
}
// drop source maps, pdb files and tests to keep the installer small
const prune = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (/^(test|tests|__tests__|\.github)$/.test(e.name)) fs.rmSync(p, { recursive: true, force: true }); else prune(p); } else if (/\.(map|pdb|ts|md)$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/README/i.test(e.name)) fs.rmSync(p); } };
prune(path.join(APP, 'node_modules'));

// the Node runtime
const exe = platform === 'win32' ? 'node.exe' : 'node';
if (!fs.existsSync(path.join(NODE, exe))) {
  if (platform !== process.platform) throw new Error(`build/node/${exe} is missing: run node scripts/fetch-node.mjs --platform ${platform} --arch ${arch}`);
  fs.copyFileSync(process.execPath, path.join(NODE, exe));
  fs.chmodSync(path.join(NODE, exe), 0o755);
}

const size = (d) => { let n = 0; const w = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) w(p); else n += fs.statSync(p).size; } }; w(d); return n; };
console.log(`staged build/app (${(size(APP) / 1048576).toFixed(1)} MB) and build/node (${(size(NODE) / 1048576).toFixed(1)} MB) for ${platform}-${arch}`);
