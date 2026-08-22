'use strict';
// Thin async wrappers around the `git` and `gh` CLIs. Every call resolves
// (never rejects) to { code, stdout, stderr } so callers branch on code.

const cp = require('child_process');
const path = require('path');

function run(cmd, args, cwd, opts) {
  const o = opts || {};
  // Network calls run with no terminal, so a credential prompt would hang the
  // panel forever. Make git fail fast instead, and cap it with a timeout.
  const env = o.noPrompt
    ? { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' }
    : process.env;
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { cwd, env, timeout: o.timeout || 0, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        timedOut: !!(err && err.killed),
      });
    });
  });
}
const git = (args, cwd, opts) => run('git', args, cwd, opts);
const gh = (args, cwd) => run('gh', args, cwd);

async function isRepo(cwd) {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.code === 0 && r.stdout === 'true';
}

// The main working directory of the repo (first entry of `git worktree list`).
async function mainRoot(cwd) {
  const r = await git(['worktree', 'list', '--porcelain'], cwd);
  if (r.code !== 0) return null;
  const m = r.stdout.match(/^worktree (.+)$/m);
  return m ? m[1] : null;
}

async function hasRemote(cwd) {
  const r = await git(['remote'], cwd);
  return r.code === 0 && r.stdout.length > 0;
}

async function defaultBranch(cwd) {
  let r = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (r.code === 0 && r.stdout) return r.stdout.replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    r = await git(['show-ref', '--verify', '--quiet', `refs/heads/${b}`], cwd);
    if (r.code === 0) return b;
  }
  return 'main';
}

// Live snapshot used to render a session row.
async function info(cwd) {
  if (!(await isRepo(cwd))) return { isRepo: false };
  const [branchR, headR, dirtyR, root] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['rev-parse', 'HEAD'], cwd),
    git(['status', '--porcelain'], cwd),
    mainRoot(cwd),
  ]);
  const branch = branchR.stdout;
  const detached = branch === 'HEAD';
  const isWorktree = !!root && path.resolve(root) !== path.resolve(cwd);
  return {
    isRepo: true,
    root,
    branch: detached ? null : branch,
    detached,
    head: headR.stdout,
    dirty: dirtyR.stdout.length > 0,
    isWorktree,
  };
}

async function branchExists(root, branch) {
  const r = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root);
  return r.code === 0;
}

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';

// Bring the default branch up to date with the remote before anything is cut
// from it, so a new session doesn't start life behind origin. Best-effort: a
// missing remote, no network, or a dirty/diverged local branch all degrade to
// "use what we have" rather than blocking session creation.
// Returns { ok, base, ref, behind, local, error } where `ref` is what callers
// should branch from and `local` says what happened to the local branch:
//   'updated' | 'current' | 'dirty' | 'diverged' | 'checked-out' | 'no-remote'
const FETCH_TIMEOUT_MS = 20000;
async function syncDefaultBranch(root) {
  const base = await defaultBranch(root);
  if (!(await hasRemote(root))) return { ok: true, base, ref: base, behind: 0, local: 'no-remote' };

  const f = await git(['fetch', '--quiet', 'origin', base], root, { timeout: FETCH_TIMEOUT_MS, noPrompt: true });
  if (f.code !== 0) {
    const error = f.timedOut ? `fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s` : (f.stderr || 'git fetch failed');
    return { ok: false, base, ref: base, behind: 0, local: 'no-remote', error };
  }
  // origin may not carry this branch at all (never pushed) — nothing to sync to.
  const ref = `origin/${base}`;
  const has = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root);
  if (has.code !== 0) return { ok: true, base, ref: base, behind: 0, local: 'no-remote' };

  const behind = (await commitsAhead(root, base, ref)) || 0;
  return { ok: true, base, ref, behind, local: await fastForwardLocal(root, base, ref, behind) };
}

// Move the local default branch up to the remote tip. Two cases: it's checked
// out in the repo root (fast-forward the working tree), or it isn't (update the
// ref directly via a self-refspec fetch, which needs no checkout).
async function fastForwardLocal(root, base, ref, behind) {
  if (behind === 0) return 'current';
  const cur = await info(root);
  if (cur.isRepo && !cur.detached && cur.branch === base) {
    if (cur.dirty) return 'dirty';                       // never touch a dirty working tree
    const m = await git(['merge', '--ff-only', ref], root);
    return m.code === 0 ? 'updated' : 'diverged';
  }
  // Fails if `base` is checked out in some other worktree; harmless either way,
  // since the new worktree is cut from `ref`, not from the local branch.
  const r = await git(['fetch', 'origin', `${base}:${base}`], root, { timeout: FETCH_TIMEOUT_MS, noPrompt: true });
  return r.code === 0 ? 'updated' : 'checked-out';
}

// Create <root>/.agents/<repo>-session-<N> as a DETACHED worktree at `baseRef`
// (default: the local default branch — callers should pass the remote-tracking
// ref from syncDefaultBranch so the session starts from an up-to-date base).
// Detached because a worktree can't share `main` with the root, and the branch
// is chosen later (in conversation). N starts at `startN` and bumps past any
// existing dir. Returns { ok, wtPath, name, error }.
async function addWorktree(root, startN, baseRef) {
  const base = baseRef || (await defaultBranch(root));
  const repo = path.basename(root);
  const fs = require('fs');
  let n = Math.max(1, startN || 1);
  for (let tries = 0; tries < 100; tries += 1, n += 1) {
    const name = `${repo}-session-${n}`;
    const wtPath = path.join(root, '.agents', name);
    if (fs.existsSync(wtPath)) continue;
    const r = await git(['worktree', 'add', '--detach', wtPath, base], root);
    if (r.code === 0) return { ok: true, wtPath, name };
    return { ok: false, error: r.stderr || 'git worktree add failed' };
  }
  return { ok: false, error: 'could not find a free session slot' };
}

