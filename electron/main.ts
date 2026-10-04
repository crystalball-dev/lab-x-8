/**
 * Desktop shell. Starts the app in its own window, without a browser and without Node on the
 * machine, and provides what a browser cannot: FFmpeg, direct disk access, system audio
 * capture without a dialog, and rendering that never slows down in the background.
 *
 * The app itself is unchanged. The shell serves it from a private local server and adds a
 * small, fixed API (see preload.ts).
 */
import {
  BrowserWindow,
  Menu,
  app,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ExportBridge } from '../bridge/ExportBridge';
import { ALLOWED_EXTENSIONS } from '../bridge/codecs';
import { BRAND } from '../src/brand';
import { CHANNEL, type ShellInfo } from './channels';
import { resolvePaths } from './paths';
import { PictureFolder } from './pictures';
import { startServer, type AppServer } from './server';
import { SettingsFile, type WindowState } from './settings';

const LAST_EXPORT_DIR = 'desktop.lastExportDir';
const DEFAULT_WINDOW: WindowState = { width: 1600, height: 900, maximized: false };
const PUBLISHER_HOST = new URL(BRAND.website).hostname;

// Rendering must never slow down because the window is covered, minimized or out of focus.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// On machines with two graphics processors, use the fast one.
app.commandLine.appendSwitch('force_high_performance_gpu');

const paths = resolvePaths();
mkdirSync(paths.dataDir, { recursive: true });
// The browser engine keeps its caches here. Setting it keeps a portable app self-contained.
app.setPath('userData', join(paths.dataDir, 'profile'));

const settings = new SettingsFile(join(paths.dataDir, 'settings.json'));
/** Copies of the pictures that presets and the session use. */
const pictures = new PictureFolder(join(paths.dataDir, 'pictures'));
const bridgeToken = randomBytes(24).toString('hex');
/** Paths the user picked in a save dialog and that have not been written yet. */
const approvedPaths = new Set<string>();
/** Files this session has written. Only these may be revealed in the file manager. */
const writtenFiles = new Set<string>();

let server: AppServer | null = null;
let bridge: ExportBridge | null = null;
let window: BrowserWindow | null = null;
let quitting = false;

function log(message: string, error?: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : error ? String(error) : '';
  const line = `${new Date().toISOString()} ${message} ${detail}`.trim();
  console.error(line);
  try {
    appendFileSync(join(paths.dataDir, `${BRAND.slug}.log`), `${line}\n`);
  } catch {
    // The log is a convenience. Failing to write it must not stop the app.
  }
}

/** The app icon as a file. A packaged app carries it in the web app, a development run in build/. */
function iconFile(): string {
  return app.isPackaged ? join(paths.webRoot, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png');
}

/** True for pages of the publisher's website, the only place the app links to. */
function isPublisherSite(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === PUBLISHER_HOST || hostname === `www.${PUBLISHER_HOST}`);
  } catch {
    return false;
  }
}

function openWebsite(): void {
  void shell.openExternal(BRAND.website);
}

