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

  // 8-bit "Claw'd" mascot, drawn from a pixel grid into crisp SVG rects.
  const MASCOT_GRID = [
    '..XXXXXXXX..',
    '.XXXXXXXXXX.',
    'XXXXXXXXXXXX',
    'XXX.XXXX.XXX',
    'XXX.XXXX.XXX',
    'XXXXXXXXXXXX',
    'XXXXXXXXXXXX',
    '.XX..XX..XX.',
  ];
  const MASCOT = (function (grid, color) {
    const w = grid[0].length, h = grid.length;
    let rects = '';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (grid[y][x] === 'X') rects += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
      }
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" fill="' + color + '" shape-rendering="crispEdges">' + rects + '</svg>';
  })(MASCOT_GRID, '#D97757');

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

  function cardEl(c) {
    const kind = c.status ? c.status.kind : 'none';
    const card = el('div', 'card ' + (c.active ? 'active' : 'inactive') + ' k-' + kind + (c.selected ? ' selected' : ''));
    card.dataset.id = c.id;

    // Row 1: project · agent   [last updated]
    const l1 = el('div', 'l1');
    l1.appendChild(el('span', 'proj', c.project));
    l1.appendChild(el('span', 'sep', '·'));
    // Agent: the Claw'd mascot for Claude (else the provider label), then the model.
    if (c.agentId === 'claude') {
      const mc = el('span', 'mascot');
      mc.innerHTML = MASCOT;
      mc.title = 'Claude' + (c.model ? ' ' + c.model : '');
      l1.appendChild(mc);
    } else {
      l1.appendChild(el('span', 'agent', c.agentLabel || c.agentId));
    }
    if (c.model) l1.appendChild(el('span', 'agent', c.model));
    const up = el('span', 'updated', c.updated ? ago(c.updated) : '');
    if (c.updated) up.title = new Date(c.updated).toLocaleString();
    l1.appendChild(up);
    card.appendChild(l1);

    // Context-usage bar (under row 1). Green → yellow → red as the window fills.
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

    // Row 2: [checkout icon] branch  [merged status]  [PR badge]
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
    }
    // main/worktree are now shown as the icon; keep other status text (e.g. merged).
    if (c.status && c.status.text && kind !== 'main' && kind !== 'worktree') {
      l2.appendChild(el('span', 'status', c.status.text));
    }
    if (!c.branch && !(c.status && c.status.text) && !c.prBadge) l2.appendChild(el('span', 'branch muted', 'no branch'));
    // Right-aligned PR badge: green approved / red blocked / white otherwise.
    if (c.prBadge) {
      l2.appendChild(el('span', 'pr-badge pr-' + (c.prBadge.review || 'open'), '[PR #' + c.prBadge.number + ']'));
    }
    card.appendChild(l2);

    // Row 3: description
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
    const out = [];
    out.push({ label: c.active ? 'Focus terminal' : 'Resume session', action: 'open' });
    out.push({ sep: true });
    out.push({ label: 'Rename', do: () => openRenameForm(c) });
    if (c.canReveal) out.push({ label: 'Reveal session file', action: 'reveal' });
    if (c.canReturn) out.push({ label: 'Return root to main', action: 'returnMain' });
    else out.push({ label: 'Set as main (test in root)', action: 'setMain' });
    if (c.prBadge) out.push({ label: 'Review PR comments…', action: 'reviewPr' });
    out.push({ label: 'Create / update PR', action: 'pr' });
    if (c.merged) {
      out.push({ sep: true });
      out.push({ label: 'Start new task…', action: 'startNewTask' });
      out.push({ label: 'Plan next task with agent', action: 'planNext' });
    }
    out.push({ sep: true });
    out.push({ label: 'Remove from list', action: 'remove', danger: true });
    return out;
  }

  function openMenu(e, c) {
    closeMenu();
    const m = el('div', 'menu');
    for (const it of items(c)) {
      if (it.sep) { m.appendChild(el('div', 'sepline')); continue; }
      const mi = el('div', 'mi' + (it.danger ? ' danger' : ''), it.label);
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
