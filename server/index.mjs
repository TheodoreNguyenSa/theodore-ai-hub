#!/usr/bin/env node
// relay — the entry point. The desktop app runs `relay serve --port 0 --exit-with-stdin` with its bundled Node and opens
// the URL it prints. Each agent runs `relay mcp --thread <id>` as its MCP server.
//
//   node server/index.mjs serve [--port N] [--open] [--fake-agents] [--home DIR]
//   node server/index.mjs mcp --thread <id> [--home DIR]
//   node server/index.mjs doctor | threads | show <id>
const argv = process.argv.slice(2);
const cmd = argv[0] || 'serve';
const flag = (k) => argv.includes(k);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (opt('--home')) process.env.RELAY_HOME = opt('--home');
if (flag('--fake-agents')) process.env.RELAY_FAKE_AGENTS = '1';

if (cmd === 'mcp') {
  const { runMcp } = await import('./mcp.mjs');
  await runMcp(argv.slice(1));
} else if (cmd === 'serve') {
  const { serve } = await import('./serve.mjs');
  const { openPath } = await import('./util.mjs');
  const s = await serve({ port: Number(opt('--port') || process.env.RELAY_PORT || 0) });
  // the desktop shell reads this exact line
  process.stdout.write(`relay serve: ${s.url}\n`);
  if (flag('--open')) openPath(s.url);
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    try { s.close(); } catch { /* */ }
    setTimeout(() => process.exit(0), 600).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);
  // the app holds our stdin open and never writes to it: when it is gone (even killed), so are we and our agents
  if (flag('--exit-with-stdin')) {
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.on('error', shutdown);
    process.stdin.resume();
  }
  process.on('uncaughtException', (e) => { process.stderr.write(`relay: ${e?.stack || e}\n`); });
} else if (cmd === 'doctor') {
  const { doctorText } = await import('./doctor.mjs');
  console.log(doctorText());
} else if (cmd === 'threads') {
  const { Store } = await import('./store.mjs');
  for (const t of new Store().listThreads()) console.log(`${t.id}  ${t.agent.padEnd(6)}  ${t.state.padEnd(8)}  ${t.title}  (${t.cwd})`);
} else if (cmd === 'show') {
  const { Store } = await import('./store.mjs');
  const { buildHandoff } = await import('./handoff.mjs');
  const t = new Store().getThread(argv[1]);
  console.log(t ? buildHandoff(t) : `No thread ${argv[1]}`);
} else {
  console.log('usage: relay serve [--port N] [--open] [--fake-agents] | mcp --thread <id> | doctor | threads | show <id>');
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
