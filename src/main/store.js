// Small JSON-file persistence for settings, bookmarks, history and passwords.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const BUILTIN_ENGINES = [
  { id: 'link', name: 'Link Search', keyword: 'l', url: 'link://search/?q=%s', suggest: '', icon: 'icon.png' },
  { id: 'duckduckgo', name: 'DuckDuckGo', keyword: 'ddg', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  { id: 'google', name: 'Google', keyword: 'g', url: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
  { id: 'brave', name: 'Brave Search', keyword: 'br', url: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
  { id: 'bing', name: 'Bing', keyword: 'b', url: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
  { id: 'startpage', name: 'Startpage', keyword: 'sp', url: 'https://www.startpage.com/do/search?q=%s', suggest: 'https://www.startpage.com/suggestions?q=%s&format=opensearch' },
  { id: 'ecosia', name: 'Ecosia', keyword: 'eco', url: 'https://www.ecosia.org/search?q=%s', suggest: 'https://ac.ecosia.org/autocomplete?q=%s&type=list' },
  { id: 'qwant', name: 'Qwant', keyword: 'qw', url: 'https://www.qwant.com/?q=%s', suggest: '' },
  { id: 'mojeek', name: 'Mojeek', keyword: 'mj', url: 'https://www.mojeek.com/search?q=%s', suggest: '' },
  { id: 'yahoo', name: 'Yahoo', keyword: 'y', url: 'https://search.yahoo.com/search?p=%s', suggest: '' },
  { id: 'youtube', name: 'YouTube', keyword: 'yt', url: 'https://www.youtube.com/results?search_query=%s', suggest: '' },
  { id: 'wikipedia', name: 'Wikipedia', keyword: 'w', url: 'https://en.wikipedia.org/wiki/Special:Search?search=%s', suggest: '' },
  { id: 'github', name: 'GitHub', keyword: 'gh', url: 'https://github.com/search?q=%s', suggest: '' },
].map((e) => ({ ...e, builtin: true, icon: e.icon || `brands/${e.id}.png` }));

const DEFAULT_SETTINGS = {
  onboarded: false,
  theme: 'dark',
  accent: '#8a6cef',
  searchEngine: 'link',
  customEngines: [],
  suggestions: true,
  homepage: 'link://newtab',
  sidebarOpen: true,
  sidebarView: 'bookmarks',
  restoreTabs: true,
  adblock: { enabled: true, level: 'adsAndTracking' },
  httpsOnly: true,
  gpc: true,
  webrtcProtect: true,
  askPermissions: true,
  allowLocationPrompts: false,
  allowNotificationPrompts: false,
  clearOnExit: false,
  vpn: { enabled: false, mode: 'tor', country: '', type: 'socks5', host: '', port: '', username: '', password: '', pac: '', bypass: [] },
  extensions: [],
};

const dir = () => app.getPath('userData');
const file = (name) => path.join(dir(), name + '.json');

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

// Writes go to a temp file first so a crash never leaves a half-written file.
const pending = new Map();
function writeJSON(name, data, immediate = false) {
  const flush = () => {
    pending.delete(name);
    const target = file(name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target + '.tmp', JSON.stringify(data));
    fs.renameSync(target + '.tmp', target);
  };
  clearTimeout(pending.get(name));
  if (immediate) return flush();
  pending.set(name, setTimeout(flush, 400));
}

let settings, bookmarks, history, session;

function load() {
  const saved = readJSON('settings', {});
  settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    adblock: { ...DEFAULT_SETTINGS.adblock, ...saved.adblock },
    vpn: { ...DEFAULT_SETTINGS.vpn, ...saved.vpn },
  };
  bookmarks = readJSON('bookmarks', { id: 'root', type: 'folder', title: 'Bookmarks', children: [] });
  history = readJSON('history', []);
  session = readJSON('session', { tabs: [] });
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- settings ----------
function getSettings() { return settings; }
function setSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    settings[k] = v && typeof v === 'object' && !Array.isArray(v) && settings[k] && typeof settings[k] === 'object' && !Array.isArray(settings[k])
      ? { ...settings[k], ...v }
      : v;
  }
  writeJSON('settings', settings);
  return settings;
}
function engines() { return [...BUILTIN_ENGINES, ...settings.customEngines]; }
function currentEngine() { return engines().find((e) => e.id === settings.searchEngine) || BUILTIN_ENGINES[0]; }

// ---------- bookmarks ----------
function findNode(id, node = bookmarks, parent = null) {
  if (node.id === id) return { node, parent };
  for (const child of node.children || []) {
    const hit = findNode(id, child, node);
    if (hit) return hit;
  }
  return null;
}
function addBookmark(item, parentId = 'root') {
  const parent = findNode(parentId)?.node || bookmarks;
  const node = { id: uid(), type: item.type || 'url', title: item.title || item.url || 'Untitled', url: item.url, ...(item.type === 'folder' ? { children: item.children || [] } : {}) };
  parent.children.push(node);
  writeJSON('bookmarks', bookmarks);
  return node;
}
function addBookmarkTree(tree, parentId = 'root') {
  // tree: { title, children: [{type, title, url, children}] } from the importer
  const assignIds = (n) => ({ ...n, id: uid(), ...(n.type === 'folder' ? { children: (n.children || []).map(assignIds) } : {}) });
  const parent = findNode(parentId)?.node || bookmarks;
  const node = assignIds({ ...tree, type: 'folder' });
  parent.children.push(node);
  writeJSON('bookmarks', bookmarks);
  return node;
}
function updateBookmark(id, patch) {
  const hit = findNode(id);
  if (hit) Object.assign(hit.node, patch);
  writeJSON('bookmarks', bookmarks);
}
function removeBookmark(id) {
  const hit = findNode(id);
  if (hit?.parent) hit.parent.children = hit.parent.children.filter((c) => c.id !== id);
  writeJSON('bookmarks', bookmarks);
}
function moveBookmark(id, targetFolderId, index) {
  const hit = findNode(id);
  const target = findNode(targetFolderId)?.node;
  if (!hit?.parent || !target || target.type !== 'folder' || findNode(targetFolderId, hit.node)) return;
  hit.parent.children = hit.parent.children.filter((c) => c.id !== id);
  target.children.splice(index ?? target.children.length, 0, hit.node);
  writeJSON('bookmarks', bookmarks);
}
function flatBookmarks(node = bookmarks, out = []) {
  for (const c of node.children || []) {
    if (c.type === 'url') out.push(c); else flatBookmarks(c, out);
  }
  return out;
}
function findBookmarkByUrl(url) { return flatBookmarks().find((b) => b.url === url) || null; }

// ---------- history ----------
const HISTORY_LIMIT = 20000;
function addHistory(url, title) {
  const now = Date.now();
  const existing = history.find((h) => h.url === url);
  if (existing) {
    existing.visits++;
    existing.lastVisit = now;
    if (title) existing.title = title;
    history = [existing, ...history.filter((h) => h !== existing)];
  } else {
    history.unshift({ url, title: title || url, visits: 1, lastVisit: now });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  }
  writeJSON('history', history);
}
function updateHistoryTitle(url, title) {
  const h = history.find((x) => x.url === url);
  if (h && title) { h.title = title; writeJSON('history', history); }
}
function mergeHistory(entries) {
  const byUrl = new Map(history.map((h) => [h.url, h]));
  for (const e of entries) {
    const cur = byUrl.get(e.url);
    if (cur) {
      cur.visits += e.visits || 1;
      cur.lastVisit = Math.max(cur.lastVisit, e.lastVisit || 0);
    } else {
      byUrl.set(e.url, { url: e.url, title: e.title || e.url, visits: e.visits || 1, lastVisit: e.lastVisit || Date.now() });
    }
  }
  history = [...byUrl.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, HISTORY_LIMIT);
  writeJSON('history', history);
}
function searchHistory(query = '', limit = 200) {
  const q = query.toLowerCase().trim();
  const list = q ? history.filter((h) => h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)) : history;
  return list.slice(0, limit);
}
function removeHistory(url) { history = history.filter((h) => h.url !== url); writeJSON('history', history); }
function clearHistory() { history = []; writeJSON('history', history, true); }
function topSites(limit = 8) {
  const seen = new Set();
  return [...history]
    .filter((h) => /^https?:/.test(h.url))
    .sort((a, b) => b.visits - a.visits)
    .filter((h) => {
      let host;
      try { host = new URL(h.url).hostname; } catch { return false; }
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    })
    .slice(0, limit)
    .map((h) => ({ url: new URL(h.url).origin, title: h.title }));
}

// ---------- tab session ----------
function getSession() { return session; }
function saveSession(tabs) { session = { tabs }; writeJSON('session', session); }

function flushAll() {
  for (const name of [...pending.keys()]) {
    const data = { settings, bookmarks, history, session }[name];
    if (data) writeJSON(name, data, true);
  }
}

module.exports = {
  BUILTIN_ENGINES, load, uid, readJSON, writeJSON, flushAll,
  getSettings, setSettings, engines, currentEngine,
  getBookmarks: () => bookmarks, addBookmark, addBookmarkTree, updateBookmark, removeBookmark, moveBookmark, flatBookmarks, findBookmarkByUrl,
  addHistory, updateHistoryTitle, mergeHistory, searchHistory, removeHistory, clearHistory, topSites,
  getSession, saveSession,
};