// Load a branch into the repo root for manual testing, without merging.
// Refuses if the root has uncommitted changes.
async function promote(root, branch) {
  const rootInfo = await info(root);
  if (rootInfo.dirty) return { ok: false, reason: 'dirty' };
  const r = await git(['checkout', '--detach', branch], root);
  return r.code === 0 ? { ok: true } : { ok: false, reason: 'git', error: r.stderr };
}

async function returnToMain(root) {
  const b = await defaultBranch(root);
  const r = await git(['checkout', b], root);
  return r.code === 0 ? { ok: true, branch: b } : { ok: false, error: r.stderr };
}

// Is `root` currently detached at the tip of `branch`?
async function isPromotedAt(root, branch) {
  const [rootInfo, tip] = await Promise.all([info(root), git(['rev-parse', branch], root)]);
  return rootInfo.detached && tip.code === 0 && tip.stdout === rootInfo.head;
}

async function removeWorktree(root, wtPath, force) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(wtPath);
  const r = await git(args, root);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr };
}

// Clear git's registry of worktrees whose directory has been deleted. Used when
// removing a session whose worktree is already gone — `worktree remove` refuses
// on a missing path, leaving a stale admin entry behind.
async function pruneWorktrees(root) {
  const r = await git(['worktree', 'prune'], root);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr };
}

async function deleteBranch(root, branch) {
  const r = await git(['branch', '-D', branch], root);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr };
}

async function pushBranch(cwd, branch) {
  const r = await git(['push', '-u', 'origin', branch], cwd);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr };
}

// Number of commits on `branch` not yet on `base`. 0 means there's nothing to
// open a PR for (gh would otherwise fail with a cryptic "no commits between…").
// null if the count couldn't be computed (e.g. unknown base ref).
async function commitsAhead(cwd, base, branch) {
  const r = await git(['rev-list', '--count', `${base}..${branch}`], cwd);
  if (r.code !== 0) return null;
  const n = parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : null;
}

// Returns { number, state, url, merged, review } or null if no PR / gh
// unavailable. `review` is 'approved' | 'blocked' | 'open', derived from
// GitHub's aggregate reviewDecision (CHANGES_REQUESTED = blocking comments).
async function prView(cwd, branch) {
  const r = await gh(['pr', 'view', branch, '--json', 'number,state,url,mergedAt,reviewDecision'], cwd);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const review =
      j.reviewDecision === 'APPROVED' ? 'approved'
      : j.reviewDecision === 'CHANGES_REQUESTED' ? 'blocked'
      : 'open';
    return {
      number: j.number, state: j.state, url: j.url,
      merged: !!j.mergedAt || j.state === 'MERGED', review,
    };
  } catch (_) {
    return null;
  }
}

async function prCreate(cwd, branch) {
  const base = await defaultBranch(cwd);
  const r = await gh(['pr', 'create', '--fill', '--base', base, '--head', branch], cwd);
  return r.code === 0 ? { ok: true, url: r.stdout } : { ok: false, error: r.stderr };
}

// Full review feedback for a PR: review summaries (approve/request-changes with
// their body), top-level conversation comments, and inline code-line comments.
// Returns { number, title, url, state, merged, reviews[], comments[], inline[] }
// or null if no PR / gh unavailable.
async function prComments(cwd, branch) {
  const r = await gh(['pr', 'view', branch, '--json', 'number,title,url,state,mergedAt,reviews,comments'], cwd);
  if (r.code !== 0) return null;
  let data;
  try { data = JSON.parse(r.stdout); } catch (_) { return null; }

  // Inline (code-line) review comments come from the REST API — gh fills in the
  // {owner}/{repo} placeholders from the repo at `cwd`. jq emits one JSON object
  // per line (NDJSON).
  const inline = [];
  const api = await gh(
    ['api', '--paginate', `repos/{owner}/{repo}/pulls/${data.number}/comments`,
      '-q', '.[] | {path, line, body, user: .user.login}'],
    cwd);
  if (api.code === 0 && api.stdout) {
    for (const line of api.stdout.split('\n')) {
      if (!line.trim()) continue;
      try { inline.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
    }
  }

  return {
    number: data.number, title: data.title || '', url: data.url || '',
    state: data.state || '', merged: !!data.mergedAt || data.state === 'MERGED',
    reviews: (data.reviews || []).filter((rv) => (rv.body && rv.body.trim()) || rv.state === 'CHANGES_REQUESTED'),
    comments: data.comments || [],
    inline,
  };
}

module.exports = {
  isRepo, info, mainRoot, hasRemote, defaultBranch, slugify,
  syncDefaultBranch, addWorktree, promote, returnToMain, isPromotedAt, removeWorktree, pruneWorktrees, deleteBranch,
  pushBranch, commitsAhead, prView, prCreate, prComments,
};
