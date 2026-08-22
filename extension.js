'use strict';
// Agents Panel — track AI-agent terminal sessions and resume them after a restart.
// Scope: this only orchestrates real integrated terminals + each agent's own CLI
// plus git worktree / GitHub (gh) convenience actions. It does not reimplement
// the terminal or any agent's resume behaviour.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const gitmod = require('./git.js');

const STATE_KEY = 'agentsPanel.sessions.v1';
const PROMO_KEY = 'agentsPanel.promoted.v1'; // { [repoRoot]: branch } currently loaded into that root
const TERMS_KEY = 'agentsPanel.terminals.v1'; // names of terminals this panel created, for stale cleanup after a restart
const ORDER_KEY = 'agentsPanel.orderSeeded.v1'; // one-time flag: sessions[] now holds the user's manual order

// --- Agent provider registry -------------------------------------------------
const providers = {
  claude: require('./agents/claude.js'),
  'chatgpt-sol': { id: 'chatgpt-sol', label: 'ChatGPT (Sol)', icon: 'comment-discussion', available: false },
  copilot: { id: 'copilot', label: 'GitHub Copilot', icon: 'github', available: false },
};

// --- Module state ------------------------------------------------------------
let ctx;
let sessions = [];                 // persisted session records
const live = new Map();            // recordId -> vscode.Terminal running the agent
const ours = new Set();            // terminals created in THIS window (never candidates for revival cleanup)
const meta = new Map();            // recordId -> live git snapshot
const prCache = new Map();         // branch -> { number, state, merged, url }
const mergePrompted = new Set();   // "recordId:prNumber" already offered this load (no 60s re-nag)
const focusedAt = new Map();       // recordId -> ms the user last focused this session's terminal
const seenMtime = new Map();       // recordId -> last observed session-file mtime (ms)
const workingUntil = new Map();    // recordId -> ms; hold the "…" roll (over "???") while now < this
let lastWorkingKey = '';           // de-dupes identical working/waiting posts to the webview
let selectedId = null;             // recordId whose terminal is the active one (1:1 with the panel highlight)
let view;                          // SessionsWebview

