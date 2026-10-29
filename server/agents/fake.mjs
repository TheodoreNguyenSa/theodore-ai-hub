// A fake agent (tools/fake-tui.mjs) that behaves like a small Claude Code: its own screen in a PTY, a Claude-format
// transcript, a permission prompt, artifacts, and a real call to the relay MCP server. For tests and UI work:
// `relay serve --fake-agents` (or RELAY_FAKE_AGENTS=1). Never used for real chats.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeExe, relayHome, uuid } from '../util.mjs';
import claude from './claude.mjs';

const TUI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/fake-tui.mjs');

export default {
  ...claude,
  id: 'fake',
  bins: [],
  promptMode: 'arg',
  login: () => ({ state: 'fake', ok: true }),
  launch(o) {
    const sessionId = o.resumeId || uuid();
    const transcript = path.join(relayHome(), 'fake', `${sessionId}.jsonl`);
    const args = [TUI, '--session', sessionId, '--transcript', transcript, '--name', o.agentName || 'Fake agent'];
    if (o.resumeId) args.push('--resume');
    if (o.prompt) args.push('--prompt', o.prompt);
    return { file: process.execPath || nodeExe(), args, env: { RELAY_FAKE_MCP: JSON.stringify(o.mcp), RELAY_ARTIFACTS: o.artifacts, RELAY_SKIP: o.skip ? '1' : '' }, sessionId };
  },
  findTranscript(t) {
    return t.nativeSessionId ? path.join(relayHome(), 'fake', `${t.nativeSessionId}.jsonl`) : null;
  },
};