function showAbout(): void {
  const icon = nativeImage.createFromPath(iconFile());
  const options: MessageBoxOptions = {
    type: 'none',
    title: `About ${BRAND.name}`,
    message: `${BRAND.name}  ${app.getVersion()}`,
    detail: [
      `${BRAND.tagline} for rave, EDM and drum and bass.`,
      '',
      `${BRAND.copyright}. All rights reserved.`,
      `${BRAND.publisherNote}.`,
      BRAND.websiteLabel,
    ].join('\n'),
    buttons: ['Close', `Open ${BRAND.websiteLabel}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    icon: icon.isEmpty() ? undefined : icon,
  };
  const shown = window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  void shown.then(({ response }) => {
    if (response === 1) openWebsite();
  });
}

/** True when a message really comes from the app's own page. */
function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return server !== null && url.startsWith(`${server.origin}/`);
}

function openExportFolder(): void {
  mkdirSync(paths.exportDir, { recursive: true });
  void shell.openPath(paths.exportDir);
}

function registerMessages(): void {
  ipcMain.on(CHANNEL.info, (event) => {
    const info: ShellInfo = {
      version: app.getVersion(),
      platform: process.platform,
      portable: paths.portable,
      bridgeToken,
      exportDir: paths.exportDir,
    };
    // A synchronous message must always be answered, or the page would hang.
    event.returnValue = fromApp(event) ? info : null;
  });

  ipcMain.on(CHANNEL.readState, (event) => {
    event.returnValue = fromApp(event) ? settings.values : {};
  });

  ipcMain.on(CHANNEL.writeState, (event, message: { key?: unknown; value?: unknown }) => {
    if (!fromApp(event) || typeof message?.key !== 'string') return;
    const { key, value } = message;
    // The shell's own entries are not the page's to change.
    if (key.startsWith('desktop.')) return;
    settings.setValue(key, typeof value === 'string' ? value : null);
  });

  ipcMain.handle(CHANNEL.chooseExportFile, async (event, suggested: unknown) => {
    if (!fromApp(event) || !window) return null;
    const name = basename(String(suggested));
    const extension = extname(name).slice(1).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) return null;

    const folder = settings.values[LAST_EXPORT_DIR] ?? paths.exportDir;
    const result = await dialog.showSaveDialog(window, {
      title: 'Export video',
      defaultPath: join(folder, name),
      filters: [{ name: `${extension.toUpperCase()} video`, extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) return null;

    let chosen = resolve(result.filePath);
    if (extname(chosen).slice(1).toLowerCase() !== extension) chosen += `.${extension}`;
    approvedPaths.add(chosen);
    settings.setValue(LAST_EXPORT_DIR, dirname(chosen));
    return chosen;
  });

  ipcMain.on(CHANNEL.showInFolder, (event, path: unknown) => {
    if (!fromApp(event) || typeof path !== 'string') return;
    const file = resolve(path);
    if (writtenFiles.has(file)) shell.showItemInFolder(file);
  });

  ipcMain.on(CHANNEL.openExportFolder, (event) => {
    if (fromApp(event)) openExportFolder();
  });

  ipcMain.handle(CHANNEL.putPicture, (event, bytes: unknown) => {
    if (!fromApp(event) || !(bytes instanceof Uint8Array)) return null;
    try {
      return pictures.put(bytes);
    } catch (error) {
      log('A picture could not be kept.', error);
      return null;
    }
  });

  ipcMain.handle(CHANNEL.getPicture, (event, id: unknown) => {
    if (!fromApp(event) || typeof id !== 'string') return null;
    return pictures.get(id);
  });

  ipcMain.handle(CHANNEL.keepPictures, (event, ids: unknown) => {
    if (!fromApp(event) || !Array.isArray(ids)) return 0;
    return pictures.keepOnly(ids.filter((id): id is string => typeof id === 'string'));
  });
}

/** Grants the page exactly what the app uses, and only to the app's own page. */
function configurePermissions(origin: string): void {
  const allowed = new Set(['media', 'display-capture', 'fullscreen']);
  const own = (url: string | undefined): boolean => (url ?? '').startsWith(origin);
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!own(details.requestingUrl ?? contents.getURL()) || !allowed.has(permission)) {
      callback(false);
      return;
    }
    // Audio inputs only. The app has no use for a camera.
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(permission !== 'media' || !types.includes('video'));
  });
  ses.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) => own(requestingOrigin) && allowed.has(permission),
  );

  // "System" audio: hand over what the computer is playing, without asking which screen.
  // The page requests a screen because the web API requires it, and drops the picture at once.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!own(request.securityOrigin)) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const source = sources[0];
        if (!source) callback({});
        else if (process.platform === 'win32') callback({ video: source, audio: 'loopback' });
        else callback({ video: source });
      })
      .catch((error: unknown) => {
        log('Could not list screens for audio capture.', error);
        callback({});
      });
  });
}

/** The saved window position, unless the screen it was on is gone. */
function restoredWindow(): WindowState {
  const saved = settings.window;
  if (!saved || !(saved.width >= 400) || !(saved.height >= 300)) return DEFAULT_WINDOW;
  if (saved.x === undefined || saved.y === undefined) return saved;
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      saved.x! < area.x + area.width - 80 &&
      saved.x! + saved.width > area.x + 80 &&
      saved.y! >= area.y - 10 &&
      saved.y! < area.y + area.height - 80
    );
  });
  return visible ? saved : { ...DEFAULT_WINDOW, maximized: saved.maximized };
}

function createWindow(origin: string): void {
  const state = restoredWindow();
  const created = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#06020c',
    title: BRAND.name,
    autoHideMenuBar: true,
    // A packaged app shows the icon built into its executable.
    icon: app.isPackaged ? undefined : iconFile(),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  window = created;
  if (state.maximized) created.maximize();
  created.once('ready-to-show', () => created.show());

  // The window shows the app and nothing else. Links to the publisher's website open in the
  // system browser.
  created.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${origin}/`)) event.preventDefault();
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (isPublisherSite(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  created.webContents.on('render-process-gone', (_event, details) => {
    log(`The page stopped (${details.reason}).`);
    if (details.reason !== 'clean-exit' && !created.isDestroyed()) created.reload();
  });

  // Remembered as it changes, not only on closing, so a crash does not lose it.
  const remember = (): void => {
    if (created.isDestroyed() || created.isMinimized() || created.isFullScreen()) return;
    settings.window = { ...created.getNormalBounds(), maximized: created.isMaximized() };
  };
  for (const change of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
    created.on(change as 'resize', remember);
  }
  created.on('close', remember);
  created.on('closed', () => {
    window = null;
  });

  void created.loadURL(`${origin}/`);
}

function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open exports folder', click: openExportFolder },
        { label: 'Open settings folder', click: () => void shell.openPath(paths.dataDir) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: `About ${BRAND.name}`, click: showAbout },
        { label: `${BRAND.publisherShort} website`, click: openWebsite },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start(): Promise<void> {
  bridge = new ExportBridge({
    exportDir: paths.exportDir,
    ffmpegPaths: paths.ffmpegCandidates,
    token: bridgeToken,
    claimOutputPath: (path) => approvedPaths.delete(resolve(path)),
    onFileWritten: (path) => writtenFiles.add(resolve(path)),
  });
  const devServer = process.env.LABX8_DEV_SERVER;
  server = await startServer({
    bridge,
    webRoot: paths.webRoot,
    devServer: devServer ? new URL(devServer) : undefined,
  });

  registerMessages();
  configurePermissions(server.origin);
  createMenu();
  createWindow(server.origin);
}

/** Stops running exports, removes their partial files, and saves the settings. */
async function shutdown(): Promise<void> {
  settings.flush();
  const closing = Promise.all([bridge?.dispose(), server?.close()]);
  await Promise.race([closing, new Promise((done) => setTimeout(done, 5000))]);
}

process.on('uncaughtException', (error) => log('Unexpected error.', error));
process.on('unhandledRejection', (error) => log('Unexpected rejection.', error));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });

  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      log('The app could not start.', error);
      dialog.showErrorBox(
        `${BRAND.name} could not start`,
        error instanceof Error ? error.message : String(error),
      );
      app.exit(1);
    });
}