function genId() {
  return 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
function makeNonce() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function getPromoted() { return ctx.globalState.get(PROMO_KEY, {}) || {}; }
function setPromoted(o) { ctx.globalState.update(PROMO_KEY, o); }

// A session's worktree can be removed outside the panel (git worktree remove,
// a cleanup script), which leaves the record pointing at nothing. Terminals are
// never launched into a missing cwd — VS Code would create a permanently broken
// tab that it then revives, and fails to launch, on every future restart.
function dirExists(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// Terminal names this panel has created. VS Code hands back only the name of a
// revived terminal, so this registry is how we recognise our own leftovers
// after a restart — including ones whose session record is long gone.
function getOwnedTerms() { return ctx.globalState.get(TERMS_KEY, []) || []; }
function setOwnedTerms(names) { ctx.globalState.update(TERMS_KEY, Array.from(new Set(names)).slice(-200)); }
function ownTerm(name) { setOwnedTerms(getOwnedTerms().concat(name)); }

function persist() {
  const data = sessions.map((s) => ({
    id: s.id, agentId: s.agentId, cwd: s.cwd, label: s.label,
    sessionId: s.sessionId || null, createdAt: s.createdAt,
    repoRoot: s.repoRoot || null, branch: s.branch || null,
    worktreePath: s.worktreePath || null, isWorktree: !!s.isWorktree,
    mergedHandledPr: s.mergedHandledPr || null, termName: s.termName || null,
  }));
  ctx.globalState.update(STATE_KEY, data);
  refresh();
}
function refresh() { if (view) view.post(); }
// What this session's terminal tab is called: the name it was created with,
// falling back to the label for records saved before termName existed.
const termNameOf = (rec) => rec.termName || rec.label;
function findById(idOrNode) {
  const id = typeof idOrNode === 'string' ? idOrNode : (idOrNode && idOrNode.recId);
  return sessions.find((s) => s.id === id);
}

// --- Terminal orchestration --------------------------------------------------
function spawn(rec, command, isNew) {
  if (!dirExists(rec.cwd)) { offerForgetMissing(rec); return; }
  const term = vscode.window.createTerminal({ name: rec.label, cwd: rec.cwd });
  ours.add(term);
  // A terminal keeps the name it was created with, even if the session is later
  // renamed — remember it, so a restart matches terminals to records by what the
  // tab is actually called rather than by a label two sessions can share.
  rec.termName = rec.label;
  ownTerm(rec.termName);
  live.set(rec.id, term);
  term.show(true);
  const autoRun = vscode.workspace.getConfiguration('agentsPanel').get('autoRunResume', true);
  if (command) term.sendText(command, isNew ? true : autoRun);
  persist();
  if (isNew) bindSession(rec);
}

// The session's directory is gone, so there is nothing to launch into. Offer to
// drop the record rather than minting a terminal that can never start.
async function offerForgetMissing(rec) {
  const FORGET = 'Remove from list';
  const choice = await vscode.window.showWarningMessage(
    `"${rec.label}" can't start — its working directory no longer exists.`,
    { modal: true, detail: `${rec.cwd}\n\nIt was removed outside the panel. Removing the record leaves the agent's transcript on disk.` },
    FORGET);
  if (choice !== FORGET) return;
  if (rec.worktreePath && rec.repoRoot) await gitmod.pruneWorktrees(rec.repoRoot);
  setOwnedTerms(getOwnedTerms().filter((n) => n !== termNameOf(rec)));
  forget(rec);
}
// Drop a session record and everything keyed off it. Nothing on disk is touched.
function forget(rec) {
  sessions = sessions.filter((s) => s.id !== rec.id);
  meta.delete(rec.id);
  seenMtime.delete(rec.id); workingUntil.delete(rec.id); focusedAt.delete(rec.id);
  if (selectedId === rec.id) selectedId = null;
  persist();
}
// Poll for the agent's new session file and bind its id to this record. The file
// isn't created until the first message lands, so binding succeeds only once the
// session is under way — it can't gate the initial prompt (see primePlanningPrompt).
function bindSession(rec) {
  const p = providers[rec.agentId];
  if (!p || typeof p.newSessionSince !== 'function') return;
  const since = Date.now();
  let tries = 0;
  const iv = setInterval(() => {
    tries += 1;
    const id = p.newSessionSince(rec.cwd, since);
    if (id && id !== rec.sessionId) { rec.sessionId = id; persist(); clearInterval(iv); }
    else if (tries >= 30) clearInterval(iv);
  }, 1000);
}
const isActive = (rec) => live.has(rec.id);
// A session's current branch: the live one (which follows in-terminal checkouts)
// falling back to whatever was persisted. Detached worktrees have none until the
// agent creates one during planning.
function currentBranch(rec) {
  return (meta.get(rec.id) || {}).branch || rec.branch || null;
}

// Keep the panel's "selected" highlight in lockstep with VS Code's active
// terminal, so the highlighted session is always the one whose terminal is
// showing (null when the active terminal isn't a tracked agent session).
function syncSelected(term) {
  let id = null;
  if (term) for (const [rid, t] of live) { if (t === term) { id = rid; break; } }
  if (id) focusedAt.set(id, Date.now());   // keep polling this session's activity for a while after focus
  if (id !== selectedId) { selectedId = id; refresh(); }
}

// --- Background refresh ------------------------------------------------------
async function refreshGit() {
  for (const rec of sessions) {
    if (!dirExists(rec.cwd)) { meta.set(rec.id, { missing: true, isRepo: false }); continue; }
    const i = await gitmod.info(rec.cwd);
    const m = {
      isRepo: i.isRepo,
      branch: i.isRepo ? (i.branch || rec.branch || null) : null,
      detached: !!i.detached,
      dirty: !!i.dirty,
      isWorktree: !!i.isWorktree,
      root: i.root || rec.repoRoot || null,
    };
    if (i.isRepo) m.hasRemote = await gitmod.hasRemote(rec.cwd);
    meta.set(rec.id, m);
  }
  const promo = getPromoted();
  let changed = false;
  for (const root of Object.keys(promo)) {
    if (!(await gitmod.isPromotedAt(root, promo[root]))) { delete promo[root]; changed = true; }
  }
  if (changed) setPromoted(promo);
  refresh();
}
async function refreshPR() {
  for (const rec of sessions) {
    const m = meta.get(rec.id);
    const branch = currentBranch(rec);
    if (!branch || !m || !m.hasRemote) continue;
    const pr = await gitmod.prView(rec.cwd, branch);
    if (pr) prCache.set(branch, pr); else prCache.delete(branch);
    if (pr && pr.merged) maybePromptMerged(rec, pr);
  }
  refresh();
}

// --- Activity roll ------------------------------------------------------------
// Each live session shows one of three rolls: an animated "…" while the agent is
// working, a static "???" while it's blocked on the user (a question, a plan to
// approve, a permission prompt), or a static ":>" when it's done and idle at the
// prompt (free for a new command). Only live sessions get a roll. We post a tiny
// id-set message rather than a full state refresh, so cards aren't rebuilt
// mid-animation (which would reset the CSS roll).
const WORK_GRACE_MS = 2500;    // let the "…" roll trail this long before flipping to "???" / ":>" (smooths transitions)
const PENDING_WAIT_MS = 5000;  // a tool pending (no progress) this long is treated as a permission prompt -> waiting

// Classify a live session's roll from the provider's activity state. The
// ambiguous 'pending' state (a tool call that could be running or blocked on a
// permission prompt) is resolved by how long it has sat without progress. Does
// NOT apply the work-trailing grace — that's pollActivity's job, so a one-off
// full render doesn't linger.
// Returns 'work' | 'ask' | 'ready' | null:
//   work  → "…"  the agent is actively working
//   ask   → "???" blocked on the user (a question, a plan, or a permission
//           prompt) — a response is required before it can continue
//   ready → ":>" done and idle at the prompt — free for any new command
function rollKind(rec) {
  if (!live.has(rec.id)) return null;                    // only live sessions roll
  const p = providers[rec.agentId];
  if (!p) return null;
  const now = Date.now();
  if (typeof p.activity === 'function') {
    const a = p.activity(rec.cwd, rec.sessionId);
    if (a.status === 'working') return 'work';
    if (a.status === 'waiting') return 'ask';            // blocked: question / plan approval
    if (a.status === 'pending') return (now - a.mtimeMs > PENDING_WAIT_MS) ? 'ask' : 'work';  // permission prompt once stale
    return 'ready';                                       // idle: turn done, awaiting a new command
  }
  if (typeof p.lastActivity === 'function') {            // fallback: mtime-delta guess (can't detect "blocked")
    const t = p.lastActivity(rec.cwd, rec.sessionId);
    if (t) { const prev = seenMtime.get(rec.id); seenMtime.set(rec.id, t); return prev !== undefined && t > prev ? 'work' : 'ready'; }
  }
  return 'ready';
}

function pollActivity() {
  const now = Date.now();
  const working = [], asking = [], ready = [];
  for (const rec of sessions) {
    if (!live.has(rec.id)) continue;
    let kind = rollKind(rec);
    if (kind === 'work') workingUntil.set(rec.id, now + WORK_GRACE_MS);
    else if ((workingUntil.get(rec.id) || 0) > now) kind = 'work';   // let the roll trail briefly
    if (kind === 'work') working.push(rec.id);
    else if (kind === 'ask') asking.push(rec.id);
    else if (kind === 'ready') ready.push(rec.id);
  }
  const key = 'w' + working.join(',') + '|a' + asking.join(',') + '|r' + ready.join(',');
  if (key !== lastWorkingKey) { lastWorkingKey = key; if (view) view.postActivity(working, asking, ready); }
}

// --- View model --------------------------------------------------------------
function computeCards() {
  const promo = getPromoted();
  const cards = sessions.map((rec) => {
    const p = providers[rec.agentId] || {};
    const m = meta.get(rec.id) || {};
    const active = live.has(rec.id);
    // The worktree can be deleted outside the panel; the record then has nothing
    // to run in, so say so on the card instead of failing at launch time.
    const missing = !dirExists(rec.cwd);
    const repoRoot = rec.repoRoot || m.root || null;
    const branch = m.branch || rec.branch || '';   // '' for a detached (new) worktree — no branch yet
    const promoted = repoRoot ? promo[repoRoot] : null;
    let isMain = false;
    if (promoted) isMain = !!branch && branch === promoted;
    else if (m.isRepo && !m.isWorktree) isMain = true;
    const pr = branch ? prCache.get(branch) : null;
    const merged = !!(pr && pr.merged);

    // status text shown inline on the branch row (line 2). An open PR is not
    // shown here — it renders as a right-aligned colored badge (see prBadge).
    let status = { kind: 'none', text: '' };
    if (missing) status = { kind: 'missing', text: 'folder missing' };
    else if (merged) status = { kind: 'merged', text: 'merged' };
    else if (pr) status = { kind: 'pr', text: '' };
    else if (isMain && m.isWorktree) status = { kind: 'main', text: 'main' };
    else if (isMain) status = { kind: 'main', text: '' };            // root already reads "main" as its branch
    else if (m.isWorktree) status = { kind: 'worktree', text: 'worktree' };

    // Checkout type drives the row-2 icon, independent of PR/merged state:
    // green git-branch = repo's main checkout, white tree = a worktree.
    const checkout = m.isRepo ? (m.isWorktree ? 'worktree' : 'main') : null;

    // "Last updated" = mtime of the agent's session file, else record time.
    let updated = rec.createdAt || 0;
    if (typeof p.lastActivity === 'function') {
      const t = p.lastActivity(rec.cwd, rec.sessionId);
      if (t) updated = t;
    }

    // Agent label + resolved model, e.g. "Claude Opus 4.8" (falls back to plain
    // "Claude" until the session has an assistant message to read the model from).
    const agentLabel = p.label || rec.agentId;
    let model = null;
    if (typeof p.modelName === 'function') model = p.modelName(rec.cwd, rec.sessionId) || null;

    // Context-window usage bar. The session file never records the window size, so
    // we take the provider's best guess (200k, or 1M when the user's selected model
    // carries the [1m] tag) and let the setting override it. The used>window bump is
    // a floor so we never render >100% if the guess is low.
    let context = null;
    if (typeof p.contextTokens === 'function') {
      const used = p.contextTokens(rec.cwd, rec.sessionId);
      if (used) {
        const cfg = vscode.workspace.getConfiguration('agentsPanel').get('contextWindowTokens', 0);
        let window = cfg && cfg > 0 ? cfg : (typeof p.contextWindow === 'function' ? p.contextWindow(rec.cwd, rec.sessionId) : 200000);
        if (!(cfg && cfg > 0) && used > window) window = 1000000;
        context = { pct: Math.min(100, Math.round((used / window) * 100)), used, window };
      }
    }

    return {
      id: rec.id,
      project: path.basename(repoRoot || rec.cwd),
      agentId: rec.agentId,
      agentLabel,
      model,
      sessionId: rec.sessionId || null,
      sessionShort: rec.sessionId ? rec.sessionId.slice(0, 8) : null,
      branch: branch || '',
      dirty: !!m.dirty,
      status,
      prBadge: pr && !merged ? { number: pr.number, review: pr.review || 'open' } : null,
      merged,
      checkout,
      context,
      active,
      roll: rollKind(rec),   // 'work' | 'ask' | 'ready' | null — initial roll state (postActivity keeps it fresh)
      missing,
      selected: rec.id === selectedId,
      updated,
      description: rec.label,
      canReveal: !!rec.sessionId,
      canReturn: !!(m.isWorktree && promoted && branch === promoted),
    };
  });
  // No sorting here: sessions[] IS the order the user arranged by dragging.
  // Activity only refreshes each card's "updated" label, it never moves the card.
  return cards;
}
function computeFolders() {
  const out = [];
  const seen = new Set();
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (seen.has(f.uri.fsPath)) continue;
    seen.add(f.uri.fsPath);
    out.push({ path: f.uri.fsPath, label: f.name });
  }
  for (const r of sessions) {
    const b = r.repoRoot || r.cwd;
    if (!b || seen.has(b)) continue;
    seen.add(b);
    out.push({ path: b, label: path.basename(b) });
  }
  return out;
}
function computeState() {
  return {
    cards: computeCards(),
    agents: Object.values(providers).map((p) => ({ id: p.id, label: p.label, available: !!p.available })),
    folders: computeFolders(),
  };
}

// --- Manual ordering ---------------------------------------------------------
// The panel list is ordered by hand (long-press + drag), so sessions[] is the
// order of record. The webview sends the full id list it just arranged; ids we
// don't recognise are dropped.
function reorderSessions(ids) {
  if (!Array.isArray(ids)) return;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const next = [];
  for (const id of ids) {
    const rec = byId.get(id);
    if (rec && !next.includes(rec)) next.push(rec);
  }
  // A record the webview didn't list (created while the drag was in flight) is
  // put back at its own index rather than shoved to the end.
  sessions.forEach((rec, i) => { if (!next.includes(rec)) next.splice(Math.min(i, next.length), 0, rec); });
  if (next.every((rec, i) => rec === sessions[i])) return;     // no-op drop
  sessions = next;
  persist();
}

// One-time migration off the old "most recently updated first" auto-sort: freeze
// today's visible order into sessions[] so the list doesn't reshuffle on upgrade.
function seedManualOrder() {
  if (ctx.globalState.get(ORDER_KEY, false)) return;
  const stamp = (rec) => {
    const p = providers[rec.agentId] || {};
    const t = typeof p.lastActivity === 'function' ? p.lastActivity(rec.cwd, rec.sessionId) : 0;
    return t || rec.createdAt || 0;
  };
  const at = new Map(sessions.map((rec) => [rec.id, stamp(rec)]));
  sessions.sort((a, b) => (at.get(b.id) || 0) - (at.get(a.id) || 0));
  ctx.globalState.update(ORDER_KEY, true);
  persist();
}

// --- Session creation --------------------------------------------------------
async function createSession(agentId, dir, desc) {
  const provider = providers[agentId];
  if (!provider || !provider.available) { vscode.window.showErrorMessage('Unknown or unavailable agent.'); return; }
  if (!dir) { vscode.window.showErrorMessage('No directory selected.'); return; }

  let cwd = dir, repoRoot = null, worktreePath = null, isWorktree = false;
  if (await gitmod.isRepo(dir)) {
    const root = (await gitmod.mainRoot(dir)) || dir;
    const startN = sessions.filter((s) => s.repoRoot === root).length + 1;   // <repo>-session-<N>
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating session worktree…' },
      () => gitmod.addWorktree(root, startN));
    if (!res.ok) { vscode.window.showErrorMessage('Worktree failed: ' + res.error); return; }
    // Detached — no branch yet; the agent creates one during planning.
    cwd = res.wtPath; repoRoot = root; worktreePath = res.wtPath; isWorktree = true;
  }

  const label = desc && desc.trim() ? desc.trim() : `${provider.label} · ${path.basename(cwd)}`;
  const rec = {
    id: genId(), agentId, cwd, label, sessionId: null, createdAt: Date.now(),
    repoRoot, branch: null, worktreePath, isWorktree,
  };
  sessions.unshift(rec);   // new work goes to the top of the manually-ordered list
  persist();
  spawn(rec, provider.launchCommand(cwd), true);
  // For a fresh worktree, prime the agent to plan a branch before any edits.
  if (isWorktree) primePlanningPrompt(rec, path.basename(repoRoot));
  refreshGit();
}

