# Link website

The website is static. It lists features, available versions, installer files,
and release notes. Downloads use files under this site's `downloads/` directory;
visitors do not need a GitHub account or a GitHub page.

## Preview

Run from the repository root:

```powershell
python -m http.server 8080 --bind 127.0.0.1 --directory website
```

Open http://localhost:8080.

## Prepare versions and downloads

```powershell
npm run dist:win
npm run website:releases
```

The preparation command uses an already authenticated GitHub CLI to retrieve
published releases and their binaries. It adds a local build of the package
version if that version is not published. Credentials stay in the CLI;
the visitor-facing website only fetches `releases.json` from its own host.
Published asset sizes and SHA-256 digests are verified when available.

If the app is running from `dist/win-unpacked`, build into an isolated directory:

```powershell
npx electron-builder --win nsis portable --config.directories.output=dist/website-build
node scripts/prepare-website-releases.mjs --sync --local-build-directory dist/website-build
```

Update `release-notes.json` for curated version notes. Published versions without
curated notes use their original release notes; missing notes are identified.
No version history is invented. Mac downloads only appear when built files exist.

## Hosting

Publish the website together with `downloads/`. Installer files are deliberately
ignored by Git, so a plain source checkout alone does not include the binaries.
Run the preparation command before copying the website to a static file host.
Keep the generated `releases.json` and its matching download directory together.

The largest current installers exceed 100 MB. Check the selected host's
per-file limits and use download storage that permits files of that size.
Serve `.exe`, `.dmg`, and `.zip` files as attachments if your host supports it.
The current catalogue uses same-origin paths, so configure matching download
routes if splitting the page and download hosting.

Downloading an installer starts from the website. The operating system still
requires the visitor to open the file and finish installation.
