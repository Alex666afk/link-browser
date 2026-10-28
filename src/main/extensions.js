// Chrome extension support: Chrome Web Store installs, unpacked folders and copies from other browsers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, screen } = require('electron');
const AdmZip = require('adm-zip');
const store = require('./store');

let ses;
const loaded = new Map(); // electron extension id -> Electron.Extension

const extDir = () => path.join(app.getPath('userData'), 'extensions');
const api = () => ses.extensions || ses; // session.extensions on Electron 36+, session.* before that

// ---------- CRX parsing ----------
function readVarint(buf, pos) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, pos];
}

// Yields [fieldNumber, value] for each length-delimited field of a protobuf message.
function* protoFields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let tag, len;
    [tag, pos] = readVarint(buf, pos);
    const wire = tag & 7;
    if (wire === 0) { [, pos] = readVarint(buf, pos); continue; }
    if (wire !== 2) break;
    [len, pos] = readVarint(buf, pos);
    yield [Math.floor(tag / 8), buf.subarray(pos, pos + len)];
    pos += len;
  }
}

const idFromKey = (key) => [...crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

// Returns { zip, publicKey } from a CRX2/CRX3 buffer.
function parseCrx(buf, expectedId) {
  if (buf.toString('ascii', 0, 4) !== 'Cr24') {
    if (buf[0] === 0x50 && buf[1] === 0x4b) return { zip: buf, publicKey: null };
    throw new Error('Not a valid extension package');
  }
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const keyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    return { zip: buf.subarray(16 + keyLen + sigLen), publicKey: buf.subarray(16, 16 + keyLen) };
  }
  const headerLen = buf.readUInt32LE(8);
  const header = buf.subarray(12, 12 + headerLen);
  let publicKey = null;
  for (const [field, proof] of protoFields(header)) {
    if (field !== 2 && field !== 3) continue; // sha256_with_rsa / sha256_with_ecdsa proofs
    for (const [f, value] of protoFields(proof)) {
      if (f === 1 && (!expectedId || idFromKey(value) === expectedId)) publicKey = Buffer.from(value);
    }
    if (publicKey) break;
  }
  return { zip: buf.subarray(12 + headerLen), publicKey };
}

// ---------- loading ----------
function popupOf(manifest) {
  return manifest.action?.default_popup || manifest.browser_action?.default_popup || manifest.page_action?.default_popup || null;
}
function iconOf(ext) {
  const icons = ext.manifest.icons || ext.manifest.action?.default_icon || ext.manifest.browser_action?.default_icon;
  if (!icons) return null;
  if (typeof icons === 'string') return `chrome-extension://${ext.id}/${icons.replace(/^\//, '')}`;
  const size = Object.keys(icons).sort((a, b) => Math.abs(a - 32) - Math.abs(b - 32))[0];
  return `chrome-extension://${ext.id}/${icons[size].replace(/^\//, '')}`;
}

function resolveMessage(dir, manifest, value) {
  const m = /^__MSG_(.+)__$/.exec(value || '');
  if (!m) return value;
  const locales = [manifest.default_locale, 'en', 'en_US'].filter(Boolean);
  for (const loc of locales) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8'));
      const key = Object.keys(msgs).find((k) => k.toLowerCase() === m[1].toLowerCase());
      if (key) return msgs[key].message;
    } catch {}
  }
  return value;
}

function readManifest(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
  return { manifest, name: resolveMessage(dir, manifest, manifest.name), description: resolveMessage(dir, manifest, manifest.description) };
}

async function loadFromDir(dir) {
  const ext = await api().loadExtension(dir, { allowFileAccess: true });
  loaded.set(ext.id, ext);
  return ext;
}

function record(ext, dir, extra = {}) {
  const { name, description } = readManifest(dir);
  const list = store.getSettings().extensions.filter((e) => e.id !== ext.id);
  const entry = { id: ext.id, path: dir, enabled: true, name, description, version: ext.version, ...extra };
  store.setSettings({ extensions: [...list, entry] });
  return entry;
}

async function init(session) {
  ses = session;
  for (const entry of store.getSettings().extensions) {
    if (!entry.enabled || !fs.existsSync(entry.path)) continue;
    try { await loadFromDir(entry.path); } catch (err) { console.error('[extensions] failed to load', entry.name, err.message); }
  }
}

