// The four agents, plus the fake one used for tests and UI work, with the user's overrides from ~/.relay/agents.json:
//
//   {
//     "claude": { "command": "C:\\Users\\me\\.local\\bin\\claude.exe", "extraArgs": ["--verbose"], "permissionMode": "acceptEdits" },
//     "codex":  { "env": { "CODEX_HOME": "D:\\codex-home" } },
//     "agy":    { "skipArgs": ["--dangerously-skip-permissions"], "promptMode": "arg", "promptArgs": ["-i"] }
//   }
//
// Every per-CLI fact lives in its adapter file, so a CLI update means editing one file (or this JSON), nothing else.
import path from 'node:path';
import fs from 'node:fs';
import claude from './claude.mjs';
import codex from './codex.mjs';
import gemini from './gemini.mjs';
import agy from './agy.mjs';
import fake from './fake.mjs';
import { readJson, relayHome, runQuick, which } from '../util.mjs';

export const AGENTS = { claude, codex, gemini, agy };
export const AGENT_IDS = Object.keys(AGENTS);

export function overrides() {
  return readJson(path.join(relayHome(), 'agents.json'), {}) || {};
}

/** The adapter for an agent id (fake agents replace all of them when RELAY_FAKE_AGENTS=1). */
export function adapter(id) {
  if (process.env.RELAY_FAKE_AGENTS === '1') return { ...fake, id, name: AGENTS[id]?.name || id, letter: AGENTS[id]?.letter || '?', anchorBottom: AGENTS[id]?.anchorBottom };
  return AGENTS[id];
}

const cache = new Map();
/** Is the CLI installed, which version, signed in? Cached for a minute (the doctor screen asks again with fresh=true). */
export function detect(id, { fresh = false } = {}) {
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.info;
  const a = adapter(id);
  const ov = overrides()[id] || {};
  let info;
  if (process.env.RELAY_FAKE_AGENTS === '1') {
    info = { id, name: a.name, installed: true, path: 'fake', version: 'fake 1.0', login: { state: 'fake', ok: true } };
  } else {
    const bin = (ov.command && (which(ov.command) || (fs.existsSync(ov.command) ? ov.command : null))) || a.bins.map(b => which(b)).find(Boolean) || null;
    let version = null;
    if (bin) {
      const r = runQuick(bin, ['--version'], { timeout: 15000 });
      version = (r.out.match(/\d+\.\d+\.\d+[\w.-]*/) || [r.out.split('\n')[0]])[0] || null;
    }
    let login = bin ? a.login() : { state: 'not installed', ok: false };
    // a key given to this agent in agents.json counts as signed in
    if (bin && !login.ok && Object.keys(ov.env || {}).some(k => /API_KEY$/.test(k))) login = { state: 'api key', ok: true, detail: 'from agents.json' };
    info = { id, name: a.name, installed: !!bin, path: bin, version, login, install: a.install };
  }
  cache.set(id, { at: Date.now(), info });
  return info;
}

export function agentList() {
  return AGENT_IDS.map(id => {
    const a = adapter(id);
    const ov = overrides()[id] || {};
    return { id, name: a.name, letter: a.letter, models: ov.models || AGENTS[id].models, efforts: ov.efforts || AGENTS[id].efforts, skipFlag: (ov.skipArgs || [a.skipFlag]).join(' '), disabled: !!ov.disabled };
  }).filter(a => !a.disabled);
}

/** Apply the user's overrides to a launch the adapter built. */
export function withOverrides(id, launch, { prompt, skip } = {}) {
  const ov = overrides()[id] || {};
  let args = [...launch.args];
  if (ov.skipArgs && skip) {
    const def = AGENTS[id].skipFlag.split(' ');
    const at = args.findIndex((x, i) => def.every((d, j) => args[i + j] === d));
    if (at >= 0) args.splice(at, def.length, ...ov.skipArgs);
  }
  if (ov.extraArgs) args.push(...ov.extraArgs);
  let promptMode = ov.promptMode || AGENTS[id].promptMode;
  if (ov.promptMode === 'arg' && AGENTS[id].promptMode === 'type' && prompt) args.push(...(ov.promptArgs || []), prompt);
  return { ...launch, args, env: { ...(launch.env || {}), ...(ov.env || {}) }, promptMode, command: ov.command };
}