// Prime a brand-new detached worktree session so the agent leads with branch
// planning before any edits. The session .jsonl is created lazily on the first
// message, so we can't wait for it to know the CLI is ready — send on a
// launch-relative timer, then confirm a session file appeared (proof the prompt
// landed) and re-send once if the TUI wasn't ready in time.
function primePlanningPrompt(rec, project) {
  const p = providers[rec.agentId];
  const delay = vscode.workspace.getConfiguration('agentsPanel').get('planPromptDelayMs', 2500);
  const since = Date.now();
  setTimeout(() => {
    injectNewSessionPlan(rec, project);
    if (!p || typeof p.newSessionSince !== 'function') return;
    setTimeout(() => {
      // No session file yet => the TUI was mid-boot and swallowed our Enter (the
      // typed prompt is still sitting in the input box). Re-press Enter to submit
      // it — do NOT retype, or the prompt lands doubled. And if the first send in
      // fact went through (Claude just slow to create the file), a bare Enter on
      // the now-empty input is a harmless no-op.
      if (live.has(rec.id) && !p.newSessionSince(rec.cwd, since)) injectNewSessionPlan(rec, project, true);
    }, 5000);
  }, delay);
}
// Submit the planning prompt as the session's first turn. `submitOnly` re-presses
// Enter without retyping — used by the resend path so a swallowed submit can't
// double the prompt text.
function injectNewSessionPlan(rec, project, submitOnly) {
  const term = live.get(rec.id);
  if (!term) return;
  const prompt =
    `[Agents Panel] Work is starting on "${project}". This is a fresh detached worktree with no branch yet. ` +
    `Discuss the task and plan with me first; once the goal is clear, create a well-named git branch for it ` +
    `(git checkout -b <name>) before making changes. What would you like to work on?`;
  term.show(false);
  try {
    if (!submitOnly) term.sendText(prompt, false);   // type the prompt without submitting
    term.sendText('', true);                          // press Enter to submit the buffered text
  } catch (_) { /* terminal gone */ }
}
function cmdNew() { if (view) view.requestForm(); }

