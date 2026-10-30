import { downloadLabel, downloadUrl, fileSize } from './release-module.mjs';

const version = document.getElementById('release-version');
const platform = document.getElementById('release-platform');
const content = document.getElementById('release-content');
const status = document.getElementById('release-status');
const retry = document.getElementById('release-retry');
const primary = document.getElementById('primary');
const userPlatform = navigator.userAgentData?.platform || navigator.platform || '';
const detected = /Win/i.test(userPlatform) ? 'win' : /Mac/i.test(userPlatform) ? 'mac' : 'all';
let releases = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function render() {
  content.replaceChildren();
  const selected = version.value === 'all' ? releases : releases.filter(release => release.version === version.value);
  let downloads = 0;
  for (const release of selected) {
    const card = element('article', 'release-card');
    card.style.marginBottom = '18px';
    const heading = element('div', 'release-heading');
    const title = element('div');
    title.append(element('h3', '', `Link ${release.version}`));
    const date = new Date(release.publishedAt);
    if (!Number.isNaN(date.getTime())) title.append(element('p', 'release-date', new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'Europe/Paris' }).format(date)));
    heading.append(title, element('span', 'release-badge', release.channel));
    const options = element('div', 'release-downloads');
    const assets = release.assets.filter(asset => platform.value === 'all' || asset.platform === platform.value);
    for (const asset of assets) {
      const option = element('div', 'download-option');
      const label = downloadLabel(asset);
      option.append(element('h4', '', label), element('p', '', `${fileSize(asset.size)} · ${asset.kind === 'portable' ? 'No installation needed' : asset.kind === 'archive' ? 'Compressed app archive' : 'Install Link on your computer'}`));
      const link = element('a', 'btn', 'Download');
      link.href = downloadUrl(asset, document.baseURI);
      link.download = asset.name;
      link.setAttribute('aria-label', `Download Link ${release.version} ${label}`);
      const arrow = element('span', '', '↓');
      arrow.setAttribute('aria-hidden', 'true');
      link.append(arrow);
      option.append(link, element('span', 'download-file', asset.name));
      options.append(option);
      downloads++;
    }
    if (!assets.length) options.append(element('p', 'empty-downloads', `No ${platform.value === 'mac' ? 'macOS' : platform.value === 'win' ? 'Windows' : ''} files are available for this version. Choose another version or platform.`));
    const notes = element('div', 'release-notes');
    notes.append(element('h4', '', "What's new"));
    if (release.notes.length) {
      const list = element('ul');
      release.notes.forEach(note => list.append(element('li', '', note)));
      notes.append(list);
    } else notes.append(element('div', 'release-notes-text', release.notesText));
    if (release.notesSource) notes.append(element('p', 'release-provenance', release.notesSource));
    card.append(heading, options, notes);
    content.append(card);
  }
  status.textContent = `${selected.length} ${selected.length === 1 ? 'version' : 'versions'} · ${downloads} ${downloads === 1 ? 'download' : 'downloads'}`;
}

async function load() {
  retry.hidden = true;
  version.disabled = platform.disabled = true;
  status.textContent = 'Loading available downloads…';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('releases.json', { signal: controller.signal, cache: 'no-cache' });
    if (!response.ok) throw new Error('catalogue');
    const data = await response.json();
    if (!Array.isArray(data.releases) || !data.releases.length) throw new Error('empty');
    releases = data.releases;
    for (const release of releases) {
      if (!Array.isArray(release.assets) || !Array.isArray(release.notes)) throw new Error('format');
      release.assets.forEach(asset => downloadUrl(asset, document.baseURI));
    }
    version.replaceChildren();
    for (const release of releases) {
      const option = element('option', '', `Link ${release.version}`);
      option.value = release.version;
      version.append(option);
    }
    const all = element('option', '', 'All versions');
    all.value = 'all';
    version.append(all);
    platform.value = detected;
    const preferred = releases.find(release => release.assets.some(asset => detected === 'all' || asset.platform === detected)) || releases[0];
    version.value = preferred.version;
    const latest = ['win', 'mac'].map(os => {
      const release = releases.find(item => item.assets.some(asset => asset.platform === os));
      return release ? `${os === 'win' ? 'Windows' : 'macOS'} ${release.version}` : null;
    }).filter(Boolean);
    document.getElementById('latest-version').textContent = latest.join(' · ');
    if (detected === 'win') {
      const installer = preferred.assets.find(asset => asset.platform === 'win' && asset.kind === 'installer');
      if (installer) {
        primary.href = downloadUrl(installer, document.baseURI);
        primary.download = installer.name;
        primary.textContent = `Download for Windows ↓`;
      }
    } else if (detected === 'mac') primary.textContent = 'Choose macOS download ↓';
    version.disabled = platform.disabled = false;
    render();
  } catch {
    content.replaceChildren();
    version.replaceChildren(element('option', '', 'Unavailable'));
    status.textContent = 'Downloads could not be loaded. Please retry.';
    retry.hidden = false;
    primary.href = '#releases';
    primary.removeAttribute('download');
    primary.textContent = 'Get Link ↓';
  } finally { clearTimeout(timeout); }
}
version.addEventListener('change', render);
platform.addEventListener('change', render);
retry.addEventListener('click', load);
load();
