# Agents Panel

A small VSCode convenience extension that adds an **Agents** view to the Activity
Bar (the icon strip on the side, alongside Explorer, Search, Source Control…) for
tracking AI-agent terminal sessions — so you can re-open and **resume** them after
a VSCode restart or crash.

It is a *tracker*, not a terminal replacement. Each session is a normal
integrated terminal running the agent's own CLI. The panel only remembers the
links (agent + directory + session id) needed to bring a session back.

## Features

- **Agents panel** listing your agent sessions as **active** (a live terminal
  exists — click to focus) or **inactive** (click to resume).
- **New Agent** flow: pick an agent, pick a project directory → a terminal opens
  in that directory, launches the agent, and is tracked automatically.
- **Lazy restore:** after a restart, sessions reappear as *inactive*. Nothing is
  launched until you click one — light on resources, no surprise token spend. A
  session only counts as *active* while its agent process is genuinely running,
  so a terminal VSCode revived as an empty shell doesn't masquerade as a live
  session; those leftovers are closed on startup instead of piling up in the
  terminal list. Terminals with anything else still running in them are left
  alone.
- **Missing directories:** if a session's worktree is deleted outside the panel,
  the card says *folder missing* and opening it offers to drop the record —
  rather than launching a terminal that can only fail ("Starting directory (cwd)
  … does not exist").
- **Exact resume:** for Claude it binds the on-disk session id, so resuming
  returns to the right conversation even with several sessions in one directory.
- **Manual ordering:** the list stays where you put it — activity only refreshes
  a card's "updated" time, it never re-sorts. Long-press a card and drag it to a
  new slot (a rule shows where it will land); drop it off the list to cancel.
  New sessions appear at the top.
- Sessions are saved automatically (no manual save). State lives in VSCode
  `globalState`, per machine.

## Supported agents

- **Claude** (`claude` CLI) — full support (launch + `--resume`).
- **ChatGPT (Sol)**, **GitHub Copilot** — placeholders; add a provider to enable.

### Adding an agent

Drop a module in `agents/<id>.js` exporting:

```js
module.exports = {
  id: 'my-agent', label: 'My Agent', icon: 'sparkle', available: true,
  launchCommand(cwd) { return 'my-agent'; },
  resumeCommand(cwd, sessionId) { return `my-agent --resume ${sessionId}`; },
  // optional: matched against the command lines under a terminal's shell to tell
  // a still-running session from a shell VSCode revived after a restart.
  processMatch: /(^|\/)my-agent(\s|$)/,
  // optional, for exact resume binding + reveal:
  // listSessions(cwd), newSessionSince(cwd, sinceMs), sessionFile(cwd, sessionId),
};
```

Then register it in the `providers` map in `extension.js`.

## Install (no build step)

This is plain JavaScript against the built-in `vscode` API — nothing to compile.

```bash
git clone https://github.com/geidsvig/vscode-ai-agents ~/projects/vscode-ai-agents
ln -s ~/projects/vscode-ai-agents ~/.vscode/extensions/agents-panel
```

Restart VSCode. The **Agents** icon appears in the Activity Bar; click it to open
the **Sessions** view.

To package a `.vsix` instead: `npx @vscode/vsce package` then
`code --install-extension agents-panel-*.vsix`.

## Tests

```bash
npm test    # no dependencies, no VSCode needed
```

- `test/restore.test.js` — restart/reload restore: which terminals are adopted,
  which leftovers are closed, and how a session whose directory vanished behaves.
- `test/activity.test.js` — how a session's transcript maps to the card's roll
  (working / waiting / idle), including cancelled turns.

## Settings

- `agentsPanel.autoRunResume` (default `true`) — execute the resume command on
  click. Set `false` to pre-type it and press Enter yourself.

## Limitations

- A crash kills the terminal process; no extension can revive a live process.
  "Resume" relaunches the agent and uses the agent's own resume — for Claude
  that reloads the conversation, which is the point.
- Tracked sessions are per-machine (they reference that machine's local agent
  files) and do not sync across computers.
- Telling a live session from a revived shell reads the process table via `ps`,
  so it is macOS/Linux only. On Windows the panel falls back to matching
  terminals by name and never closes one.

## License

MIT
