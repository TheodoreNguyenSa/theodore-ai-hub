// Recognise an agent's own permission prompt on its screen, so a chat in the background can be answered from the
// Approvals inbox. Matching needs both a question line and numbered/labelled answer options right under it; prose that
// only mentions a question never matches. Answering types the agent's own keys (Enter = the highlighted "yes", Esc = no).
//
// Seen on: Claude Code 2.1.312 ("Do you want to proceed?" / "❯ 1. Yes"), Codex 0.165 ("Would you like to run the following
// command?" / "› 1. Yes, proceed (y)"), Gemini CLI 0.66 ("Allow execution of: …?" / "● 1. Allow once"), agy 1.4
// ("Run this command?" / "> 1. Yes, run command", "Requesting permission for: …").

const QUESTION = /(Do you want to [^?]{1,160}\?|Would you like to [^?]{1,160}\?|Allow [^?]{1,200}\?|Run this command\?|Apply (?:this|these) [^?]{0,40}\?|Make this edit[^?]{0,80}\?|Proceed with [^?]{1,80}\?|Allow execution[^?]{0,200}\?|Do you trust [^?]{1,120}\?)/i;
const YES_OPTION = /^\s*(?:[❯›>●▶*→]\s*)?(?:1[.)]\s*)?(Yes\b|Allow\b|Approve\b|Proceed\b|Run\b|Trust\b)/i;
const NUMBERED = /^\s*(?:[❯›>●▶*→]\s*)?(\d)[.)]\s+(.+)$/;
const BOX = /^[\s│┃|╭╮╰╯─━┌┐└┘├┤╷╵▌▐]+|[\s│┃|╭╮╰╯─━┌┐└┘├┤▌▐]+$/g;

const clean = (l) => String(l || '').replace(BOX, '').trim();

/**
 * @param {string} agent  claude | codex | gemini | agy | fake
 * @param {string[]} lines  the visible screen
 * @returns {{question:string, what:string, options:{key:string,label:string}[], keys:{approve:string,deny:string,always?:string}, trust?:boolean}|undefined}
 */
export function detectApproval(agent, lines) {
  const ls = lines.map(clean);
  // the prompt is drawn near the bottom: search the last 40 rows, newest first
  const start = Math.max(0, ls.length - 40);
  for (let q = ls.length - 1; q >= start; q--) {
    const m = QUESTION.exec(ls[q]);
    if (!m || /^(Reason|Justification|Why):/i.test(ls[q])) continue; // Codex prints the model's own reason as a question
    // the line must essentially *be* the question (not a sentence in a reply that contains one)
    const before = ls[q].slice(0, m.index).trim();
    if (before.length > 40 && !/permission|Requesting/i.test(before)) continue;
    const opts = [];
    for (let j = q + 1; j < Math.min(ls.length, q + 16); j++) {
      const n = NUMBERED.exec(ls[j]);
      if (n) opts.push({ key: n[1], label: n[2].replace(/\s{2,}.*$/, '').trim() });
      else if (YES_OPTION.test(ls[j]) && !opts.length) opts.push({ key: '1', label: ls[j].replace(/^[❯›>●▶*→\s]+/, '').trim() });
    }
    if (!opts.length || !YES_OPTION.test(opts[0].label) && !/^(yes|allow|approve|proceed|run|trust)/i.test(opts[0].label)) continue;
    // a live prompt sits at the bottom: only a footer ("Esc to cancel", a status line) may follow its options.
    // An old prompt still in the scrollback, with the conversation going on under it, is not waiting any more.
    let lastOpt = q;
    for (let j = q + 1; j < Math.min(ls.length, q + 16); j++) if (NUMBERED.test(ls[j])) lastOpt = j;
    if (ls.slice(lastOpt + 1).filter(Boolean).length > 6) continue;
    const question = m[1].trim();
    const always = opts.find(o => /don.?t ask again|always|for this session|for the rest|for the conversation|allow all/i.test(o.label));
    const firstOpt = ls.findIndex((l, i) => i > q && (NUMBERED.test(l) || YES_OPTION.test(l)));
    const reason = ls.slice(q + 1, firstOpt).find(l => /^Reason:/i.test(l))?.replace(/^Reason:\s*/i, '');
    return {
      question,
      what: describe(agent, ls, q, question, firstOpt),
      ...(reason ? { reason } : {}),
      options: opts,
      keys: { approve: '\r', deny: '\x1b', ...(always ? { always: always.key } : {}) },
      trust: /trust/i.test(question),
    };
  }
  return undefined;
}

