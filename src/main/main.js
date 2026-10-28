const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, session, protocol, net, Menu, clipboard, dialog, shell, nativeTheme } = require('electron');

app.setName('Link');
if (!app.requestSingleInstanceLock()) app.quit();

const store = require('./store');
const protection = require('./protection');
const extensions = require('./extensions');
const importer = require('./importer');
const passwords = require('./passwords');
const linkSearch = require('./linkSearch');
const answers = require('./answers');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, '..', 'assets');
const PERSIST_PARTITION = 'persist:link';
const API_TOKEN = require('crypto').randomBytes(16).toString('hex');
const PRIVATE_PARTITION = 'link-private';

protocol.registerSchemesAsPrivileged([
  { scheme: 'link', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
let vpnStatus = { state: 'off' };
let mainSes, privateSes;
const send = (channel, ...args) => win && !win.isDestroyed() && win.webContents.send(channel, ...args);

// ---------- link:// internal pages ----------
const PAGES = {
  newtab: { '/': 'newtab.html', '/newtab.css': 'newtab.css', '/newtab.js': 'newtab.js' },
  search: { '/': 'search.html', '/search.css': 'search.css', '/search.js': 'search.js', '/answers.js': 'answers.js' },
};

async function handleLinkProtocol(req) {
  const url = new URL(req.url);
  const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  const pages = PAGES[url.hostname];
  if (!pages) return new Response('Not found', { status: 404 });
  // Only Link's own pages know the per-launch token, so web pages can't call the API.
  if (url.pathname.startsWith('/api/') && req.headers.get('x-link-token') !== API_TOKEN) return new Response('Forbidden', { status: 403 });
  if (url.pathname === '/api/results') {
    const q = url.searchParams.get('q') || '';
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const ql = q.toLowerCase();
    const seenTitles = new Set();
    const library = page === 1 && ql ? [
      ...store.flatBookmarks().filter((b) => (b.title + ' ' + b.url).toLowerCase().includes(ql)).map((b) => ({ title: b.title, url: b.url, kind: 'Bookmark' })),
      ...store.searchHistory(q, 40).map((h) => ({ title: h.title, url: h.url, kind: 'History' })),
    ].filter((item) => !(searchEngineFor(item.url) && searchQueryOf(item.url)) && /^https?:/.test(item.url)) // your past searches aren't useful here
      .filter((item) => { const k = (item.title || item.url).toLowerCase(); return !seenTitles.has(k) && seenTitles.add(k); })
      .slice(0, 5) : [];
    const data = q ? await linkSearch.search(q, page).catch((err) => ({ error: 'status', status: err.message })) : { results: [] };
    const others = store.engines().filter((e) => e.id !== 'link' && e.builtin).slice(0, 8).map(({ id, name, url: u, icon }) => ({ id, name, url: u, icon }));
    return json({ ...data, library, others, theme: store.getSettings().theme });
  }
  const answer = /^\/api\/answer\/([a-z]+)$/.exec(url.pathname);
  if (answer) return json(await answers.handle(answer[1], url.searchParams));
  if (url.pathname === '/api/state') {
    const s = store.getSettings();
    return json({
      engines: store.engines().map(({ id, name, url: u, icon }) => ({ id, name, url: u, icon })),
      engine: store.currentEngine().id,
      topSites: store.topSites(8),
      bookmarks: store.flatBookmarks().slice(0, 8),
      theme: s.theme,
      accent: s.accent,
      blocked: protection.getStats().total,
      vpn: s.vpn.enabled,
    });
  }
  if (url.pathname === '/api/engine') {
    const id = url.searchParams.get('id');
    if (store.engines().some((e) => e.id === id)) send('settings', store.setSettings({ searchEngine: id }));
    return json({ ok: true });
  }
  const brand = /^\/brands\/([a-z0-9-]+\.png)$/.exec(url.pathname);
  if (brand) return net.fetch(pathToFileURL(path.join(ASSETS, 'brands', brand[1])).toString());
  if (url.pathname === '/icon.png') return net.fetch(pathToFileURL(path.join(ASSETS, 'icon.png')).toString());
  const file = pages[url.pathname];
  if (!file) return new Response('Not found', { status: 404 });
  const filePath = path.join(ROOT, 'pages', file);
  if (file.endsWith('.html')) {
    const html = fs.readFileSync(filePath, 'utf8').replace('__LINK_TOKEN__', API_TOKEN);
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return net.fetch(pathToFileURL(filePath).toString());
}

// ---------- window ----------
const TITLEBAR = { dark: { color: '#262626', symbolColor: '#dadada' }, light: { color: '#f6f6f6', symbolColor: '#222222' } };
const resolvedTheme = () => {
  const t = store.getSettings().theme;
  return t === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : t;
};

function createWindow() {
  const theme = resolvedTheme();
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'Link',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { ...TITLEBAR[theme], height: 40 },
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => handleShortcut(e, input));
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));
  win.on('closed', () => { win = null; });
}

function updateTitleBar() {
  if (win && process.platform !== 'darwin') win.setTitleBarOverlay(TITLEBAR[resolvedTheme()]);
}

// ---------- keyboard shortcuts (shared by the shell and every page) ----------
function shortcutFor(input) {
  if (input.type !== 'keyDown') return null;
  const mod = process.platform === 'darwin' ? input.meta : input.control;
  const k = input.key.toLowerCase();
  if (input.key === 'F5') return input.control || input.shift ? 'hard-reload' : 'reload';
  if (input.key === 'F12') return 'devtools';
  if (input.key === 'F11') return 'fullscreen';
  if (input.alt && !mod && input.key === 'ArrowLeft') return 'back';
  if (input.alt && !mod && input.key === 'ArrowRight') return 'forward';
  if (input.alt && !mod && input.key === 'Home') return 'home';
  if (!mod || input.alt) return null;
  if (input.key === 'Tab') return input.shift ? 'prev-tab' : 'next-tab';
  if (/^[1-9]$/.test(input.key)) return `tab-${input.key}`;
  const map = input.shift
    ? { n: 'private-tab', t: 'reopen-tab', r: 'hard-reload', i: 'devtools', b: 'toggle-sidebar', o: 'bookmarks', delete: 'clear-data' }
    : { t: 'new-tab', w: 'close-tab', l: 'focus-address', r: 'reload', p: 'command-palette', ',': 'settings', f: 'find', d: 'bookmark', h: 'history', j: 'downloads', '=': 'zoom-in', '+': 'zoom-in', '-': 'zoom-out', 0: 'zoom-reset', '\\': 'toggle-sidebar', e: 'quick-switcher', k: 'focus-address', s: 'save-page', u: 'view-source' };
  return map[k] || null;
}
function handleShortcut(e, input) {
  const action = shortcutFor(input);
  if (!action) return;
  e.preventDefault();
  if (action === 'fullscreen') return win?.setFullScreen(!win.isFullScreen());
  send('shortcut', action);
}

// ---------- search pages ----------
const hostKey = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function searchEngineFor(url) {
  const host = hostKey(url);
  return host && store.engines().find((e) => e.id !== 'link' && hostKey(e.url.replace('%s', '')) === host);
}
function searchQueryOf(url) {
  try {
    const p = new URL(url).searchParams;
    return p.get('q') || p.get('p') || p.get('query') || p.get('search_query') || p.get('search') || '';
  } catch { return ''; }
}

// ---------- page (webview guest) wiring ----------
function setupGuest(contents) {
  protection.attachToGuest(contents);
  const isPrivate = () => contents.session === privateSes;

  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    // Sized popups (OAuth sign-in windows, etc.) keep their opener; everything else becomes a tab.
    if (disposition === 'new-window' && /width|height/.test(features)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#ffffff' } };
    }
    send('open-tab', { url, private: isPrivate(), background: disposition === 'background-tab' });
    return { action: 'deny' };
  });

  contents.on('before-input-event', (e, input) => handleShortcut(e, input));

  // Some search engines answer VPN traffic with a robot check. Tell the shell, which offers to
  // open that site without the VPN (or to use Link Search) — it never switches engines by itself.
  let lastBlocked = { host: '', at: 0 };
  const reportBlocked = (name, retryUrl) => {
    const host = hostKey(retryUrl);
    if (!store.getSettings().vpn.enabled || (store.getSettings().vpn.bypass || []).includes(host)) return;
    if (lastBlocked.host === host && Date.now() - lastBlocked.at < 30000) return; // one notice per block
    lastBlocked = { host, at: Date.now() };
    send('vpn-blocked', { id: contents.id, name, host, retryUrl, query: searchQueryOf(retryUrl) });
  };
  const ROBOT_CHECK = /captcha|not a robot|unusual traffic|verify you are human|verification required|just a moment\.\.\.|are you a robot|attention required/;
  const GOOGLE_SORRY = /^https:\/\/(www\.)?google\.[a-z.]+\/sorry\//;
  // The address to retry once the block is out of the way (challenge pages add their own junk).
  const cleanRetryUrl = (url) => {
    try {
      const u = new URL(url);
      if (GOOGLE_SORRY.test(url)) return u.searchParams.get('continue') || url;
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('__cf')) u.searchParams.delete(k);
      return u.toString();
    } catch { return url; }
  };
  contents.on('did-navigate', (e, url) => { if (GOOGLE_SORRY.test(url)) reportBlocked('Google', cleanRetryUrl(url)); });
  const checkForRobotCheck = async (titleOnly) => {
    if (!store.getSettings().vpn.enabled) return;
    const url = contents.getURL();
    if (GOOGLE_SORRY.test(url)) return; // handled above
    const engine = searchEngineFor(url);
    if (!engine || !searchQueryOf(url)) return;
    const text = titleOnly ? contents.getTitle().toLowerCase() : await Promise.race([
      contents.executeJavaScript('(document.title + " " + (document.body ? document.body.innerText.slice(0, 3000) : "")).toLowerCase()'),
      new Promise((r) => setTimeout(() => r(''), 3000)),
    ]).catch(() => '');
    if (ROBOT_CHECK.test(text)) reportBlocked(engine.name, cleanRetryUrl(url));
  };
  contents.on('did-finish-load', () => checkForRobotCheck(false));
  contents.on('page-title-updated', () => checkForRobotCheck(true));

  // Panels and suggestions close when you click into the page.
  contents.on('before-mouse-event', (e, mouse) => { if (mouse.type === 'mouseDown') send('guest-mousedown'); });

  const record = (url) => {
    if (!isPrivate() && /^https?:/.test(url)) store.addHistory(url, contents.getTitle());
  };
  contents.on('did-navigate', (e, url) => record(url));
  contents.on('did-navigate-in-page', (e, url, isMainFrame) => isMainFrame && record(url));
  contents.on('page-title-updated', (e, title) => !isPrivate() && store.updateHistoryTitle(contents.getURL(), title));

  contents.on('context-menu', (e, p) => {
    const openTab = (url, priv = isPrivate()) => send('open-tab', { url, private: priv, background: true });
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => openTab(p.linkURL) },
        { label: 'Open link in private tab', click: () => openTab(p.linkURL, true) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open image in new tab', click: () => openTab(p.srcURL) },
        { label: 'Save image as…', click: () => contents.downloadURL(p.srcURL) },
        { label: 'Copy image', click: () => contents.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      for (const s of (p.dictionarySuggestions || []).slice(0, 4)) items.push({ label: s, click: () => contents.replaceMisspelling(s) });
      if (p.dictionarySuggestions?.length) items.push({ type: 'separator' });
      items.push(
        { role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' },
        { role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' }, { type: 'separator' },
      );
    } else if (p.selectionText) {
      const text = p.selectionText.trim();
      const short = text.length > 24 ? text.slice(0, 24) + '…' : text;
      items.push(
        { role: 'copy' },
        { label: `Search ${store.currentEngine().name} for “${short}”`, click: () => openTab(store.currentEngine().url.replace('%s', encodeURIComponent(text))) },
        { type: 'separator' },
      );
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText) {
      items.push(
        { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: 'Reload', click: () => contents.reload() },
        { type: 'separator' },
        { label: 'Save page as…', click: () => send('shortcut', 'save-page') },
        { label: 'Bookmark this page', click: () => send('shortcut', 'bookmark') },
        { type: 'separator' },
      );
    }
    items.push({ label: 'Inspect', click: () => contents.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

// ---------- downloads ----------
const downloads = new Map();
function setupDownloads(ses) {
  ses.on('will-download', (e, item) => {
    const id = store.uid();
    const dir = app.getPath('downloads');
    const { name, ext } = path.parse(item.getFilename());
    let target = path.join(dir, name + ext);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${name} (${i})${ext}`);
    item.setSavePath(target);
    downloads.set(id, item);
    const report = (state) => send('download', {
      id, state, filename: path.basename(target), path: target, url: item.getURL(),
      received: item.getReceivedBytes(), total: item.getTotalBytes(),
    });
    report('progressing');
    item.on('updated', (ev, state) => report(state === 'interrupted' ? 'interrupted' : 'progressing'));
    item.once('done', (ev, state) => { report(state); downloads.delete(id); });
  });
}

// ---------- search suggestions ----------
async function suggest(query) {
  const engine = store.currentEngine();
  const q = query.trim();
  const local = [
    ...store.flatBookmarks().filter((b) => (b.title + b.url).toLowerCase().includes(q.toLowerCase())).slice(0, 3).map((b) => ({ type: 'bookmark', title: b.title, url: b.url })),
    ...store.searchHistory(q, 5).map((h) => ({ type: 'history', title: h.title, url: h.url })),
  ].filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i).slice(0, 6);
  let remote = [];
  if (store.getSettings().suggestions && engine.id === 'link' && q && !/^[@!]/.test(q)) {
    remote = (await linkSearch.suggest(q)).slice(0, 6).map((s) => ({ type: 'search', title: s }));
  } else if (store.getSettings().suggestions && engine.suggest && q && !q.startsWith('@') && !q.startsWith('!')) {
    try {
      const res = await mainSes.fetch(engine.suggest.replace('%s', encodeURIComponent(q)), { signal: AbortSignal.timeout(1500) });
      const data = await res.json();
      const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : Array.isArray(data) ? data.map((d) => d.phrase || d) : [];
      remote = list.filter((s) => typeof s === 'string').slice(0, 6).map((s) => ({ type: 'search', title: s }));
    } catch {}
  }
  return { local, remote };
}

// ---------- IPC ----------
function broadcastBookmarks() { send('bookmarks', store.getBookmarks()); }

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (e, ...args) => fn(...args));

  h('state:get', () => ({
    settings: store.getSettings(),
    engines: store.engines(),
    bookmarks: store.getBookmarks(),
    session: store.getSession(),
    platform: process.platform,
    versions: { app: app.getVersion(), chrome: process.versions.chrome, electron: process.versions.electron },
    downloadsDir: app.getPath('downloads'),
    stats: protection.getStats(),
    vpnStatus,
  }));

  h('settings:set', async (patch) => {
    const before = store.getSettings();
    const oldAdblock = JSON.stringify(before.adblock);
    const oldVpn = JSON.stringify(before.vpn);
    const oldTheme = before.theme;
    if (patch.vpn && 'password' in patch.vpn && patch.vpn.password !== undefined) patch.vpn.password = protection.encrypt(patch.vpn.password);
    const s = store.setSettings(patch);
    if (JSON.stringify(s.adblock) !== oldAdblock) await protection.applyAdblock().catch((err) => console.error('[adblock]', err));
    if (JSON.stringify(s.vpn) !== oldVpn) {
      await protection.applyProxyRules(); // quick: routing (and per-site exceptions) take effect now
      protection.applyProxy(); // may take a while: reports progress through 'vpn-status'
    }
    if (s.theme !== oldTheme) updateTitleBar();
    send('settings', s);
    return s;
  });
  h('engines:get', () => store.engines());

  h('bookmarks:add', (item, parentId) => { const n = store.addBookmark(item, parentId); broadcastBookmarks(); return n; });
  h('bookmarks:update', (id, patch) => { store.updateBookmark(id, patch); broadcastBookmarks(); });
  h('bookmarks:remove', (id) => { store.removeBookmark(id); broadcastBookmarks(); });
  h('bookmarks:move', (id, target, index) => { store.moveBookmark(id, target, index); broadcastBookmarks(); });

  h('history:search', (q, limit) => store.searchHistory(q, limit));
  h('history:remove', (url) => store.removeHistory(url));
  h('history:clear', () => store.clearHistory());
  h('suggest', (q) => suggest(q));
  h('upgrade-url', (url) => protection.upgradeUrl(url) || url);
  h('blocked:get', (id) => protection.getBlockedFor(id));
  h('session:save', (tabs) => store.saveSession(tabs));

  h('import:detect', async () => Promise.all(importer.detect().map(async (src) => {
    // Use the real icon of the installed browser.
    const exe = src.exe;
    delete src.exe;
    if (exe) {
      try { src.icon = (await app.getFileIcon(exe, { size: 'large' })).toDataURL(); } catch {}
    }
    return src;
  })));
  h('import:run', async (source, types) => {
    const r = await importer.run(source, types);
    broadcastBookmarks();
    return r;
  });
  h('import:file', async (kind) => {
    const filters = kind === 'passwords' ? [{ name: 'Passwords CSV', extensions: ['csv'] }] : [{ name: 'Bookmarks HTML', extensions: ['html', 'htm'] }];
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    if (canceled || !filePaths[0]) return null;
    const r = kind === 'passwords' ? importer.importPasswordsCsv(filePaths[0]) : importer.importBookmarksHtml(filePaths[0]);
    broadcastBookmarks();
    return r;
  });

  h('ext:list', () => extensions.list());
  h('ext:install', (input) => extensions.installFromStore(input));
  h('ext:unpacked', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Select an unpacked extension folder' });
    if (canceled || !filePaths[0]) return null;
    return extensions.installUnpacked(filePaths[0]);
  });
  h('ext:remove', (id) => extensions.remove(id));
  h('ext:toggle', (id, enabled) => extensions.setEnabled(id, enabled));
  h('ext:open', (id, kind) => extensions.openPage(id, kind, win));

  h('pw:list', () => passwords.list());
  h('pw:reveal', (id) => passwords.reveal(id));
  h('pw:remove', (id) => passwords.remove(id));
  h('pw:add', (entry) => passwords.add(entry));
  h('pw:for', (origin) => passwords.forOrigin(origin));
  h('pw:fill', async (webContentsId, id) => {
    const { webContents } = require('electron');
    const guest = webContents.fromId(webContentsId);
    const entry = passwords.list().find((p) => p.id === id);
    if (!guest || !entry) return false;
    const user = JSON.stringify(entry.username);
    const pass = JSON.stringify(passwords.reveal(id));
    return guest.executeJavaScript(`(() => {
      const visible = (el) => el && el.offsetParent !== null && !el.disabled;
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pw = [...document.querySelectorAll('input[type=password]')].find(visible);
      const inputs = [...document.querySelectorAll('input')].filter((i) => visible(i) && /^(text|email|tel|)$/.test(i.type));
      const user = pw ? inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING).pop() : inputs.find((i) => /user|mail|login/i.test(i.name + i.id + i.autocomplete));
      if (user) set(user, ${user});
      if (pw) set(pw, ${pass});
      return !!(user || pw);
    })()`);
  });

  h('vpn:check', () => protection.checkIp());
  h('data:clear', async ({ history, cookies, cache }) => {
    if (history) store.clearHistory();
    for (const ses of [mainSes, privateSes]) {
      if (cookies) await ses.clearStorageData();
      if (cache) await ses.clearCache();
    }
  });

  h('download:open', (p) => shell.openPath(p));
  h('download:show', (p) => shell.showItemInFolder(p));
  h('download:cancel', (id) => downloads.get(id)?.cancel());
  h('page:save', async (webContentsId) => {
    const { webContents } = require('electron');
    const guest = webContents.fromId(webContentsId);
    if (!guest) return;
    const name = (guest.getTitle() || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('downloads'), name + '.html'),
      filters: [{ name: 'Web page, complete', extensions: ['html'] }],
    });
    if (!canceled && filePath) await guest.savePage(filePath, 'HTMLComplete');
  });
  h('app:default-browser', () => {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
    if (process.platform === 'win32') shell.openExternal('ms-settings:defaultapps');
  });
}

// URLs passed on the command line (e.g. when Link is the default browser).
const urlsFrom = (argv) => argv.filter((a) => /^https?:\/\//i.test(a));

// macOS hands links to the default browser through 'open-url' (possibly before the window exists).
const pendingUrls = [];
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (win) send('open-tab', { url });
  else pendingUrls.push(url);
});

app.on('second-instance', (e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  for (const url of urlsFrom(argv)) send('open-tab', { url });
});

app.on('web-contents-created', (e, contents) => {
  if (contents.getType() === 'webview') setupGuest(contents);
});

app.on('will-attach-webview', (e, prefs, params) => {
  // Pages never get Node or a custom preload, whatever the shell asks for.
  delete prefs.preload;
  prefs.nodeIntegration = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  if (![PERSIST_PARTITION, PRIVATE_PARTITION].includes(params.partition)) e.preventDefault();
});

app.whenReady().then(async () => {
  store.load();
  mainSes = session.fromPartition(PERSIST_PARTITION);
  privateSes = session.fromPartition(PRIVATE_PARTITION);

  // Present as plain Chrome so sites don't treat Link as an unknown browser.
  const ua = mainSes.getUserAgent().replace(/\s(link-browser|Link)\/\S+/gi, '').replace(/\sElectron\/\S+/, '');
  app.userAgentFallback = ua;
  for (const ses of [mainSes, privateSes]) {
    ses.setUserAgent(ua);
    ses.protocol.handle('link', handleLinkProtocol);
    setupDownloads(ses);
  }
  protocol.handle('link', handleLinkProtocol);

  protection.init([mainSes, privateSes], (id, count, total) => send('blocked', { id, count, total }), (status) => {
    vpnStatus = status;
    send('vpn-status', status);
  });
  registerIpc();
  nativeTheme.on('updated', updateTitleBar);
  await extensions.init(mainSes);
  linkSearch.init(mainSes);
  answers.init(mainSes);
  // Windows/Linux: no menu bar (Link draws its own UI). macOS always has a menu bar, and its
  // Edit menu is what makes ⌘C / ⌘V / ⌘A work in text fields, so give it the standard menus.
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
  createWindow();
  const initial = [...urlsFrom(process.argv), ...pendingUrls];
  if (initial.length) win.webContents.once('did-finish-load', () => initial.forEach((url) => send('open-tab', { url })));
});

let quitting = false;
app.on('before-quit', async (e) => {
  store.flushAll();
  protection.stopVpn();
  if (quitting || !store.getSettings().clearOnExit) return;
  e.preventDefault();
  quitting = true;
  store.clearHistory();
  store.saveSession([]);
  await Promise.all([mainSes, privateSes].map((ses) => Promise.all([ses.clearStorageData(), ses.clearCache()])));
  store.flushAll();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
