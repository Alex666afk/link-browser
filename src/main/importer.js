// Imports bookmarks, history, extensions and passwords from other browsers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const initSqlJs = require('sql.js');
const store = require('./store');
const extensions = require('./extensions');
const passwords = require('./passwords');

const home = os.homedir();
const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const mac = path.join(home, 'Library', 'Application Support');
const linux = path.join(home, '.config');

const CHROMIUM_BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', win: [local, 'Google/Chrome/User Data'], mac: [mac, 'Google/Chrome'], linux: [linux, 'google-chrome'] },
  { id: 'edge', name: 'Microsoft Edge', win: [local, 'Microsoft/Edge/User Data'], mac: [mac, 'Microsoft Edge'], linux: [linux, 'microsoft-edge'] },
  { id: 'brave', name: 'Brave', win: [local, 'BraveSoftware/Brave-Browser/User Data'], mac: [mac, 'BraveSoftware/Brave-Browser'], linux: [linux, 'BraveSoftware/Brave-Browser'] },
  { id: 'vivaldi', name: 'Vivaldi', win: [local, 'Vivaldi/User Data'], mac: [mac, 'Vivaldi'], linux: [linux, 'vivaldi'] },
  { id: 'opera', name: 'Opera', win: [roaming, 'Opera Software/Opera Stable'], mac: [mac, 'com.operasoftware.Opera'], linux: [linux, 'opera'], single: true },
  { id: 'operagx', name: 'Opera GX', win: [roaming, 'Opera Software/Opera GX Stable'], mac: [mac, 'com.operasoftware.OperaGX'], single: true },
  { id: 'chromium', name: 'Chromium', win: [local, 'Chromium/User Data'], mac: [mac, 'Chromium'], linux: [linux, 'chromium'] },
  { id: 'arc', name: 'Arc', win: [local, 'Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data'], mac: [mac, 'Arc/User Data'] },
];
const FIREFOX = { win: [roaming, 'Mozilla/Firefox/Profiles'], mac: [mac, 'Firefox/Profiles'], linux: [home, '.mozilla/firefox'] };

