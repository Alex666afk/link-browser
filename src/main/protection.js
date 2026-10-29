// Link Protect: ad & tracker blocking, VPN/proxy routing, HTTPS-only, privacy headers.
const fs = require('fs');
const path = require('path');
const { app, ipcMain, safeStorage, dialog, BrowserWindow, net } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const store = require('./store');
const tor = require('./tor');

let sessions = [];
let blocker = null;
let blockerLevel = null;
let blockingOn = false;
const blockedCounts = new Map(); // webContentsId -> Set of blocked URLs on the current page
let totalBlocked = 0;
let onBlocked = () => {};
let onVpnStatus = () => {};
let vpnLocation = null; // where the VPN exit is: { ip, city, country, lat, lon, timezone }
const httpsFallback = new Set(); // hosts that failed over HTTPS
const upgraded = new Set(); // hosts we upgraded to HTTPS

const COSMETIC_CHANNELS = ['@ghostery/adblocker/inject-cosmetic-filters', '@ghostery/adblocker/is-mutation-observer-enabled'];

async function loadBlocker(level) {
  const cache = path.join(app.getPath('userData'), `adblock-${level}.bin`);
  const factory = level === 'full' ? 'fromPrebuiltFull' : level === 'ads' ? 'fromPrebuiltAdsOnly' : 'fromPrebuiltAdsAndTracking';
  // Refresh the cached filter lists once a week.
  try {
    if (Date.now() - fs.statSync(cache).mtimeMs > 7 * 864e5) fs.unlinkSync(cache);
  } catch {}
  const b = await ElectronBlocker[factory](fetch, {
    path: cache,
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  });
  b.on('request-blocked', (request) => {
    // Pages often retry a blocked request over and over; count each blocked address once per page.
    if (!request.tabId) return;
    const seen = blockedCounts.get(request.tabId) || new Set();
    blockedCounts.set(request.tabId, seen);
    if (seen.has(request.url)) return;
    seen.add(request.url);
    totalBlocked++;
    onBlocked(request.tabId, seen.size, totalBlocked);
  });
  return b;
}

function disableBlocking() {
  if (!blocker || !blockingOn) return;
  for (const ses of sessions) {
    try { blocker.disableBlockingInSession(ses); } catch {}
  }
  for (const ch of COSMETIC_CHANNELS) ipcMain.removeHandler(ch);
  blockingOn = false;
}

async function applyAdblock() {
  const { enabled, level } = store.getSettings().adblock;
  if (!enabled) return disableBlocking();
  if (!blocker || blockerLevel !== level) {
    disableBlocking();
    blocker = await loadBlocker(level);
    blockerLevel = level;
  }
  if (blockingOn) return;
  for (const ses of sessions) {
    // The blocker registers global IPC handlers per session; clear them so a second session can register too.
    for (const ch of COSMETIC_CHANNELS) ipcMain.removeHandler(ch);
    blocker.enableBlockingInSession(ses);
  }
  blockingOn = true;
}

// ---------- VPN / proxy ----------
function decrypt(value) {
  if (!value) return '';
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; }
}
function encrypt(value) {
  if (!value) return '';
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : '';
}

function proxyConfig() {
  const vpn = store.getSettings().vpn;
  if (!vpn.enabled) return { mode: 'direct' };
  // Sites you chose to open without the VPN (e.g. a search engine that blocks it).
  const proxyBypassRules = ['<local>', ...(vpn.bypass || []).flatMap((host) => [host, `*.${host}`])].join(';');
  if (vpn.mode === 'tor') return { proxyRules: `socks5://127.0.0.1:${tor.getPort()}`, proxyBypassRules };
  if (vpn.mode === 'pac' && vpn.pac) return { mode: 'pac_script', pacScript: vpn.pac };
  if (vpn.mode === 'custom' && vpn.host && vpn.port) {
    return { proxyRules: `${vpn.type}://${vpn.host}:${vpn.port}`, proxyBypassRules };
  }
  return { mode: 'direct' };
}

