// Prepare static, same-origin downloads without exposing account credentials to visitors.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, copyFile, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const website = path.join(root, 'website');
const repo = 'Alex666afk/link-browser';
const sync = process.argv.includes('--sync');
const metadataPath = path.join(root, 'dist', 'website-release-cache.json');
const localDirectoryFlag = process.argv.indexOf('--local-build-directory');
if (localDirectoryFlag >= 0 && !process.argv[localDirectoryFlag + 1]) throw new Error('Missing local build directory');
const localDirectory = localDirectoryFlag >= 0 ? path.resolve(root, process.argv[localDirectoryFlag + 1]) : path.join(root, 'dist');
await mkdir(path.dirname(metadataPath), { recursive: true });
let published;
if (sync) {
  const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true }));
  published = pages.flat().filter(release => !release.draft);
  await writeFile(metadataPath, JSON.stringify(published, null, 2) + '\n');
  for (const release of published) {
    if (!/^v?\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(release.tag_name)) continue;
    const version = release.tag_name.replace(/^v/, '');
    const directory = path.join(website, 'downloads', version);
    await mkdir(directory, { recursive: true });
    const downloadable = release.assets.filter(asset => /\.(exe|dmg|zip|AppImage|deb)$/i.test(asset.name));
    const missing = [];
    for (const asset of downloadable) {
      if (path.basename(asset.name) !== asset.name) throw new Error('Invalid release asset name');
      const existing = await stat(path.join(directory, asset.name)).catch(() => null);
      if (!existing || existing.size !== asset.size) missing.push(asset.name);
      else if (asset.digest?.startsWith('sha256:') && asset.digest !== 'sha256:' + await digest(path.join(directory, asset.name))) missing.push(asset.name);
    }
    if (missing.length) {
      const args = ['release', 'download', release.tag_name, '--repo', repo, '--dir', directory, '--clobber'];
      missing.forEach(name => args.push('--pattern', name));
      execFileSync('gh', args, { stdio: 'inherit', windowsHide: true });
    }
  }
} else {
  published = JSON.parse(await readFile(metadataPath, 'utf8').catch(() => '[]'));
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const currentVersion = packageJson.version;
if (!/^\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(currentVersion)) throw new Error('Invalid package version');
const currentDirectory = path.join(website, 'downloads', currentVersion);
await mkdir(currentDirectory, { recursive: true });
const localNames = (await readdir(localDirectory).catch(() => [])).filter(name => name.includes(`-${currentVersion}`) && /\.(exe|dmg|zip|AppImage|deb)$/i.test(name));
const alreadyPublished = published.some(release => release.tag_name.replace(/^v/, '') === currentVersion);
if (!alreadyPublished) {
  for (const name of localNames) await copyFile(path.join(localDirectory, name), path.join(currentDirectory, name));
}
const notes = JSON.parse(await readFile(path.join(website, 'release-notes.json'), 'utf8'));
const versions = new Map();
for (const release of published) {
  const version = release.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(version)) continue;
  versions.set(version, { version, publishedAt: release.published_at, channel: release.prerelease ? 'Preview release' : 'Published release', publishedAssets: release.assets, body: release.body });
}
if (!alreadyPublished && localNames.length) {
  const buildStat = await stat(path.join(localDirectory, localNames[0]));
  versions.set(currentVersion, { version: currentVersion, publishedAt: buildStat.mtime.toISOString(), channel: 'Local build', publishedAssets: [] });
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const releases = [];
for (const release of versions.values()) {
  const assets = [];
  const directory = path.join(website, 'downloads', release.version);
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/\.(exe|dmg|zip|AppImage|deb)$/i.test(name)) continue;
    const file = path.join(directory, name);
    const info = await stat(file);
    const sha256 = await digest(file);
    const original = release.publishedAssets.find(asset => asset.name === name);
    if (original && original.size !== info.size) throw new Error(`Incomplete download: ${name}`);
    if (original?.digest?.startsWith('sha256:') && original.digest !== 'sha256:' + sha256) throw new Error(`Checksum mismatch: ${name}`);
    const platform = name.endsWith('.exe') ? 'win' : /mac/i.test(name) || name.endsWith('.dmg') ? 'mac' : /linux/i.test(name) || name.endsWith('.deb') || /\.AppImage$/i.test(name) ? 'linux' : 'other';
    const arch = /arm64|aarch64/i.test(name) ? 'arm64' : /x64|x86_64|amd64/i.test(name) || platform === 'win' ? 'x64' : '';
    const kind = /portable|\.AppImage$/i.test(name) ? 'portable' : name.endsWith('.zip') ? 'archive' : 'installer';
    assets.push({ name, path: `downloads/${release.version}/${encodeURIComponent(name)}`, size: info.size, sha256, platform, arch, kind });
  }
  if (!assets.length) continue;
  const platformOrder = { win: 0, mac: 1, linux: 2, other: 3 };
  const kindOrder = { installer: 0, portable: 1, archive: 2 };
  assets.sort((a, b) => platformOrder[a.platform] - platformOrder[b.platform] || kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name));
  const entry = notes[release.version];
  releases.push({ version: release.version, publishedAt: release.publishedAt, channel: release.channel, notes: entry?.notes || [], notesText: entry ? '' : release.body || 'No release notes were provided for this version.', notesSource: entry?.source || '', assets });
}
releases.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
const output = path.join(website, 'releases.json');
await writeFile(output + '.pending', JSON.stringify({ generatedAt: new Date().toISOString(), releases }, null, 2) + '\n');
await rename(output + '.pending', output);
console.log(`Prepared ${releases.length} versions and ${releases.reduce((sum, release) => sum + release.assets.length, 0)} downloads.`);
