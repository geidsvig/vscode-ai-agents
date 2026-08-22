'use strict';
// Terminal restore after a reload / restart. Runs without VS Code: the API is
// stubbed, and the process states the extension has to tell apart are made with
// real processes, since that is exactly what it inspects.
//
//   node test/restore.test.js

const Module = require('module');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.join(__dirname, '..');
const disposed = [], created = [];
let panel = null, onMsg = null, lastState = null, openTerminal = null, warned = null;

const noop = () => ({ dispose() {} });
const vscodeStub = {
  window: {
    terminals: [],
    activeTerminal: undefined,
    createTerminal: (o) => { created.push(o); return mkTerm(o.name, process.pid); },
    registerWebviewViewProvider: (_id, provider) => { panel = provider; return { dispose() {} }; },
    onDidCloseTerminal: noop, onDidChangeActiveTerminal: noop, onDidChangeWindowState: noop,
    onDidOpenTerminal: (h) => { openTerminal = h; return { dispose() {} }; },
    showInformationMessage: () => Promise.resolve(undefined),
    // Always take the last (affirmative) button so the confirm paths run through.
    showWarningMessage: (m, ...rest) => { warned = m; return Promise.resolve(rest[rest.length - 1]); },
    showErrorMessage: () => Promise.resolve(undefined),
    withProgress: (_o, f) => f(),
  },
  commands: { registerCommand: noop, executeCommand: () => Promise.resolve() },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), workspaceFolders: [] },
  Uri: { joinPath: (...a) => ({ fsPath: a.join('/') }), file: (p) => ({ fsPath: p }) },
  ProgressLocation: { Notification: 15 },
};
const load = Module._load;
Module._load = function (req) { return req === 'vscode' ? vscodeStub : load.apply(this, arguments); };

const ext = require(path.join(EXT, 'extension.js'));

function mkTerm(name, pid) {
  return { name, processId: Promise.resolve(pid), show() {}, sendText() {}, dispose() { disposed.push(name); } };
}
// Reads back what the panel renders, through the same webview messages it posts.
const fakeView = {
  visible: true,
  onDidChangeVisibility: noop,
  webview: {
    options: {}, html: '', cspSource: 'x',
    asWebviewUri: (u) => u,
    onDidReceiveMessage: (h) => { onMsg = h; return { dispose() {} }; },
    postMessage: (m) => { if (m.type === 'state') lastState = m; return Promise.resolve(true); },
  },
};

let failures = 0;
function check(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}` + (ok ? '' : `\n       got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cards = () => lastState.cards;
const card = (desc) => cards().find((c) => c.description === desc);

const spawned = [];
function bg(cmd, args) { const p = cp.spawn(cmd, args, { detached: true, stdio: 'ignore' }); spawned.push(p); return p.pid; }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-panel-test-'));
  // A shell with the agent CLI under it — a terminal that survived a reload.
  // Named `claude` on disk so the real process-table match is what gets tested.
  const fakeCli = path.join(tmp, 'claude');
  fs.symlinkSync('/bin/sleep', fakeCli);
  // The launcher keeps "claude" out of the shell's own command line, so finding
  // the agent really does mean walking into the shell's children.
  const launcher = path.join(tmp, 'launch.sh');
  fs.writeFileSync(launcher, `"${fakeCli}" 30\n`);
  const agentShell = bg('/bin/sh', [launcher]);                   // agent as a child of the shell
  const agentExec = bg('/bin/sh', ['-c', `exec "${fakeCli}" 30`]); // shell exec'd into the agent
  // Shells with nothing under them — what a restart revives sessions into.
  const idleShell = bg('/bin/sleep', ['30']);
  const orphanShell = bg('/bin/sleep', ['30']);
  // A shell running something that isn't the agent: the user's own work.
  const busyShell = bg('/bin/sh', ['-c', 'sleep 30; :']);
  await sleep(500);

  const store = new Map();
  store.set('agentsPanel.sessions.v1', [
    { id: 'r1', agentId: 'claude', cwd: EXT, label: 'agent-live', termName: 'agent-live', createdAt: 1 },
    { id: 'r2', agentId: 'claude', cwd: EXT, label: 'revived', termName: 'revived', createdAt: 1 },
    { id: 'r3', agentId: 'claude', cwd: EXT, label: 'busy-shell', termName: 'busy-shell', createdAt: 1 },
    { id: 'r4', agentId: 'claude', cwd: path.join(tmp, 'gone'), label: 'gone-dir', termName: 'gone-dir', createdAt: 1 },
    { id: 'r5', agentId: 'claude', cwd: EXT, label: 'agent-exec', termName: 'agent-exec', createdAt: 1 },
  ]);
  // "orphan" was the panel's terminal before its session was removed; "user-term"
  // never was. The session terminals are deliberately absent from the registry,
  // which is what an upgrade (or a first run) looks like — being named after a
  // tracked session has to be enough to claim them.
  store.set('agentsPanel.terminals.v1', ['orphan']);
  const ctx = {
    extensionUri: { fsPath: EXT },
    subscriptions: [],
    globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: (k, v) => store.set(k, v) },
  };

  vscodeStub.window.terminals = [
    mkTerm('agent-live', agentShell),
    mkTerm('agent-exec', agentExec),
    mkTerm('revived', idleShell),
    mkTerm('busy-shell', busyShell),
    mkTerm('gone-dir', undefined),        // failed to launch: cwd is gone, so no shell process
    mkTerm('orphan', orphanShell),
    mkTerm('user-term', orphanShell),     // not the panel's -> never touched
  ];

  ext.activate(ctx);
  panel.resolveWebviewView(fakeView);
  await onMsg({ action: 'ready' });
  await sleep(1500);
  await onMsg({ action: 'ready' });

  check(cards().filter((c) => c.active).map((c) => c.description).sort(), ['agent-exec', 'agent-live', 'busy-shell'],
    'adopts terminals whose agent (or other work) is still running');
  check(disposed.slice().sort(), ['gone-dir', 'orphan', 'revived'],
    'disposes revived, failed and orphaned terminals of its own');
  check(disposed.includes('user-term'), false, 'leaves terminals it did not create alone');
  check(card('revived').active, false, 'a revived shell reads as inactive, so opening it resumes the agent');
  check([card('gone-dir').missing, card('gone-dir').status.text], [true, 'folder missing'],
    'flags a session whose directory is gone');

  // A terminal revived a moment after startup gets the same treatment.
  const lateShell = bg('/bin/sleep', ['30']);
  await sleep(300);
  const lateTerm = mkTerm('revived', lateShell);
  vscodeStub.window.terminals = [lateTerm];
  openTerminal(lateTerm);
  await sleep(4000);
  check(disposed.filter((n) => n === 'revived').length, 2, 'sweeps terminals revived just after activation');

  // Opening a session whose directory is gone must not mint another broken
  // terminal — it offers to drop the record instead (the stub accepts).
  await onMsg({ action: 'open', id: 'r4' });
  await sleep(300);
  await onMsg({ action: 'ready' });
  check(created.length, 0, 'never launches a terminal into a missing directory');
  check(/no longer exists/.test(warned || ''), true, 'says why the session cannot start');
  check(cards().some((c) => c.description === 'gone-dir'), false, 'removes the record once confirmed');

  // detached: true put each helper in its own group, so take the group with it.
  for (const p of spawned) {
    try { process.kill(-p.pid); } catch (_) { /* group already gone */ }
    try { process.kill(p.pid); } catch (_) { /* already exited */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