async function applyProxyRules() {
  const vpn = store.getSettings().vpn;
  if (vpn.enabled && vpn.mode === 'tor') await tor.preparePort();
  await setSessionsProxy(proxyConfig());
}

async function setSessionsProxy(cfg) {
  await Promise.all(sessions.map(async (ses) => {
    await ses.setProxy(cfg);
    await ses.closeAllConnections();
  }));
}

// Routing switches to the VPN before it is connected, so nothing leaks while it starts up:
// pages simply wait until the built-in VPN is ready.
async function applyProxy() {
  const vpn = store.getSettings().vpn;
  const builtIn = vpn.enabled && vpn.mode === 'tor';
  if (!builtIn) tor.stop();
  else await tor.preparePort(); // so pages route to the VPN (and wait) from the very first moment
  await setSessionsProxy(proxyConfig());
  if (!vpn.enabled) { setVpnLocation(null); return onVpnStatus({ state: 'off' }); }
  if (!builtIn) { onVpnStatus({ state: 'connected' }); return setVpnLocation(await locateVpn()); }
  const country = vpn.country || '';
  if (tor.isRunning(country)) return onVpnStatus({ state: 'connected' });
  onVpnStatus({ state: 'connecting', step: 'connect', percent: 0 });
  try {
    await tor.start((step, percent) => onVpnStatus({ state: 'connecting', step, percent }), country);
    await Promise.all(sessions.map((ses) => ses.closeAllConnections()));
    setVpnLocation(await locateVpn());
    onVpnStatus({ state: 'connected' });
  } catch (err) {
    onVpnStatus({ state: 'error', message: err.message });
  }
}

// Built-in VPN only: moves to a different Tor exit (for sites that block or misplace the current one).
async function switchExit() {
  await tor.newExit(vpnLocation?.ip);
  await Promise.all(sessions.map((ses) => ses.closeAllConnections()));
  vpnLocation = await locateVpn().catch(() => null);
  return vpnLocation;
}
const canSwitchExit = () => {
  const vpn = store.getSettings().vpn;
  return vpn.enabled && vpn.mode === 'tor' && tor.isRunning(vpn.country || '');
};

async function locateVpn() {
  const info = await checkIp();
  return info.error || info.lat == null ? null : info;
}

function setVpnLocation(loc) {
  vpnLocation = loc;
}

// Supplies credentials when the custom proxy asks for them.
function handleProxyLogin(event, details, authInfo, callback) {
  if (!authInfo.isProxy) return;
  const vpn = store.getSettings().vpn;
  if (vpn.enabled && vpn.mode === 'custom' && vpn.username) {
    event.preventDefault();
    callback(vpn.username, decrypt(vpn.password));
  }
}

async function checkIp() {
  try {
    // The address is fetched through the VPN (what sites see); its location is looked up separately,
    // since many geo-IP services refuse requests coming from VPN and Tor exits.
    const { ip } = await (await sessions[0].fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: AbortSignal.timeout(20000) })).json();
    let geo = {};
    try { geo = await (await net.fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(8000) })).json(); } catch {}
    return { ip, country: geo.country, countryCode: geo.country_code, city: geo.city, region: geo.region, isp: geo.connection?.isp, lat: geo.latitude, lon: geo.longitude, timezone: geo.timezone?.id };
  } catch (err) {
    return { error: true, message: err.message };
  }
}

// ---------- headers, HTTPS-only, WebRTC, permissions ----------
function installHeaderRules(ses) {
  // onBeforeRequest / onHeadersReceived belong to the ad blocker; this event is free.
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    const s = store.getSettings();
    const headers = details.requestHeaders;
    if (s.gpc) {
      headers['Sec-GPC'] = '1';
      headers['DNT'] = '1';
    }
    cb({ requestHeaders: headers });
  });
}

function isLocalHost(host) {
  return host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '[::1]';
}

function upgradeUrl(url) {
  if (!store.getSettings().httpsOnly || !url.startsWith('http://')) return null;
  try {
    const u = new URL(url);
    if (isLocalHost(u.hostname) || httpsFallback.has(u.hostname)) return null;
    u.protocol = 'https:';
    upgraded.add(u.hostname);
    return u.toString();
  } catch { return null; }
}

