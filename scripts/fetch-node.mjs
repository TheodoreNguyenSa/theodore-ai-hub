#!/usr/bin/env node
// Download the Node runtime the installer bundles (build/node/node.exe on Windows), checked against the release's
// SHASUMS256.txt.   node scripts/fetch-node.mjs [--version 24.11.1] [--platform win32] [--arch x64]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const platform = arg('--platform', process.platform);
const arch = arg('--arch', process.arch);
let version = arg('--version', process.env.RELAY_NODE_VERSION || '');
const OUT = path.join(ROOT, 'build', 'node');
fs.mkdirSync(OUT, { recursive: true });

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

if (!version) {
  // the newest LTS release
  const index = JSON.parse((await get('https://nodejs.org/dist/index.json')).toString());
  version = index.find(r => r.lts).version.replace(/^v/, '');
}
const base = `https://nodejs.org/dist/v${version}`;
const sums = (await get(`${base}/SHASUMS256.txt`)).toString();
const check = (name, buf) => {
  const want = sums.split('\n').find(l => l.endsWith(`  ${name}`))?.split(' ')[0];
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (!want || want !== got) throw new Error(`checksum mismatch for ${name}`);
};

if (platform === 'win32') {
  // node.exe alone is published per release: win-x64/node.exe, win-arm64/node.exe
  const name = `win-${arch}/node.exe`;
  const buf = await get(`${base}/${name}`);
  check(name, buf);
  fs.writeFileSync(path.join(OUT, 'node.exe'), buf);
} else {
  const plat = platform === 'darwin' ? 'darwin' : 'linux';
  const name = `node-v${version}-${plat}-${arch}.tar.gz`;
  const buf = await get(`${base}/${name}`);
  check(name, buf);
  const tgz = path.join(OUT, name);
  fs.writeFileSync(tgz, buf);
  execFileSync('tar', ['-xzf', tgz, '-C', OUT, '--strip-components=2', `node-v${version}-${plat}-${arch}/bin/node`]);
  fs.unlinkSync(tgz);
}
console.log(`Node ${version} for ${platform}-${arch} in build/node`);
