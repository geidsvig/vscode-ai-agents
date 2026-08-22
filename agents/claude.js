'use strict';
// Claude Code agent provider.
// Sessions are stored by Claude Code as JSONL files under:
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// where <encoded-cwd> is the absolute cwd with every "/" and "." replaced by "-".

const os = require('os');
const path = require('path');
const fs = require('fs');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function encodeCwd(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

function projectDir(cwd) {
  return path.join(PROJECTS_DIR, encodeCwd(cwd));
}

// All session files for a cwd, newest first: [{ id, mtimeMs }]
function listSessions(cwd) {
  const dir = projectDir(cwd);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      out.push({ id: f.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs });
    } catch (_) { /* file vanished; skip */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Newest session whose file was modified at/after `sinceMs` — used to bind
// the correct id to a freshly launched terminal, even if several Claude
// sessions share the same directory.
function newSessionSince(cwd, sinceMs) {
  const sessions = listSessions(cwd);
  for (const s of sessions) {
    if (s.mtimeMs >= sinceMs - 1000) return s.id;
  }
  return null;
}

function sessionFile(cwd, sessionId) {
  return path.join(projectDir(cwd), sessionId + '.jsonl');
}

// mtime (ms) of the session's JSONL — i.e. when Claude last wrote to it. Falls
// back to the newest session in the cwd, else null. Used for "last updated".
function lastActivity(cwd, sessionId) {
  try {
    if (sessionId) return fs.statSync(sessionFile(cwd, sessionId)).mtimeMs;
  } catch (_) { /* file gone; fall through */ }
  const list = listSessions(cwd);
  return list.length ? list[0].mtimeMs : null;
}

// "claude-opus-4-8" -> "Opus 4.8". Pulls the family (opus/sonnet/haiku/fable)
// and the short numeric segments, dropping date stamps and tags like "[1m]".
function friendlyModel(id) {
  if (!id || typeof id !== 'string') return null;
  const s = id.toLowerCase().replace(/\[[^\]]*\]/g, '');
  const fam = (s.match(/opus|sonnet|haiku|fable/) || [])[0];
  if (!fam) return null;                                  // e.g. "<synthetic>"
  const ver = (s.match(/\d+/g) || []).filter((n) => n.length <= 2).join('.');
  const Fam = fam.charAt(0).toUpperCase() + fam.slice(1);
  return ver ? `${Fam} ${ver}` : Fam;
}

// One tail-read of the session JSONL yielding the most recent model + context
// token count, cached by file mtime so large/active sessions stay cheap. Context
// tokens = the last request's prompt size (input + cache read + cache creation),
// i.e. everything currently in the window.
const TAIL_BYTES = 256 * 1024;
const infoCache = new Map(); // filePath -> { mtimeMs, model, contextTokens, status }
// Tools that block on the user and never run on their own — a pending call to one
// of these means "waiting for you", not "working" (unlike Bash/Edit/etc., which a
// pending call can't be told apart from mid-execution and so get a time-based guess).
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// Cancelling a turn (Esc) appends a user message carrying only Claude Code's
// interruption marker — "[Request interrupted by user]", or "…for tool use]"
// when a tool call was in flight. Nothing is owed in reply, so unlike an ordinary
// trailing user message it ends the turn. Some versions also tag the entry with
// interruptedMessageId; either tell is enough.
function isInterruption(o) {
  if (o.interruptedMessageId) return true;
  const c = o.message && o.message.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('')
    : '';
  return /^\s*\[Request interrupted by user/.test(text);
}

function readSessionInfo(cwd, sessionId) {
  // Prefer the record's bound session; fall back to the newest session in the cwd
  // so an unbound record still shows a model/context gauge (as lastActivity does).
  let file = null, st = null;
  if (sessionId) {
    try { const f = sessionFile(cwd, sessionId); st = fs.statSync(f); file = f; } catch (_) { /* gone */ }
  }
  if (!file) {
    const list = listSessions(cwd);
    if (list.length) { try { const f = sessionFile(cwd, list[0].id); st = fs.statSync(f); file = f; } catch (_) {} }
  }
  if (!file) return null;
  const cached = infoCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached;
  let model = null, contextTokens = null, status = 'idle';
  try {
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && (model === null || contextTokens === null); i--) {
      if (!lines[i].includes('"model"') && !lines[i].includes('"usage"')) continue;
      let m;
      try { m = JSON.parse(lines[i]).message; }            // tail may clip line 0 -> skip
      catch (_) { continue; }
      if (!m) continue;
      if (model === null && m.model) model = friendlyModel(m.model);
      if (contextTokens === null && m.usage) {
        const u = m.usage;
        const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (t > 0) contextTokens = t;
      }
    }
    // What's the agent doing? Scan the tail backwards for the last meaningful
    // event (skipping the ai-title / mode / attachment metadata lines) and map
    // it to one of four states:
    //   idle    - turn closed (a system turn_duration, or an assistant message
    //             with a terminal stop_reason) -> waiting for the next prompt
    //   waiting - last message is an unresolved call to an interactive tool
    //             (AskUserQuestion / ExitPlanMode) -> blocked on the user
    //   pending - last message is an unresolved call to any other tool -> either
    //             running or blocked on a permission prompt (ambiguous from the
    //             transcript; the extension resolves it with a staleness timer)
    //   working - last message is a user prompt / tool_result, or assistant
    //             thinking/text mid-turn -> the model owes a reply
    // A cancelled turn (Esc) is idle: the trailing user message is Claude's own
    // interruption marker, which asks for nothing (see isInterruption).
    // A trailing user message is only "working" if a real turn precedes it. After
    // /compact, Claude appends the summary as user messages right after a
    // compact_boundary with no reply owed — so a user run preceded by that
    // boundary is idle, not working. We keep scanning past trailing user messages
    // to see what comes before them (an assistant turn = real prompt -> working;
    // a compact_boundary = compaction summary -> idle). This holds across long
    // silent gaps because the last message stays put until the next write.
    let trailingUser = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln || (ln.indexOf('"role"') === -1 && ln.indexOf('turn_duration') === -1 && ln.indexOf('compact_boundary') === -1)) continue;
      let o;
      try { o = JSON.parse(ln); } catch (_) { continue; }  // clipped tail line -> skip
      if (o.type === 'system' && o.subtype === 'compact_boundary') { status = 'idle'; break; }  // trailing user run was the /compact summary
      if (o.type === 'system' && o.subtype === 'turn_duration') { status = trailingUser ? 'working' : 'idle'; break; }
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      if (o.type === 'user') {
        // A cancelled turn leaves the agent idle at the prompt. Only when it is
        // the last word, though: a real prompt after it means work resumed.
        if (!trailingUser && isInterruption(o)) { status = 'idle'; break; }
        trailingUser = true; status = 'working'; continue;   // tentative — look at what precedes it
      }
      const m = o.message || {};
      if (trailingUser) { status = 'working'; break; }   // user message(s) followed this assistant turn -> real prompt/tool_result
      const sr = m.stop_reason;
      if (sr === 'end_turn' || sr === 'stop_sequence') { status = 'idle'; break; }
      const tool = (Array.isArray(m.content) ? m.content : []).find((b) => b && b.type === 'tool_use');
      if (tool) { status = INTERACTIVE_TOOLS.has(tool.name) ? 'waiting' : 'pending'; break; }
      status = 'working';   // assistant thinking/text mid-turn
      break;
    }
  } catch (_) { /* unreadable */ }
  const info = { mtimeMs: st.mtimeMs, model, contextTokens, status };
  infoCache.set(file, info);
  return info;
}
function modelName(cwd, sessionId) { const i = readSessionInfo(cwd, sessionId); return i ? i.model : null; }
function contextTokens(cwd, sessionId) { const i = readSessionInfo(cwd, sessionId); return i ? i.contextTokens : null; }

