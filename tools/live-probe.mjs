#!/usr/bin/env node
// Drive a REAL agent CLI inside Theodore AI Hub, against the fake model (no account, no quota), and report what Theodore AI Hub saw:
// transcript found and parsed, a permission prompt recognised and answered, the theodore MCP tool called.
// Run it on Windows after installing a CLI to check that Theodore AI Hub works with that version:
//
//   node tools/live-probe.mjs claude            (also: codex, gemini, agy)
//   node tools/live-probe.mjs claude --isolate  (a throwaway home folder, so the CLI's own config is not used)
//
// Writes probe-<agent>.json with the screens and the parsed record next to this file's working folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeModel } from './fake-model.mjs';

const agent = process.argv[2] || 'claude';
const isolate = process.argv.includes('--isolate');
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fake = await startFakeModel(0);
const port = fake.address().port;
const base = fs.mkdtempSync(path.join(os.tmpdir(), `relay-probe-${agent}-`));
const work = path.join(base, 'work'); fs.mkdirSync(work);
const relayHome = path.join(base, 'relay');
process.env.RELAY_HOME = relayHome;
const logFile = path.join(base, 'fake-model.log');
process.env.FAKE_MODEL_LOG = logFile;

if (isolate) {
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
  // first-run dialogs answered in advance, in the throwaway home only
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['fakefakefakefakefake'] }, projects: { [work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } } }));
}
const url = `http://127.0.0.1:${port}`;
const overrides = {
  claude: { env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-api03-fakefakefakefakefakefakefakefakefake', DISABLE_TELEMETRY: '1', IS_SANDBOX: '1' } },
  codex: { env: { FAKE_KEY: 'x' }, extraArgs: ['-c', 'model_provider=fake', '-c', `model_providers.fake={name="fake",base_url="${url}/v1",wire_api="responses",env_key="FAKE_KEY"}`, '-m', 'fake-model'] },
  gemini: { env: { GEMINI_API_KEY: 'fake', GOOGLE_GEMINI_BASE_URL: url }, extraArgs: ['--skip-trust'] },
  agy: { env: { GEMINI_API_KEY: 'fake', GOOGLE_GEMINI_BASE_URL: url } },
};
fs.mkdirSync(relayHome, { recursive: true });
fs.writeFileSync(path.join(relayHome, 'agents.json'), JSON.stringify({ [agent]: overrides[agent] }, null, 1));

const { Controller } = await import('../server/controller.mjs');
const ctl = new Controller({ tickMs: 500 });
const report = { agent, version: null, screens: {}, approvals: [], mcp: [], ok: {} };
const screen = (id) => ctl.live.get(id)?.host.lines().join('\n').replace(/\n{3,}/g, '\n\n') || '';
const dump = (id, label) => { report.screens[label] = screen(id); console.log(`--- screen: ${label} ---\n${report.screens[label]}\n---`); };
ctl.on('approval', (a) => { report.approvals.push({ question: a.question, what: a.what, options: a.options }); console.log(`  approval: ${a.question} · ${a.what}`); });

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); }
  console.log(`  ✖ timed out: ${what}`);
  return null;
}

