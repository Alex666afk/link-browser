// Link — browser shell: tabs, omnibox, sidebar, protection/VPN popovers and commands.
const L = window.link;
const $ = (id) => document.getElementById(id);
const NEWTAB = 'link://newtab';
const PARTITION = { normal: 'persist:link', private: 'link-private' };

const state = {
  settings: null,
  engines: [],
  bookmarks: null,
  platform: '',
  versions: {},
  tabs: [],
  activeId: null,
  closed: [],
  downloads: new Map(),
  totalBlocked: 0,
  vpnInfo: null,
  vpnStatus: { state: 'off' },
  collapsed: new Set(JSON.parse(localStorage.getItem('collapsed-folders') || '[]')),
};
let tabSeq = 0;

const activeTab = () => state.tabs.find((t) => t.id === state.activeId);
const homepage = () => state.settings.homepage || NEWTAB;
const isInternal = (url) => !url || url.startsWith('link://');
const isNewTab = (url) => !url || url.startsWith(NEWTAB);
const linkSearchQuery = (url) => (url?.startsWith('link://search/') ? new URL(url).searchParams.get('q') || '' : null);
const currentEngine = () => state.engines.find((e) => e.id === state.settings.searchEngine) || state.engines[0];
const searchUrl = (q, engine = currentEngine()) => engine.url.replace('%s', encodeURIComponent(q));

// ============================================================
// Theme
// ============================================================
function applyTheme() {
  const s = state.settings;
  const dark = s.theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : s.theme !== 'light';
  document.body.classList.toggle('theme-dark', dark);
  document.body.classList.toggle('theme-light', !dark);
  document.documentElement.style.setProperty('--accent', s.accent || '#8a6cef');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.settings && applyTheme());

// ============================================================
// Input → URL
// ============================================================
function parseKeyword(text) {
  const m = /^[@!](\S+)(?:\s+(.*))?$/.exec(text.trim());
  if (!m) return null;
  const key = m[1].toLowerCase();
  const engine = state.engines.find((e) => e.keyword?.toLowerCase() === key || e.id === key);
  return engine ? { engine, query: m[2] || '' } : null;
}

async function resolveInput(raw) {
  const text = raw.trim();
  if (!text) return null;
  const kw = parseKeyword(text);
  if (kw) return kw.query ? searchUrl(kw.query, kw.engine) : new URL(kw.engine.url.replace('%s', '')).origin;
  if (/^link:\/\/settings/i.test(text)) { openSettings(); return null; }
  if (/^link:\/\/(history|bookmarks|downloads)/i.test(text)) { showSidebar(text.slice(7).replace(/\/.*/, '')); return null; }
  if (/^(https?|file|link|chrome-extension|view-source|data):/i.test(text)) return L.upgradeUrl(text);
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^\s/?#]+\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i.test(text)) return `https://${text}`;
  return searchUrl(text);
}

// ============================================================
// Tabs
// ============================================================
function createTab({ url = homepage(), private: priv = false, background = false, lazy = false, title, index } = {}) {
  const tab = {
    id: ++tabSeq, url, title: title || (isNewTab(url) ? 'New tab' : url), favicon: null, loading: false,
    private: priv, blocked: 0, wcId: null, ready: false, zoom: 0, audible: false, muted: false, wv: null,
  };
  const at = index ?? (state.activeId ? state.tabs.indexOf(activeTab()) + 1 : state.tabs.length);
  state.tabs.splice(at, 0, tab);
  if (!lazy) ensureWebview(tab);
  if (!background) activateTab(tab.id);
  renderTabs();
  saveSessionSoon();
  return tab;
}

function ensureWebview(tab) {
  if (tab.wv) return tab.wv;
  const wv = document.createElement('webview');
  wv.setAttribute('partition', tab.private ? PARTITION.private : PARTITION.normal);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', tab.url);
  tab.wv = wv;
  const update = () => { renderTabs(); if (tab.id === state.activeId) updateChrome(); };

  wv.addEventListener('dom-ready', () => {
    if (!tab.ready) {
      tab.ready = true;
      tab.wcId = wv.getWebContentsId();
      if (tab.zoom) wv.setZoomLevel(tab.zoom);
      if (tab.muted) wv.setAudioMuted(true);
    }
    update();
  });
  wv.addEventListener('did-start-loading', () => { tab.loading = true; update(); });
  wv.addEventListener('did-stop-loading', () => { tab.loading = false; update(); saveSessionSoon(); });
  wv.addEventListener('did-navigate', (e) => {
    if (hostOf(e.url) !== hostOf(tab.url)) tab.favicon = null;
    tab.draft = null;
    tab.url = e.url;
    if (isNewTab(e.url)) tab.title = 'New tab';
    update();
    if (tab.id === state.activeId) checkPasswords(tab);
  });
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { tab.url = e.url; update(); } });
  wv.addEventListener('page-title-updated', (e) => { tab.title = e.title; update(); saveSessionSoon(); });
  wv.addEventListener('page-favicon-updated', (e) => {
    tab.favicon = e.favicons?.[0] || null;
    if (!tab.private) rememberFavicon(tab.url, tab.favicon);
    renderTabs();
  });
  wv.addEventListener('update-target-url', (e) => {
    if (tab.id !== state.activeId) return;
    $('hover-url').textContent = e.url;
    $('hover-url').classList.toggle('hidden', !e.url);
  });
  wv.addEventListener('found-in-page', (e) => {
    const r = e.result;
    if (r.finalUpdate) $('find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No results';
  });
  wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('html-fullscreen'));
  wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('html-fullscreen'));
  wv.addEventListener('media-started-playing', () => { tab.audible = true; renderTabs(); });
  wv.addEventListener('media-paused', () => { tab.audible = false; renderTabs(); });
  wv.addEventListener('close', () => closeTab(tab.id));
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return;
    showErrorPage(tab, e.validatedURL, e.errorCode, e.errorDescription);
  });
  $('views').append(wv);
  return wv;
}

function loadIn(tab, url) {
  tab.url = url;
  if (!tab.wv) return ensureWebview(tab);
  if (tab.ready) tab.wv.loadURL(url).catch(() => {});
  else tab.wv.setAttribute('src', url);
  if (tab.id === state.activeId) updateChrome();
}

