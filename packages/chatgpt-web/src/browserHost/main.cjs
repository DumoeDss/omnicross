// Minimal Electron host main script for the omnicross chatgpt-web bridge.
//
// Spawned by electronHost.ts with:
//   electron main.cjs --data-dir=<dir> [--login] [--show]
//
// - One persistent partition ("persist:chatgpt") keeps the ChatGPT login.
// - userData is pinned into --data-dir so Chromium writes DevToolsActivePort
//   there and the bridge discovers the CDP endpoint.
// - Electron's browser-level Target.createTarget is NOT supported, so this
//   main exposes a loopback HTTP control endpoint for tab lifecycle:
//   POST /new-target {url} -> {targetId}   POST /close-target {targetId}
//   The control port is written to <userData>/host-control.json.
// - Default window is a hidden background automation surface; --login/--show
//   makes it visible for interactive sign-in or watching turns.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const { writeFileSync } = require('node:fs');
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
// Blank-window hardening on Windows GPU/driver combos: software rasterize.
app.disableHardwareAcceleration();

const URL = 'https://chatgpt.com';

/** WebContentsViews keyed by their CDP target id (targets on the main frame). */
const views = new Map();

function viewForTarget(targetId) {
  return views.get(targetId);
}

async function listCdpTargets() {
  try {
    const content = require('node:fs')
      .readFileSync(path.join(dataDir, 'DevToolsActivePort'), 'utf8')
      .trim()
      .split(/\r?\n/);
    const port = Number.parseInt(content[0] ?? '', 10);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return await response.json();
  } catch {
    return [];
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function startControlServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.method === 'POST' && req.url === '/new-target') {
        const { url, show } = await readBody(req);
        // One hidden window per automation tab. webContents.id is NOT the CDP
        // target id, so discover the real one through the DevTools HTTP
        // endpoint by diffing the target list before/after window creation.
        const before = new Set((await listCdpTargets()).map((target) => target.id));
        const tabWindow = new BrowserWindow({
          width: 1280,
          height: 900,
          show: show === true,
          title: 'OmniCross · turn',
          webPreferences: {
            partition: 'persist:chatgpt',
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
            paintWhenInitiallyHidden: true,
          },
        });
        await tabWindow.webContents.loadURL('about:blank');
        let targetId = null;
        for (let attempt = 0; attempt < 20 && !targetId; attempt += 1) {
          const fresh = await listCdpTargets();
          const added = fresh.filter((target) => !before.has(target.id));
          if (added.length > 0) targetId = added[added.length - 1].id;
          else await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!targetId) {
          tabWindow.destroy();
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'new tab never appeared in the CDP target list' }));
          return;
        }
        views.set(String(targetId), tabWindow);
        tabWindow.webContents.loadURL(url || 'about:blank');
        res.end(JSON.stringify({ targetId }));
        return;
      }
      if (req.method === 'POST' && req.url === '/close-target') {
        const { targetId } = await readBody(req);
        const tabWindow = viewForTarget(String(targetId));
        if (tabWindow) {
          views.delete(String(targetId));
          if (!tabWindow.isDestroyed()) tabWindow.destroy();
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/healthz') {
        res.end(JSON.stringify({ ok: true, views: views.size }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    writeFileSync(path.join(dataDir, 'host-control.json'), `${JSON.stringify({ port })}\n`);
  });
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    // Create visible windows as visible from the start — a hidden window
    // promoted with showInactive() can stay unpainted on some platforms.
    show,
    title: 'OmniCross · ChatGPT Web (automation)',
    webPreferences: {
      partition: 'persist:chatgpt',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
    },
  });
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
  startControlServer();
});

app.on('before-quit', () => {
  app.quitting = true;
});

// Single instance: a second spawn (login while bridge runs) focuses the
// existing window instead of creating a second profile lock conflict.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
