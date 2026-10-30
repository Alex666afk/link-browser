// Video downloader: saves the video from the page you're on. Uses yt-dlp (youtube-dl's successor,
// which supports YouTube and a thousand other sites), downloaded from its GitHub release on first
// use and checked against the release's published SHA-256. For personal use; some sites' terms don't
// allow downloading, so that's on you.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, net } = require('electron');

const ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform];
const toolDir = () => path.join(app.getPath('userData'), 'tools');
const binPath = () => path.join(toolDir(), ASSET || 'yt-dlp');
const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

let getting = null; // in-flight download promise

async function ensureBinary(onStatus) {
  if (fs.existsSync(binPath())) return binPath();
  if (getting) return getting;
  getting = (async () => {
    if (!ASSET) throw new Error('The video downloader is not available on this system.');
    onStatus?.({ phase: 'setup', percent: 0 });
    const sums = await (await net.fetch(`${RELEASE}/SHA2-256SUMS`)).text();
    const expected = sums.split('\n').find((l) => l.trim().endsWith(' ' + ASSET) || l.trim().endsWith('*' + ASSET))?.split(/\s+/)[0];

    const res = await net.fetch(`${RELEASE}/${ASSET}`);
    if (!res.ok) throw new Error(`Couldn't download the video tool (${res.status}).`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      got += chunk.length;
      if (total) onStatus?.({ phase: 'setup', percent: Math.round((got / total) * 100) });
    }
    const buf = Buffer.concat(chunks);
    if (expected && crypto.createHash('sha256').update(buf).digest('hex') !== expected) {
      throw new Error('The video tool download was corrupted. Please try again.');
    }
    fs.mkdirSync(toolDir(), { recursive: true });
    fs.writeFileSync(binPath(), buf, { mode: 0o755 });
    return binPath();
  })().finally(() => { getting = null; });
  return getting;
}

// Downloads the video at pageUrl into the Downloads folder, reporting progress as it goes.
function run(bin, pageUrl, onStatus) {
  return new Promise((resolve, reject) => {
    const out = path.join(app.getPath('downloads'), '%(title).150B [%(id)s].%(ext)s');
    const args = [
      pageUrl,
      '--no-playlist', // just this video, not a whole playlist/channel
      '--newline', // one progress line at a time, so we can report it
      '--no-part', '--no-mtime', '--restrict-filenames',
      // Best single pre-merged file (no ffmpeg needed), preferring mp4.
      '-f', 'best[ext=mp4]/best',
      '-o', out,
      '--print', 'after_move:filepath',
    ];
    const child = spawn(bin, args, { windowsHide: true });
    let savedPath = '';
    let title = '';
    let lastErr = '';
    const onLine = (buf, stderr) => {
      for (const line of String(buf).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const pct = /\[download\]\s+([\d.]+)%/.exec(t);
        if (pct) onStatus?.({ phase: 'download', percent: Math.round(+pct[1]) });
        else if (/^\[download\] Destination: /.test(t)) title = path.basename(t.slice(24));
        else if (/^(ERROR|error):/i.test(t)) lastErr = t.replace(/^error:\s*/i, '');
        else if (stderr && t) lastErr = t;
        else if (!pct && !t.startsWith('[')) savedPath = t; // the --print filepath line
      }
    };
    child.stdout.on('data', (d) => onLine(d, false));
    child.stderr.on('data', (d) => onLine(d, true));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ path: savedPath || null, title: title || path.basename(savedPath || '') });
      else reject(new Error(friendly(lastErr)));
    });
  });
}

function friendly(err) {
  if (/Unsupported URL|no video|Unable to extract|not a valid URL|no media/i.test(err)) {
    return 'No downloadable video was found on this page.';
  }
  if (/Sign in|age|login|private|members-only/i.test(err)) return 'This video needs you to be signed in, or is private.';
  return err || 'The video could not be downloaded.';
}

async function download(pageUrl, onStatus) {
  if (!/^https?:\/\//i.test(pageUrl || '')) throw new Error('Open a web page with a video first.');
  const bin = await ensureBinary(onStatus);
  return run(bin, pageUrl, onStatus);
}

module.exports = { download, isAvailable: () => !!ASSET };