function showErrorPage(tab, url, code, desc) {
  const blocked = code === -20;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const dark = document.body.classList.contains('theme-dark');
  const title = blocked ? 'Link Protect blocked this page' : code === -105 ? 'This site can’t be found' : code === -106 ? 'You’re offline' : 'This page can’t be reached';
  const detail = blocked
    ? 'This address is on a known ad or tracker list. You can turn off ad blocking in Link Protect if you trust it.'
    : code === -105 ? `Check the spelling of <b>${esc(hostOf(url))}</b>, or search for it instead.` : esc(desc || 'The connection failed.');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:Inter,"Segoe UI",system-ui,sans-serif;
    background:${dark ? '#1e1e1e' : '#fff'};color:${dark ? '#dadada' : '#222'}}
    main{max-width:520px;padding:32px}h1{font-size:22px;margin:16px 0 8px}p{color:${dark ? '#b3b3b3' : '#5c5c5c'};line-height:1.6}
    code{font-size:12px;color:${dark ? '#6f6f6f' : '#ababab'}}a{display:inline-block;margin-top:16px;padding:6px 14px;border-radius:4px;border:1px solid ${dark ? '#363636' : '#e3e3e3'};background:${dark ? '#262626' : '#f6f6f6'};color:inherit;text-decoration:none;font-size:13px}
    .i{color:${dark ? '#6f6f6f' : '#ababab'}}
    </style></head><body><main><div class="i"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${blocked ? ICONS.shield : ICONS.alert}</svg></div><h1>${title}</h1><p>${detail}</p><code>${esc(url)} · ${esc(desc)} (${code})</code><br><a href="${esc(url)}">Try again</a></main></body></html>`;
  tab.wv.executeJavaScript(`document.open();document.write(${JSON.stringify(html)});document.close();`).catch(() => {});
}

function activateTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  state.activeId = id;
  ensureWebview(tab);
  for (const t of state.tabs) t.wv?.classList.toggle('is-active', t.id === id);
  $('hover-url').classList.add('hidden');
  closeFind();
  renderTabs();
  updateChrome();
  checkPasswords(tab);
  if (isNewTab(tab.url)) setTimeout(() => focusAddress(), 0);
  else tab.wv.focus();
  if (state.settings.sidebarView === 'tabs') renderSidebar();
}

function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = state.tabs.splice(i, 1);
  if (!tab.private) state.closed.push({ url: tab.url, title: tab.title, index: i });
  tab.wv?.remove();
  if (!state.tabs.length) createTab();
  else if (state.activeId === id) activateTab(state.tabs[Math.min(i, state.tabs.length - 1)].id);
  renderTabs();
  saveSessionSoon();
  if (state.settings.sidebarView === 'tabs') renderSidebar();
}

function reopenTab() {
  const last = state.closed.pop();
  if (last) createTab({ url: last.url, title: last.title, index: Math.min(last.index, state.tabs.length) });
}

function moveTab(id, toIndex) {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from < 0) return;
  const [tab] = state.tabs.splice(from, 1);
  state.tabs.splice(toIndex > from ? toIndex - 1 : toIndex, 0, tab);
  renderTabs();
  saveSessionSoon();
}

function tabFavicon(tab) {
  const wrap = h('span', { class: 'tab-favicon' });
  if (tab.loading && !isInternal(tab.url)) wrap.append(h('span', { class: 'spin' }, icon('loader', 14)));
  else if (tab.private) wrap.append(icon('incognito', 14));
  else if (isInternal(tab.url)) wrap.append(appLogo(14));
  else if (tab.favicon) {
    const img = h('img', { src: tab.favicon, draggable: 'false' });
    img.onerror = () => img.replaceWith(icon('globe', 14));
    wrap.append(img);
  } else wrap.append(icon('globe', 14));
  return wrap;
}

let dragTabId = null;
function renderTabs() {
  const strip = $('tabs');
  strip.replaceChildren(...state.tabs.map((tab, index) => {
    const el = h('div', {
      class: `tab ${tab.id === state.activeId ? 'is-active' : ''} ${tab.private ? 'is-private' : ''} ${tab.audible ? 'is-audible' : ''}`,
      title: `${tab.title}\n${tab.url}`,
      draggable: 'true',
      onmousedown: (e) => { if (e.button === 0 && !e.target.closest('.clickable-icon')) activateTab(tab.id); },
      onauxclick: (e) => { if (e.button === 1) closeTab(tab.id); },
      oncontextmenu: (e) => tabMenu(tab, e),
      ondragstart: (e) => { dragTabId = tab.id; e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('is-dragging-tab'); el.classList.add('is-dragging'); },
      ondragend: () => { dragTabId = null; document.body.classList.remove('is-dragging-tab'); renderTabs(); },
      ondragover: (e) => { if (dragTabId) e.preventDefault(); },
      ondrop: (e) => {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        if (dragTabId && dragTabId !== tab.id) moveTab(dragTabId, e.clientX > r.left + r.width / 2 ? index + 1 : index);
      },
    },
    h('span', { class: 'tab-corner' }),
    h('span', { class: 'tab-inner' }),
    tabFavicon(tab),
    h('span', { class: 'tab-title' }, tab.title || 'Untitled'),
    h('button', {
      class: 'clickable-icon tab-audio', 'aria-label': tab.muted ? 'Unmute tab' : 'Mute tab',
      onclick: () => toggleMute(tab),
    }, icon(tab.muted ? 'volume-x' : 'volume-2', 13)),
    h('button', { class: 'clickable-icon tab-close', 'aria-label': 'Close tab', onclick: () => closeTab(tab.id) }, icon('x', 14)));
    return el;
  }));
  document.title = `${activeTab()?.title || 'New tab'} — Link`;
}

function toggleMute(tab) {
  tab.muted = !tab.muted;
  if (tab.ready) tab.wv.setAudioMuted(tab.muted);
  renderTabs();
}

function tabMenu(tab, e) {
  e.preventDefault();
  const i = state.tabs.indexOf(tab);
  showMenu([
    { title: 'New tab to the right', icon: 'plus', onClick: () => createTab({ index: i + 1 }) },
    '-',
    { title: 'Reload', icon: 'rotate-cw', onClick: () => tab.ready && tab.wv.reload() },
    { title: 'Duplicate', icon: 'copy', onClick: () => createTab({ url: tab.url, private: tab.private, index: i + 1 }) },
    { title: tab.muted ? 'Unmute tab' : 'Mute tab', icon: tab.muted ? 'volume-2' : 'volume-x', onClick: () => toggleMute(tab) },
    { title: 'Bookmark tab', icon: 'bookmark-plus', onClick: () => addBookmark(tab), disabled: isInternal(tab.url) },
    { title: 'Copy link', icon: 'link', onClick: () => navigator.clipboard.writeText(tab.url) },
    '-',
    { title: 'Close', icon: 'x', hint: 'Ctrl+W', onClick: () => closeTab(tab.id) },
    { title: 'Close other tabs', icon: 'none', onClick: () => state.tabs.filter((t) => t !== tab).forEach((t) => closeTab(t.id)) },
    { title: 'Close tabs to the right', icon: 'none', onClick: () => state.tabs.slice(i + 1).forEach((t) => closeTab(t.id)) },
    { title: 'Reopen closed tab', icon: 'rotate-ccw', hint: 'Ctrl+Shift+T', disabled: !state.closed.length, onClick: reopenTab },
  ], { x: e.clientX, y: e.clientY });
}

let sessionTimer;
function saveSessionSoon() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    L.saveSession(state.tabs.filter((t) => !t.private).map((t) => ({ url: t.url, title: t.title, active: t.id === state.activeId })));
  }, 600);
}

// ============================================================
// Navigation chrome (view header, omnibox, status bar)
// ============================================================
function prettyUrl(url) {
  const q = linkSearchQuery(url);
  if (q !== null) return q;
  if (isInternal(url)) return '';
  try { return decodeURI(url); } catch { return url; }
}

function updateChrome() {
  const tab = activeTab();
  if (!tab) return;
  const input = $('address');
  if (document.activeElement !== input) input.value = tab.draft ?? prettyUrl(tab.url);
  input.placeholder = `Search with ${currentEngine().name} or enter address`;
  const ready = tab.ready;
  $('btn-back').disabled = !(ready && tab.wv.canGoBack());
  $('btn-forward').disabled = !(ready && tab.wv.canGoForward());
  setIcon($('btn-reload'), tab.loading ? 'x' : 'rotate-cw');

  const iconEl = $('omnibox-icon');
  iconEl.className = 'omnibox-icon';
  const name = linkSearchQuery(tab.url) !== null ? 'search' : isInternal(tab.url) ? 'search' : tab.url.startsWith('https:') ? 'lock' : tab.url.startsWith('http:') ? 'lock-open' : tab.url.startsWith('chrome-extension:') ? 'puzzle' : 'file';
  if (name === 'lock') iconEl.classList.add('is-secure');
  if (name === 'lock-open') iconEl.classList.add('is-insecure');
  iconEl.replaceChildren(icon(name, 14));
  iconEl.title = name === 'lock' ? 'Connection is secure (HTTPS)' : name === 'lock-open' ? 'Connection is not secure' : '';

  const starred = state.flatBookmarks?.some((b) => b.url === tab.url);
  $('btn-star').classList.toggle('is-active', !!starred);
  $('btn-star').classList.toggle('hidden', isInternal(tab.url));

  const storeId = webStoreId(tab.url);
  $('btn-store-install').classList.toggle('hidden', !storeId);

  updateShield();
  renderStatusBar();
}

function webStoreId(url) {
  const m = /^https:\/\/(chromewebstore\.google\.com\/detail\/|chrome\.google\.com\/webstore\/detail\/)(?:[^/]+\/)?([a-p]{32})/.exec(url || '');
  return m ? m[2] : null;
}

function updateShield() {
  const tab = activeTab();
  const on = state.settings.adblock.enabled;
  const btnEl = $('btn-shield');
  btnEl.classList.toggle('is-off', !on);
  setIcon(btnEl, on ? 'shield-check' : 'shield-off');
  $('shield-badge').textContent = on && tab?.blocked ? (tab.blocked > 99 ? '99+' : tab.blocked) : '';
  $('btn-vpn').classList.toggle('is-on', state.settings.vpn.enabled);
}

function renderStatusBar() {
  const tab = activeTab();
  const s = state.settings;
  const items = [];
  const item = (iconName, text, onClick, cls = '') => h('div', { class: `status-bar-item ${onClick ? 'mod-clickable' : ''} ${cls}`, onclick: onClick }, iconName ? icon(iconName, 13) : null, text);
  if (tab?.zoom) items.push(item('search', `${Math.round(1.2 ** tab.zoom * 100)}%`, () => zoom(0)));
  if (tab?.private) items.push(item('incognito', 'Private'));
  items.push(item(s.adblock.enabled ? 'shield-check' : 'shield-off', s.adblock.enabled ? `${state.totalBlocked.toLocaleString()} blocked` : 'Protection off', (e) => openShieldPopover(e.currentTarget)));
  const vs = state.vpnStatus;
  const vpnText = !s.vpn.enabled ? 'VPN off'
    : vs.state === 'connecting' ? (vs.step === 'download' ? `Setting up VPN ${vs.percent}%` : `VPN connecting ${vs.percent}%`)
    : vs.state === 'error' ? 'VPN error'
    : state.vpnInfo?.country ? `VPN · ${state.vpnInfo.country}` : 'VPN on';
  items.push(item('globe-lock', vpnText, (e) => openVpnPopover(e.currentTarget), s.vpn.enabled && vs.state === 'connected' ? 'is-good' : ''));
  const engineItem = item(null, currentEngine().name, (e) => engineMenu(e.currentTarget));
  engineItem.prepend(engineIcon(currentEngine(), 13));
  items.push(engineItem);
  $('status-bar').replaceChildren(...items);
}

function zoom(dir) {
  const tab = activeTab();
  if (!tab?.ready) return;
  tab.zoom = dir === 0 ? 0 : Math.max(-6, Math.min(8, tab.zoom + dir * 0.5));
  tab.wv.setZoomLevel(tab.zoom);
  renderStatusBar();
}

function engineMenu(anchor) {
  showMenu([
    { label: 'Default search engine' },
    ...state.engines.map((e) => ({
      title: e.name, img: engineIcon(e), checked: e.id === state.settings.searchEngine,
      onClick: () => setSettings({ searchEngine: e.id }),
    })),
    '-',
    { title: 'Manage search engines…', icon: 'settings', onClick: () => openSettings('search') },
  ], anchor);
}

// ============================================================
// Omnibox + suggestions
// ============================================================
const omni = { items: [], selected: -1, token: 0 };

function focusAddress() {
  const input = $('address');
  input.focus();
  input.select();
}

function suggestionEngine(text) {
  return parseKeyword(text)?.engine || currentEngine();
}

async function updateSuggestions() {
  const input = $('address');
  const text = input.value;
  const box = $('suggestions');
  const engine = suggestionEngine(text);
  paintEngineChip();
  if (!text.trim()) { box.classList.add('hidden'); omni.items = []; return; }
  const token = ++omni.token;
  const kw = parseKeyword(text);
  const query = kw ? kw.query : text.trim();
  const looksUrl = !kw && /^[^\s]+\.[a-z]{2,}(\/|$)|^https?:|^localhost/i.test(text.trim());

  const first = looksUrl
    ? { kind: 'go', title: text.trim(), hint: 'Go to address', icon: 'globe', run: () => navigate(text) }
    : { kind: 'search', title: query || engine.name, hint: `Search ${engine.name}`, img: () => engineIcon(engine, 15), run: () => navigate(text) };
  const items = [first];
  if (!kw && /^[@!]\S*$/.test(text.trim())) {
    const typed = text.trim().slice(1).toLowerCase();
    for (const e of state.engines.filter((x) => x.keyword?.startsWith(typed)).slice(0, 6)) {
      items.push({ kind: 'engine', title: `@${e.keyword}`, hint: `Search ${e.name}`, img: () => engineIcon(e, 15), run: () => { input.value = `@${e.keyword} `; updateSuggestions(); input.focus(); } });
    }
  }
  render(items);
  if (kw && !kw.query) return;

  const res = await L.suggest(query);
  if (token !== omni.token) return;
  for (const s of res.remote) {
    if (s.title.toLowerCase() === query.toLowerCase()) continue;
    items.push({ kind: 'search', title: s.title, icon: 'search', run: () => navigateTo(searchUrl(s.title, engine)) });
  }
  if (res.local.length) items.push({ group: 'Bookmarks & history' });
  for (const s of res.local) {
    items.push({ kind: s.type, title: s.title || s.url, url: s.url, icon: s.type === 'bookmark' ? 'bookmark' : 'history', run: () => navigateTo(s.url) });
  }
  render(items);

  function render(list) {
    omni.items = list.filter((x) => !x.group);
    omni.selected = 0;
    let idx = -1;
    box.replaceChildren(...list.map((it) => {
      if (it.group) return h('div', { class: 'suggestion-group' }, it.group);
      const i = ++idx;
      return h('div', {
        class: `suggestion-item ${i === omni.selected ? 'is-selected' : ''}`,
        onmousedown: (e) => { e.preventDefault(); it.run(); hideSuggestions(); },
        onmousemove: () => { omni.selected = i; paintSuggestions(); },
      },
      it.img ? it.img() : it.url ? faviconEl(it.url, it.icon) : icon(it.icon, 15),
      h('span', { class: 'suggestion-title' }, it.title),
      it.url ? h('span', { class: 'suggestion-url' }, '— ' + prettyUrl(it.url)) : null,
      it.hint ? h('span', { class: 'suggestion-hint' }, it.hint) : null);
    }));
    // One click searches what you typed with any engine.
    const typed = (kw ? kw.query : text).trim();
    if (typed && !looksUrl) {
      box.append(h('div', { class: 'suggestion-engines' },
        h('span', { class: 'suggestion-engines-label' }, 'Search with'),
        state.engines.map((en) => h('button', {
          class: `clickable-icon ${en.id === engine.id ? 'is-active' : ''}`, title: en.name, 'aria-label': `Search ${en.name}`,
          onmousedown: (e) => { e.preventDefault(); navigateTo(searchUrl(typed, en)); },
        }, engineIcon(en, 16)))));
    }
    box.classList.toggle('hidden', !list.length);
  }
}
function paintSuggestions() {
  [...$('suggestions').querySelectorAll('.suggestion-item')].forEach((el, i) => el.classList.toggle('is-selected', i === omni.selected));
}
function hideSuggestions() { $('suggestions').classList.add('hidden'); omni.token++; }

async function navigate(text, opts = {}) {
  const target = await resolveInput(text);
  if (target) navigateTo(target, opts);
}
function navigateTo(url, { newTab = false } = {}) {
  hideSuggestions();
  if (newTab) return createTab({ url });
  const tab = activeTab();
  loadIn(tab, url);
  tab.draft = null;
  $('address').value = prettyUrl(url);
  $('address').blur();
  tab.wv.focus();
}

function paintEngineChip() {
  const en = suggestionEngine($('address').value);
  $('omnibox-engine').replaceChildren(engineIcon(en, 14), en.name, icon('chevron-down', 12));
}

function bindOmnibox() {
  const input = $('address');
  const box = $('omnibox');
  input.addEventListener('focus', () => {
    box.classList.add('is-focused');
    paintEngineChip();
    if (activeTab()?.draft) updateSuggestions();
    else setTimeout(() => input.select());
  });
  input.addEventListener('blur', () => { box.classList.remove('is-focused'); setTimeout(hideSuggestions, 120); });
  input.addEventListener('input', () => {
    const t = activeTab();
    // Typed text stays as a per-tab draft until you press Enter or Esc, or the page changes.
    if (t) t.draft = input.value === prettyUrl(t.url) ? null : input.value;
    updateSuggestions();
  });
  input.addEventListener('keydown', (e) => {
    const visible = !$('suggestions').classList.contains('hidden');
    if (e.key === 'ArrowDown' && visible) { omni.selected = Math.min(omni.items.length - 1, omni.selected + 1); paintSuggestions(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && visible) { omni.selected = Math.max(0, omni.selected - 1); paintSuggestions(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = omni.items[omni.selected];
      if (e.altKey || e.ctrlKey) return navigate(input.value, { newTab: true });
      if (visible && it && omni.selected > 0) it.run(); else navigate(input.value);
      hideSuggestions();
    } else if (e.key === 'Escape') {
      hideSuggestions();
      if (activeTab()) activeTab().draft = null;
      input.value = prettyUrl(activeTab()?.url);
      activeTab()?.wv?.focus();
    }
  });
  $('omnibox-engine').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const typed = input.value;
    showMenu([
      { label: 'Search engine' },
      ...state.engines.map((en) => ({
        title: en.name, img: engineIcon(en), checked: en.id === state.settings.searchEngine,
        onClick: async () => {
          await setSettings({ searchEngine: en.id });
          input.value = typed;
          input.focus();
          paintEngineChip();
          if (typed.trim()) updateSuggestions();
        },
      })),
      '-',
      { title: 'Manage search engines…', icon: 'settings', onClick: () => openSettings('search') },
    ], e.currentTarget);
  });
}

// ============================================================
// Bookmarks
// ============================================================
function flatten(node, out = []) {
  for (const c of node.children || []) c.type === 'url' ? out.push(c) : flatten(c, out);
  return out;
}
function setBookmarks(tree) {
  state.bookmarks = tree;
  state.flatBookmarks = flatten(tree);
  updateChrome();
  if (['bookmarks'].includes(state.settings.sidebarView)) renderSidebar();
}
async function addBookmark(tab = activeTab()) {
  if (!tab || isInternal(tab.url)) return;
  const existing = state.flatBookmarks.find((b) => b.url === tab.url);
  if (existing) {
    await L.bookmarks.remove(existing.id);
    notice('Bookmark removed');
  } else {
    await L.bookmarks.add({ type: 'url', title: tab.title, url: tab.url }, 'root');
    notice(`Bookmarked “${tab.title}”`);
  }
}
function findParent(id, node = state.bookmarks) {
  for (const c of node.children || []) {
    if (c.id === id) return node;
    if (c.type === 'folder') { const p = findParent(id, c); if (p) return p; }
  }
  return null;
}

// ============================================================
// Sidebar (tabs / bookmarks / history / downloads)
// ============================================================
const SIDEBAR_VIEWS = [
  ['bookmarks', 'bookmark', 'Bookmarks'],
  ['tabs', 'tabs', 'Open tabs'],
  ['history', 'history', 'History'],
  ['downloads', 'download', 'Downloads'],
];

function showSidebar(view) {
  setSettings({ sidebarOpen: true, sidebarView: view });
}

function renderSidebarChrome() {
  const s = state.settings;
  $('sidebar').classList.toggle('is-collapsed', !s.sidebarOpen);
  $('sidebar-tabs').replaceChildren(...SIDEBAR_VIEWS.map(([id, ic, label]) => h('button', {
    class: `clickable-icon ${s.sidebarView === id ? 'is-active' : ''}`, 'aria-label': label, title: label,
    onclick: () => setSettings({ sidebarView: id }),
  }, icon(ic, 17))));
}

let historyQuery = '';
async function renderSidebar() {
  renderSidebarChrome();
  if (!state.settings.sidebarOpen) return;
  const view = state.settings.sidebarView;
  const nav = $('sidebar-nav');
  const content = $('sidebar-content');
  const navBtn = (ic, label, onClick) => h('button', { class: 'clickable-icon', 'aria-label': label, title: label, onclick: onClick }, icon(ic, 16));

  if (view === 'tabs') {
    nav.replaceChildren(navBtn('plus', 'New tab', () => createTab()), navBtn('incognito', 'New private tab', () => createTab({ private: true })));
    content.replaceChildren(...state.tabs.map((t) => h('div', {
      class: `tree-item-self ${t.id === state.activeId ? 'is-active' : ''}`,
      onclick: () => activateTab(t.id), oncontextmenu: (e) => tabMenu(t, e), onauxclick: (e) => e.button === 1 && closeTab(t.id),
    },
    h('span', { class: 'tree-item-icon' }, tabFavicon(t)),
    h('span', { class: 'tree-item-inner' }, t.title || t.url),
    h('button', { class: 'clickable-icon tree-item-action', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, icon('x', 13)))));
  }

  if (view === 'bookmarks') {
    nav.replaceChildren(
      navBtn('bookmark-plus', 'Bookmark current page', () => addBookmark()),
      navBtn('folder-plus', 'New folder', async () => {
        const name = await promptText('New folder', '', { placeholder: 'Folder name', cta: 'Create' });
        if (name) L.bookmarks.add({ type: 'folder', title: name }, 'root');
      }),
      navBtn('chevrons-down-up', 'Collapse all', () => {
        const walk = (n) => (n.children || []).forEach((c) => { if (c.type === 'folder') { state.collapsed.add(c.id); walk(c); } });
        walk(state.bookmarks);
        saveCollapsed();
        renderSidebar();
      }),
      navBtn('import', 'Import bookmarks', () => openSettings('import')));
    const children = state.bookmarks.children || [];
    content.replaceChildren(...(children.length ? children.map((c) => bookmarkNode(c)) : [h('div', { class: 'empty-state' },
      'No bookmarks yet.', h('br'), 'Press ', h('kbd', {}, 'Ctrl+D'), ' to bookmark a page, or ', h('span', { class: 'link-text', onclick: () => openSettings('import') }, 'import from another browser'), '.')]));
  }

  if (view === 'history') {
    const search = h('input', { class: 'text', placeholder: 'Search history…', value: historyQuery, spellcheck: false });
    search.addEventListener('input', () => { historyQuery = search.value; renderHistoryList(); });
    nav.replaceChildren(h('div', { class: 'search-input-container' }, icon('search', 14), search),
      navBtn('trash', 'Clear history', async () => {
        if (await confirmDialog('Clear history', 'Delete your entire browsing history from Link? This cannot be undone.', 'Clear history')) {
          await L.history.clear();
          renderHistoryList();
        }
      }));
    renderHistoryList();
  }

  if (view === 'downloads') {
    nav.replaceChildren(navBtn('folder', 'Open downloads folder', () => L.downloads.open(state.downloadsDir)));
    renderDownloads();
  }
}

function saveCollapsed() { localStorage.setItem('collapsed-folders', JSON.stringify([...state.collapsed])); }

let dragBookmarkId = null;
function bookmarkNode(node) {
  const isFolder = node.type === 'folder';
  const collapsed = state.collapsed.has(node.id);
  const self = h('div', {
    class: `tree-item-self ${!isFolder && node.url === activeTab()?.url ? 'is-active' : ''}`,
    draggable: 'true',
    title: isFolder ? node.title : `${node.title}\n${node.url}`,
    onclick: (e) => {
      if (isFolder) {
        collapsed ? state.collapsed.delete(node.id) : state.collapsed.add(node.id);
        saveCollapsed();
        renderSidebar();
      } else if (e.ctrlKey || e.metaKey) createTab({ url: node.url, background: true });
      else navigateTo(node.url);
    },
    onauxclick: (e) => { if (e.button === 1 && !isFolder) createTab({ url: node.url, background: true }); },
    oncontextmenu: (e) => { e.preventDefault(); bookmarkMenu(node, e); },
    ondragstart: (e) => { dragBookmarkId = node.id; e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); },
    ondragend: () => { dragBookmarkId = null; },
    ondragover: (e) => { if (dragBookmarkId && dragBookmarkId !== node.id) { e.preventDefault(); self.classList.add('is-drop-target'); } },
    ondragleave: () => self.classList.remove('is-drop-target'),
    ondrop: (e) => {
      e.preventDefault();
      self.classList.remove('is-drop-target');
      if (!dragBookmarkId || dragBookmarkId === node.id) return;
      if (isFolder) L.bookmarks.move(dragBookmarkId, node.id);
      else {
        const parent = findParent(node.id);
        L.bookmarks.move(dragBookmarkId, parent.id, parent.children.indexOf(node));
      }
    },
  },
  isFolder ? h('span', { class: 'collapse-icon' }, icon('chevron-down', 14)) : null,
  h('span', { class: 'tree-item-icon' }, isFolder ? icon(collapsed ? 'folder' : 'folder', 15) : faviconEl(node.url, 'globe', 14)),
  h('span', { class: 'tree-item-inner' }, node.title || node.url),
  isFolder ? h('span', { class: 'tree-item-flair' }, String(flatten(node).length)) : null);
  return h('div', { class: `tree-item ${collapsed ? 'is-collapsed' : ''}` },
    self,
    isFolder && !collapsed ? h('div', { class: 'tree-item-children' }, (node.children || []).map(bookmarkNode)) : null);
}

function bookmarkMenu(node, e) {
  const isFolder = node.type === 'folder';
  const rename = async () => {
    const title = await promptText(isFolder ? 'Rename folder' : 'Rename bookmark', node.title);
    if (title) L.bookmarks.update(node.id, { title });
  };
  showMenu(isFolder ? [
    { title: 'Open all in new tabs', icon: 'tabs', onClick: () => flatten(node).forEach((b) => createTab({ url: b.url, background: true })) },
    { title: 'New folder inside', icon: 'folder-plus', onClick: async () => {
      const name = await promptText('New folder', '', { placeholder: 'Folder name', cta: 'Create' });
      if (name) L.bookmarks.add({ type: 'folder', title: name }, node.id);
    } },
    { title: 'Bookmark current page here', icon: 'bookmark-plus', disabled: isInternal(activeTab()?.url), onClick: () => L.bookmarks.add({ type: 'url', title: activeTab().title, url: activeTab().url }, node.id) },
    '-',
    { title: 'Rename', icon: 'pencil', onClick: rename },
    { title: 'Delete folder', icon: 'trash', warning: true, onClick: async () => {
      if (await confirmDialog('Delete folder', `Delete “${node.title}” and the ${flatten(node).length} bookmarks inside it?`, 'Delete')) L.bookmarks.remove(node.id);
    } },
  ] : [
    { title: 'Open in new tab', icon: 'plus', onClick: () => createTab({ url: node.url }) },
    { title: 'Open in private tab', icon: 'incognito', onClick: () => createTab({ url: node.url, private: true }) },
    { title: 'Copy link', icon: 'link', onClick: () => navigator.clipboard.writeText(node.url) },
    '-',
    { title: 'Rename', icon: 'pencil', onClick: rename },
    { title: 'Edit URL', icon: 'globe', onClick: async () => {
      const url = await promptText('Edit URL', node.url);
      if (url) L.bookmarks.update(node.id, { url });
    } },
    { title: 'Delete', icon: 'trash', warning: true, onClick: () => L.bookmarks.remove(node.id) },
  ], { x: e.clientX, y: e.clientY });
}

async function renderHistoryList() {
  const list = await L.history.search(historyQuery, 400);
  const content = $('sidebar-content');
  if (state.settings.sidebarView !== 'history') return;
  if (!list.length) return content.replaceChildren(h('div', { class: 'empty-state' }, historyQuery ? 'No matching pages.' : 'Your history is empty.'));
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  const out = [];
  let lastDay = null;
  for (const item of list) {
    const day = new Date(item.lastVisit).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      out.push(h('div', { class: 'sidebar-section-title' }, day === today ? 'Today' : day === yesterday ? 'Yesterday' : new Date(item.lastVisit).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })));
    }
    out.push(h('div', {
      class: 'tree-item-self', title: item.url,
      onclick: (e) => (e.ctrlKey ? createTab({ url: item.url, background: true }) : navigateTo(item.url)),
      onauxclick: (e) => e.button === 1 && createTab({ url: item.url, background: true }),
      oncontextmenu: (e) => {
        e.preventDefault();
        showMenu([
          { title: 'Open in new tab', icon: 'plus', onClick: () => createTab({ url: item.url }) },
          { title: 'Copy link', icon: 'link', onClick: () => navigator.clipboard.writeText(item.url) },
          { title: 'Remove from history', icon: 'trash', warning: true, onClick: async () => { await L.history.remove(item.url); renderHistoryList(); } },
        ], { x: e.clientX, y: e.clientY });
      },
    },
    h('span', { class: 'tree-item-icon' }, faviconEl(item.url, 'globe', 14)),
    h('span', { class: 'tree-item-inner' }, item.title || item.url),
    h('span', { class: 'tree-item-flair' }, new Date(item.lastVisit).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))));
  }
  content.replaceChildren(...out);
}

function renderDownloads() {
  if (state.settings.sidebarView !== 'downloads' || !state.settings.sidebarOpen) return;
  const list = [...state.downloads.values()].reverse();
  $('sidebar-content').replaceChildren(...(list.length ? list.map((d) => {
    const done = d.state === 'completed';
    const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
    return h('div', { class: 'download-item', ondblclick: () => done && L.downloads.open(d.path) },
      h('div', { class: 'download-name', title: d.path }, d.filename),
      d.state === 'progressing' ? h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })) : null,
      h('div', { class: 'download-meta' },
        h('span', { style: { flex: 1 } }, done ? formatBytes(d.total || d.received)
          : d.state === 'progressing' ? `${formatBytes(d.received)} of ${d.total ? formatBytes(d.total) : '?'}`
          : d.state === 'cancelled' ? 'Cancelled' : 'Failed'),
        done ? h('button', { class: 'clickable-icon', title: 'Open', onclick: () => L.downloads.open(d.path) }, icon('external-link', 13)) : null,
        done ? h('button', { class: 'clickable-icon', title: 'Show in folder', onclick: () => L.downloads.show(d.path) }, icon('folder', 13)) : null,
        d.state === 'progressing' ? h('button', { class: 'clickable-icon', title: 'Cancel', onclick: () => L.downloads.cancel(d.id) }, icon('x', 13)) : null));
  }) : [h('div', { class: 'empty-state' }, 'No downloads yet.')]));
}

function bindSidebarResize() {
  const handle = $('sidebar-resize');
  const saved = parseInt(localStorage.getItem('sidebar-width'), 10);
  if (saved) document.documentElement.style.setProperty('--sidebar-width', saved + 'px');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = $('sidebar').offsetWidth;
    document.body.classList.add('is-resizing');
    handle.classList.add('is-dragging');
    const move = (ev) => {
      const w = Math.max(180, Math.min(520, startW + ev.clientX - startX));
      document.documentElement.style.setProperty('--sidebar-width', w + 'px');
    };
    const up = () => {
      document.body.classList.remove('is-resizing');
      handle.classList.remove('is-dragging');
      localStorage.setItem('sidebar-width', $('sidebar').offsetWidth);
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

// ============================================================
// Popovers: Link Protect, VPN, extensions, passwords
// ============================================================
function openShieldPopover(anchor = $('btn-shield')) {
  const tab = activeTab();
  const s = state.settings;
  showPopover([
    h('h3', {}, icon(s.adblock.enabled ? 'shield-check' : 'shield-off', 18), 'Link Protect'),
    h('div', { class: 'popover-sub' }, s.adblock.enabled ? `Blocking ads & trackers${tab && !isInternal(tab.url) ? ' on ' + hostOf(tab.url) : ''}` : 'Ad & tracker blocking is off'),
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat-card' }, h('div', { class: 'big-stat' }, String(tab?.blocked || 0)), h('div', { class: 'label' }, 'Blocked on this page')),
      h('div', { class: 'stat-card' }, h('div', { class: 'big-stat' }, state.totalBlocked.toLocaleString()), h('div', { class: 'label' }, 'Blocked this session'))),
    h('div', { class: 'row' }, 'Block ads & trackers', toggle(s.adblock.enabled, (v) => setSettings({ adblock: { enabled: v } }).then(() => notice(v ? 'Ad blocking on — reload to apply' : 'Ad blocking off — reload to apply')))),
    h('div', { class: 'row' }, 'Block cookie banners & annoyances', toggle(s.adblock.level === 'full', (v) => setSettings({ adblock: { level: v ? 'full' : 'adsAndTracking' } }))),
    h('div', { class: 'row' }, 'HTTPS-only mode', toggle(s.httpsOnly, (v) => setSettings({ httpsOnly: v }))),
    h('div', { class: 'row' }, 'Tell sites not to sell my data (GPC)', toggle(s.gpc, (v) => setSettings({ gpc: v }))),
    h('div', { class: 'popover-footer' },
      btn('Reload page', () => { closeFloating(); tab?.ready && tab.wv.reload(); }),
      btn('Protection settings', () => openSettings('protection'), 'mod-cta')),
  ], anchor);
}

async function refreshVpnInfo() {
  try {
    state.vpnInfo = await L.vpnCheck();
  } catch {
    state.vpnInfo = { error: true };
  }
  renderStatusBar();
  return state.vpnInfo;
}

// A site (usually a search engine) blocked the VPN: let you choose what to do, never decide for you.
function onVpnBlocked({ id, name, host, retryUrl, query }) {
  const tab = state.tabs.find((t) => t.wcId === id);
  if (!tab) return;
  const el = notice(h('div', { class: 'notice-body' },
    h('div', {}, h('b', {}, name), ' blocks VPN connections.'),
    h('div', { class: 'notice-actions' },
      btn(`Open ${name} without VPN`, async () => {
        el.remove();
        await setSettings({ vpn: { bypass: [...new Set([...(state.settings.vpn.bypass || []), host])] } });
        loadIn(tab, retryUrl);
      }, 'mod-cta'),
      query ? btn('Use Link Search', () => { el.remove(); loadIn(tab, `link://search/?q=${encodeURIComponent(query)}`); }) : null)),
  { timeout: 20000 });
}

