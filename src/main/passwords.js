// Password vault. Passwords are encrypted with the OS keychain (DPAPI / Keychain / libsecret) via safeStorage.
const { safeStorage } = require('electron');
const store = require('./store');

let vault = null;
const load = () => (vault = vault || store.readJSON('passwords', []));
const save = () => store.writeJSON('passwords', vault, true);

function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system.');
  return safeStorage.encryptString(text).toString('base64');
}
const decrypt = (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64'));

function parseCsv(text) {
  const out = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((f) => f));
}

// Accepts the CSV exports of Chrome, Edge, Brave, Opera, Firefox, Safari, Bitwarden and 1Password.
function importCsv(text) {
  load();
  const [header, ...lines] = parseCsv(text.replace(/^﻿/, ''));
  const col = (...names) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const iUrl = col('url', 'login_uri', 'website', 'origin');
  const iUser = col('username', 'login_username', 'user', 'email');
  const iPass = col('password', 'login_password');
  const iName = col('name', 'title');
  if (iUrl < 0 || iPass < 0) throw new Error('This CSV has no url/password columns. Export passwords from your browser as CSV and try again.');
  let added = 0;
  for (const r of lines) {
    const url = r[iUrl] || '';
    const username = iUser >= 0 ? r[iUser] || '' : '';
    const password = r[iPass] || '';
    if (!password) continue;
    if (vault.some((v) => v.url === url && v.username === username)) continue;
    let name = iName >= 0 ? r[iName] : '';
    if (!name) { try { name = new URL(url).hostname; } catch { name = url; } }
    vault.push({ id: store.uid(), name, url, username, password: encrypt(password), created: Date.now() });
    added++;
  }
  save();
  return added;
}

const list = () => load().map(({ password, ...rest }) => rest);
const reveal = (id) => { const e = load().find((v) => v.id === id); return e ? decrypt(e.password) : ''; };
function add({ name, url, username, password }) {
  load().push({ id: store.uid(), name: name || url, url, username, password: encrypt(password), created: Date.now() });
  save();
}
function remove(id) { vault = load().filter((v) => v.id !== id); save(); }
function forOrigin(origin) {
  return load()
    .filter((v) => { try { return new URL(v.url).hostname.replace(/^www\./, '') === new URL(origin).hostname.replace(/^www\./, ''); } catch { return false; } })
    .map((v) => ({ id: v.id, username: v.username }));
}

module.exports = { importCsv, list, reveal, add, remove, forOrigin };
