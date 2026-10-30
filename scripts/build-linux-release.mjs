import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.platform, 'linux', 'Build Linux packages on the Linux runner');
const source = path.resolve(process.argv[2] || '.');
const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
const config = {
  ...pkg.build,
  extraMetadata: { ...pkg.build?.extraMetadata, homepage: pkg.homepage || 'https://github.com/Alex666afk/link-browser' },
  publish: pkg.build?.publish || { provider: 'github', owner: 'Alex666afk', repo: 'link-browser' },
  linux: {
    ...pkg.build?.linux,
    target: ['AppImage', 'deb'], category: 'Network', maintainer: 'Link contributors',
    executableName: 'link', icon: 'assets/icon-1024.png',
    artifactName: 'Link-${version}-linux-${arch}.${ext}',
  },
};
await mkdir(path.join(source, 'dist'), { recursive: true });
const configPath = path.join(source, 'dist', 'linux-build-config.json');
await writeFile(configPath, JSON.stringify(config, null, 2));
execFileSync('npx', ['electron-builder', '--linux', 'AppImage', 'deb', '--x64', '--publish', 'never', '--config', configPath], { cwd: source, stdio: 'inherit' });
