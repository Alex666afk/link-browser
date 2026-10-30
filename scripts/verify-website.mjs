import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { downloadLabel, downloadUrl, fileSize } from '../website/release-module.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'website');
const catalogue = JSON.parse(await readFile(path.join(site, 'releases.json'), 'utf8'));
const html = await readFile(path.join(site, 'index.html'), 'utf8');
const source = (await readFile(path.join(site, 'releases.js'), 'utf8')).replace(/^import[^\n]+\n/, '');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size, 'Duplicate HTML IDs');
assert(!/protection-test|vpn-showcase|ipify|probes\/|live-checks|class="compare"/.test(html), 'Obsolete test UI remains');
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  const target = match[1];
  if (!/^https?:/.test(target)) await stat(path.join(site, decodeURIComponent(target)));
}
for (const release of catalogue.releases) {
  assert(release.notes.length || release.notesText, 'Missing notes state');
  for (const asset of release.assets) {
    const url = downloadUrl(asset, 'http://localhost:8080/');
    assert(url.startsWith('http://localhost:8080/downloads/'));
    const info = await stat(path.join(site, decodeURIComponent(asset.path)));
    assert.equal(info.size, asset.size);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
}
assert.throws(() => downloadUrl({ path: 'https://example.com/setup.exe' }, 'http://localhost:8080/'));
assert.throws(() => downloadUrl({ path: 'downloads/../../secret.exe' }, 'http://localhost:8080/'));
assert.throws(() => downloadUrl({ path: 'downloads/page.html' }, 'http://localhost:8080/'));
assert.match(downloadUrl({ path: 'downloads/1.0.1/Link-1.0.1-linux-x64.AppImage' }, 'http://localhost:8080/'), /\.AppImage$/);
assert.match(downloadLabel({ platform: 'linux', arch: 'x64', name: 'Link-1.0.1-linux-x64.deb' }), /Debian/);

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.value = ''; this.textContent = ''; this.hidden = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
}
function descendants(node, predicate) { return node.children.flatMap(child => [ ...(predicate(child) ? [child] : []), ...descendants(child, predicate) ]); }
async function browser(platformName, fail = false) {
  const nodes = new Map(ids.map(id => [id, new Node()]));
  const document = { baseURI: 'http://localhost:8080/', getElementById: id => { assert(nodes.has(id), `Missing ${id}`); return nodes.get(id); }, createElement: tag => new Node(tag) };
  const context = { document, navigator: { platform: platformName }, fetch: async () => ({ ok: !fail, json: async () => catalogue }), AbortController, setTimeout, clearTimeout, URL, Intl, Date, downloadLabel, downloadUrl, fileSize };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return nodes;
}
const windows = await browser('Win32');
assert.equal(windows.get('release-platform').value, 'win');
assert(windows.get('primary').href.startsWith('http://localhost:8080/downloads/'));
assert(windows.get('primary').download.endsWith('.exe'));
assert.equal(windows.get('release-version').disabled, false);
windows.get('release-version').value = 'all';
windows.get('release-platform').value = 'all';
windows.get('release-version').listeners.change();
const links = descendants(windows.get('release-content'), node => node.tagName === 'a');
assert.equal(links.length, catalogue.releases.reduce((sum, release) => sum + release.assets.length, 0));
assert(links.every(link => link.download && link.href.startsWith('http://localhost:8080/downloads/')));
const mac = await browser('MacIntel');
assert.equal(mac.get('release-platform').value, 'mac');
const macRelease = catalogue.releases.find(release => release.assets.some(asset => asset.platform === 'mac'));
assert.equal(mac.get('release-version').value, macRelease.version);
assert.match(mac.get('primary').textContent, /Choose macOS/);
const linux = await browser('Linux x86_64');
assert.equal(linux.get('release-platform').value, 'linux');
const linuxRelease = catalogue.releases.find(release => release.assets.some(asset => asset.platform === 'linux'));
if (linuxRelease) assert.equal(linux.get('release-version').value, linuxRelease.version);
assert.match(linux.get('primary').textContent, /Choose Linux/);
const failed = await browser('Win32', true);
assert.equal(failed.get('release-retry').hidden, false);
assert.match(failed.get('release-status').textContent, /could not be loaded/);
console.log(`Verified ${catalogue.releases.length} versions, ${links.length} local downloads, release notes, platform defaults, filters, and load-error recovery.`);