// Best-effort context-window size. The session file never records it, so we can't
// read it per-session; instead we default to Claude's standard 200k and upgrade to
// 1M when the user's selected model carries the "[1m]" tag (Claude Code's 1M beta),
// as stored in ~/.claude/settings.json. Cached by that file's mtime.
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
let settingsCache = { mtimeMs: -1, has1m: false };
function has1mModel() {
  try {
    const st = fs.statSync(SETTINGS_FILE);
    if (st.mtimeMs !== settingsCache.mtimeMs) {
      let has1m = false;
      try { has1m = /\[1m\]/i.test(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).model || ''); } catch (_) {}
      settingsCache = { mtimeMs: st.mtimeMs, has1m };
    }
    return settingsCache.has1m;
  } catch (_) { return false; }
}
function contextWindow() { return has1mModel() ? 1000000 : 200000; }
// Activity state + file mtime, for the panel's working/waiting roll. status is one
// of working | waiting | pending | idle (see readSessionInfo); the caller times the
// ambiguous "pending" state to decide working-vs-waiting.
function activity(cwd, sessionId) {
  const i = readSessionInfo(cwd, sessionId);
  return i ? { status: i.status, mtimeMs: i.mtimeMs } : { status: 'idle', mtimeMs: 0 };
}

module.exports = {
  id: 'claude',
  label: 'Claude',
  icon: 'sparkle',
  available: true,

  // Matches the CLI process under a terminal's shell, so the extension can tell
  // a terminal whose agent is still running from one VS Code merely revived as a
  // bare shell after a restart. `claude` normally, but a wrapper can leave the
  // command name as node/npx running the CLI entry point.
  processMatch: /(^|\/)claude(\s|$)|claude[^/]*\/cli\.js/,

  launchCommand() {
    return 'claude';
  },

  resumeCommand(cwd, sessionId) {
    return sessionId ? `claude --resume ${sessionId}` : 'claude -c';
  },

  // Optional hooks used by the extension:
  listSessions,
  newSessionSince,
  sessionFile,
  lastActivity,
  activity,
  modelName,
  contextTokens,
  contextWindow,
};
