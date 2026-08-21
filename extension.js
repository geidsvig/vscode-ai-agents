'use strict';
// Agents Panel — track AI-agent terminal sessions and resume them after a restart.
// Scope: this only orchestrates real integrated terminals + each agent's own CLI
// plus git worktree / GitHub (gh) convenience actions. It does not reimplement
// the terminal or any agent's resume behaviour.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const gitmod = require('./git.js');

const STATE_KEY = 'agentsPanel.sessions.v1';
const PROMO_KEY = 'agentsPanel.promoted.v1'; // { [repoRoot]: branch } currently loaded into that root

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
const meta = new Map();            // recordId -> live git snapshot
const prCache = new Map();         // branch -> { number, state, merged, url }
const mergePrompted = new Set();   // "recordId:prNumber" already offered this load (no 60s re-nag)
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

function persist() {
  const data = sessions.map((s) => ({
    id: s.id, agentId: s.agentId, cwd: s.cwd, label: s.label,
    sessionId: s.sessionId || null, createdAt: s.createdAt,
    repoRoot: s.repoRoot || null, branch: s.branch || null,
    worktreePath: s.worktreePath || null, isWorktree: !!s.isWorktree,
    mergedHandledPr: s.mergedHandledPr || null,
  }));
  ctx.globalState.update(STATE_KEY, data);
  refresh();
}
function refresh() { if (view) view.post(); }
function findById(idOrNode) {
  const id = typeof idOrNode === 'string' ? idOrNode : (idOrNode && idOrNode.recId);
  return sessions.find((s) => s.id === id);
}

// --- Terminal orchestration --------------------------------------------------
function spawn(rec, command, isNew) {
  const term = vscode.window.createTerminal({ name: rec.label, cwd: rec.cwd });
  live.set(rec.id, term);
  term.show(true);
  const autoRun = vscode.workspace.getConfiguration('agentsPanel').get('autoRunResume', true);
  if (command) term.sendText(command, isNew ? true : autoRun);
  refresh();
  if (isNew) bindSession(rec);
}
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

// Keep the panel's "selected" highlight in lockstep with VS Code's active
// terminal, so the highlighted session is always the one whose terminal is
// showing (null when the active terminal isn't a tracked agent session).
function syncSelected(term) {
  let id = null;
  if (term) for (const [rid, t] of live) { if (t === term) { id = rid; break; } }
  if (id !== selectedId) { selectedId = id; refresh(); }
}

// --- Background refresh ------------------------------------------------------
async function refreshGit() {
  for (const rec of sessions) {
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
    if (!rec.branch || !m || !m.hasRemote) continue;
    const pr = await gitmod.prView(rec.cwd, rec.branch);
    if (pr) prCache.set(rec.branch, pr); else prCache.delete(rec.branch);
    if (pr && pr.merged) maybePromptMerged(rec, pr);
  }
  refresh();
}