async function onVpnStatus(status) {
  const prev = state.vpnStatus.state;
  state.vpnStatus = status;
  renderStatusBar();
  if (isVpnPopoverOpen()) openVpnPopover();
  if (status.state === 'connected' && prev !== 'connected' && state.settings.vpn.enabled) {
    const r = await refreshVpnInfo();
    notice(r.error ? 'VPN is on, but the connection test failed. Check the server settings.' : `VPN connected — sites now see you in ${r.country}`, { type: r.error ? 'error' : 'success', timeout: 6000 });
    if (isVpnPopoverOpen()) openVpnPopover();
  }
  if (status.state === 'off' && prev !== 'off') notice('VPN off');
  if (status.state === 'error') notice(status.message, { type: 'error', timeout: 8000 });
}

const VPN_COUNTRIES = [['', 'Fastest (automatic)'], ['us', 'United States'], ['ca', 'Canada'], ['gb', 'United Kingdom'], ['de', 'Germany'], ['nl', 'Netherlands'], ['fr', 'France'], ['ch', 'Switzerland'], ['se', 'Sweden'], ['no', 'Norway'], ['fi', 'Finland'], ['at', 'Austria'], ['pl', 'Poland'], ['ro', 'Romania'], ['es', 'Spain'], ['it', 'Italy'], ['lu', 'Luxembourg'], ['is', 'Iceland'], ['jp', 'Japan'], ['sg', 'Singapore'], ['au', 'Australia']];