// --- Commands: open / resume / focus -----------------------------------------
function cmdFocus(node) {
  const rec = findById(node);
  const term = rec && live.get(rec.id);
  if (term) term.show(false);
}
function cmdResume(node) {
  const rec = findById(node);
  if (!rec) return;
  if (isActive(rec)) { cmdFocus(rec.id); return; }
  const p = providers[rec.agentId];
  const command = p && p.resumeCommand ? p.resumeCommand(rec.cwd, rec.sessionId) : null;
  spawn(rec, command, false);
}
function cmdOpenOrResume(id) {
  const rec = findById(id);
  if (!rec) return;
  if (isActive(rec)) cmdFocus(id); else cmdResume(id);
}
async function cmdRename(node) {
  const rec = findById(node);
  if (!rec) return;
  const value = await vscode.window.showInputBox({ prompt: 'Rename session', value: rec.label });
  if (value == null || value.trim() === '') return;
  rec.label = value.trim();
  persist();
}
function renameTo(id, value) {
  const rec = findById(id);
  if (rec && value && value.trim()) { rec.label = value.trim(); persist(); }
}
async function cmdRevealSession(node) {
  const rec = findById(node);
  if (!rec) return;
  const p = providers[rec.agentId];
  if (!rec.sessionId || !p || typeof p.sessionFile !== 'function') {
    vscode.window.showInformationMessage('No saved session file for this entry yet.');
    return;
  }
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p.sessionFile(rec.cwd, rec.sessionId)));
}