function list() {
  return store.getSettings().extensions.map((entry) => {
    const ext = loaded.get(entry.id);
    return {
      ...entry,
      loaded: !!ext,
      icon: ext ? iconOf(ext) : null,
      popup: ext ? popupOf(ext.manifest) : null,
      options: ext ? (ext.manifest.options_ui?.page || ext.manifest.options_page || null) : null,
    };
  });
}

// ---------- installing ----------
const STORE_ID = /([a-p]{32})/;

async function installFromStore(input) {
  const id = (STORE_ID.exec(input) || [])[1];
  if (!id) throw new Error('That is not a Chrome Web Store link or extension ID.');
  const chromeVersion = process.versions.chrome;
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${chromeVersion}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
  const res = await ses.fetch(url);
  if (!res.ok) throw new Error(`Chrome Web Store returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('Extension not found in the Chrome Web Store.');
  const { zip, publicKey } = parseCrx(buf, id);

  const dir = path.join(extDir(), id);
  await unloadById(id);
  fs.rmSync(dir, { recursive: true, force: true });
  new AdmZip(zip).extractAllTo(dir, true);
  fs.rmSync(path.join(dir, '_metadata'), { recursive: true, force: true });

  // Embedding the store key keeps the extension ID identical to Chrome's.
  if (publicKey) {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
    manifest.key = publicKey.toString('base64');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const ext = await loadFromDir(dir);
  return record(ext, dir, { source: 'Chrome Web Store', storeId: id });
}

async function installUnpacked(srcDir) {
  if (!fs.existsSync(path.join(srcDir, 'manifest.json'))) throw new Error('That folder has no manifest.json.');
  const ext = await loadFromDir(srcDir);
  return record(ext, srcDir, { source: 'Unpacked folder' });
}

// Copies an extension already installed in another browser profile.
async function installFromFolderCopy(srcDir, source) {
  const { manifest } = readManifest(srcDir);
  const name = path.basename(path.dirname(srcDir));
  const dir = path.join(extDir(), STORE_ID.test(name) ? name : store.uid());
  await unloadById(name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(srcDir, dir, { recursive: true });
  fs.rmSync(path.join(dir, '_metadata'), { recursive: true, force: true });
  if (!manifest.manifest_version) throw new Error('Invalid manifest');
  const ext = await loadFromDir(dir);
  return record(ext, dir, { source });
}

async function unloadById(id) {
  const ext = loaded.get(id) || [...loaded.values()].find((e) => e.path?.includes(id));
  if (!ext) return;
  try { await api().removeExtension(ext.id); } catch {}
  loaded.delete(ext.id);
}

async function remove(id) {
  const entry = store.getSettings().extensions.find((e) => e.id === id);
  await unloadById(id);
  store.setSettings({ extensions: store.getSettings().extensions.filter((e) => e.id !== id) });
  if (entry && entry.path.startsWith(extDir())) fs.rmSync(entry.path, { recursive: true, force: true });
}

async function setEnabled(id, enabled) {
  const entry = store.getSettings().extensions.find((e) => e.id === id);
  if (!entry) return;
  if (enabled && !loaded.has(id)) await loadFromDir(entry.path);
  if (!enabled) await unloadById(id);
  store.setSettings({ extensions: store.getSettings().extensions.map((e) => (e.id === id ? { ...e, enabled } : e)) });
}

// Opens an extension's toolbar popup or options page in a small window near the cursor.
function openPage(id, kind, parent) {
  const ext = loaded.get(id);
  if (!ext) return;
  const page = kind === 'options' ? (ext.manifest.options_ui?.page || ext.manifest.options_page) : popupOf(ext.manifest);
  if (!page) return;
  const popup = kind === 'popup';
  const { x, y } = screen.getCursorScreenPoint();
  const win = new BrowserWindow({
    parent: popup ? parent : undefined,
    width: popup ? 380 : 900,
    height: popup ? 560 : 700,
    x: popup ? x - 340 : undefined,
    y: popup ? y + 16 : undefined,
    title: ext.name,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    webPreferences: { session: ses, sandbox: true, contextIsolation: true },
  });
  if (popup) win.on('blur', () => !win.isDestroyed() && win.close());
  win.loadURL(`chrome-extension://${ext.id}/${page.replace(/^\//, '')}`);
}

module.exports = { init, list, installFromStore, installUnpacked, installFromFolderCopy, remove, setEnabled, openPage, readManifest, STORE_ID };
