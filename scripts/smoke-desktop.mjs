#!/usr/bin/env node
/**
 * Actual Electron smoke, after `npm run build:desktop`.
 * Run from the repository with `node scripts/smoke-desktop.mjs`.
 *
 * Optional environment:
 *   OWNTAKE_DESKTOP_EXECUTABLE: packaged app executable, absolute or repo-relative.
 *   OWNTAKE_DESKTOP_SCREENSHOT: screenshot file, absolute or repo-relative.
 *   OWNTAKE_SMOKE_FFMPEG / OWNTAKE_SMOKE_FFPROBE: explicit tool paths.
 *   OWNTAKE_DESKTOP_HEADLESS=1: Linux Ozone headless; automatic without a display.
 *   OWNTAKE_DESKTOP_TEST_NO_SANDBOX=1: explicit CI-only sandbox opt-out.
 *
 * Use xvfb-run externally when an X display is preferred. This script never
 * bypasses the app's single-instance lock. Native file dialogs and file-manager
 * methods are intercepted only in the tested main process; no provider or CLI
 * is configured. Failed runs keep their temporary data and lifecycle log.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron } from 'playwright-core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const unsafeSandbox = process.env.OWNTAKE_DESKTOP_TEST_NO_SANDBOX === '1';
const packagedExecutable = process.env.OWNTAKE_DESKTOP_EXECUTABLE
  ? resolve(repo, process.env.OWNTAKE_DESKTOP_EXECUTABLE) : undefined;
const screenshotPath = process.env.OWNTAKE_DESKTOP_SCREENSHOT
  ? resolve(repo, process.env.OWNTAKE_DESKTOP_SCREENSHOT) : undefined;
const headless = process.platform === 'linux' && process.env.OWNTAKE_DESKTOP_HEADLESS !== '0'
  && (process.env.OWNTAKE_DESKTOP_HEADLESS === '1' || !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
const flags = [...(headless ? ['--ozone-platform=headless'] : []), ...(unsafeSandbox ? ['--no-sandbox'] : [])];
const pageErrors = [];
const remoteRequests = [];
const observedPages = new WeakSet();
let running;
let temporary;
let success = false;

function step(message) { console.log(`[desktop-smoke] ${message}`); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function bounded(promise, timeout, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout} ms`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function until(read, ready, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (ready(value)) return value;
    await delay(100);
  } while (Date.now() < end);
  throw new Error(`${label} timed out; last result: ${JSON.stringify(value)}`);
}
async function executable(configured, name) {
  const names = process.platform === 'win32' ? [name + '.exe', name] : [name];
  const candidates = configured ? [resolve(repo, configured)]
    : (process.env.PATH || '').split(delimiter).filter(Boolean).flatMap(directory => names.map(binary => join(directory, binary)));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Cannot find ${name}. Install it or set OWNTAKE_SMOKE_${name.toUpperCase()} to its executable path.`);
}
async function runTool(path, args) {
  try { return await exec(path, args, { cwd: repo, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }); }
  catch (error) { throw new Error(`${path} failed: ${String(error.stderr || error.message).slice(-4000)}`, { cause: error }); }
}
function observe(page) {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('crash', () => pageErrors.push('Renderer process crashed'));
}
async function launch(env) {
  // Playwright otherwise adds --no-sandbox by default on Linux. Keep it enabled
  // unless the explicit test opt-out above was supplied.
  running = await _electron.launch({ cwd: repo, args: [...flags, ...(packagedExecutable ? [] : ['.'])],
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    chromiumSandbox: !unsafeSandbox, env, timeout: 45000 });
  running.on('window', observe);
  for (const page of running.windows()) observe(page);
  await running.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      remoteRequests.push(url.origin); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await running.firstWindow({ timeout: 35000 });
  observe(page);
  await page.waitForFunction(() => typeof window.ownTakeDesktop?.info === 'function');
  await page.locator('.initial-loading').waitFor({ state: 'detached' });
  const info = await page.evaluate(() => window.ownTakeDesktop.info());
  const origin = new URL(info.coreUrl);
  assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(Number(origin.port) > 0); assert.equal(info.background, true);
  assert.ok(info.version && info.electron && info.node);
  assert.equal(new URL(page.url()).origin, origin.origin);
  return { page, info };
}
async function apiSession(coreUrl) {
  const bootstrap = await fetch(coreUrl + '/api/session', { signal: AbortSignal.timeout(10000) });
  assert.equal(bootstrap.status, 200, 'Session bootstrap');
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
  const { csrfToken } = await bootstrap.json();
  assert.ok(cookie && csrfToken);
  async function send(path, { method = 'GET', body, raw, expected = 200 } = {}) {
    assert.ok(path.startsWith('/api/'), 'The test API client only accesses local /api resources');
    const response = await fetch(coreUrl + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...(raw ? { 'Content-Type': 'application/octet-stream' } : body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) });
    if (response.status !== expected) throw new Error(`${method} ${path}: expected ${expected}, got ${response.status}: ${(await response.text()).slice(0, 3000)}`);
    return response;
  }
  return {
    json: async (path, options) => (await send(path, options)).json(),
    bytes: async path => Buffer.from(await (await send(path)).arrayBuffer()),
  };
}
async function installNativeMocks() {
  await running.evaluate(({ dialog, shell }) => {
    const state = globalThis.__ownTakeDesktopSmoke = { results: [], dialogs: [], opened: [], revealed: [] };
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      state.dialogs.push({ title: options.title, properties: options.properties, filters: options.filters || [] });
      if (!state.results.length) throw new Error('Unexpected native file dialog in desktop smoke');
      return state.results.shift();
    };
    shell.openPath = async path => { state.opened.push(path); return ''; };
    shell.showItemInFolder = path => { state.revealed.push(path); };
  });
}
async function nativeState() {
  return running.evaluate(() => {
    const state = globalThis.__ownTakeDesktopSmoke;
    return { pending: state.results.length, dialogs: state.dialogs, opened: state.opened, revealed: state.revealed };
  });
}
async function chooseFile(page, label, file) {
  const previous = (await nativeState()).dialogs.length;
  await running.evaluate((_, value) => { globalThis.__ownTakeDesktopSmoke.results.push({ canceled: value === null, filePaths: value === null ? [] : [value] }); }, file);
  const button = page.getByRole('button', { name: label, exact: true });
  await button.click();
  await until(nativeState, state => state.dialogs.length === previous + 1 && state.pending === 0, `Native dialog ${label}`);
  await until(() => button.isEnabled(), Boolean, `Native dialog completion ${label}`);
}
async function navigate(page, label) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: label, exact: true }).click();
}
async function openProjectUi(page, name) {
  await navigate(page, '作品');
  await page.locator('.project-card').filter({ hasText: name }).click();
  await page.getByRole('button', { name: '打开当前项目目录', exact: true }).waitFor({ state: 'visible' });
  await navigate(page, '导出');
  await page.getByRole('heading', { name: '让故事成为作品', exact: true }).waitFor({ state: 'visible' });
}
async function assertNoPaidOperations(api, projectId) {
  assert.deepEqual(await api.json('/api/providers'), []);
  assert.deepEqual(await api.json('/api/runtimes'), []);
  for (const category of ['calls', 'generations', 'studio-operations']) assert.deepEqual(await api.json(`/api/projects/${projectId}/${category}`), [], `No ${category} should be created by this smoke`);
}
async function normalQuit(dataDir, coreUrl) {
  const app = running;
  assert.ok(app);
  // ElectronApplication.close() calls app.quit(), exercising OwnTake's normal
  // before-quit/core shutdown path rather than destroying its BrowserWindow.
  await bounded(app.close(), 30000, 'Normal application quit');
  running = undefined;
  assert.equal(app.process().exitCode, 0, 'Electron should exit normally');
  await until(() => exists(join(dataDir, 'instance.lock')), locked => !locked, 'Core instance lock release');
  await until(async () => {
    try { const response = await fetch(coreUrl + '/api/session', { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); return false; }
    catch { return true; }
  }, Boolean, 'Owned HTTP service shutdown');
}

try {
  if (process.platform === 'linux' && process.getuid?.() === 0 && !unsafeSandbox) {
    throw new Error('Electron sandbox cannot run as root. Use a normal user, or explicitly opt into OWNTAKE_DESKTOP_TEST_NO_SANDBOX=1 for this isolated CI test.');
  }
  if (packagedExecutable) {
    await access(packagedExecutable, constants.X_OK);
    assert.ok((await stat(packagedExecutable)).isFile(), 'OWNTAKE_DESKTOP_EXECUTABLE must point to the packaged executable, not its .app directory');
  } else {
    for (const file of ['apps/desktop/dist/main.mjs', 'apps/desktop/dist/preload.cjs', 'apps/desktop/dist/service.mjs', 'apps/web/dist/index.html']) {
      if (!await exists(join(repo, file))) throw new Error(`Missing ${file}; run npm run build:desktop first.`);
    }
  }
  const [ffmpeg, ffprobe] = await Promise.all([executable(process.env.OWNTAKE_SMOKE_FFMPEG, 'ffmpeg'), executable(process.env.OWNTAKE_SMOKE_FFPROBE, 'ffprobe')]);
  temporary = await mkdtemp(join(tmpdir(), 'owntake-desktop-smoke-'));
  const dataDir = join(temporary, 'data');
  const projectsDir = join(temporary, 'projects');
  const sourcePath = join(temporary, '桌面 smoke clip.mp4');
  const outputPath = join(temporary, 'verified-export.mp4');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('OWNTAKE_') && !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)));
  Object.assign(env, { OWNTAKE_DATA_DIR: dataDir, OWNTAKE_PROJECTS_DIR: projectsDir, OWNTAKE_PORT: '0' });
  step(`Local fixture; ${packagedExecutable ? 'packaged executable' : 'repository Electron'}, ${headless ? 'Ozone headless' : 'display session'}, sandbox ${unsafeSandbox ? 'explicitly disabled for this test' : 'enabled'}`);
  await runTool(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x40513b:s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', '-y', sourcePath]);
  const source = await readFile(sourcePath);
  const first = await launch(env);
  const page = first.page;
  const api = await apiSession(first.info.coreUrl);
  assert.ok(await exists(join(dataDir, 'instance.lock')), 'Running core owns an instance lock');

  step('Renderer isolation, fixed bridge, and native Settings interactions');
  const preferences = await running.evaluate(({ BrowserWindow, app }) => {
    const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration, webSecurity: value.webSecurity, webviewTag: value.webviewTag, noSandbox: app.commandLine.hasSwitch('no-sandbox') };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, noSandbox: unsafeSandbox });
  assert.deepEqual(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, bridge: Object.keys(window.ownTakeDesktop).sort() })),
    { require: 'undefined', process: 'undefined', bridge: ['choosePath', 'info', 'openProject', 'revealArtifact'] });
  await installNativeMocks();
  await navigate(page, '设置');
  await page.getByRole('heading', { name: '桌面工作台', exact: true }).waitFor({ state: 'visible' });
  assert.match(await page.locator('.desktop-status').innerText(), /关闭窗口后.*后台/);
  await page.getByText('查看桌面诊断信息', { exact: true }).click();
  await page.getByText(first.info.coreUrl, { exact: true }).waitFor({ state: 'visible' });
  const ffmpegInput = page.getByRole('textbox', { name: 'FFmpeg 可执行文件', exact: true });
  const originalFfmpeg = await ffmpegInput.inputValue();
  await chooseFile(page, '选择FFmpeg 可执行文件', null);
  assert.equal(await ffmpegInput.inputValue(), originalFfmpeg, 'Cancel must preserve the form value');
  await chooseFile(page, '选择FFmpeg 可执行文件', ffmpeg);
  assert.equal(await ffmpegInput.inputValue(), ffmpeg);
  await chooseFile(page, '选择ffprobe 可执行文件', ffprobe);
  assert.equal(await page.getByRole('textbox', { name: 'ffprobe 可执行文件', exact: true }).inputValue(), ffprobe);
  await chooseFile(page, '选择字幕字体文件', null);
  assert.equal(await page.getByRole('textbox', { name: '字幕字体文件', exact: true }).inputValue(), '');
  assert.equal((await api.json('/api/settings')).ffmpegPath, originalFfmpeg, 'Choosing a path must not save settings');
  const settingsResponse = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/settings');
  await page.getByRole('button', { name: '保存并检测', exact: true }).click();
  assert.equal((await settingsResponse).status(), 200);
  const settings = await api.json('/api/settings');
  assert.equal(settings.ffmpegPath, ffmpeg); assert.equal(settings.ffprobePath, ffprobe);
  const health = await api.json('/api/health');
  assert.equal(health.ffmpeg.available, true); assert.equal(health.ffprobe.available, true);
  assert.equal(await realpath(health.dataDir), await realpath(dataDir));
  assert.equal(await realpath(health.projectsDir), await realpath(projectsDir));
  await page.getByRole('button', { name: '添加本机 CLI', exact: true }).click();
  await chooseFile(page, '选择本机 CLI 可执行文件', await realpath(process.execPath));
  const runtimeModal = page.locator('.provider-modal');
  assert.equal(await runtimeModal.getByRole('textbox', { name: '可执行文件绝对路径', exact: true }).inputValue(), await realpath(process.execPath));
  await runtimeModal.getByRole('button', { name: '取消', exact: true }).click();
  const dialogs = (await nativeState()).dialogs;
  assert.equal(dialogs.length, 5);
  assert.deepEqual(dialogs[3].filters[0].extensions, ['otf', 'ttf', 'ttc']);
  assert.ok(dialogs.every(item => item.properties.includes('openFile') && !item.properties.includes('openDirectory')));

  step('Create project, import real media, and open the saved timeline in the UI');
  const project = await api.json('/api/projects', { method: 'POST', expected: 201, body: { name: `Desktop smoke ${randomUUID().slice(0, 8)}`, brief: 'Local-only desktop smoke. No models or remote providers.', ratio: '16:9' } });
  const imported = await api.json(`/api/projects/${project.id}/assets?name=${encodeURIComponent('桌面 smoke clip.mp4')}`, { method: 'POST', expected: 201, body: source, raw: true });
  assert.equal(imported.kind, 'video'); assert.equal(imported.sha256, digest(source));
  const timeline = await api.json(`/api/projects/${project.id}/timeline`, { method: 'PUT', body: { expectedVersion: 0, width: 320, height: 180, fps: 24, clips: [{ artifactId: imported.id, sourceInMs: 0, durationMs: 1500, fit: 'contain', muteSource: false }], captions: [], audio: [] } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.initial-loading').waitFor({ state: 'detached' });
  await openProjectUi(page, project.name);
  await until(() => page.getByRole('button', { name: '导出 MP4', exact: true }).isEnabled(), Boolean, 'Export controls ready');
  await page.getByRole('button', { name: '打开当前项目目录', exact: true }).click();
  const projectDirectory = await realpath(join(projectsDir, project.id));
  await until(nativeState, state => state.opened.length === 1, 'Native project-directory request');
  assert.deepEqual((await nativeState()).opened, [projectDirectory]);

  step('Close the window, render while hidden, and verify the resulting MP4');
  const hidden = await running.evaluate(({ BrowserWindow }) => {
    const current = BrowserWindow.getAllWindows()[0]; current.close();
    return { destroyed: current.isDestroyed(), visible: current.isVisible() };
  });
  assert.deepEqual(hidden, { destroyed: false, visible: false }); assert.equal(page.isClosed(), false);
  assert.equal((await api.json('/api/health')).status, 'ok', 'Core stays reachable after window close');
  // Submit only after hide: a successful export proves the core runs independently
  // of an open window, even if a tiny encode would otherwise finish before close.
  const job = await api.json(`/api/projects/${project.id}/exports`, { method: 'POST', expected: 202, body: { timelineId: timeline.id, clientRequestId: randomUUID() } });
  const finished = await until(() => api.json(`/api/jobs/${job.id}`), value => ['succeeded', 'failed', 'cancelled'].includes(value.status), 'Background export', 60000);
  assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
  const snapshot = await api.json(`/api/projects/${project.id}`);
  const output = snapshot.artifacts.find(artifact => artifact.id === finished.result?.artifactId);
  assert.ok(output); assert.equal(output.source, 'render'); assert.equal(output.kind, 'video');
  const outputBytes = await api.bytes(`/api/artifacts/${output.id}/content`);
  assert.equal(digest(outputBytes), output.sha256);
  await writeFile(outputPath, outputBytes);
  const probe = JSON.parse((await runTool(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath])).stdout);
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(video && audio); assert.equal(video.codec_name, 'h264'); assert.equal(audio.codec_name, 'aac');
  assert.deepEqual([video.width, video.height], [320, 180]);
  assert.ok(Math.abs(Number(probe.format.duration) - 1.5) < 0.2, `Unexpected duration ${probe.format.duration}`);
  await running.evaluate(({ app }) => { app.emit('activate'); });
  await until(() => running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), Boolean, 'Reopen on app activation');
  await navigate(page, '导出');
  await until(() => page.getByRole('link', { name: '下载成片', exact: true }).getAttribute('href'), value => value === `/api/artifacts/${output.id}/content`, 'Export result shown in UI');
  await page.locator('.output-preview video').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '在文件夹中显示', exact: true }).click();
  await until(nativeState, state => state.revealed.length === 1, 'Native reveal-artifact request');
  assert.deepEqual((await nativeState()).revealed, [await realpath(join(projectDirectory, output.relativePath))]);
  if (screenshotPath) { await mkdir(dirname(screenshotPath), { recursive: true }); await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 15000 }); }
  await assertNoPaidOperations(api, project.id);
  assert.deepEqual(pageErrors, [], 'No renderer errors before exit');
  assert.deepEqual(remoteRequests, [], 'No external renderer requests');

  step('Quit normally, release the lock, and reopen the same project and artifacts');
  await normalQuit(dataDir, first.info.coreUrl);
  const second = await launch(env);
  const restartedApi = await apiSession(second.info.coreUrl);
  const recovered = await restartedApi.json(`/api/projects/${project.id}`);
  assert.equal(recovered.project.name, project.name);
  assert.equal(recovered.timeline.id, timeline.id);
  assert.deepEqual(recovered.artifacts.map(artifact => [artifact.id, artifact.sha256]).sort(), [[imported.id, imported.sha256], [output.id, output.sha256]].sort());
  assert.equal(recovered.jobs.length, 1); assert.equal(recovered.jobs[0].id, job.id); assert.equal(recovered.jobs[0].status, 'succeeded');
  assert.equal(digest(await restartedApi.bytes(`/api/artifacts/${output.id}/content`)), output.sha256, 'Export bytes survive restart');
  await openProjectUi(second.page, project.name);
  await second.page.getByRole('link', { name: '下载成片', exact: true }).waitFor({ state: 'visible' });
  await assertNoPaidOperations(restartedApi, project.id);
  await normalQuit(dataDir, second.info.coreUrl);
  assert.deepEqual(pageErrors, [], 'No renderer errors across both launches');
  assert.deepEqual(remoteRequests, [], 'No external renderer requests across both launches');
  success = true;
  step(`PASS: ${first.info.platform}, Electron ${first.info.electron}, Node ${first.info.node}; real import/export, native bridge, background processing, normal quit, and restart persistence.`);
  if (unsafeSandbox) step('OS sandbox was explicitly disabled for this test; renderer isolation and sandbox preferences were checked, not OS sandbox enforcement.');
  if (screenshotPath) step(`Screenshot: ${screenshotPath}`);
} catch (error) {
  console.error('[desktop-smoke] FAIL:', error.stack || error);
  process.exitCode = 1;
} finally {
  if (running) {
    try {
      // Failure cleanup only: acknowledge the normal quit prompt for fixture jobs.
      await bounded(running.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }), 2000, 'Cleanup quit dialog');
      await bounded(running.close(), 25000, 'Failure cleanup');
    } catch {
      const child = running.process();
      if (child?.exitCode === null) child.kill('SIGKILL');
    }
  }
  if (temporary) {
    if (success) await rm(temporary, { recursive: true, force: true });
    else console.error(`[desktop-smoke] Kept fixture for diagnosis: ${temporary}\nLifecycle log: ${join(temporary, 'data', 'desktop', 'desktop.log')}`);
  }
}
