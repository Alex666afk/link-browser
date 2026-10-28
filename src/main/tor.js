// Link VPN: a built-in Tor client. Downloaded from torproject.org on first use (checksum-verified),
// started in the background when the VPN is turned on, and stopped when Link quits.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { app, net } = require('electron');

const PREFERRED_PORT = 9155; // not 9150/9050, so it doesn't clash with Tor Browser or a Tor service
let port = 0;
const PLATFORMS = { win32: { x64: 'windows-x86_64', ia32: 'windows-i686' }, darwin: { arm64: 'macos-aarch64', x64: 'macos-x86_64' }, linux: { x64: 'linux-x86_64' } };

let proc = null;
let ready = null; // promise while starting
let progress = 0;
let currentCountry = ''; // two-letter exit country, '' = any

const portFree = (p) => new Promise((resolve) => {
  const srv = require('net').createServer();
  srv.once('error', () => resolve(false));
  srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
});

// Picks the local port Tor will listen on (another copy of Link may already be using the usual one).
async function preparePort() {
  if (port && (proc || (await portFree(port)))) return port;
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 40; p++) {
    if (await portFree(p)) return (port = p);
  }
  throw new Error('No free local port for the VPN.');
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
  const meta = await (await net.fetch(`https://aus1.torproject.org/torbrowser/update_3/release/download-${plat}.json`)).json();
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
      ...(geoip ? ['--GeoIPFile', geoip] : []),
      ...(geoip6 ? ['--GeoIPv6File', geoip6] : []),
      // Only leave the Tor network in the chosen country.
      ...(country ? ['--ExitNodes', `{${country}}`, '--StrictNodes', '1'] : []),
    ];
    currentCountry = country;
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

const isRunning = (country = '') => !!proc && progress === 100 && currentCountry === country;

// Resolves once Tor is connected with the requested exit country; safe to call repeatedly.
async function start(onProgress, country = '') {
  if (ready) await ready.catch(() => {});
  if (isRunning(country)) return;
  if (proc) stop(); // switching country
  ready = (async () => {
    if (!torBinary()) await download(onProgress);
    await preparePort();
    await launch(onProgress, country);
  })().finally(() => { ready = null; });
  return ready;
}

function stop() {
  if (proc) { proc.kill(); proc = null; }
  progress = 0;
}

module.exports = { start, stop, preparePort, getPort: () => port, isRunning };