function vpnLabel() {
  const v = state.settings.vpn;
  return v.mode === 'tor' ? `Link VPN${v.country ? ' · ' + VPN_COUNTRIES.find(([c]) => c === v.country)?.[1] : ''}` : v.mode === 'pac' ? 'PAC script' : `${(v.type || 'socks5').toUpperCase()} ${v.host || 'proxy'}`;
}

const isVpnPopoverOpen = () => !!activeFloating?.el.querySelector('.vpn-hero');

// Opens the VPN panel, or refreshes it in place if it's already open, so it never jumps or closes
// while the VPN connects. Status-bar items are redrawn constantly, so the panel anchors to the
// toolbar button instead.
function openVpnPopover(anchor) {
  if (!anchor || !anchor.isConnected || anchor.closest('#status-bar')) anchor = $('btn-vpn');
  const v = state.settings.vpn;
  const info = state.vpnInfo;
  const orb = h('div', { class: `vpn-orb ${v.enabled ? 'is-on' : ''}` }, icon('globe-lock', 22));
  const vs = state.vpnStatus;
  const sub = h('div', { class: 'vpn-status-sub' }, !v.enabled ? 'Your real IP address is visible to sites'
    : vs.state === 'connecting' ? (vs.step === 'download' ? `Setting up for the first time… ${vs.percent}%` : `Connecting… ${vs.percent}%`)
    : vs.state === 'error' ? vs.message
    : info?.error ? 'Can’t reach the network through this route'
    : info?.ip ? `${info.ip} · ${[info.city, info.country].filter(Boolean).join(', ')}` : 'Checking…');
  const configured = v.mode === 'tor' || (v.mode === 'custom' && v.host && v.port) || (v.mode === 'pac' && v.pac);
  const content = [
    h('div', { class: 'vpn-hero' }, orb, h('div', {},
      h('div', { class: 'vpn-status-title' }, v.enabled ? `Protected via ${vpnLabel()}` : 'VPN is off'), sub)),
    h('div', { class: 'row' }, 'VPN', toggle(v.enabled, async (on) => {
      if (on && !configured) { closeFloating(); openSettings('vpn'); return notice('Set up a VPN server first'); }
      state.vpnInfo = null;
      await setSettings({ vpn: { enabled: on } });
      openVpnPopover();
    })),
    h('div', { class: 'row' }, 'Route', dropdown([['tor', 'Link VPN (free)'], ['custom', 'My VPN / proxy server'], ['pac', 'PAC script']], v.mode, async (mode) => {
      state.vpnInfo = null;
      await setSettings({ vpn: { mode } });
      openVpnPopover();
    })),
    v.mode === 'tor' ? h('div', { class: 'row' }, 'Country', dropdown(VPN_COUNTRIES, v.country || '', async (country) => {
      state.vpnInfo = null;
      await setSettings({ vpn: { country } });
      openVpnPopover();
    })) : null,
    h('div', { class: 'popover-footer' },
      btn('Check my IP', async () => { await refreshVpnInfo(); openVpnPopover(); }),
      btn('VPN settings', () => openSettings('vpn'), 'mod-cta')),
  ];
  if (isVpnPopoverOpen()) activeFloating.el.replaceChildren(...content.filter(Boolean));
  else showPopover(content, anchor);
  if (v.enabled && !info && vs.state === 'connected') refreshVpnInfo().then(() => isVpnPopoverOpen() && openVpnPopover());
}