let exitCode = 0;
try {
  step(`start ${agent} in ${work}`);
  const t = ctl.newChat({ agent, folder: work, prompt: '[[shell:echo relay-probe > probe.txt]]' });
  report.version = t.cliVersion;
  console.log(`  thread ${t.id} · ${t.cmdline?.slice(0, 300)}`);
  await sleep(4000);
  dump(t.id, 'after start');

  step('a permission prompt for the shell command (answered from Theodore AI Hub)');
  const ap = await waitFor(() => [...ctl.approvals.values()].find(a => a.threadId === t.id), 45000, 'approval');
  if (ap) {
    dump(t.id, 'approval');
    report.ok.approvalDetected = true;
    if (ap.trust) { console.log('  (folder trust dialog: approving it, then waiting for the real prompt)'); ctl.approve(t.id, ap.id, 'approve'); }
    else ctl.approve(t.id, ap.id, 'approve');
  }
  const ran = await waitFor(() => fs.existsSync(path.join(work, 'probe.txt')) || ([...ctl.approvals.values()].find(a => a.threadId === t.id && !a.trust) && (ctl.approve(t.id, [...ctl.approvals.values()].find(a => a.threadId === t.id).id, 'approve'), false)), 45000, 'probe.txt written');
  report.ok.commandRan = !!ran;
  await sleep(2500);
  dump(t.id, 'after command');

  step('the theodore MCP tool');
  ctl.live.get(t.id)?.host.paste('[[mcp:get_handoff_context]]');
  await sleep(300); ctl.input(t.id, '\r');
  const mcp = await waitFor(() => {
    const ap2 = [...ctl.approvals.values()].find(a => a.threadId === t.id);
    if (ap2) { console.log(`  MCP call asked for approval: ${ap2.question} · ${ap2.what}`); report.ok.mcpNeededApproval = true; ctl.approve(t.id, ap2.id, ap2.keys?.always ? 'always' : 'approve'); }
    return ctl.store.readEvents(t.id).find(e => e.tool === 'get_handoff_context');
  }, 45000, 'MCP call logged');
  report.ok.mcpCalled = !!mcp;
  await sleep(2500);
  dump(t.id, 'after mcp');

  step('stop the agent, then reopen the chat (resume with its session)');
  const before = ctl.store.getThread(t.id).turns.length;
  ctl.stop(t.id);
  await waitFor(() => !ctl.live.has(t.id), 15000, 'agent stopped');
  ctl.restart(t.id);
  await sleep(5000);
  dump(t.id, 'resumed');
  ctl.live.get(t.id)?.host.paste('after resume');
  await sleep(300); ctl.input(t.id, '\r');
  const resumed = await waitFor(() => { ctl.tick(); const x = ctl.store.getThread(t.id); return x.turns.some(y => y.text === 'after resume') && x.turns.length > before && x; }, 40000, 'turn after resume recorded with the earlier ones');
  report.ok.resume = !!resumed;
  await sleep(1500);

  const other = process.argv.find(a => a.startsWith('--handoff='))?.slice(10);
  if (other) {
    step(`hand off to ${other}`);
    if (overrides[other]) { const cur = JSON.parse(fs.readFileSync(path.join(relayHome, 'agents.json'), 'utf8')); cur[other] = overrides[other]; fs.writeFileSync(path.join(relayHome, 'agents.json'), JSON.stringify(cur, null, 1)); }
    const h = ctl.handoff(t.id, { agent: other });
    const loaded = await waitFor(() => {
      const ap3 = [...ctl.approvals.values()].find(a => a.threadId === h.id);
      if (ap3) { console.log(`  ${other} asked: ${ap3.question} · ${ap3.what}`); ctl.approve(h.id, ap3.id, 'approve'); }
      return ctl.store.getThread(h.id)?.handoffLoaded;
    }, 60000, 'handoff context loaded by the next agent');
    await sleep(2500);
    dump(h.id, 'handoff');
    report.ok.handoff = !!loaded;
  }

  step('what Theodore AI Hub recorded');
  ctl.tick();
  const rec = ctl.store.getThread(t.id);
  report.ok.transcript = !!rec.transcriptPath;
  report.record = { transcriptPath: rec.transcriptPath, nativeSessionId: rec.nativeSessionId, state: rec.state, cliVersion: rec.cliVersion, turns: rec.turns, tools: rec.tools, usage: rec.usage };
  console.log(`  transcript: ${rec.transcriptPath}`);
  console.log(`  session:    ${rec.nativeSessionId}`);
  for (const x of rec.turns) console.log(`  turn ${x.role}: ${x.text.slice(0, 100).replace(/\n/g, ' ')}`);
  for (const x of rec.tools) console.log(`  tool ${x.kind} ${x.name} [${x.status}] ${x.target}`);
  report.ok.turnsParsed = rec.turns.some(x => x.role === 'user' && /relay-probe/.test(x.text)) && rec.turns.some(x => x.role === 'assistant');
  report.ok.toolParsed = rec.tools.some(x => x.kind === 'command' && /relay-probe/.test(x.target));
  report.fakeModel = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-20).map(l => JSON.parse(l)) : [];
  // did the agent get Theodore AI Hub's note (artifact folder) in its instructions?
  report.ok.noteDelivered = fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes(`Theodore AI Hub thread ${t.id}`);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  const out = path.resolve(`probe-${agent}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`\nresult: ${Object.entries(report.ok).map(([k, v]) => `${v ? '✔' : '✖'} ${k}`).join('  ')}\nreport: ${out}`);
  ctl.close(); fake.close();
  setTimeout(() => process.exit(exitCode), 500);
}
