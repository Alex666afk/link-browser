// Auto-update: checks GitHub Releases for a newer Link, downloads it in the background, and installs
// it when you choose to restart (or on the next quit). Only works in the installed app, not when run
// from source or as the portable .exe.
const { autoUpdater } = require('electron-updater');

let send = () => {};
let state = { status: 'idle', version: null, progress: 0, error: null };

function set(patch) {
  state = { ...state, ...patch };
  send('update-status', state);
}

function init(sendToWindow) {
  send = sendToWindow;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, progress: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => set({ status: 'error', error: String(err?.message || err) }));
}

// Checks quietly in the background a few seconds after launch, then daily.
function startBackgroundChecks() {
  if (!canUpdate()) return;
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

const canUpdate = () => {
  try { return require('electron').app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE == null; }
  catch { return false; }
};

async function check() {
  if (!canUpdate()) {
    set({ status: 'unsupported' });
    return state;
  }
  try {
    await autoUpdater.checkForUpdates(); // events (update-available / -not-available / error) drive state
  } catch (err) {
    set({ status: 'error', error: String(err?.message || err) });
  }
  return state;
}

function install() {
  if (state.status === 'ready') autoUpdater.quitAndInstall();
}

module.exports = { init, startBackgroundChecks, check, install, getState: () => state, canUpdate };
