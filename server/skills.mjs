// One skills library for every agent. A skill is a folder with SKILL.md (frontmatter name + description), the format
// Claude Code, Codex and Gemini CLI all read. Turned on, it is linked into the agents' own user-level folders:
//   ~/.claude/skills/<name>   Claude Code
//   ~/.agents/skills/<name>   Codex (verified 0.165: listed as a skill root) and Gemini CLI (0.66 docs: user skills alias), agy
// On Windows the link is a directory junction (no admin or developer mode needed); if even that fails, a copy marked with
// .theodore-managed. Theodore AI Hub only ever removes links and copies it made itself.
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, ensureDir, isWin, readJson, samePath, writeJson } from './util.mjs';

const userHome = () => process.env.RELAY_SKILLS_HOME || HOME_DIR; // tests point this at a temp folder

export function skillTargets() {
  const h = userHome();
  return [
    { id: 'claude', dir: path.join(process.env.RELAY_SKILLS_HOME ? path.join(h, '.claude') : process.env.CLAUDE_CONFIG_DIR || path.join(h, '.claude'), 'skills'), agents: ['claude'] },
    { id: 'agents', dir: path.join(h, '.agents', 'skills'), agents: ['codex', 'gemini', 'agy'] },
  ];
}
const extraScan = () => [
  { dir: path.join(process.env.RELAY_SKILLS_HOME ? path.join(userHome(), '.codex') : process.env.CODEX_HOME || path.join(userHome(), '.codex'), 'skills'), agents: ['codex'] },
  { dir: path.join(userHome(), '.gemini', 'skills'), agents: ['gemini'] },
];

const libDir = (store) => store.file('skills');
const manifestFile = (store) => store.file('skills.json');
const manifest = (store) => readJson(manifestFile(store), { enabled: {} }) || { enabled: {} };

export function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src || '');
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

export const validName = (n) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(n || '');

export function listSkills(store) {
  const man = manifest(store);
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(libDir(store), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const file = path.join(libDir(store), e.name, 'SKILL.md');
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(src);
    out.push({ name: e.name, description: fm.description || '', file, enabled: man.enabled[e.name] !== false, links: linkState(e.name, store) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function linkState(name, store) {
  return skillTargets().map(t => {
    const p = path.join(t.dir, name);
    return { target: t.id, path: p, ours: isOurs(p, store) };
  });
}

export function readSkill(store, name) {
  if (!validName(name)) return null;
  try { return fs.readFileSync(path.join(libDir(store), name, 'SKILL.md'), 'utf8'); } catch { return null; }
}

export function createSkill(store, { name, description, body }) {
  if (!validName(name)) throw new Error('A skill name is lowercase letters, digits and dashes, like "release-notes".');
  const dir = path.join(libDir(store), name);
  if (fs.existsSync(dir)) throw new Error(`A skill named ${name} already exists.`);
  ensureDir(dir);
  const desc = String(description || '').replace(/\n/g, ' ').trim() || `What ${name} does and when to use it`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body || `# ${name}\n\nInstructions for the agent go here.\n`}`);
  setEnabled(store, name, true);
  return path.join(dir, 'SKILL.md');
}

export function deleteSkill(store, name) {
  if (!validName(name)) return;
  setEnabled(store, name, false);
  fs.rmSync(path.join(libDir(store), name), { recursive: true, force: true });
  const man = manifest(store); delete man.enabled[name]; writeJson(manifestFile(store), man);
}

export function setEnabled(store, name, on) {
  const man = manifest(store);
  man.enabled[name] = !!on;
  writeJson(manifestFile(store), man);
  return sync(store);
}

/** Is `p` a link into our library, or a copy we made? */
function isOurs(p, store) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      // a junction reads back as an absolute path, sometimes as \\?\C:\…
      const to = fs.readlinkSync(p).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
      return samePath(path.dirname(path.resolve(path.dirname(p), to)), libDir(store));
    }
    return st.isDirectory() && fs.existsSync(path.join(p, '.theodore-managed'));
  } catch { return false; }
}

function link(src, dest) {
  ensureDir(path.dirname(dest));
  try {
    fs.symlinkSync(src, dest, isWin ? 'junction' : 'dir');
    return 'link';
  } catch {
    fs.cpSync(src, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, '.theodore-managed'), 'Copied by Theodore AI Hub from its skills library; Theodore AI Hub replaces or removes this folder.\n');
    return 'copy';
  }
}

/** Make the agents' folders match the library: enabled skills linked, the rest of ours removed. */
export function sync(store) {
  const report = { linked: [], removed: [], conflicts: [] };
  const skills = listSkills(store);
  for (const t of skillTargets()) {
    for (const s of skills) {
      const dest = path.join(t.dir, s.name);
      const src = path.join(libDir(store), s.name);
      const ours = isOurs(dest, store);
      const exists = fs.existsSync(dest) || (() => { try { fs.lstatSync(dest); return true; } catch { return false; } })();
      if (s.enabled) {
        if (exists && !ours) { report.conflicts.push(dest); continue; }
        if (ours) {
          // a copy goes stale: refresh it; a link is always current
          if (!fs.lstatSync(dest).isSymbolicLink()) { fs.rmSync(dest, { recursive: true, force: true }); link(src, dest); }
          continue;
        }
        link(src, dest); report.linked.push(dest);
      } else if (ours) {
        unlink(dest); report.removed.push(dest);
      }
    }
    // links to skills that left the library
    let ents = [];
    try { ents = fs.readdirSync(t.dir); } catch { continue; }
    for (const n of ents) {
      const p = path.join(t.dir, n);
      if (!skills.some(s => s.name === n) && isOurs(p, store)) { unlink(p); report.removed.push(p); }
    }
  }
  return report;
}

function unlink(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } }
    else fs.rmSync(p, { recursive: true, force: true });
  } catch { /* gone */ }
}

/** Skills in the agents' own folders that are not from the library (to import). */
export function foundSkills(store) {
  const lib = new Set(listSkills(store).map(s => s.name));
  const out = [];
  for (const t of [...skillTargets(), ...extraScan()]) {
    let ents = [];
    try { ents = fs.readdirSync(t.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(t.dir, e.name);
      if (isOurs(p, store) || lib.has(e.name)) continue;
      const file = path.join(p, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      out.push({ name: e.name, description: fm.description || '', path: p, agents: t.agents });
    }
  }
  return out;
}

export function importSkill(store, src) {
  const name = path.basename(src);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('Not a skill folder (no SKILL.md).');
  const dest = path.join(libDir(store), validName(name) ? name : name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
  if (fs.existsSync(dest)) throw new Error(`The library already has ${path.basename(dest)}.`);
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  setEnabled(store, path.basename(dest), true);
  return dest;
}