// --- View model --------------------------------------------------------------
function computeCards() {
  const promo = getPromoted();
  const cards = sessions.map((rec) => {
    const p = providers[rec.agentId] || {};
    const m = meta.get(rec.id) || {};
    const active = live.has(rec.id);
    const repoRoot = rec.repoRoot || m.root || null;
    const branch = m.branch || rec.branch || (m.detached ? 'detached' : '');
    const promoted = repoRoot ? promo[repoRoot] : null;
    let isMain = false;
    if (promoted) isMain = !!branch && branch === promoted;
    else if (m.isRepo && !m.isWorktree) isMain = true;
    const pr = branch ? prCache.get(branch) : null;
    const merged = !!(pr && pr.merged);

    // status text shown inline on the branch row (line 2). An open PR is not
    // shown here — it renders as a right-aligned colored badge (see prBadge).
    let status = { kind: 'none', text: '' };
    if (merged) status = { kind: 'merged', text: 'merged' };
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
    let agent = p.label || rec.agentId;
    if (typeof p.modelName === 'function') {
      const mn = p.modelName(rec.cwd, rec.sessionId);
      if (mn) agent = `${agent} ${mn}`;
    }

    // Context-window usage bar. The session file doesn't record the window size,
    // and Claude has only two (200k / 1M), so infer: >200k used ⇒ 1M. Overridable.
    let context = null;
    if (typeof p.contextTokens === 'function') {
      const used = p.contextTokens(rec.cwd, rec.sessionId);
      if (used) {
        const cfg = vscode.workspace.getConfiguration('agentsPanel').get('contextWindowTokens', 0);
        const window = cfg && cfg > 0 ? cfg : (used > 200000 ? 1000000 : 200000);
        context = { pct: Math.min(100, Math.round((used / window) * 100)), used, window };
      }
    }

    return {
      id: rec.id,
      project: path.basename(repoRoot || rec.cwd),
      agent,
      branch: branch || '',
      dirty: !!m.dirty,
      status,
      prBadge: pr && !merged ? { number: pr.number, review: pr.review || 'open' } : null,
      merged,
      checkout,
      context,
      active,
      selected: rec.id === selectedId,
      updated,
      description: rec.label,
      canReveal: !!rec.sessionId,
      canReturn: !!(m.isWorktree && promoted && branch === promoted),
    };
  });
  cards.sort((a, b) => (b.updated || 0) - (a.updated || 0)); // most recent first
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

// --- Session creation --------------------------------------------------------
async function createSession(agentId, dir, desc) {
  const provider = providers[agentId];
  if (!provider || !provider.available) { vscode.window.showErrorMessage('Unknown or unavailable agent.'); return; }
  if (!dir) { vscode.window.showErrorMessage('No directory selected.'); return; }

  let cwd = dir, repoRoot = null, branch = null, worktreePath = null, isWorktree = false;
  if (await gitmod.isRepo(dir)) {
    const root = (await gitmod.mainRoot(dir)) || dir;
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating worktree…' },
      () => gitmod.addWorktree(root, desc || provider.label));
    if (!res.ok) { vscode.window.showErrorMessage('Worktree failed: ' + res.error); return; }
    cwd = res.wtPath; repoRoot = root; branch = res.branch; worktreePath = res.wtPath; isWorktree = true;
  }

  const label = desc && desc.trim() ? desc.trim() : `${provider.label} · ${path.basename(cwd)}`;
  const rec = {
    id: genId(), agentId, cwd, label, sessionId: null, createdAt: Date.now(),
    repoRoot, branch, worktreePath, isWorktree,
  };
  sessions.push(rec);
  persist();
  spawn(rec, provider.launchCommand(cwd), true);
  refreshGit();
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
// When a session's PR turns merged, offer to move on — once per PR, nothing
// automatic. The extension drives git; the agent (via cmdPlanNext) makes the
// judgement calls (is context stale? new description? /clear or keep?).
async function maybePromptMerged(rec, pr) {
  if (rec.mergedHandledPr === pr.number) return;        // already handled for this PR
  const key = rec.id + ':' + pr.number;
  if (mergePrompted.has(key)) return;                   // already offered this load — don't re-nag
  mergePrompted.add(key);

  // Preferred: ask inside the agent thread, where the user is and will decide.
  // A toast is easy to miss; a submitted turn puts the question in the transcript
  // and the agent raises it directly. Recorded as handled so it won't re-fire.
  if (live.has(rec.id)) {
    const n = pr ? `#${pr.number}` : '';
    const ask =
      `[Agents Panel] My PR ${n} for branch "${rec.branch}" just merged, so this task is complete. ` +
      `Ask me whether to start a new task on a fresh branch, and help me decide: ` +
      `(1) whether to /clear this conversation or keep it, based on how much of our context is still ` +
      `relevant; (2) a short description and branch name for the next task; (3) any cleanup for the ` +
      `finished branch. Give your recommendation, then wait for my decision.`;
    injectPrompt(rec, ask, true);                       // submit → agent asks in-thread
    rec.mergedHandledPr = pr.number;
    persist();
    return;
  }

  // Fallback: no running agent to ask, so notify. Missed/auto-dismissed toast
  // (choice === undefined) re-offers on the next reload instead of vanishing.
  const NEW = 'New task (new branch)';
  const PLAN = 'Plan with agent';
  const choice = await vscode.window.showInformationMessage(
    `✅ PR #${pr.number} for "${rec.label}" is merged — this task's work is done. ` +
    `Start a new task on a fresh branch?`,
    NEW, PLAN, 'Not now');
  if (choice === undefined) return;
  rec.mergedHandledPr = pr.number;
  persist();
  if (choice === NEW) cmdStartNewTask(rec.id);
  else if (choice === PLAN) cmdPlanNext(rec.id);
}

// Start a fresh task: a new worktree/branch off the repo's default branch, in the
// same repo and with the same agent. Leaves the finished session intact, then
// offers to clean up its merged worktree.
async function cmdStartNewTask(node) {
  const rec = findById(node);
  if (!rec) return;
  const root = rec.repoRoot || (meta.get(rec.id) || {}).root;
  if (!root) { vscode.window.showInformationMessage('This session is not in a git repo — no branch to start.'); return; }
  const desc = await vscode.window.showInputBox({
    prompt: 'Describe the new task (used for the new worktree/branch name)',
    placeHolder: 'e.g. add dark-mode toggle',
  });
  if (desc == null || !desc.trim()) return;
  await createSession(rec.agentId, root, desc.trim());
  const pr = rec.branch ? prCache.get(rec.branch) : null;
  if (rec.worktreePath && pr && pr.merged) {
    const CLEAN = 'Clean up old worktree';
    const pick = await vscode.window.showInformationMessage(
      `New task started. Remove the finished worktree "${rec.label}" (branch ${rec.branch}, merged)?`,
      CLEAN, 'Keep it');
    if (pick === CLEAN) cmdRemove(rec.id);
  }
}

// Keep this session/chat, but ask the running agent to plan the hand-off: whether
// to /clear stale context, a suggested description + branch name, and cleanup for
// the finished branch. Pre-typed so the user submits or discards — for people who
// live in one long chat and refresh with /clear rather than a new session.
function cmdPlanNext(node) {
  const rec = findById(node);
  if (!rec) return;
  const pr = rec.branch ? prCache.get(rec.branch) : null;
  const n = pr ? `#${pr.number}` : '';
  const prompt =
    `My PR ${n} for branch "${rec.branch}" just merged, so this task is complete. ` +
    `Help me transition to the next task without dragging along stale context: ` +
    `(1) tell me whether to /clear this conversation or keep it, based on how much of our ` +
    `current context is still relevant and how long we've been going; ` +
    `(2) suggest a short description and branch name for the next task; ` +
    `(3) note any cleanup for the finished branch (e.g. removing the merged worktree). ` +
    `Recommend, but let me decide.`;
  injectPrompt(rec, prompt);
  vscode.window.showInformationMessage(
    `Transition prompt loaded into "${rec.label}". Press Enter to ask the agent, or clear the line to discard.`);
}

// --- Commands: remove --------------------------------------------------------
async function cmdRemove(node) {
  const rec = findById(node);
  if (!rec) return;
  const term = live.get(rec.id);
  let removeWt = false, delBranch = false;

  if (rec.worktreePath && rec.repoRoot) {
    const m = meta.get(rec.id) || {};
    const pr = rec.branch ? prCache.get(rec.branch) : null;
    const merged = !!(pr && pr.merged);
    const dangerLabel = 'Remove worktree' + (merged ? ' + branch (merged)' : '');
    const choice = await vscode.window.showWarningMessage(
      `Remove "${rec.label}"?` + (m.dirty ? '\n\n⚠️ This worktree has UNCOMMITTED changes that will be lost.' : ''),
      { modal: true, detail: `Worktree: ${rec.worktreePath}\nBranch: ${rec.branch}` },
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
    else if (delBranch && rec.branch) await gitmod.deleteBranch(rec.repoRoot, rec.branch);
  }

  sessions = sessions.filter((s) => s.id !== rec.id);
  meta.delete(rec.id);
  persist();
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
      case 'startNewTask': cmdStartNewTask(id); break;
      case 'planNext': cmdPlanNext(id); break;
      case 'remove': cmdRemove(id); break;
    }
  }
}