const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], path.join(local, 'Programs'), local].filter(Boolean);
const EXES = {
  chrome: ['Google/Chrome/Application/chrome.exe'],
  edge: ['Microsoft/Edge/Application/msedge.exe'],
  brave: ['BraveSoftware/Brave-Browser/Application/brave.exe'],
  vivaldi: ['Vivaldi/Application/vivaldi.exe'],
  opera: ['Opera/opera.exe', 'Opera/launcher.exe'],
  operagx: ['Opera GX/opera.exe', 'Opera GX/launcher.exe'],
  chromium: ['Chromium/Application/chrome.exe'],
  firefox: ['Mozilla Firefox/firefox.exe'],
};
const MAC_APPS = {
  chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave Browser', vivaldi: 'Vivaldi', opera: 'Opera',
  operagx: 'Opera GX', chromium: 'Chromium', arc: 'Arc', firefox: 'Firefox',
};
function findExe(id) {
  if (process.platform === 'darwin') {
    const app = MAC_APPS[id] && [path.join('/Applications', `${MAC_APPS[id]}.app`), path.join(home, 'Applications', `${MAC_APPS[id]}.app`)].find((p) => fs.existsSync(p));
    return app || null;
  }
  if (process.platform !== 'win32') return null;
  for (const base of programFiles) {
    for (const rel of EXES[id] || []) {
      const p = path.join(base, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const platformKey = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const resolve = (parts) => (parts ? path.join(...parts) : null);

let SQL;
async function openDb(file) {
  SQL = SQL || await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  // Copy first: the source browser may hold a lock on its database.
  const tmp = path.join(app.getPath('temp'), `link-import-${Date.now()}.sqlite`);
  fs.copyFileSync(file, tmp);
  const db = new SQL.Database(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  return db;
}
function rows(db, sql) {
  const res = db.exec(sql)[0];
  if (!res) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

// ---------- detection ----------
function chromiumProfiles(browser) {
  const root = resolve(browser[platformKey]);
  if (!root || !fs.existsSync(root)) return [];
  if (browser.single) return [{ name: 'Default', path: root }];
  let names = {};
  try { names = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile.info_cache; } catch {}
  return fs.readdirSync(root)
    .filter((d) => (d === 'Default' || /^Profile \d+$/.test(d)) && fs.existsSync(path.join(root, d, 'Preferences')))
    .map((d, i, all) => {
      const name = names[d]?.name || d;
      // Two profiles can share a display name; add the folder so they can be told apart.
      const clash = all.some((o) => o !== d && (names[o]?.name || o) === name);
      return { name: clash ? `${name} · ${d}` : name, path: path.join(root, d) };
    });
}

function firefoxProfiles() {
  const root = resolve(FIREFOX[platformKey]);
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((p) => fs.existsSync(path.join(p, 'places.sqlite')))
    .map((p) => ({ name: path.basename(p).replace(/^[a-z0-9]+\./, ''), path: p }));
}

function detect() {
  const found = [];
  for (const b of CHROMIUM_BROWSERS) {
    for (const p of chromiumProfiles(b)) found.push({ browser: b.id, kind: 'chromium', name: b.name, profile: p.name, path: p.path, exe: findExe(b.id) });
  }
  for (const p of firefoxProfiles()) found.push({ browser: 'firefox', kind: 'firefox', name: 'Firefox', profile: p.name, path: p.path, exe: findExe('firefox') });
  return found;
}

// ---------- chromium ----------
const chromeTime = (t) => (t ? Math.round(Number(t) / 1000 - 11644473600000) : Date.now());

function chromiumBookmarks(profile) {
  const file = path.join(profile, 'Bookmarks');
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const convert = (n) => (n.type === 'folder'
    ? { type: 'folder', title: n.name, children: (n.children || []).map(convert) }
    : { type: 'url', title: n.name, url: n.url });
  const roots = data.roots || {};
  const children = ['bookmark_bar', 'other', 'synced']
    .filter((k) => roots[k]?.children?.length)
    .map((k) => convert(roots[k]));
  return children;
}

async function chromiumHistory(profile) {
  const file = path.join(profile, 'History');
  if (!fs.existsSync(file)) return [];
  const db = await openDb(file);
  const list = rows(db, 'SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 20000');
  db.close();
  return list.map((r) => ({ url: r.url, title: r.title, visits: r.visit_count, lastVisit: chromeTime(r.last_visit_time) }));
}

function chromiumExtensionDirs(profile) {
  const root = path.join(profile, 'Extensions');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((id) => extensions.STORE_ID.test(id))
    .map((id) => {
      const versions = fs.readdirSync(path.join(root, id)).filter((v) => fs.existsSync(path.join(root, id, v, 'manifest.json')));
      return versions.length ? { id, dir: path.join(root, id, versions.sort().pop()) } : null;
    })
    .filter(Boolean)
    .filter(({ dir }) => {
      // Skip themes and Chrome's own hidden component apps.
      try {
        const { manifest } = extensions.readManifest(dir);
        return !manifest.theme && !manifest.app && manifest.manifest_version;
      } catch { return false; }
    });
}

// ---------- firefox ----------
async function firefoxData(profile) {
  const db = await openDb(path.join(profile, 'places.sqlite'));
  const hist = rows(db, 'SELECT url, title, visit_count, last_visit_date FROM moz_places WHERE visit_count > 0 AND hidden = 0 ORDER BY last_visit_date DESC LIMIT 20000')
    .map((r) => ({ url: r.url, title: r.title, visits: r.visit_count, lastVisit: r.last_visit_date ? Math.round(r.last_visit_date / 1000) : Date.now() }));
  const marks = rows(db, 'SELECT b.id, b.type, b.parent, b.title, b.position, p.url, b.guid FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id ORDER BY b.parent, b.position');
  db.close();

  const byParent = new Map();
  for (const m of marks) {
    if (!byParent.has(m.parent)) byParent.set(m.parent, []);
    byParent.get(m.parent).push(m);
  }
  const build = (id) => (byParent.get(id) || [])
    .filter((m) => m.guid !== 'tags________' && (m.type === 2 || (m.type === 1 && m.url && !m.url.startsWith('place:'))))
    .map((m) => (m.type === 2
      ? { type: 'folder', title: m.title || 'Folder', children: build(m.id) }
      : { type: 'url', title: m.title || m.url, url: m.url }));
  const root = marks.find((m) => m.guid === 'root________');
  const names = { 'menu________': 'Bookmarks Menu', 'toolbar_____': 'Bookmarks Toolbar', 'unfiled_____': 'Other Bookmarks', 'mobile______': 'Mobile Bookmarks' };
  const top = (byParent.get(root?.id) || [])
    .filter((m) => names[m.guid])
    .map((m) => ({ type: 'folder', title: names[m.guid], children: build(m.id) }))
    .filter((f) => f.children.length);
  return { history: hist, bookmarks: top };
}

// ---------- main entry ----------
async function run({ kind, name, profile, path: profilePath }, types) {
  const label = `Imported from ${name}${profile && profile !== 'Default' ? ` (${profile})` : ''}`;
  const result = { bookmarks: 0, history: 0, extensions: 0, extensionErrors: [], errors: [] };
  const countUrls = (nodes) => nodes.reduce((n, c) => n + (c.type === 'url' ? 1 : countUrls(c.children || [])), 0);

  try {
    if (kind === 'firefox') {
      const data = await firefoxData(profilePath);
      if (types.includes('bookmarks') && data.bookmarks.length) {
        store.addBookmarkTree({ title: label, children: data.bookmarks });
        result.bookmarks = countUrls(data.bookmarks);
      }
      if (types.includes('history')) { store.mergeHistory(data.history); result.history = data.history.length; }
    } else {
      if (types.includes('bookmarks')) {
        const marks = chromiumBookmarks(profilePath);
        if (marks?.length) {
          store.addBookmarkTree({ title: label, children: marks });
          result.bookmarks = countUrls(marks);
        }
      }
      if (types.includes('history')) {
        const hist = await chromiumHistory(profilePath);
        store.mergeHistory(hist);
        result.history = hist.length;
      }
    }
  } catch (err) {
    result.errors.push(/locked|EBUSY|EPERM/i.test(err.message)
      ? `${name} is using its data right now. Close ${name} completely and try again.`
      : err.message);
  }

  if (types.includes('extensions') && kind === 'chromium') {
    for (const { id, dir } of chromiumExtensionDirs(profilePath)) {
      try {
        await extensions.installFromFolderCopy(dir, name);
        result.extensions++;
      } catch (err) {
        try {
          await extensions.installFromStore(id);
          result.extensions++;
        } catch {
          result.extensionErrors.push(`${id}: ${err.message}`);
        }
      }
    }
  }
  return result;
}

// Netscape bookmark HTML — the format every browser (Safari, Firefox, Chrome…) can export.
function parseBookmarksHtml(html) {
  const root = { type: 'folder', title: 'root', children: [] };
  const stack = [root];
  let pendingFolder = null;
  const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  const re = /<DT><H3[^>]*>([\s\S]*?)<\/H3>|<DT><A\s[^>]*HREF="([^"]*)"[^>]*>([\s\S]*?)<\/A>|<DL>|<\/DL>/gi;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      pendingFolder = { type: 'folder', title: decode(m[1]), children: [] };
      top.children.push(pendingFolder);
    } else if (m[2] !== undefined) {
      top.children.push({ type: 'url', url: decode(m[2]), title: decode(m[3]) || m[2] });
    } else if (/^<DL>/i.test(m[0])) {
      if (pendingFolder) { stack.push(pendingFolder); pendingFolder = null; }
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  return root.children;
}

function importBookmarksHtml(file) {
  const children = parseBookmarksHtml(fs.readFileSync(file, 'utf8'));
  const count = (nodes) => nodes.reduce((n, c) => n + (c.type === 'url' ? 1 : count(c.children)), 0);
  if (children.length) store.addBookmarkTree({ title: `Imported from ${path.basename(file)}`, children });
  return { bookmarks: count(children) };
}

function importPasswordsCsv(file) {
  return { passwords: passwords.importCsv(fs.readFileSync(file, 'utf8')) };
}

module.exports = { detect, run, importBookmarksHtml, importPasswordsCsv };