// --- Commands: git / github --------------------------------------------------
async function cmdSetAsMain(node) {
  const rec = findById(node);
  if (!rec) return;
  const m = meta.get(rec.id) || {};
  const root = rec.repoRoot || m.root;
  const branch = rec.branch || m.branch;
  if (!root || !branch) { vscode.window.showInformationMessage('This session has no git branch to set as main.'); return; }
  if (!m.isWorktree) {
    vscode.window.showInformationMessage(
      `"${path.basename(root)}" is the repo root — it already is the checkout you manually test.`);
    return;
  }
  const res = await gitmod.promote(root, branch);
  if (!res.ok) {
    if (res.reason === 'dirty') {
      vscode.window.showWarningMessage(
        `Can't set as main: the "${path.basename(root)}" root has uncommitted changes. Commit or stash them first.`);
    } else {
      vscode.window.showErrorMessage('Set as main failed: ' + (res.error || res.reason));
    }
    return;
  }
  const promo = getPromoted();
  promo[root] = branch;
  setPromoted(promo);
  vscode.window.showInformationMessage(
    `Now testing ${branch} in ${path.basename(root)} (detached — not merged). Use "Return root to main" to restore.`);
  refreshGit();
}
async function cmdReturnToMain(node) {
  const rec = findById(node);
  if (!rec) return;
  const root = rec.repoRoot || (meta.get(rec.id) || {}).root;
  if (!root) return;
  const res = await gitmod.returnToMain(root);
  if (!res.ok) { vscode.window.showErrorMessage('Return to main failed: ' + res.error); return; }
  const promo = getPromoted();
  delete promo[root];
  setPromoted(promo);
  vscode.window.showInformationMessage(`${path.basename(root)} root is back on ${res.branch}.`);
  refreshGit();
}
async function cmdPr(node) {
  const rec = findById(node);
  if (!rec) return;
  const branch = rec.branch || (meta.get(rec.id) || {}).branch;
  if (!branch) { vscode.window.showInformationMessage('This session has no branch to open a PR for.'); return; }
  // A branch with no commits ahead of its base can't back a PR — gh would fail
  // with a cryptic "no commits between" error. Catch it here with a message the
  // user can act on (commit first), rather than pushing into that dead end.
  const base = await gitmod.defaultBranch(rec.cwd);
  const ahead = await gitmod.commitsAhead(rec.cwd, base, branch);
  if (ahead === 0) {
    const m = meta.get(rec.id) || {};
    vscode.window.showWarningMessage(m.dirty
      ? `"${branch}" has no commits yet and has uncommitted changes. Commit your work in the session terminal first, then create the PR.`
      : `"${branch}" has no commits ahead of ${base} — nothing to open a PR for yet.`);
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pushing ${branch}…` },
    async () => {
      const push = await gitmod.pushBranch(rec.cwd, branch);
      if (!push.ok) { vscode.window.showErrorMessage('Push failed: ' + push.error); return; }
      let pr = await gitmod.prView(rec.cwd, branch);
      if (!pr) {
        const created = await gitmod.prCreate(rec.cwd, branch);
        if (!created.ok) { vscode.window.showErrorMessage('PR create failed: ' + created.error); return; }
        vscode.window.showInformationMessage('PR created: ' + created.url);
        pr = await gitmod.prView(rec.cwd, branch);
      } else {
        vscode.window.showInformationMessage(`PR #${pr.number} updated (pushed).`);
      }
      if (pr) prCache.set(branch, pr);
    });
  refresh();
}

// Render fetched PR feedback as a markdown document for the agent to read.
function formatPrComments(d) {
  const quote = (s) => String(s || '').trim().split('\n').map((l) => '  > ' + l).join('\n');
  const out = [`# PR #${d.number} — review feedback`];
  if (d.title) out.push(`_${d.title}_`);
  if (d.url) out.push(d.url);
  out.push('');
  if (d.reviews && d.reviews.length) {
    out.push('## Review summaries');
    for (const r of d.reviews) {
      const who = (r.author && r.author.login) || 'reviewer';
      out.push(`- **${who}** — ${r.state || 'COMMENTED'}`);
      if (r.body && r.body.trim()) out.push(quote(r.body));
    }
    out.push('');
  }
  if (d.inline && d.inline.length) {
    out.push('## Inline code comments');
    for (const c of d.inline) {
      const loc = c.path ? `\`${c.path}\`${c.line ? ':' + c.line : ''}` : '(general)';
      out.push(`- ${loc} — ${c.user || 'reviewer'}`);
      out.push(quote(c.body));
    }
    out.push('');
  }
  if (d.comments && d.comments.length) {
    out.push('## Conversation');
    for (const c of d.comments) {
      const who = (c.author && c.author.login) || 'commenter';
      out.push(`- **${who}**`);
      out.push(quote(c.body));
    }
    out.push('');
  }
  return out.join('\n');
}

// Pre-type `text` into the agent's terminal WITHOUT running it, so the user can
// press Enter to send it to the agent or clear the line to discard. Boots/resumes
// the session first if it isn't live (the agent CLI needs a moment to be ready).
function injectPrompt(rec, text, submit) {
  const nl = !!submit;   // true = press Enter (agent acts now); false = pre-type for the user
  const term = live.get(rec.id);
  if (term) { term.show(false); term.sendText(text, nl); return; }
  cmdResume(rec.id);
  const started = live.get(rec.id);
  if (started) {
    started.show(false);
    setTimeout(() => { try { started.sendText(text, nl); } catch (_) { /* terminal gone */ } }, 2500);
  }
}