async function openExtensionsPopover(anchor = $('btn-extensions')) {
  const list = (await L.extensions.list()).filter((e) => e.enabled);
  showPopover([
    h('h3', {}, icon('puzzle', 18), 'Extensions'),
    h('div', { class: 'popover-sub' }, list.length ? 'Click an extension to open it.' : 'No extensions installed yet.'),
    h('div', {}, list.map((ext) => h('div', {
      class: 'ext-row',
      onclick: () => { closeFloating(); ext.popup ? L.extensions.open(ext.id, 'popup') : ext.options ? L.extensions.open(ext.id, 'options') : notice(`${ext.name} has no popup — it works automatically on pages.`); },
    },
    ext.icon ? h('img', { src: ext.icon }) : h('span', { class: 'ext-icon' }, icon('puzzle', 13)),
    h('span', { class: 'ext-name' }, ext.name),
    ext.options ? h('button', { class: 'clickable-icon', title: 'Options', onclick: (e) => { e.stopPropagation(); closeFloating(); L.extensions.open(ext.id, 'options'); } }, icon('settings', 14)) : null))),
    h('div', { class: 'popover-footer' },
      btn('Chrome Web Store', () => { closeFloating(); createTab({ url: 'https://chromewebstore.google.com/' }); }),
      btn('Manage', () => openSettings('extensions'), 'mod-cta')),
  ], anchor);
}

