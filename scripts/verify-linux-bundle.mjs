import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve(process.argv[2] || '.');
const require = createRequire(path.join(source, 'package.json'));
const { extractFile } = require('@electron/asar');
const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
const archive = path.join(source, 'dist', 'linux-unpacked', 'resources', 'app.asar');
const packaged = JSON.parse(extractFile(archive, 'package.json').toString());
assert.equal(packaged.version, pkg.version);
async function verify(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await verify(file);
    else if (item.isFile()) assert(extractFile(archive, path.relative(source, file).split(path.sep).join('/')).equals(await readFile(file)), `Source mismatch: ${file}`);
  }
}
await verify(path.join(source, 'src'));
await verify(path.join(source, 'assets'));
// electron-builder names the package with Debian's arch convention (e.g. Link-1.0.0-linux-amd64.deb),
// so find it rather than assume a fixed name.
const debName = (await readdir(path.join(source, 'dist'))).find((f) => f.endsWith('.deb'));
assert(debName, 'No .deb package was produced in dist/');
const deb = path.join(source, 'dist', debName);
const version = execFileSync('dpkg-deb', ['--field', deb, 'Version'], { encoding: 'utf8' }).trim();
assert.equal(version, pkg.version);
const architecture = execFileSync('dpkg-deb', ['--field', deb, 'Architecture'], { encoding: 'utf8' }).trim();
assert.equal(architecture, 'amd64');
console.log(`Verified Linux ${pkg.version}: original source, package version and amd64 architecture.`);