async function cmdReviewPr(node) {
  const rec = findById(node);
  if (!rec) return;
  const branch = rec.branch || (meta.get(rec.id) || {}).branch;
  if (!branch) { vscode.window.showInformationMessage('This session has no branch with a PR to review.'); return; }

  const data = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fetching PR comments for ${branch}…` },
    () => gitmod.prComments(rec.cwd, branch));
  if (!data) { vscode.window.showInformationMessage('No PR found for this branch, or `gh` is unavailable.'); return; }
  if (data.merged) { vscode.window.showInformationMessage(`PR #${data.number} is already merged — nothing to review.`); return; }
  if (data.state === 'CLOSED') { vscode.window.showInformationMessage(`PR #${data.number} is closed — nothing to review.`); return; }

  const hasFeedback =
    (data.inline && data.inline.length) ||
    (data.comments && data.comments.length) ||
    (data.reviews && data.reviews.some((r) => r.body && r.body.trim()));
  if (!hasFeedback) { vscode.window.showInformationMessage(`PR #${data.number} has no review comments yet.`); return; }

  const file = path.join(os.tmpdir(), `agents-panel-pr-${data.number}-${genId()}.md`);
  try {
    fs.writeFileSync(file, formatPrComments(data), 'utf8');
  } catch (e) {
    vscode.window.showErrorMessage('Could not write PR comments file: ' + (e && e.message ? e.message : e));
    return;
  }

  const prompt =
    `Please help me address the PR #${data.number} review feedback saved at ${file} — ` +
    `read it, then for each comment propose a fix and, once I confirm, apply it.`;
  injectPrompt(rec, prompt);
  vscode.window.showInformationMessage(
    `PR #${data.number} feedback loaded into "${rec.label}". Press Enter in the terminal to work through it, or clear the line to discard.`);
}

// --- Task lifecycle: nudge to a new task once a PR merges --------------------
// New-branch creation and context cleanup are the agent's job, done in the
// terminal thread — not menu actions. So on merge we just ask the running agent
// to raise it and let the user decide there. Fires once per PR; nothing is
// created, cleared, or closed automatically.
function injectMergedAsk(rec, pr) {
  const n = pr ? `#${pr.number}` : '';
  const ask =
    `[Agents Panel] My PR ${n} for branch "${currentBranch(rec) || '(unknown)'}" just merged, so this task is complete. ` +
    `Ask me whether to start a new task on a fresh branch/worktree, and help me decide: ` +
    `(1) whether to /clear this conversation or keep it, based on how much of our context is still ` +
    `relevant; (2) a short description and branch name for the next task; (3) any cleanup for the ` +
    `finished branch. Give your recommendation, then wait for my decision — don't close this session.`;
  injectPrompt(rec, ask, true);   // submit → the agent raises it in-thread (resumes first if needed)
}

async function maybePromptMerged(rec, pr) {
  if (rec.mergedHandledPr === pr.number) return;        // already handled for this PR
  const key = rec.id + ':' + pr.number;
  if (mergePrompted.has(key)) return;                   // already offered this load — don't re-nag
  mergePrompted.add(key);

  if (live.has(rec.id)) {                               // agent running → ask in-thread now
    injectMergedAsk(rec, pr);
    rec.mergedHandledPr = pr.number;
    persist();
    return;
  }
  // No running agent to converse with — offer to bring it back so the hand-off
  // happens in the thread. A missed/dismissed toast re-offers on the next load.
  const RESUME = 'Resume & plan next';
  const choice = await vscode.window.showInformationMessage(
    `✅ PR #${pr.number} for "${rec.label}" is merged — this task's work is done.`, RESUME, 'Not now');
  if (choice === undefined) return;
  rec.mergedHandledPr = pr.number;
  persist();
  if (choice === RESUME) injectMergedAsk(rec, pr);
}

// Menu-triggered "Review session": ask the agent (in-thread) to assess the
// session's health — merged branch, context pressure, stale description — and
// recommend next steps, without changing anything. Single-line so it submits
// cleanly into the agent's input.
function cmdReviewSession(node) {
  const rec = findById(node);
  if (!rec) return;
  const curBranch = currentBranch(rec);
  const branch = curBranch || '(none yet)';
  const pr = curBranch ? prCache.get(curBranch) : null;
  const prState = pr ? (pr.merged ? `merged (PR #${pr.number})` : `has open PR #${pr.number}`) : 'has no PR';
  const p = providers[rec.agentId] || {};
  let ctx = 'unknown';
  if (typeof p.contextTokens === 'function') {
    const used = p.contextTokens(rec.cwd, rec.sessionId);
    if (used) {
      const cfg = vscode.workspace.getConfiguration('agentsPanel').get('contextWindowTokens', 0);
      const win = cfg && cfg > 0 ? cfg : (used > 200000 ? 1000000 : 200000);
      ctx = `~${Math.round((used / win) * 100)}% of the window`;
    }
  }
  const prompt =
    `[Agents Panel] Please review this session and recommend next steps (don't change anything without my ok): ` +
    `(1) branch "${branch}" ${prState} — if this work is merged/done, recommend starting a fresh working branch/worktree for the next task; ` +
    `(2) context is at ${ctx} — advise whether to /clear or /compact based on how much is still relevant; ` +
    `(3) the session description is "${rec.label}" — is it still accurate for what we're doing now, and if not suggest a better one. ` +
    `Give your recommendations, then wait for my decision.`;
  injectPrompt(rec, prompt, true);   // submit → agent runs the review in-thread (resumes first if needed)
}