async function installFromStore(id) {
  const n = notice('Installing extension…', { timeout: 0 });
  try {
    const ext = await L.extensions.install(id);
    notice(`“${ext.name}” added to Link`, { type: 'success' });
  } catch (err) {
    notice(`Couldn’t install: ${cleanError(err)}`, { type: 'error', timeout: 7000 });
  } finally { n.remove(); }
}
const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function checkPasswords(tab) {
  const keyBtn = $('btn-key');
  if (!tab || tab.private || !/^https?:/.test(tab.url)) return keyBtn.classList.add('hidden');
  const logins = await L.passwords.forOrigin(tab.url);
  if (tab.id !== state.activeId) return;
  keyBtn.classList.toggle('hidden', !logins.length);
  keyBtn.onclick = () => showMenu([
    { label: 'Fill saved login' },
    ...logins.map((l) => ({ title: l.username || '(no username)', icon: 'key', onClick: async () => {
      const ok = await L.passwords.fill(tab.wcId, l.id);
      if (!ok) notice('No login form found on this page.');
    } })),
    '-',
    { title: 'Manage passwords…', icon: 'settings', onClick: () => openSettings('passwords') },
  ], keyBtn);
}

function mainMenu(anchor) {
  const tab = activeTab();
  showMenu([
    { title: 'New tab', icon: 'plus', hint: 'Ctrl+T', onClick: () => createTab() },
    { title: 'New private tab', icon: 'incognito', hint: 'Ctrl+Shift+N', onClick: () => createTab({ private: true }) },
    '-',
    { title: 'Bookmarks', icon: 'bookmark', hint: 'Ctrl+Shift+O', onClick: () => showSidebar('bookmarks') },
    { title: 'History', icon: 'history', hint: 'Ctrl+H', onClick: () => showSidebar('history') },
    { title: 'Downloads', icon: 'download', hint: 'Ctrl+J', onClick: () => showSidebar('downloads') },
    { title: 'Passwords', icon: 'key', onClick: () => openSettings('passwords') },
    { title: 'Extensions', icon: 'puzzle', onClick: () => openSettings('extensions') },
    '-',
    { title: 'Find in page', icon: 'search', hint: 'Ctrl+F', onClick: openFind },
    { title: 'Zoom in', icon: 'zoom-in', hint: 'Ctrl+=', onClick: () => zoom(1) },
    { title: 'Zoom out', icon: 'zoom-out', hint: 'Ctrl+-', onClick: () => zoom(-1) },
    { title: 'Print…', icon: 'printer', onClick: () => tab?.ready && tab.wv.print() },
    { title: 'Save page as…', icon: 'save', hint: 'Ctrl+S', onClick: () => runAction('save-page') },
    '-',
    { title: 'Import browser data', icon: 'import', onClick: () => openSettings('import') },
    { title: 'Developer tools', icon: 'code', hint: 'F12', onClick: () => runAction('devtools') },
    { title: 'Settings', icon: 'settings', hint: 'Ctrl+,', onClick: () => openSettings() },
  ], anchor);
}

