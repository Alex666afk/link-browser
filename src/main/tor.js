// Link VPN: a built-in Tor client. Downloaded from torproject.org on first use (checksum-verified),
// started in the background when the VPN is turned on, and stopped when Link quits.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { app, net, utilityProcess } = require('electron');

const PREFERRED_PORT = 9155; // not 9150/9050, so it doesn't clash with Tor Browser or a Tor service
let port = 0;
const PLATFORMS = { win32: { x64: 'windows-x86_64', ia32: 'windows-i686' }, darwin: { arm64: 'macos-aarch64', x64: 'macos-x86_64' }, linux: { x64: 'linux-x86_64' } };

let proc = null;
let ready = null; // promise while starting
let progress = 0;
let currentCountry = ''; // the exit country the user chose, '' = automatic (launch arg)
let pinnedCountry = ''; // in automatic mode, the country we pin the exit to so every site agrees

const portFree = (p) => new Promise((resolve) => {
  const srv = require('net').createServer();
  srv.once('error', () => resolve(false));
  srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
});

// Picks the local port Tor will listen on (another copy of Link may already be using the usual one).
async function preparePort() {
  await startRelay();
  if (port && (proc || (await portFree(port)))) return tellRelay(port);
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 40; p++) {
    if (await portFree(p)) return tellRelay((port = p));
  }
  throw new Error('No free local port for the VPN.');
}

// Pages reach Tor through torRelay.js, which saves a trip through the Tor network on every new
// connection. It keeps its port for as long as Link runs (and gets it back if it ever restarts),
// since that's the address pages are routed to.
let relay = null;
let quitting = false;
app.on('will-quit', () => { quitting = true; });
let relayPort = 0;
function startRelay() {
  if (relay) return relay.ready;
  const child = utilityProcess.fork(path.join(__dirname, 'torRelay.js'), [], { serviceName: 'Link VPN relay' });
  relay = { child };
  relay.ready = new Promise((resolve, reject) => {
    child.on('message', (m) => {
      if (m.port) { relayPort = m.port; resolve(); }
      if (m.error) reject(new Error(`The VPN could not start: ${m.error}`));
    });
  });
  child.on('exit', () => { relay = null; if (!quitting) setTimeout(() => startRelay().then(() => tellRelay(port)).catch(() => {}), 500); });
  child.postMessage({ torPort: port, listen: relayPort });
  return relay.ready;
}
function tellRelay(torPort) {
  relay?.child.postMessage({ torPort });
  return torPort;
}

const torDir = () => path.join(app.getPath('userData'), 'tor');
const platform = () => PLATFORMS[process.platform]?.[process.arch];

function find(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) { const hit = find(p, name); if (hit) return hit; }
  }
  return null;
}
const torBinary = () => find(path.join(torDir(), 'bundle'), process.platform === 'win32' ? 'tor.exe' : 'tor');