function attachToGuest(contents) {
  if (store.getSettings().webrtcProtect) contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

  const upgrade = (e) => {
    if (!e.isMainFrame) return;
    const target = upgradeUrl(e.url);
    if (!target) return;
    e.preventDefault();
    contents.loadURL(target);
  };
  // Typed URLs are upgraded by the address bar; these cover links and redirects.
  contents.on('will-navigate', upgrade);
  contents.on('will-redirect', upgrade);
  contents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    // If an upgraded page has no HTTPS version, remember it and fall back to HTTP.
    if (!isMainFrame || !url.startsWith('https://') || code === -3) return;
    const host = new URL(url).hostname;
    if (code <= -100 && code >= -220 && upgraded.has(host) && !httpsFallback.has(host)) {
      httpsFallback.add(host);
      contents.loadURL(url.replace(/^https:/, 'http:'));
    }
  });
  contents.on('did-start-navigation', (e) => {
    if (!e.isMainFrame || e.isSameDocument) return;
    blockedCounts.set(contents.id, new Set());
    onBlocked(contents.id, 0, totalBlocked);
  });
}

const PERMISSION_LABELS = {
  media: 'use your camera and/or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
  pointerLock: 'lock your mouse pointer',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'capture your screen',
  hid: 'use HID devices',
  serial: 'use serial ports',
  usb: 'use USB devices',
};
const permissionDecisions = new Map(); // `${origin}|${permission}` -> boolean

function installPermissionHandler(ses) {
  // Pages that only check ("may I get the location?") get "no" while the VPN is on, too.
  ses.setPermissionCheckHandler((contents, permission) => {
    const s = store.getSettings();
    if (permission === 'geolocation') return !s.vpn.enabled && s.allowLocationPrompts;
    if (permission === 'notifications') return s.allowNotificationPrompts;
    return true;
  });
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const always = ['fullscreen', 'clipboard-sanitized-write', 'window-management'];
    if (always.includes(permission)) return callback(true);
    const s = store.getSettings();
    // Location and notification requests are refused quietly unless you've opted in to being asked.
    // With the VPN on, location is always refused: your device's position would undo the VPN.
    if (permission === 'geolocation' && (s.vpn.enabled || !s.allowLocationPrompts)) return callback(false);
    if (permission === 'notifications' && !s.allowNotificationPrompts) return callback(false);
    if (!store.getSettings().askPermissions) return callback(true);
    const label = PERMISSION_LABELS[permission];
    if (!label) return callback(false);
    let origin = '';
    for (const u of [details.requestingUrl, contents.getURL()]) {
      try { const o = new URL(u).origin; if (o && o !== 'null') { origin = o; break; } } catch {}
    }
    const key = `${origin}|${permission}`;
    if (permissionDecisions.has(key)) return callback(permissionDecisions.get(key));
    const win = BrowserWindow.fromWebContents(contents.hostWebContents || contents);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Permission request',
      message: `${origin || 'This site'} wants to ${label}.`,
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
    });
    const allowed = response === 0;
    permissionDecisions.set(key, allowed);
    callback(allowed);
  });
}

function init(sessionList, blockedCallback, vpnCallback) {
  sessions = sessionList;
  onBlocked = blockedCallback;
  onVpnStatus = vpnCallback;
  for (const ses of sessions) {
    installHeaderRules(ses);
    installPermissionHandler(ses);
  }
  app.on('login', handleProxyLogin);
  applyProxy();
  applyAdblock().catch((err) => console.error('[adblock]', err));
}

module.exports = {
  init, applyAdblock, applyProxy, applyProxyRules, switchExit, canSwitchExit, stopVpn: () => tor.stop(), getVpnLocation: () => vpnLocation, attachToGuest, upgradeUrl, checkIp, encrypt,
  getStats: () => ({ total: totalBlocked }),
  getBlockedFor: (id) => blockedCounts.get(id)?.size || 0,
  isBlockerReady: () => blockingOn,
};