// ============================================================
// Find in page
// ============================================================
function openFind() {
  $('find-bar').classList.remove('hidden');
  $('find-input').focus();
  $('find-input').select();
}
function closeFind() {
  if ($('find-bar').classList.contains('hidden')) return;
  $('find-bar').classList.add('hidden');
  $('find-count').textContent = '';
  const tab = activeTab();
  if (tab?.ready) tab.wv.stopFindInPage('clearSelection');
}
function bindFind() {
  const input = $('find-input');
  const find = (opts = {}) => {
    const tab = activeTab();
    if (!tab?.ready) return;
    if (!input.value) { tab.wv.stopFindInPage('clearSelection'); $('find-count').textContent = ''; return; }
    tab.wv.findInPage(input.value, opts);
  };
  input.addEventListener('input', () => find());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') find({ findNext: true, forward: !e.shiftKey });
    if (e.key === 'Escape') { closeFind(); activeTab()?.wv.focus(); }
  });
  $('find-next').onclick = () => find({ findNext: true, forward: true });
  $('find-prev').onclick = () => find({ findNext: true, forward: false });
  $('find-close').onclick = closeFind;
}

// ============================================================
// Commands (shortcuts, ribbon, command palette)
// ============================================================
const COMMANDS = [
  ['new-tab', 'New tab', 'plus', 'Ctrl+T'],
  ['private-tab', 'New private tab', 'incognito', 'Ctrl+Shift+N'],
  ['close-tab', 'Close current tab', 'x', 'Ctrl+W'],
  ['reopen-tab', 'Reopen closed tab', 'rotate-ccw', 'Ctrl+Shift+T'],
  ['duplicate-tab', 'Duplicate tab', 'copy'],
  ['focus-address', 'Focus address bar', 'search', 'Ctrl+L'],
  ['quick-switcher', 'Quick switcher: tabs, bookmarks & history', 'search', 'Ctrl+E'],
  ['reload', 'Reload page', 'rotate-cw', 'Ctrl+R'],
  ['hard-reload', 'Hard reload (ignore cache)', 'rotate-cw', 'Ctrl+Shift+R'],
  ['home', 'Go to homepage', 'home', 'Alt+Home'],
  ['bookmark', 'Bookmark this page', 'bookmark-plus', 'Ctrl+D'],
  ['bookmarks', 'Show bookmarks', 'bookmark', 'Ctrl+Shift+O'],
  ['history', 'Show history', 'history', 'Ctrl+H'],
  ['downloads', 'Show downloads', 'download', 'Ctrl+J'],
  ['toggle-sidebar', 'Toggle sidebar', 'panel-left', 'Ctrl+\\'],
  ['find', 'Find in page', 'search', 'Ctrl+F'],
  ['zoom-in', 'Zoom in', 'zoom-in', 'Ctrl+='],
  ['zoom-out', 'Zoom out', 'zoom-out', 'Ctrl+-'],
  ['zoom-reset', 'Reset zoom', 'search', 'Ctrl+0'],
  ['mute-tab', 'Mute / unmute tab', 'volume-x'],
  ['print', 'Print page', 'printer'],
  ['save-page', 'Save page as…', 'save', 'Ctrl+S'],
  ['view-source', 'View page source', 'code', 'Ctrl+U'],
  ['devtools', 'Toggle developer tools', 'code', 'F12'],
  ['protection', 'Open Link Protect', 'shield'],
  ['toggle-adblock', 'Toggle ad & tracker blocker', 'shield'],
  ['vpn', 'Open VPN panel', 'globe-lock'],
  ['toggle-vpn', 'Toggle VPN', 'globe-lock'],
  ['extensions', 'Show extensions', 'puzzle'],
  ['import', 'Import data from another browser', 'import'],
  ['passwords', 'Open passwords', 'key'],
  ['clear-data', 'Clear browsing data', 'trash', 'Ctrl+Shift+Del'],
  ['settings', 'Open settings', 'settings', 'Ctrl+,'],
  ['settings-search', 'Settings: search engines', 'search'],
  ['toggle-theme', 'Toggle light / dark theme', 'palette'],
  ['command-palette', 'Open command palette', 'command', 'Ctrl+P'],
];

