// Endpoints lens: everything the app answers and everything it calls, in one list. Three kinds, each
// marked the same way everywhere: web addresses (HTTP routes, with their method), MCP tools (what AI
// agents can do through the app's MCP servers, grouped by server) and calls out to outside services
// (by address). Picking one shows it on the map. Data: graph.routes and graph.outbound (build.mjs).
(() => {
  const SC = window.Floorplan;
  if (!SC) return;
  const G = SC.graph;
  const routes = (G.routes || []).map((r, i) => ({ r, i }));
  const outbound = G.outbound || [];
  if (!routes.length && !outbound.length) return;
  const { h } = SC;

  const style = document.createElement('style');
  style.textContent = `
#ep-menu { position: fixed; width: 380px; max-height: min(72vh, 620px); overflow: auto; transform-origin: top right; overscroll-behavior: contain; }
#ep-menu .ep-f { position: sticky; top: -6px; margin: -6px -6px 4px; padding: 10px 10px 6px; background: var(--menu-solid); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); z-index: 1; border-radius: 18px 18px 0 0; }
#ep-menu .ep-f input { width: 100%; height: 34px; border: 0; border-radius: 12px; padding: 0 12px; background: rgba(var(--ink), .06); color: var(--text); outline: none; transition: background .2s var(--ease), box-shadow .2s var(--ease); }
#ep-menu .ep-f input:focus { background: rgba(var(--ink), .08); box-shadow: 0 0 0 1px rgba(var(--ink), .14); }
#ep-menu .ep-k { padding: 12px 12px 2px; font-size: 12px; font-weight: 600; color: var(--text-2); display: flex; align-items: baseline; gap: 6px; }
#ep-menu .ep-k span { font-weight: 400; color: var(--text-3); }
#ep-menu .ep-k p { margin: 0; }
#ep-menu .ep-why { padding: 0 12px 4px; font-size: 11.5px; color: var(--text-3); line-height: 1.4; }
#ep-menu .ep-g { padding: 8px 12px 2px; font-size: 11.5px; color: var(--text-3); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ep-menu .ep-r { display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: left; border: 0; background: none; color: var(--text); padding: 8px 12px; border-radius: 12px; cursor: pointer; transition: background .15s var(--ease); }
#ep-menu .ep-r:hover, #ep-menu .ep-r.on { background: rgba(var(--ink), .07); }
#ep-menu .ep-r:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
#ep-menu .ep-r .method { margin-top: 1px; }
#ep-menu .ep-host { flex: none; width: 8px; height: 8px; margin: 6px 2px 0; border-radius: 999px; background: var(--k-http); }
#ep-menu .ep-t { min-width: 0; flex: 1; }
#ep-menu .ep-t b { font-weight: 500; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ep-menu .ep-t span { font-family: var(--mono); font-size: 11.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
#ep-menu .ep-none { padding: 14px 12px; color: var(--text-3); font-size: 12.5px; }
@media (prefers-reduced-motion: reduce) { #ep-menu .ep-r, #ep-menu .ep-f input { transition: none; } }
`;
  document.head.appendChild(style);

  // ---------- data ----------
  const fileName = (p) => SC.files.get(p)?.name || p.split('/').pop();
  const groupBy = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
  const web = routes.filter((x) => x.r.m !== 'TOOL');
  const tools = routes.filter((x) => x.r.m === 'TOOL');
  const KINDS = [
    { id: 'web', title: 'Web addresses', list: web, why: 'Requests the app’s servers answer, by address.', by: (x) => x.r.f },
    { id: 'mcp', title: 'MCP tools', list: tools, why: 'What AI agents can do in the app, through each server’s /mcp address.', by: (x) => x.r.f },
    { id: 'out', title: 'Calls to outside services', list: outbound, why: 'Addresses outside the app that its code calls.', by: null },
  ].filter((k) => k.list.length);

  const routeRow = ({ r, i }) => `<button class="ep-r" data-ep="r:${i}"><span class="method" style="--m:var(--m-${r.m in { GET: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1, CALL: 1, TOOL: 1 } ? r.m : 'ANY'})">${h(r.m)}</span><span class="ep-t"><b>${h(r.name)}</b><span>${h(r.m === 'TOOL' ? r.p.replace(/^\/mcp\//, '') : r.p)}</span></span></button>`;
  const hostRow = (o) => `<button class="ep-r" data-ep="${h(o.node ? 'n:' + o.node : 'f:' + o.files[0])}"><span class="ep-host"></span><span class="ep-t"><b>${h(o.host)}</b><span>${h(o.files.length === 1 ? fileName(o.files[0]) : SC.plural(o.files.length, 'file'))}</span></span></button>`;

  function show(id) {
    closeMenu();
    if (!SC.exists(id)) return SC.toast?.('That one isn’t on the map.');
    SC.reveal(id);
  }

  // ---------- header menu ----------
  const menu = document.createElement('div');
  menu.id = 'ep-menu';
  menu.className = 'menu glass';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Endpoints');
  document.body.appendChild(menu);
  let btn = null;
  const total = routes.length + outbound.length;

  function renderList(q = '') {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (text) => !words.length || words.every((w) => text.toLowerCase().includes(w));
    let html = '', shown = 0;
    for (const k of KINDS) {
      let body = '', n = 0;
      if (k.by) {
        for (const [file, list] of groupBy(k.list, k.by)) {
          const rows = list.filter(({ r }) => hit(`${r.m} ${r.p} ${r.name} ${r.d} ${file}`));
          if (!rows.length) continue;
          body += `<div class="ep-g" title="${h(file)}">${h(fileName(file))} · ${h(file)}</div>` + rows.map(routeRow).join('');
          n += rows.length;
        }
      } else {
        const rows = k.list.filter((o) => hit(`${o.host} ${o.files.join(' ')}`));
        body = rows.map(hostRow).join('');
        n = rows.length;
      }
      if (!n) continue;
      html += `<div class="ep-k"><p>${h(k.title)}</p><span>${n}</span></div>${words.length ? '' : `<div class="ep-why">${h(k.why)}</div>`}${body}`;
      shown += n;
    }
    if (!shown) html = `<div class="ep-none">Nothing matches “${h(q)}”.</div>`;
    const list = menu.querySelector('.ep-l');
    list.innerHTML = html;
    list.querySelectorAll('[data-ep]').forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); show(b.dataset.ep); });
    list.querySelector('.ep-r')?.classList.add('on');
  }
  function renderMenu() {
    menu.innerHTML = `${total > 8 ? '<div class="ep-f"><input id="ep-q" placeholder="Find an endpoint, tool or address…" aria-label="Find an endpoint, tool or address" spellcheck="false" autocomplete="off"></div>' : ''}<div class="ep-l"></div>`;
    renderList('');
    const input = menu.querySelector('#ep-q');
    if (!input) return;
    input.oninput = () => renderList(input.value);
    input.onkeydown = (ev) => {
      const rows = [...menu.querySelectorAll('.ep-r')];
      const cur = rows.findIndex((r) => r.classList.contains('on'));
      if (ev.key === 'Enter' && rows[cur]) { ev.preventDefault(); rows[cur].click(); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const next = rows[Math.max(0, Math.min(rows.length - 1, cur + (ev.key === 'ArrowDown' ? 1 : -1)))];
        rows.forEach((r) => r.classList.toggle('on', r === next));
        next?.scrollIntoView({ block: 'nearest' });
      }
    };
  }
  function openMenu() {
    document.body.click(); // let the viewer close its own menus
    renderMenu();
    place();
    menu.classList.add('open');
    (menu.querySelector('#ep-q') || menu.querySelector('.ep-r'))?.focus();
  }
  function place() {
    const r = btn.getBoundingClientRect();
    menu.style.top = r.bottom + 8 + 'px';
    menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
  }
  function closeMenu() { menu.classList.remove('open'); }
  const isOpen = () => menu.classList.contains('open');

  const counts = KINDS.map((k) => `${k.list.length} ${k.id === 'web' ? 'web' : k.id === 'mcp' ? 'MCP' : 'outside'}`).join(', ');
  btn = SC.addHeaderButton({ id: 'endpoints-btn', label: 'Endpoints', icon: 'route', title: `Every endpoint, MCP tool and outside call (${counts})`, onClick: () => (isOpen() ? closeMenu() : openMenu()) });
  window.addEventListener('pointerdown', (ev) => { if (isOpen() && !menu.contains(ev.target) && !btn.contains(ev.target)) closeMenu(); }, true);
  window.addEventListener('keydown', (ev) => {
    if (!isOpen()) return;
    if (ev.key === 'Escape') { ev.stopImmediatePropagation(); ev.preventDefault(); closeMenu(); btn.focus(); }
    else if (ev.target?.id !== 'ep-q' && !(ev.target?.classList?.contains('ep-r') && (ev.key === 'Enter' || ev.key === ' '))) ev.stopPropagation(); // keep viewer shortcuts out of the open menu
  }, true);
  window.addEventListener('resize', () => { if (isOpen()) place(); });

  // ---------- overview panel ----------
  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>Endpoints <span class="c">${total}</span></h3><div class="list"><a class="row" data-ep-open><span class="dot" style="background:var(--n-route)"></span><span class="rt"><div class="rn">See every endpoint</div><div class="rd">${h(KINDS.map((k) => `${k.list.length} ${k.title.toLowerCase()}`).join(' · '))}</div></span></a></div></div>`,
    bind: (el) => el?.querySelector('[data-ep-open]')?.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openMenu(); }),
  }));

  window.FloorplanEndpoints = { openMenu };
})();