async function download(onProgress) {
  const plat = platform();
  if (!plat) throw new Error('The built-in VPN is not available on this system.');
  // macOS has one version file for both architectures; Windows and Linux have one per architecture.
  const metaRes = await net.fetch(`https://aus1.torproject.org/torbrowser/update_3/release/download-${process.platform === 'darwin' ? 'macos' : plat}.json`);
  if (!metaRes.ok) throw new Error(`Could not look up the latest VPN version (${metaRes.status}).`);
  const meta = await metaRes.json();
  const version = meta.version;
  const base = `https://dist.torproject.org/torbrowser/${version}`;
  const file = `tor-expert-bundle-${plat}-${version}.tar.gz`;

  const sums = await (await net.fetch(`${base}/sha256sums-unsigned-build.txt`)).text();
  const expected = sums.split('\n').find((l) => l.trim().endsWith(file))?.split(/\s+/)[0];
  if (!expected) throw new Error('Could not verify the VPN download.');

  const res = await net.fetch(`${base}/${file}`);
  if (!res.ok) throw new Error(`VPN download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (total) onProgress?.('download', Math.round((received / total) * 100));
  }
  const buf = Buffer.concat(chunks);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== expected) throw new Error('The VPN download was corrupted. Please try again.');

  fs.rmSync(torDir(), { recursive: true, force: true });
  fs.mkdirSync(path.join(torDir(), 'bundle'), { recursive: true });
  const archive = path.join(torDir(), file);
  fs.writeFileSync(archive, buf);
  // Windows 10+, macOS and Linux all ship a tar that reads .tar.gz.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await new Promise((resolve, reject) => execFile(tar, ['-xzf', archive, '-C', path.join(torDir(), 'bundle')], { windowsHide: true }, (err) => (err ? reject(err) : resolve())));
  fs.rmSync(archive, { force: true });
  if (!torBinary()) throw new Error('The VPN package was incomplete.');
}

// The macOS Tor bundle ships unsigned, and Apple Silicon kills unsigned arm64 programs on launch,
// so give Tor, its library and the pluggable transports an ad-hoc signature (only once).
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (err) => (err ? reject(err) : resolve())));
async function signForMac() {
  if (process.platform !== 'darwin') return;
  const bin = torBinary();
  if (await run('codesign', ['-v', bin]).then(() => true, () => false)) return;
  const dir = path.dirname(bin);
  const files = [bin, ...fs.readdirSync(dir).filter((f) => f.endsWith('.dylib')).map((f) => path.join(dir, f))];
  const pt = path.join(dir, 'pluggable_transports');
  if (fs.existsSync(pt)) files.push(...fs.readdirSync(pt).map((f) => path.join(pt, f)).filter((f) => fs.statSync(f).mode & 0o111));
  await run('codesign', ['--force', '--sign', '-', ...files]);
}

function launch(onProgress, country) {
  return new Promise((resolve, reject) => {
    const bin = torBinary();
    const geoip = find(path.join(torDir(), 'bundle'), 'geoip');
    const geoip6 = find(path.join(torDir(), 'bundle'), 'geoip6');
    const args = [
      '--SocksPort', `127.0.0.1:${port}`,
      '--DataDirectory', path.join(torDir(), 'data'),
      '--ClientOnly', '1',
      '--Log', 'notice stdout',
      // A local control connection, so Link can ask for a fresh exit (see newExit).
      '--ControlPort', 'auto',
      '--ControlPortWriteToFile', path.join(torDir(), 'data', 'control-port'),
      '--CookieAuthentication', '1',
      // Conflux (splitting a connection over two paths) stops Tor from sending a page's first
      // bytes along with the connect, which torRelay.js relies on to save a trip per connection.
      '--ConfluxEnabled', '0',
      ...(geoip ? ['--GeoIPFile', geoip] : []),
      ...(geoip6 ? ['--GeoIPv6File', geoip6] : []),
      // Only leave the Tor network in the chosen country.
      ...(country ? ['--ExitNodes', `{${country}}`, '--StrictNodes', '1'] : []),
    ];
    currentCountry = country;
    pinnedCountry = '';
    avoided.clear(); // a new Tor starts without them
    const child = spawn(bin, args, { windowsHide: true, cwd: path.dirname(bin) });
    proc = child;
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; stop(); reject(new Error('The VPN took too long to connect. Check your internet connection.')); } }, 120000);
    let lastLines = '';
    child.stdout.on('data', (d) => {
      lastLines = (lastLines + String(d)).split('\n').slice(-6).join('\n');
      for (const m of String(d).matchAll(/Bootstrapped (\d+)%/g)) {
        progress = +m[1];
        onProgress?.('connect', progress);
        if (progress === 100 && !done) { done = true; clearTimeout(timer); resolve(); }
      }
    });
    child.on('exit', (code) => {
      // Only forget it if it's still the current one (switching country starts a new Tor first).
      if (proc === child) { proc = null; progress = 0; }
      const why = /\[(?:err|warn)\] (.+)/.exec(lastLines)?.[1]?.trim();
      if (!done) { done = true; clearTimeout(timer); reject(new Error(`The VPN stopped unexpectedly${why ? ': ' + why : ` (code ${code})`}.`)); }
    });
  });
}

// Sends one command over Tor's control connection and resolves with its reply.
function control(command) {
  return new Promise((resolve, reject) => {
    const dataDir = path.join(torDir(), 'data');
    let host, ctlPort, cookie;
    try {
      [host, ctlPort] = /PORT=([\d.]+):(\d+)/.exec(fs.readFileSync(path.join(dataDir, 'control-port'), 'utf8')).slice(1);
      cookie = fs.readFileSync(path.join(dataDir, 'control_auth_cookie')).toString('hex');
    } catch { return reject(new Error('The VPN is not running.')); }
    const sock = require('net').connect(+ctlPort, host);
    let reply = '';
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('The VPN did not answer.')); });
    sock.on('error', reject);
    sock.on('data', (d) => { reply += d; });
    sock.on('end', () => (/^250 /m.test(reply) && !/^5\d\d /m.test(reply) ? resolve(reply) : reject(new Error(reply.trim() || 'No reply'))));
    sock.write(`AUTHENTICATE ${cookie}\r\n${command}\r\nQUIT\r\n`);
  });
}

// In automatic mode, Tor can leave through any country and a different one per site, so Link's own
// IP check and the sites you visit can disagree. Pinning the exit to one country keeps them in step.
// (When you chose a country, it's already pinned at launch, so this is a no-op.)
async function pinExitCountry(cc) {
  if (!proc || currentCountry || !cc) return;
  cc = String(cc).toLowerCase();
  if (pinnedCountry === cc) return;
  await control(`SETCONF ExitNodes="{${cc}}" StrictNodes=1`);
  pinnedCountry = cc;
  lastNewExit = Date.now();
  await control('SIGNAL NEWNYM'); // drop old circuits so new connections use the pinned country
}
async function clearExitPin() {
  if (!proc || !pinnedCountry) return;
  await control('RESETCONF ExitNodes\r\nRESETCONF StrictNodes');
  pinnedCountry = '';
}

// Switches new connections to a different exit (Tor's "new identity"). With no country chosen,
// the exit being left (and its neighbours, which sites tend to treat alike) is avoided from then
// on, and the country pin is lifted so the switch can land somewhere new; with a country chosen
// there may be too few exits to skip any.
let lastNewExit = 0;
const avoided = new Set(); // "a.b.c.0/24" blocks, until Tor restarts
async function newExit(avoidIp) {
  if (!proc) throw new Error('The VPN is not running.');
  if (!currentCountry) {
    await clearExitPin().catch(() => {});
    if (/^\d+\.\d+\.\d+\.\d+$/.test(avoidIp || '')) {
      avoided.add(avoidIp.replace(/\.\d+$/, '.0/24'));
      if (avoided.size > 64) avoided.delete(avoided.values().next().value);
      await control(`SETCONF ExcludeExitNodes="${[...avoided].join(',')}"`);
    }
  }
  // Tor only honours this once every 10 seconds; wait out the rest rather than be ignored.
  const wait = lastNewExit + 10500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNewExit = Date.now();
  await control('SIGNAL NEWNYM');
}

const isRunning = (country = '') => !!proc && progress === 100 && currentCountry === country;

// Resolves once Tor is connected with the requested exit country; safe to call repeatedly.
async function start(onProgress, country = '') {
  if (ready) await ready.catch(() => {});
  if (isRunning(country)) return;
  if (proc) stop(); // switching country
  ready = (async () => {
    if (!torBinary()) await download(onProgress);
    await signForMac();
    await preparePort();
    await launch(onProgress, country);
  })().finally(() => { ready = null; });
  return ready;
}

function stop() {
  if (proc) { proc.kill(); proc = null; }
  progress = 0;
}

// getPort is where pages send their traffic: the relay, which passes it on to Tor.
module.exports = { start, stop, preparePort, newExit, pinExitCountry, getPort: () => relayPort || port, isRunning };
