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
const infoCache = new Map(); // sessionId -> { mtimeMs, model, contextTokens }
function readSessionInfo(cwd, sessionId) {
  if (!sessionId) return null;
  let file, st;
  try { file = sessionFile(cwd, sessionId); st = fs.statSync(file); }
  catch (_) { return null; }
  const cached = infoCache.get(sessionId);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached;
  let model = null, contextTokens = null;
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
  } catch (_) { /* unreadable */ }
  const info = { mtimeMs: st.mtimeMs, model, contextTokens };
  infoCache.set(sessionId, info);
  return info;
}
function modelName(cwd, sessionId) { const i = readSessionInfo(cwd, sessionId); return i ? i.model : null; }
function contextTokens(cwd, sessionId) { const i = readSessionInfo(cwd, sessionId); return i ? i.contextTokens : null; }

module.exports = {
  id: 'claude',
  label: 'Claude',
  icon: 'sparkle',
  available: true,

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
  modelName,
  contextTokens,
};
