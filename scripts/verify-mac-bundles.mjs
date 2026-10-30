// Check the actual Mac packages without altering their native UI or app behavior.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { extractFile } = require('@electron/asar');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
assert.equal(process.platform, 'darwin', 'Run this verification on the macOS builder');

async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(file));
    else if (item.isFile()) result.push(file);
  }
  return result;
}
const sources = [...await files(path.join(root, 'src')), ...await files(path.join(root, 'assets'))];
for (const [directory, architecture] of [['mac', 'x86_64'], ['mac-arm64', 'arm64']]) {
  const app = path.join(root, 'dist', directory, 'Link.app');
  const plist = path.join(app, 'Contents', 'Info.plist');
  const actualVersion = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  assert.equal(actualVersion, version, 'Bundle version mismatch');
  const actualArchitecture = execFileSync('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'Link')], { encoding: 'utf8' }).trim();
  assert(actualArchitecture.split(/\s+/).includes(architecture), `Missing ${architecture} executable`);
  const archive = path.join(app, 'Contents', 'Resources', 'app.asar');
  for (const source of sources) {
    const relative = path.relative(root, source).split(path.sep).join('/');
    assert(extractFile(archive, relative).equals(await readFile(source)), `Packaged source differs: ${directory}/${relative}`);
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`Verified Link ${version} ${architecture}: ${sources.length} shared source/assets, native signature and bundle metadata.`);
}
