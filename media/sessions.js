/* Agents Panel — sessions webview: two-line cards, right-click menu, popup forms. */
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('cards');
  let menuEl = null;
  let overlayEl = null;
  let agents = [];
  let folders = [];
  let dirSelectRef = null; // active New-form directory <select>, for Browse round-trip

  document.getElementById('new').addEventListener('click', openNewForm);

  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'state') { agents = d.agents || []; folders = d.folders || []; render(d.cards || []); }
    else if (d.type === 'activity') { applyActivity(d.working || [], d.asking || [], d.ready || []); }
    else if (d.type === 'openForm') { openNewForm(); }
    else if (d.type === 'browsed') { onBrowsed(d.path); }
  });

  document.addEventListener('click', closeMenu);
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('.card')) closeMenu(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); closeOverlay(); } });
  window.addEventListener('blur', closeMenu);

  vscode.postMessage({ action: 'ready' });

  // Checkout-type glyphs (theme-aware via currentColor). Main = git-branch;
  // worktree = a small tree. Rendered inline so CSS can recolor them.
  const ICON_MAIN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/>' +
    '<path d="M6 8.5v1.5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V8.5"/><path d="M12 13v2.5"/></svg>';
  const ICON_WORKTREE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 21V8.5"/><path d="M12 14l-5-3.5"/><path d="M12 16l5-3.5"/>' +
    '<circle cx="12" cy="6" r="2.3"/><circle cx="5.5" cy="9.5" r="2"/><circle cx="18.5" cy="11.5" r="2"/></svg>';

  // Context-menu glyphs — outline codicon-style, recolored via currentColor so they
  // inherit the menu foreground (and the danger red on "Remove"). 16x16 viewBox.
  const svg = (body) =>
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  const MENU_ICON = {
    review:   svg('<path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.9"/>'),
    rename:   svg('<path d="M10.6 2.4l3 3"/><path d="M9.7 3.3 3 10v3h3l6.7-6.7-3-3Z"/>'),
    file:     svg('<path d="M4 1.8h5l3 3v8.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"/><path d="M9 1.8v3.2h3"/>'),
    star:     svg('<path d="M8 1.9l1.85 3.75 4.15.6-3 2.93.71 4.13L8 11.38 4.29 13.34 5 9.18l-3-2.93 4.15-.6L8 1.9Z"/>'),
    comment:  svg('<path d="M2 3.3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6.2L3.4 13v-2.7H3a1 1 0 0 1-1-1Z"/>'),
    pr:       svg('<circle cx="4.5" cy="4" r="1.7"/><circle cx="4.5" cy="12" r="1.7"/><circle cx="11.5" cy="12" r="1.7"/><path d="M4.5 5.7v4.6"/><path d="M11.5 10.3V7a2 2 0 0 0-2-2H7.6"/><path d="M9 3.3 7.4 5 9 6.7"/>'),
    trash:    svg('<path d="M3 4.4h10"/><path d="M6.4 4.4V3.1a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.3"/><path d="M4.7 4.4l.5 8a1 1 0 0 0 1 .95h3.6a1 1 0 0 0 1-.95l.5-8"/><path d="M6.8 6.8v4M9.2 6.8v4"/>'),
  };

  // 8-bit "Claw'd" mascot, drawn from a pixel grid into crisp SVG rects.
  const MASCOT_GRID = [   // traced from icons8 "Claw'd" (16x10 sprite grid)
    '..XXXXXXXXXXXX..',
    '..XXXXXXXXXXXX..',
    '..XX.XXXXXX.XX..',   // eyes (2 tall)
    '..XX.XXXXXX.XX..',
    '..XXXXXXXXXXXX..',
    'XXXXXXXXXXXXXXXX',   // arms out both sides
    'XXXXXXXXXXXXXXXX',
    '..XXXXXXXXXXXX..',
    '...X.X....X.X...',   // four legs
    '...X.X....X.X...',
  ];
  const MASCOT = (function (grid) {
    const w = grid[0].length, h = grid.length;
    let rects = '';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (grid[y][x] === 'X') rects += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
      }
    }
    // fill=currentColor so the coral follows --ap-agent (.lag .mascot) per theme.
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" fill="currentColor" shape-rendering="crispEdges">' + rects + '</svg>';
  })(MASCOT_GRID);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // --- cards ---
  function render(cards) {
    closeMenu();
    root.innerHTML = '';
    if (!cards.length) {
      root.appendChild(el('div', 'empty', 'No agent sessions yet. Use “＋ New Agent” above to create one.'));
      return;
    }
    for (const c of cards) root.appendChild(cardEl(c));
  }

  // Toggle the working "…" / asking "???" / ready ":>" roll on already-rendered
  // cards without rebuilding them (rebuilding would restart the CSS animation).
  function applyActivity(workIds, askIds, readyIds) {
    const w = new Set(workIds), a = new Set(askIds), r = new Set(readyIds);
    for (const node of root.querySelectorAll('.card')) {
      const id = node.dataset.id;
      const working = w.has(id), asking = a.has(id), ready = r.has(id);
      node.classList.toggle('working', working);
      node.classList.toggle('asking', asking);
      node.classList.toggle('ready', ready);
      const work = node.querySelector('.lag .work');
      if (work) work.title = rollTitle(asking ? 'ask' : ready ? 'ready' : 'work');
    }
  }
  function rollTitle(kind) {
    return kind === 'ask' ? 'Waiting for your input to continue'
      : kind === 'ready' ? 'Done — ready for a new command'
      : 'Agent is working…';
  }

  function cardEl(c) {
    const kind = c.status ? c.status.kind : 'none';
    const card = el('div', 'card ' + (c.active ? 'active' : 'inactive') + (c.selected ? ' selected' : '') +
      (c.roll === 'work' ? ' working' : c.roll === 'ask' ? ' asking' : c.roll === 'ready' ? ' ready' : ''));
    card.dataset.id = c.id;

    // Row 1: project ............................. [last updated]
    const l1 = el('div', 'l1');
    l1.appendChild(el('span', 'proj', c.project));
    const up = el('span', 'updated', c.updated ? ago(c.updated) : '');
    if (c.updated) up.title = new Date(c.updated).toLocaleString();
    l1.appendChild(up);
    card.appendChild(l1);

    // Context-usage bar. Green → yellow → red as the window fills.
    if (c.context) {
      const ctx = el('div', 'ctx');
      const track = el('div', 'ctx-track');
      const fill = el('div', 'ctx-fill' + (c.context.pct >= 90 ? ' hot' : c.context.pct >= 70 ? ' warm' : ''));
      fill.style.width = c.context.pct + '%';
      track.appendChild(fill);
      ctx.appendChild(track);
      ctx.appendChild(el('span', 'ctx-pct', c.context.pct + '%'));
      ctx.title = 'Context ~' + c.context.pct + '% · ' + fmtTokens(c.context.used) + ' / ' + fmtTokens(c.context.window) + ' tokens';
      card.appendChild(ctx);
    }

    // Branch row: [checkout icon] branch .......... [merged] [PR badge]
    const l2 = el('div', 'l2');
    if (c.checkout) {
      const ic = el('span', 'ctype ctype-' + c.checkout);
      ic.innerHTML = c.checkout === 'main' ? ICON_MAIN : ICON_WORKTREE;
      ic.title = c.checkout === 'main' ? "On the repo's main checkout" : 'Running in a git worktree';
      l2.appendChild(ic);
    }
    if (c.branch) {
      const b = el('span', 'branch');
      b.appendChild(el('span', null, c.branch));
      if (c.dirty) b.appendChild(el('span', 'dirty', ' *'));
      l2.appendChild(b);
    } else {
      l2.appendChild(el('span', 'branch muted', 'no branch yet'));
    }
    if (c.status && c.status.text && kind !== 'main' && kind !== 'worktree') {
      l2.appendChild(el('span', 'status', c.status.text));
    }
    if (c.prBadge) {
      l2.appendChild(el('span', 'pr-badge pr-' + (c.prBadge.review || 'open'), '[PR #' + c.prBadge.number + ']'));
    }
    card.appendChild(l2);

    // Agent row: [mascot / provider] model  <session-id>
    const lag = el('div', 'lag');
    if (c.agentId === 'claude') {
      const mc = el('span', 'mascot');
      mc.innerHTML = MASCOT;
      mc.title = 'Claude' + (c.model ? ' ' + c.model : '');
      lag.appendChild(mc);
    } else {
      lag.appendChild(el('span', 'agent', c.agentLabel || c.agentId));
    }
    if (c.model) lag.appendChild(el('span', 'agent model', c.model));
    // Activity glyph: "…" working, "???" blocked on you, ":>" done/idle. Always in
    // the DOM; CSS reveals it via the .working / .asking / .ready class, so toggling
    // those (via the light 'activity' message) never rebuilds the card.
    const work = el('span', 'work');
    work.title = rollTitle(c.roll);
    lag.appendChild(work);
    if (c.sessionShort) {
      const sid = el('span', 'sid', c.sessionShort);
      sid.title = 'Session id: ' + (c.sessionId || c.sessionShort);
      lag.appendChild(sid);
    }
    card.appendChild(lag);

    // Description row
    card.appendChild(el('div', 'l3', c.description || ''));

    card.addEventListener('click', () => vscode.postMessage({ action: 'open', id: c.id }));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e, c); });
    return card;
  }

  // Compact token count: 265868 -> "266k", 1000000 -> "1M".
  function fmtTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return '' + n;
  }

  // Relative "last updated" label; full datetime shown on hover (title).
  function ago(ms) {
    const diff = Date.now() - ms;
    if (diff < 45 * 1000) return 'just now';
    const m = Math.floor(diff / 60000);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d < 7) return d + 'd ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // --- context menu ---
  function items(c) {
    // Left-clicking the card already focuses/resumes the session, so the menu
    // omits that action and leads with the things a click can't do.
    const out = [];
    out.push({ label: 'Review session', action: 'reviewSession', icon: MENU_ICON.review });
    out.push({ label: 'Rename', do: () => openRenameForm(c), icon: MENU_ICON.rename });
    if (c.canReveal) out.push({ label: 'Reveal session file', action: 'reveal', icon: MENU_ICON.file });
    if (c.canReturn) out.push({ label: 'Return root to main', action: 'returnMain', icon: MENU_ICON.star });
    else out.push({ label: 'Set as main (test in root)', action: 'setMain', icon: MENU_ICON.star });
    if (c.prBadge) out.push({ label: 'Review PR comments…', action: 'reviewPr', icon: MENU_ICON.comment });
    out.push({ label: 'Create / update PR', action: 'pr', icon: MENU_ICON.pr });
    out.push({ sep: true });
    out.push({ label: 'Remove from list', action: 'remove', danger: true, icon: MENU_ICON.trash });
    return out;
  }

  function openMenu(e, c) {
    closeMenu();
    const m = el('div', 'menu');
    for (const it of items(c)) {
      if (it.sep) { m.appendChild(el('div', 'sepline')); continue; }
      const mi = el('div', 'mi' + (it.danger ? ' danger' : ''));
      const ic = el('span', 'mi-ic');
      if (it.icon) ic.innerHTML = it.icon;
      mi.appendChild(ic);
      mi.appendChild(el('span', 'mi-label', it.label));
      mi.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeMenu();
        if (it.do) it.do();
        else vscode.postMessage({ action: it.action, id: c.id });
      });
      m.appendChild(mi);
    }
    document.body.appendChild(m);
    const pad = 4, w = m.offsetWidth, h = m.offsetHeight;
    let x = e.clientX, y = e.clientY;
    if (x + w + pad > window.innerWidth) x = window.innerWidth - w - pad;
    if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
    m.style.left = Math.max(pad, x) + 'px';
    m.style.top = Math.max(pad, y) + 'px';
    menuEl = m;
  }
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

  // --- modal ---
  function showModal(title, contentNode, submitLabel, onSubmit) {
    closeOverlay();
    const overlay = el('div', 'overlay');
    const modal = el('div', 'modal');
    modal.appendChild(el('h3', null, title));
    modal.appendChild(contentNode);
    const btns = el('div', 'btns');
    const cancel = el('button', 'secondary', 'Cancel');
    const submit = el('button', 'primary', submitLabel);
    cancel.addEventListener('click', closeOverlay);
    submit.addEventListener('click', () => { if (onSubmit() !== false) closeOverlay(); });
    btns.appendChild(cancel); btns.appendChild(submit);
    modal.appendChild(btns);
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
    document.body.appendChild(overlay);
    overlayEl = overlay;
    return { modal, submit };
  }
  function closeOverlay() { if (overlayEl) { overlayEl.remove(); overlayEl = null; dirSelectRef = null; } }

  function field(labelText, control) {
    const f = el('div', 'field');
    f.appendChild(el('label', null, labelText));
    f.appendChild(control);
    return f;
  }

  function openNewForm() {
    closeMenu();
    const body = el('div');

    const agentSel = document.createElement('select');
    for (const a of agents) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.label + (a.available ? '' : ' (coming soon)');
      o.disabled = !a.available;
      agentSel.appendChild(o);
    }
    // default to first available
    const firstAvail = agents.find((a) => a.available);
    if (firstAvail) agentSel.value = firstAvail.id;

    const dirSel = document.createElement('select');
    rebuildDirOptions(dirSel, null);
    dirSel.addEventListener('change', () => {
      if (dirSel.value === '__browse') { vscode.postMessage({ action: 'browse' }); dirSel.value = dirSel.dataset.last || ''; }
      else dirSel.dataset.last = dirSel.value;
    });
    dirSelectRef = dirSel;

    const desc = document.createElement('input');
    desc.type = 'text';
    desc.placeholder = 'e.g. fix login redirect';

    body.appendChild(field('AI agent', agentSel));
    body.appendChild(field('Project directory', dirSel));
    body.appendChild(field('Short description (used for the worktree/branch name)', desc));

    showModal('New Agent', body, 'Create', () => {
      const agentId = agentSel.value;
      const cwd = dirSel.value && dirSel.value !== '__browse' ? dirSel.value : '';
      const d = desc.value.trim();
      if (!agentId) { agentSel.focus(); return false; }
      if (!cwd) { dirSel.focus(); return false; }
      if (!d) { desc.focus(); return false; }
      vscode.postMessage({ action: 'create', agentId, cwd, desc: d });
    });
    setTimeout(() => desc.focus(), 30);
  }

  function rebuildDirOptions(sel, selected) {
    sel.innerHTML = '';
    for (const f of folders) {
      const o = document.createElement('option');
      o.value = f.path; o.textContent = f.label + '  —  ' + f.path;
      sel.appendChild(o);
    }
    const br = document.createElement('option');
    br.value = '__browse'; br.textContent = 'Browse…';
    sel.appendChild(br);
    if (selected) sel.value = selected;
    else if (folders[0]) sel.value = folders[0].path;
    sel.dataset.last = sel.value;
  }

  function onBrowsed(p) {
    if (!p || !dirSelectRef) return;
    if (!folders.some((f) => f.path === p)) {
      folders.push({ path: p, label: p.split('/').pop() || p });
    }
    rebuildDirOptions(dirSelectRef, p);
  }

  function openRenameForm(c) {
    const input = document.createElement('input');
    input.type = 'text'; input.value = c.description || '';
    const body = el('div');
    body.appendChild(field('Session name', input));
    showModal('Rename session', body, 'Save', () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return false; }
      vscode.postMessage({ action: 'rename', id: c.id, value: v });
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }
})();
