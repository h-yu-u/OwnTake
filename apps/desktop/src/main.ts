import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, utilityProcess } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverConfig } from '../../server/src/config.ts';
import { validateId } from '../../../packages/storage/src/validation.ts';
import type { DesktopInfo } from '../../../packages/contracts/src/desktop.ts';
import { CoreHost } from './core-host.ts';
import { buildCoreEnvironment, validateChoosePathKind, validateDesktopSender } from './policy.ts';
import { iconPng } from './icon.ts';

app.setName('OwnTake');
const config = serverConfig({ port: 0, devOrigin: undefined });
const desktopDir = join(config.dataDir, 'desktop');
mkdirSync(desktopDir, { recursive: true, mode: 0o700 });
app.setPath('userData', desktopDir);
const logPath = join(desktopDir, 'desktop.log');
try { if (statSync(logPath).size > 256 * 1024) renameSync(logPath, logPath + '.previous'); } catch { /* no previous log */ }
function log(event: string) {
  // Only fixed lifecycle event names. Never log provider bodies or credentials.
  try { appendFileSync(logPath, `${new Date().toISOString()} ${event}\n`, { mode: 0o600 }); } catch { /* UI still reports failure */ }
}
const host = new CoreHost(log, utilityProcess.fork);
const icon = nativeImage.createFromBuffer(iconPng());
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let checkingQuit = false;
let ready = false;

function showWindow() {
  if (!ready) return;
  if (!window || window.isDestroyed()) createWindow();
  if (window!.isMinimized()) window!.restore();
  window!.show(); window!.focus();
}

function createWindow() {
  const current = window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640,
    show: false, title: 'OwnTake', backgroundColor: '#10140f', icon,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      spellcheck: false, navigateOnDragDrop: false,
    },
  });
  const contents = current.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin !== host.url) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  contents.on('will-redirect', (event, url) => {
    try { if (new URL(url).origin !== host.url) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.on('render-process-gone', () => {
    log('renderer.exited');
    if (!quitting) void dialog.showMessageBox({ type: 'error', title: '界面已停止',
      message: '本地任务仍由核心管理。重新打开只重载界面，不会重发模型调用。',
      buttons: ['重新打开界面', '退出应用'], defaultId: 0, cancelId: 0,
    }).then(result => result.response === 0 ? current.loadURL(host.url) : app.quit());
  });
  current.once('ready-to-show', () => current.show());
  current.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    current.hide(); log('window.hidden');
  });
  current.once('closed', () => { if (window === current) window = undefined; });
  void current.loadURL(host.url).catch(() => {
    log('window.load.failed');
    if (!quitting) dialog.showErrorBox('无法打开工作台', '请通过菜单重新打开 OwnTake。核心数据未被重置。');
  });
}

function authorize(event: IpcMainInvokeEvent) {
  if (!window || !ready || quitting) throw new Error('OwnTake 正在启动或退出。');
  validateDesktopSender(event, window.webContents.id, host.url);
}

function installBridge() {
  ipcMain.handle('owntake:info', event => {
    authorize(event);
    return { version: app.getVersion(), electron: process.versions.electron, node: host.node,
      platform: process.platform, coreUrl: host.url, background: true } satisfies DesktopInfo;
  });
  ipcMain.handle('owntake:choose-path', async (event, raw: unknown) => {
    authorize(event);
    const kind = validateChoosePathKind(raw);
    const result = await dialog.showOpenDialog(window!, {
      title: kind === 'font' ? '选择字幕字体' : kind === 'runtime' ? '选择 CLI 可执行文件' : `选择 ${kind} 可执行文件`,
      properties: ['openFile', 'showHiddenFiles'],
      ...(kind === 'font' ? { filters: [{ name: '字体', extensions: ['otf', 'ttf', 'ttc'] }] } : {}),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = result.filePaths[0];
    if (!(await stat(selected)).isFile()) throw new Error('请选择一个普通文件。');
    return selected;
  });
  ipcMain.handle('owntake:open-project', async (event, id: unknown) => {
    authorize(event); validateId(id);
    const path = await host.request('projectPath', id);
    if (typeof path !== 'string') throw new Error('无法定位项目目录。');
    const error = await shell.openPath(path);
    if (error) throw new Error('系统无法打开项目目录。');
  });
  ipcMain.handle('owntake:reveal-artifact', async (event, id: unknown) => {
    authorize(event); validateId(id);
    const path = await host.request('artifactPath', id);
    if (typeof path !== 'string') throw new Error('无法定位成片文件。');
    shell.showItemInFolder(path);
  });
}

async function requestQuit() {
  if (checkingQuit || quitting) return;
  checkingQuit = true;
  try {
    if (ready) {
      let activeJobs: number | undefined;
      try { activeJobs = (await host.request('status') as { activeJobs: number }).activeJobs; }
      catch { /* unknown core state must still be disclosed */ }
      if (activeJobs === undefined || activeJobs > 0) {
        const result = await dialog.showMessageBox({ type: 'question', title: '退出 OwnTake？',
          message: activeJobs === undefined ? '无法确认当前任务状态。' : `当前有 ${activeJobs} 项任务尚未结束。`,
          detail: '退出会停止本地工作并保存状态。远端任务可能仍在运行，下次启动会核对已有任务；无法确认的提交不会自动重发。关闭窗口可继续在后台运行。',
          buttons: ['继续后台运行', '保存状态并退出'], defaultId: 0, cancelId: 0,
        });
        if (result.response !== 1) { showWindow(); return; }
      }
    }
    quitting = true; log('app.quitting');
    await host.stop();
    tray?.destroy(); app.quit();
  } finally { checkingQuit = false; }
}

if (!app.requestSingleInstanceLock()) {
  log('app.second-instance'); app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => { /* Closing a window keeps the owned core alive. */ });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  void app.whenReady().then(async () => {
    if (quitting) return;
    const reopen = { label: '打开 OwnTake', click: showWindow };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'OwnTake', submenu: [reopen, { type: 'separator' }, { label: '退出 OwnTake', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
      { role: 'editMenu' },
      { label: '窗口', submenu: [reopen, { role: 'minimize' }, { role: 'close' }, { role: 'togglefullscreen' }] },
    ]));
    try {
      const trayImage = nativeImage.createFromBuffer(iconPng(32));
      if (process.platform === 'darwin') trayImage.setTemplateImage(true);
      tray = new Tray(trayImage);
      tray.setToolTip('OwnTake · 本地创作工作台');
      tray.setContextMenu(Menu.buildFromTemplate([reopen, { type: 'separator' }, { label: '退出 OwnTake', click: () => app.quit() }]));
      tray.on('click', showWindow);
    } catch { log('tray.unavailable'); }
    installBridge();
    await host.start(fileURLToPath(new URL('./service.mjs', import.meta.url)), join(app.getAppPath(), 'apps/web/dist'),
      buildCoreEnvironment(process.env, { dataDir: config.dataDir, projectsDir: config.projectsDir }), () => {
        ready = false;
        dialog.showErrorBox('本地核心已停止', '应用不会自动重发任何模型调用。请退出后重新启动；已知远端任务、完整回复与未知提交将按持久记录恢复。');
        app.quit();
      });
    if (quitting) { await host.stop(); return; }
    ready = true; createWindow(); log('app.ready');
  }).catch(async error => {
    log('app.start.failed');
    if (!quitting) dialog.showErrorBox('OwnTake 启动失败', error instanceof Error ? error.message : '请检查应用文件与数据目录。');
    quitting = true; await host.stop(); tray?.destroy(); app.quit();
  });
}
