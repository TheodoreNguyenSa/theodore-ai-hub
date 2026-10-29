// The approval detector against real prompt screens captured with tools/live-probe.mjs (Claude Code 2.1.312,
// Codex 0.165.0, Gemini CLI 0.66.0), and against text that only looks like a prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectApproval } from '../server/approvals.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const screen = (f) => fs.readFileSync(path.join(FIX, f), 'utf8').split('\n');

test('Claude Code 2.1.312: a Bash prompt names the command; option 2 is "always"', () => {
  const a = detectApproval('claude', screen('claude-2.1.312-approval.txt'));
  assert.equal(a.question, 'Do you want to proceed?');
  assert.equal(a.what, 'Bash command · echo relay-probe > probe.txt');
  assert.deepEqual(a.keys, { approve: '\r', deny: '\x1b', always: '2' });
});

test('Codex 0.165.0: the command under the question, the model\'s reason kept apart', () => {
  const a = detectApproval('codex', screen('codex-0.165.0-approval.txt'));
  assert.equal(a.question, 'Would you like to run the following command?');
  assert.equal(a.what, 'echo relay-probe > probe.txt');
  assert.equal(a.reason, 'Do you want to let the probe write a file?');
  assert.equal(a.keys.always, '2');
});

test('Gemini CLI 0.66.0: "Allow execution of [Shell]?" names the tool and command', () => {
  const a = detectApproval('gemini', screen('gemini-0.66.0-approval.txt'));
  assert.equal(a.question, 'Allow execution of [Shell]?');
  assert.equal(a.what, 'Shell · echo relay-probe > probe.txt');
  assert.equal(a.options[0].label, 'Allow once');
});

test('agy style: "Requesting permission for:" gives the command', () => {
  const a = detectApproval('agy', ['● Ran (ls -la /x/mcp) (ctrl+o to expand)', 'Command', '─'.repeat(20), 'Requesting permission for: ls -la /x/mcp', 'Run this command?', '> 1. Yes, run command', '  4. No, cancel']);
  assert.equal(a.what, 'ls -la /x/mcp');
});

test('prose that mentions a prompt is not one', () => {
  assert.equal(detectApproval('claude', ['I will ask: Do you want to proceed?', 'and then continue']), undefined);
  assert.equal(detectApproval('codex', ['Would you like to run the tests? sure', 'ok']), undefined);
});

test('an answered prompt left in the scrollback, with the chat going on under it, is not waiting', () => {
  const old = [...screen('claude-2.1.312-approval.txt'), '', '● Ran the command', '', '● Done.', '', '✻ Worked for 2s', '', '> next message', '● Reply', '> '];
  assert.equal(detectApproval('claude', old), undefined);
});