/** A one-line summary of what is asked: the command, the file, the tool. */
const SEP = /^[╌┄┈─━═\-·.]{6,}$/;
const HEADER = /^(Bash command|PowerShell command|Edit file|Create file|Write file|Read file|Delete file|Tool use|MCP tool|Shell command|Command|Fetch|Web fetch|Network request)\b/i;
function describe(agent, ls, q, question, firstOpt) {
  // below the question, before the options (Codex): "$ command", "Reason: …"
  const below = ls.slice(q + 1, firstOpt).filter(Boolean);
  const belowCmd = below.find(l => /^\$\s+/.test(l));
  if (belowCmd) return belowCmd.replace(/^\$\s+/, '');
  const above = ls.slice(Math.max(0, q - 16), q).filter(l => l && !/^Tip:/i.test(l) && !/^Esc to cancel/i.test(l));
  const req = above.find(l => /^Requesting permission for:/i.test(l));
  if (req) return req.replace(/^Requesting permission for:\s*/i, '');
  // Gemini: "? Shell  echo hi > x" heads its box
  const gem = [...above].reverse().find(l => /^\?\s+\S/.test(l));
  if (gem) { const [tool, ...rest] = gem.replace(/^\?\s+/, '').split(/\s{2,}/); return rest.length ? `${tool} · ${rest.join(' ')}` : tool; }
  const dollar = [...above].reverse().find(l => /^\$\s+/.test(l));
  if (dollar) return dollar.replace(/^\$\s+/, '');
  // Claude Code: the command between two dashed rules right above the question
  const seps = above.map((l, i) => (SEP.test(l) ? i : -1)).filter(i => i >= 0);
  let block = [];
  if (seps.length >= 2) block = above.slice(seps[seps.length - 2] + 1, seps[seps.length - 1]);
  else if (seps.length === 1) block = above.slice(seps[0] + 1);
  block = block.filter(l => !SEP.test(l) && !HEADER.test(l));
  const header = above.find(l => HEADER.test(l));
  const head = header ? header.replace(/\s{2,}.*/, '') : '';
  const exec = /Allow execution of:?\s*['"`]?([^\[\]]+?)['"`]?\?$/i.exec(question);
  const file = /(?:create|edit|write to|make this edit to|delete|overwrite)\s+(.+?)\?$/i.exec(question);
  const detail = exec?.[1] || (block.length && block.length <= 4 ? block.join(' ') : '') || file?.[1] || '';
  if (head && detail) return `${head} · ${detail}`;
  if (detail) return detail;
  if (head) {
    const i = above.indexOf(header);
    const rest = above.slice(i + 1).filter(l => !SEP.test(l)).slice(0, 2).join(' · ');
    return rest ? `${head} · ${rest}` : head;
  }
  return above.filter(l => !SEP.test(l)).slice(-2).join(' · ') || question;
}

/** A rough risk tag for the inbox. */
export function riskOf(what) {
  const s = String(what || '');
  if (/\b(rm|del|rmdir|Remove-Item|format|mkfs|dd|shutdown|reg\s+delete|git\s+push\s+.*--force|git\s+reset\s+--hard|drop\s+table)\b/i.test(s)) return { tag: 'destructive', level: 3 };
  if (/\b(curl|wget|Invoke-WebRequest|iwr|npm\s+(i|install)|pip\s+install|git\s+push|ssh|scp)\b/i.test(s)) return { tag: 'network', level: 2 };
  if (/(create|edit|write|file|>\s*\S)/i.test(s)) return { tag: 'edits a file', level: 1 };
  return { tag: 'runs a command', level: 1 };
}
