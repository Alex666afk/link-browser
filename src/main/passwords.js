// Password vault, kept only on this computer and never sent anywhere.
//
// vault.bin holds every entry (site, username, password) as one AES-256-GCM encrypted blob, so the
// file is unreadable bytes and any change to it is detected. Its 256-bit key is random and stored
// in vault.key, itself encrypted with safeStorage, whose key lives in the macOS Keychain (DPAPI on
// Windows, libsecret on Linux) where only Link may read it. Copying the files elsewhere is useless
// without this Mac's Keychain. Entries are decrypted only when needed and never kept in memory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const store = require('./store');

const MAGIC = Buffer.from('LINKVAULT1');
const vaultFile = () => path.join(app.getPath('userData'), 'vault.bin');
const keyFile = () => path.join(app.getPath('userData'), 'vault.key');

function writePrivate(file, data) {
  fs.writeFileSync(file + '.tmp', data, { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

// Overwrites a file with random bytes before deleting it, so the old contents aren't left on disk.
function shred(file) {
  try {
    fs.writeFileSync(file, crypto.randomBytes(fs.statSync(file).size));
    fs.unlinkSync(file);
  } catch {}
}

let key = null; // the vault key, unwrapped once per run
function vaultKey() {
  if (key) return key;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system.');
  if (fs.existsSync(keyFile())) {
    key = Buffer.from(safeStorage.decryptString(fs.readFileSync(keyFile())), 'hex');
  } else {
    key = crypto.randomBytes(32);
    writePrivate(keyFile(), safeStorage.encryptString(key.toString('hex')));
  }
  return key;
}

function read() {
  migrate();
  if (!fs.existsSync(vaultFile())) return [];
  const blob = fs.readFileSync(vaultFile());
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('The password vault is damaged.');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(blob.subarray(MAGIC.length + 28)), decipher.final()]).toString('utf8'));
}

function write(entries) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()]);
  writePrivate(vaultFile(), Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]));
}

// Older versions kept passwords.json with only the passwords encrypted; move it into the vault.
let migrated = false;
function migrate() {
  if (migrated) return;
  migrated = true;
  const old = path.join(app.getPath('userData'), 'passwords.json');
  if (!fs.existsSync(old)) return;
  const entries = JSON.parse(fs.readFileSync(old, 'utf8'))
    .map(({ password, ...rest }) => ({ ...rest, password: safeStorage.decryptString(Buffer.from(password, 'base64')) }));
  write([...(fs.existsSync(vaultFile()) ? read() : []), ...entries]);
  shred(old);
}

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
  const vault = read();
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
    vault.push({ id: store.uid(), name, url, username, password, created: Date.now() });
    added++;
  }
  write(vault);
  return added;
}

const sameSite = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; } };

const list = () => read().map(({ password, ...rest }) => rest);
const reveal = (id) => read().find((v) => v.id === id)?.password || '';
function add({ name, url, username, password }) {
  const vault = read();
  vault.push({ id: store.uid(), name: name || url, url, username, password, created: Date.now() });
  write(vault);
}
function remove(id) { write(read().filter((v) => v.id !== id)); }
const forOrigin = (origin) => read().filter((v) => sameSite(v.url, origin)).map((v) => ({ id: v.id, username: v.username }));

module.exports = { importCsv, list, reveal, add, remove, forOrigin, sameSite };