function runAction(action, anchor) {
  const tab = activeTab();
  const ready = tab?.ready;
  const tabMatch = /^tab-(\d)$/.exec(action);
  if (tabMatch) {
    const n = +tabMatch[1];
    const t = n === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[n - 1];
    return t && activateTab(t.id);
  }
  switch (action) {
    case 'new-tab': return createTab();
    case 'private-tab': return createTab({ private: true });
    case 'close-tab': return tab && closeTab(tab.id);
    case 'reopen-tab': return reopenTab();
    case 'duplicate-tab': return tab && createTab({ url: tab.url, private: tab.private });
    case 'next-tab':
    case 'prev-tab': {
      const i = state.tabs.indexOf(tab) + (action === 'next-tab' ? 1 : -1);
      return activateTab(state.tabs[(i + state.tabs.length) % state.tabs.length].id);
    }
    case 'focus-address': return focusAddress();
    case 'reload': return ready && tab.wv.reload();
    case 'hard-reload': return ready && tab.wv.reloadIgnoringCache();
    case 'back': return ready && tab.wv.canGoBack() && tab.wv.goBack();
    case 'forward': return ready && tab.wv.canGoForward() && tab.wv.goForward();
    case 'home': return navigateTo(homepage());
    case 'bookmark': return addBookmark();
    case 'bookmarks': return showSidebar('bookmarks');
    case 'history': return showSidebar('history');
    case 'downloads': return showSidebar('downloads');
    case 'toggle-sidebar': return setSettings({ sidebarOpen: !state.settings.sidebarOpen });
    case 'find': return openFind();
    case 'zoom-in': return zoom(1);
    case 'zoom-out': return zoom(-1);
    case 'zoom-reset': return zoom(0);
    case 'mute-tab': return tab && toggleMute(tab);
    case 'print': return ready && tab.wv.print();
    case 'save-page': return ready && L.savePage(tab.wcId);
    case 'view-source': return tab && !isInternal(tab.url) && createTab({ url: 'view-source:' + tab.url });
    case 'devtools': return ready && (tab.wv.isDevToolsOpened() ? tab.wv.closeDevTools() : tab.wv.openDevTools());
    case 'protection': return openShieldPopover(anchor);
    case 'toggle-adblock': return setSettings({ adblock: { enabled: !state.settings.adblock.enabled } }).then((s) => notice(`Ad blocker ${s.adblock.enabled ? 'on' : 'off'}`));
    case 'vpn': return openVpnPopover(anchor);
    case 'toggle-vpn': state.vpnInfo = null; return setSettings({ vpn: { enabled: !state.settings.vpn.enabled } });
    case 'extensions': return openExtensionsPopover(anchor);
    case 'import': return openSettings('import');
    case 'passwords': return openSettings('passwords');
    case 'clear-data': return openSettings('protection');
    case 'settings': return openSettings();
    case 'settings-search': return openSettings('search');
    case 'toggle-theme': return setSettings({ theme: document.body.classList.contains('theme-dark') ? 'light' : 'dark' });
    case 'command-palette': return openCommandPalette();
    case 'quick-switcher': return openQuickSwitcher();
    case 'help': return openSettings('shortcuts');
  }
}

function openCommandPalette() {
  openPrompt({
    placeholder: 'Select a command…',
    getItems: (q) => {
      const engineCmds = state.engines.map((e) => ['', `Switch search engine to ${e.name}`, e, '', () => setSettings({ searchEngine: e.id })]);
      return [...COMMANDS, ...engineCmds]
        .map(([id, name, ic, key, run]) => ({ m: fuzzyMatch(q, name), id, name, ic, key, run }))
        .filter((c) => c.m && c.id !== 'command-palette')
        .sort((a, b) => b.m.score - a.m.score)
        .map((c) => ({ title: c.name, ranges: c.m.ranges, ...(typeof c.ic === 'string' ? { icon: c.ic } : { img: engineIcon(c.ic) }), hint: c.key, run: c.run || (() => runAction(c.id)) }));
    },
  });
}

async function openQuickSwitcher() {
  openPrompt({
    placeholder: 'Find a tab, bookmark or page from your history…',
    instructions: [['↑↓', 'to navigate'], ['↵', 'to open'], ['esc', 'to dismiss']],
    getItems: async (q) => {
      const seen = new Set();
      const out = [];
      const add = (title, url, note, ic, run) => {
        if (seen.has(url)) return;
        const m = fuzzyMatch(q, title + ' ' + url);
        if (!m) return;
        seen.add(url);
        out.push({ title, note, img: faviconEl(url, ic), score: m.score + (ic === 'tabs' ? 20 : ic === 'bookmark' ? 10 : 0), ranges: m.ranges.filter(([a, b]) => b <= title.length), run });
      };
      for (const t of state.tabs) add(t.title || t.url, t.url, `Open tab · ${prettyUrl(t.url)}`, 'tabs', () => activateTab(t.id));
      for (const b of state.flatBookmarks) add(b.title, b.url, `Bookmark · ${b.url}`, 'bookmark', () => navigateTo(b.url));
      for (const hi of await L.history.search(q.split(' ')[0] || '', 60)) add(hi.title || hi.url, hi.url, `History · ${timeAgo(hi.lastVisit)}`, 'history', () => navigateTo(hi.url));
      out.sort((a, b) => b.score - a.score);
      if (q.trim()) out.push({ title: `Search ${currentEngine().name} for “${q}”`, img: engineIcon(currentEngine()), run: () => navigate(q) });
      return out.slice(0, 40);
    },
  });
}

// ============================================================
// Settings sync
// ============================================================
async function setSettings(patch) {
  const s = await L.setSettings(patch);
  onSettings(s);
  return s;
}
async function onSettings(s) {
  const prevSidebar = state.settings && `${state.settings.sidebarOpen}|${state.settings.sidebarView}`;
  state.settings = s;
  state.engines = await L.getEngines();
  applyTheme();
  updateChrome();
  if (prevSidebar !== `${s.sidebarOpen}|${s.sidebarView}`) renderSidebar();
  else renderSidebarChrome();
}

// ============================================================
// Boot
// ============================================================
async function boot() {
  const s = await L.getState();
  state.settings = s.settings;
  state.engines = s.engines;
  state.platform = s.platform;
  state.versions = s.versions;
  state.downloadsDir = s.downloadsDir;
  state.totalBlocked = s.stats.total;
  document.body.classList.add(`platform-${s.platform}`);
  applyTheme();
  hydrateIcons();
  setBookmarks(s.bookmarks);

  document.querySelectorAll('[data-action]').forEach((el) => el.addEventListener('click', (e) => runAction(el.dataset.action, e.currentTarget)));
  $('btn-back').onclick = () => runAction('back');
  $('btn-forward').onclick = () => runAction('forward');
  $('btn-reload').onclick = () => { const t = activeTab(); if (t?.ready) t.loading ? t.wv.stop() : t.wv.reload(); };
  $('btn-star').onclick = () => addBookmark();
  $('btn-shield').onclick = (e) => openShieldPopover(e.currentTarget);
  $('btn-vpn').onclick = (e) => openVpnPopover(e.currentTarget);
  $('btn-extensions').onclick = (e) => openExtensionsPopover(e.currentTarget);
  $('btn-menu').onclick = (e) => mainMenu(e.currentTarget);
  $('btn-store-install').onclick = () => { const id = webStoreId(activeTab()?.url); if (id) installFromStore(id); };
  bindOmnibox();
  bindFind();
  bindSidebarResize();

  L.on.shortcut((action) => runAction(action));
  L.on.openTab(({ url, private: priv, background }) => createTab({ url, private: !!priv, background: !!background }));
  L.on.settings((settings) => onSettings(settings));
  L.on.bookmarks((tree) => setBookmarks(tree));
  L.on.fullscreen((on) => document.body.classList.toggle('is-fullscreen', on));
  L.on.vpnStatus(onVpnStatus);
  L.on.notice((message) => notice(message, { timeout: 6000 }));
  L.on.guestMousedown(() => { hideSuggestions(); closeFloating(); });
  L.on.vpnBlocked(onVpnBlocked);
  state.vpnStatus = s.vpnStatus;
  L.on.blocked(({ id, count, total }) => {
    state.totalBlocked = total;
    const tab = state.tabs.find((t) => t.wcId === id);
    if (tab) tab.blocked = count;
    if (tab?.id === state.activeId) updateShield();
    clearTimeout(L.statusTimer);
    L.statusTimer = setTimeout(renderStatusBar, 250);
  });
  L.on.download((d) => {
    const isNew = !state.downloads.has(d.id);
    state.downloads.set(d.id, d);
    if (isNew) notice(`Downloading ${d.filename}`);
    if (d.state === 'completed') notice(h('span', {}, `Downloaded ${d.filename} · `, h('span', { class: 'link-text', onclick: () => L.downloads.show(d.path) }, 'Show in folder')), { type: 'success' });
    renderDownloads();
  });

  const saved = s.settings.restoreTabs ? s.session.tabs.filter((t) => t.url) : [];
  if (saved.length) {
    const activeIndex = Math.max(0, saved.findIndex((t) => t.active));
    saved.forEach((t, i) => createTab({ url: t.url, title: t.title, background: true, lazy: i !== activeIndex, index: i }));
    activateTab(state.tabs[activeIndex].id);
  } else createTab();

  renderSidebar();
  if (s.settings.vpn.enabled && s.vpnStatus.state === 'connected') refreshVpnInfo();
  if (!s.settings.onboarded) openWelcome();
}

// settings.js loads after this file, so wait for every script before booting.
window.addEventListener('DOMContentLoaded', boot);