// --- Activation --------------------------------------------------------------
function activate(context) {
  ctx = context;
  sessions = (context.globalState.get(STATE_KEY, []) || []).map((s) => ({ ...s }));

  view = new SessionsWebview(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentsPanel.sessions', view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of live) { if (term === t) { live.delete(id); if (selectedId === id) selectedId = null; refresh(); break; } }
    }),
    vscode.window.onDidChangeActiveTerminal((t) => syncSelected(t)),
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
    vscode.commands.registerCommand('agentsPanel.startNewTask', cmdStartNewTask),
    vscode.commands.registerCommand('agentsPanel.planNext', cmdPlanNext),
  );

  // On reload VSCode reconnects still-running terminals (persistent sessions keep
  // the agent process alive), so adopt them as live, matched to their session.
  // Clicking the card then FOCUSES the terminal instead of re-sending the agent's
  // resume command — which, injected into an already-running agent, would be read
  // as a prompt (e.g. Claude would receive a literal "claude --resume <id>").
  for (const term of vscode.window.terminals) {
    const rec = sessions.find((s) => s.label === term.name && !live.has(s.id));
    if (rec) live.set(rec.id, term);
  }
  syncSelected(vscode.window.activeTerminal);

  const gi = setInterval(() => refreshGit(), 12000);
  const pi = setInterval(() => refreshPR(), 60000);
  context.subscriptions.push({ dispose: () => { clearInterval(gi); clearInterval(pi); } });
  // Populate git metadata first, THEN PR state — refreshPR reads the `meta` that
  // refreshGit fills in (hasRemote, branch). Firing them back-to-back let the
  // first PR refresh run before meta was ready, so it no-op'd and merge detection
  // (badge, merged chip, new-task nudge) was delayed to the 60s interval tick.
  refreshGit().then(() => refreshPR());
}

function deactivate() {}

module.exports = { activate, deactivate };
