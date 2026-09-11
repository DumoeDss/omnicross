// Minimal Electron host main script for the omnicross chatgpt-web bridge.
//
// Spawned by electronHost.ts with:
//   electron main.cjs --data-dir=<dir> [--login] [--show]
//
// - One persistent partition ("persist:chatgpt") keeps the ChatGPT login.
// - userData is pinned into --data-dir so Chromium writes DevToolsActivePort
//   there and the bridge discovers the CDP endpoint without extra plumbing.
// - Default window is HIDDEN background automation surface; --login/--show
//   makes it visible for interactive sign-in or watching turns.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

function argValue(name) {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : undefined;
}

const dataDir = argValue('data-dir') || app.getPath('userData');
const login = process.argv.includes('--login');
const show = login || process.argv.includes('--show');

app.setPath('userData', dataDir);
app.commandLine.appendSwitch('remote-allow-origins', '*');

const URL = 'https://chatgpt.com';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show,
    title: 'OmniCross · ChatGPT Web (automation)',
    webPreferences: {
      partition: 'persist:chatgpt',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Headless-safe: never steal focus from the user's work; content stays
  // renderable while minimized or occluded.
  if (show) {
    win.showInactive();
  }
  win.loadURL(login ? URL : `${URL}/?temporary-chat=true`);
  win.on('close', (event) => {
    // The bridge owns the lifecycle; hide instead of destroying so an
    // in-flight turn's renderer survives until the bridge stops us.
    if (!win.isDestroyed() && !app.quitting) {
      event.preventDefault();
      win.hide();
    }
  });
});

app.on('before-quit', () => {
  app.quitting = true;
});

// Single instance: a second spawn (login while bridge runs) focuses the
// existing window instead of creating a second profile lock conflict.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