// --- Commands: remove --------------------------------------------------------
async function cmdRemove(node) {
  const rec = findById(node);
  if (!rec) return;
  const term = live.get(rec.id);
  let removeWt = false, delBranch = false;

  const wtBranch = currentBranch(rec);
  if (rec.worktreePath && rec.repoRoot && !dirExists(rec.worktreePath)) {
    // The worktree is already gone — there is nothing to confirm deleting, only
    // the record (and git's stale registry entry) to tidy up.
    const ok = await vscode.window.showWarningMessage(
      `Remove "${rec.label}" from the list?`,
      { modal: true, detail: `Its worktree (${rec.worktreePath}) no longer exists.` }, 'Remove');
    if (ok !== 'Remove') return;
    await gitmod.pruneWorktrees(rec.repoRoot);
  } else if (rec.worktreePath && rec.repoRoot) {
    const m = meta.get(rec.id) || {};
    const pr = wtBranch ? prCache.get(wtBranch) : null;
    const merged = !!(pr && pr.merged);
    const dangerLabel = 'Remove worktree' + (merged ? ' + branch (merged)' : '');
    const choice = await vscode.window.showWarningMessage(
      `Remove "${rec.label}"?` + (m.dirty ? '\n\n⚠️ This worktree has UNCOMMITTED changes that will be lost.' : ''),
      { modal: true, detail: `Worktree: ${rec.worktreePath}\nBranch: ${wtBranch || '(none)'}` },
      dangerLabel, 'Forget only');
    if (choice === undefined) return;
    if (choice === dangerLabel) { removeWt = true; delBranch = merged; }
  } else {
    const ok = await vscode.window.showWarningMessage(
      `Remove "${rec.label}" from the list?`, { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
  }

  if (term) term.dispose();
  live.delete(rec.id);

  if (removeWt) {
    const m = meta.get(rec.id) || {};
    const res = await gitmod.removeWorktree(rec.repoRoot, rec.worktreePath, m.dirty);
    if (!res.ok) vscode.window.showErrorMessage('Worktree remove failed: ' + res.error);
    else if (delBranch && wtBranch) await gitmod.deleteBranch(rec.repoRoot, wtBranch);
  }

  setOwnedTerms(getOwnedTerms().filter((n) => n !== termNameOf(rec)));
  forget(rec);
}

// --- Sessions webview --------------------------------------------------------
class SessionsWebview {
  constructor(extUri) { this.extUri = extUri; this.view = null; this.ready = false; this.pendingForm = false; }
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((m) => this.onMessage(m));
    webviewView.onDidChangeVisibility(() => { if (webviewView.visible && this.ready) this.post(); });
  }
  post() {
    if (this.view) this.view.webview.postMessage({ type: 'state', ...computeState() });
  }
  // Lightweight roll update — toggles working/asking/ready on existing cards
  // without rebuilding them (a full post() would reset the CSS animation).
  postActivity(working, asking, ready) {
    if (this.view) this.view.webview.postMessage({ type: 'activity', working, asking, ready });
  }
  requestForm() {
    vscode.commands.executeCommand('agentsPanel.sessions.focus');
    if (this.ready && this.view) this.view.webview.postMessage({ type: 'openForm' });
    else this.pendingForm = true;
  }
  getHtml(webview) {
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', f));
    const nonce = makeNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('sessions.css')}">
</head><body>
<button class="new" id="new"><span class="plus">＋</span> New Agent</button>
<div id="cards"></div>
<script nonce="${nonce}" src="${uri('sessions.js')}"></script>
</body></html>`;
  }
  async onMessage(msg) {
    const { action, id } = msg || {};
    switch (action) {
      case 'ready':
        this.ready = true;
        this.post();
        if (this.pendingForm && this.view) { this.pendingForm = false; this.view.webview.postMessage({ type: 'openForm' }); }
        break;
      case 'browse': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use this folder',
        });
        if (this.view) this.view.webview.postMessage({ type: 'browsed', path: uris && uris[0] ? uris[0].fsPath : null });
        break;
      }
      case 'create': createSession(msg.agentId, msg.cwd, msg.desc); break;
      case 'rename': renameTo(id, msg.value); break;
      case 'open': cmdOpenOrResume(id); break;
      case 'reveal': cmdRevealSession(id); break;
      case 'setMain': cmdSetAsMain(id); break;
      case 'returnMain': cmdReturnToMain(id); break;
      case 'pr': cmdPr(id); break;
      case 'reviewPr': cmdReviewPr(id); break;
      case 'reviewSession': cmdReviewSession(id); break;
      case 'remove': cmdRemove(id); break;
      case 'reorder': reorderSessions(msg.ids); break;
    }
  }
}

// --- Terminal adoption after a reload / restart -------------------------------
// A plain window reload keeps the pty host alive, so the agent survives and its
// terminal simply reconnects. A full restart does NOT: VS Code *revives* the tab
// by starting a fresh shell in the saved cwd (or failing outright, "Starting
// directory (cwd) … does not exist", when the worktree is gone). Both look the
// same through the API — same name, same object — so the only reliable tell is
// whether the agent process is still running under the terminal's shell.

// pid -> command line, plus a ppid -> [pid] index, for walking a terminal's
// process subtree. Full command lines (not just `comm`) so an agent started
// through a wrapper — `node .../cli.js` — is still recognisable. POSIX only;
// null on Windows or if `ps` fails, which callers read as "can't tell".
function processTable() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') { resolve(null); return; }
    cp.execFile('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const kids = new Map();
      const cmd = new Map();
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = +m[1], ppid = +m[2];
        cmd.set(pid, m[3]);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
      }
      resolve({ kids, cmd });
    });
  });
}
// What is running under a terminal's shell: 'agent' when the agent CLI is in the
// subtree (Claude is usually a direct child, but a wrapper or `npx` adds levels,
// so walk it), 'busy' when something unrecognised is, 'idle' when nothing is —
// which is what a revived shell, or one that failed to launch, looks like.
function subtreeState(table, rootPid, agentId) {
  const re = (providers[agentId] || {}).processMatch;
  if (!table || !rootPid) return 'idle';
  const isAgent = (pid) => re instanceof RegExp && re.test(table.cmd.get(pid) || '');
  if (isAgent(rootPid)) return 'agent';   // a shell that exec'd straight into the agent
  let busy = false;
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length && seen.size <= 5000) {
    for (const kid of table.kids.get(queue.shift()) || []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      busy = true;
      if (isAgent(kid)) return 'agent';
      queue.push(kid);
    }
  }
  return busy ? 'busy' : 'idle';
}
// terminal.processId settles when the shell comes up; a terminal that failed to
// launch can leave it pending, so don't let one hang startup.
function pidOf(term) {
  return Promise.race([
    Promise.resolve(term.processId).catch(() => undefined),
    new Promise((r) => setTimeout(() => r(undefined), 3000)),
  ]);
}

// Match surviving terminals back to their sessions, and clear out the panel's
// own dead ones. Adopting a revived-but-agentless shell used to mark the card
// active, so clicking it focused an empty shell instead of resuming — and the
// dead tabs, never disposed, were re-persisted and re-revived on every restart
// until the terminal list filled up with broken duplicates.
async function adoptTerminals(terms, fullSweep) {
  if (!terms.length) { if (fullSweep) setOwnedTerms(sessions.map(termNameOf)); return; }
  const [table, pids] = await Promise.all([processTable(), Promise.all(terms.map(pidOf))]);
  // Ours to clean up: terminals we recorded creating, plus any named after a
  // tracked session — the registry starts empty on upgrade, and the leftovers
  // that prompted it are named after the sessions they belonged to.
  const owned = new Set(getOwnedTerms().concat(sessions.map(termNameOf)));
  const stale = [], kept = [];
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (owned.has(term.name)) kept.push(term.name);
    const rec = sessions.find((s) => termNameOf(s) === term.name && !live.has(s.id) && dirExists(s.cwd));
    // No process table (Windows, or ps unavailable): keep the old name-only
    // adoption and never dispose — a wrong guess there is cheaper than closing
    // a terminal the user is using.
    if (!table) { if (rec) live.set(rec.id, term); continue; }
    // Anything still running under the shell keeps the terminal: the agent when
    // we can name the process, otherwise whatever the user left running there,
    // which is never worth closing on them.
    if (subtreeState(table, pids[i], rec ? rec.agentId : null) !== 'idle') {
      if (rec) live.set(rec.id, term);
      continue;
    }
    // Idle: a shell VS Code revived with nothing behind it, or a tab whose
    // launch failed outright. Ours to clean up; anyone else's to leave alone.
    if (owned.has(term.name)) stale.push(term);
  }
  const gone = new Set(stale.map((t) => t.name));
  for (const term of stale) { try { term.dispose(); } catch (_) { /* already gone */ } }
  if (!fullSweep) return;
  if (stale.length > 1) {
    vscode.window.showInformationMessage(
      `Agents Panel: closed ${stale.length} finished agent terminals left over from a previous session.`);
  }
  // Names that can still come back: current sessions, plus any of our terminals
  // this sweep left open. Everything else was just disposed, so stop tracking it.
  setOwnedTerms(sessions.map(termNameOf).concat(kept.filter((n) => !gone.has(n))));
}

// --- Activation --------------------------------------------------------------
function activate(context) {
  ctx = context;
  sessions = (context.globalState.get(STATE_KEY, []) || []).map((s) => ({ ...s }));
  seedManualOrder();

  view = new SessionsWebview(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentsPanel.sessions', view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of live) { if (term === t) { live.delete(id); if (selectedId === id) selectedId = null; refresh(); break; } }
    }),
    vscode.window.onDidChangeActiveTerminal((t) => syncSelected(t)),
    // Coming back to VS Code (e.g. after merging a PR in the browser) rechecks
    // git + PR state so the merged-task nudge appears promptly, not on the 60s tick.
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) { refreshGit(); refreshPR(); } }),
    vscode.commands.registerCommand('agentsPanel.new', cmdNew),
    vscode.commands.registerCommand('agentsPanel.openOrResume', cmdOpenOrResume),
    vscode.commands.registerCommand('agentsPanel.resume', cmdResume),
    vscode.commands.registerCommand('agentsPanel.focus', cmdFocus),
    vscode.commands.registerCommand('agentsPanel.rename', cmdRename),
    vscode.commands.registerCommand('agentsPanel.remove', cmdRemove),
    vscode.commands.registerCommand('agentsPanel.revealSession', cmdRevealSession),
    vscode.commands.registerCommand('agentsPanel.setAsMain', cmdSetAsMain),
    vscode.commands.registerCommand('agentsPanel.returnToMain', cmdReturnToMain),
    vscode.commands.registerCommand('agentsPanel.pr', cmdPr),
    vscode.commands.registerCommand('agentsPanel.reviewPr', cmdReviewPr),
    vscode.commands.registerCommand('agentsPanel.reviewSession', cmdReviewSession),
  );

  // Adopt the terminals whose agent is still running (a reload keeps them alive)
  // and dispose the panel's leftovers from previous runs. Clicking an adopted
  // card FOCUSES its terminal instead of re-sending the resume command — which,
  // injected into an already-running agent, would be read as a prompt (Claude
  // would receive a literal "claude --resume <id>"). Everything else falls back
  // to a real resume, which is what actually restores a session after a restart.
  adoptTerminals(vscode.window.terminals.slice(), true)
    .then(() => { syncSelected(vscode.window.activeTerminal); refresh(); });

  // Revival can also land just after the extension starts, and those terminals
  // would otherwise miss the sweep above and linger to the next restart. Judge
  // late arrivals we didn't create ourselves for a short while, giving each a
  // moment to start its shell so a genuinely new terminal isn't read as idle.
  const startedAt = Date.now();
  context.subscriptions.push(vscode.window.onDidOpenTerminal((t) => {
    if (ours.has(t) || Date.now() - startedAt > 20000) return;
    setTimeout(() => { if (!ours.has(t)) adoptTerminals([t], false).then(refresh); }, 3000);
  }));

  const gi = setInterval(() => refreshGit(), 12000);
  const pi = setInterval(() => refreshPR(), 60000);
  const ai = setInterval(() => pollActivity(), 800);   // fast tick that drives the "working" roll
  context.subscriptions.push({ dispose: () => { clearInterval(gi); clearInterval(pi); clearInterval(ai); } });
  // Populate git metadata first, THEN PR state — refreshPR reads the `meta` that
  // refreshGit fills in (hasRemote, branch). Firing them back-to-back let the
  // first PR refresh run before meta was ready, so it no-op'd and merge detection
  // (badge, merged chip, new-task nudge) was delayed to the 60s interval tick.
  refreshGit().then(() => refreshPR());
}

function deactivate() {}

module.exports = { activate, deactivate };
