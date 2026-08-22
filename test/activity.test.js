'use strict';
// What the panel's roll shows for a session: the provider classifies the tail of
// Claude's transcript as working ("…"), waiting ("???"), pending, or idle (":>").
//
//   node test/activity.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

// The provider resolves transcripts under ~/.claude/projects at load time, so
// point HOME at a scratch dir before requiring it — no real sessions are touched.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-panel-home-'));
os.homedir = () => home;
const claude = require('../agents/claude.js');

const cwd = '/tmp/agents-panel-fake-project';
const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });

let n = 0;
// Writes the lines as a session transcript and returns how the panel reads it.
function statusOf(lines) {
  const id = `session-${++n}`;
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return claude.activity(cwd, id).status;
}

const user = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const assistantText = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const assistantDone = (text) => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const assistantTool = (name) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, id: 't1', input: {} }] } });
const CANCEL = '[Request interrupted by user]';
const CANCEL_TOOL = '[Request interrupted by user for tool use]';

let failures = 0;
function check(lines, expected, what) {
  const got = statusOf(lines);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}` + (ok ? '' : `\n       got "${got}", want "${expected}"`));
}

const turn = [user('do the thing'), assistantText('on it')];

check([...turn, assistantDone('done')], 'idle', 'a finished turn is idle');
check([...turn], 'working', 'mid-turn assistant text is working');
check([user('go')], 'working', 'a fresh prompt is working');
check([...turn, assistantTool('Bash')], 'pending', 'an in-flight tool call is pending');
check([...turn, assistantTool('AskUserQuestion')], 'waiting', 'an interactive tool call waits on the user');

// The fix: cancelling with Esc appends an interruption marker as a user message.
// Read as an ordinary trailing prompt it looked like work the agent still owed.
check([...turn, user(CANCEL)], 'idle', 'cancelling mid-reply goes back to idle');
check([...turn, assistantTool('Bash'), user(CANCEL_TOOL)], 'idle', 'cancelling a tool call goes back to idle');
check([...turn, { ...user(CANCEL), interruptedMessageId: 'msg_01' }], 'idle', 'cancel tagged with interruptedMessageId');
check([...turn, { type: 'user', message: { role: 'user', content: CANCEL } }], 'idle', 'cancel with plain-string content');
check([...turn, user(CANCEL), user('try again, differently')], 'working', 'a prompt after a cancel resumes work');
check([...turn, user(CANCEL), assistantText('sure')], 'working', 'the agent replying after a cancel is working');

// Guard the neighbouring case: /compact appends its summary as user messages
// with nothing owed in reply, which must stay idle too.
check([...turn, assistantDone('done'), { type: 'system', subtype: 'compact_boundary' }, user('summary of the conversation…')],
  'idle', 'a /compact summary is idle, not a new prompt');

fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
