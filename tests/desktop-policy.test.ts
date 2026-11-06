import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoreEnvironment, validateChoosePathKind, validateDesktopSender, validateOwnedCoreUrl } from '../apps/desktop/src/policy.ts';

const core = 'http://127.0.0.1:4317';
function sender(url = core + '/project/demo?view=timeline#preview', id = 7) {
  const mainFrame = { url };
  return { sender: { id, mainFrame }, senderFrame: mainFrame };
}

test('owned core URL permits only an exact numeric-port IPv4 loopback origin', () => {
  for (const port of [1, 80, 4317, 65535]) assert.equal(validateOwnedCoreUrl(`http://127.0.0.1:${port}`), `http://127.0.0.1:${port}`);
  const attacks: unknown[] = [
    undefined, null, {}, 4317, '', core + '/', core + '/api', core + '?key=value', core + '#fragment',
    ' ' + core, core + '\n', 'HTTP://127.0.0.1:4317', 'https://127.0.0.1:4317', 'http://localhost:4317',
    'http://127.1:4317', 'http://2130706433:4317', 'http://0x7f000001:4317', 'http://0177.0.0.1:4317',
    'http://[::1]:4317', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:04317',
    'http://127.0.0.1:65536', 'http://127.0.0.1:1e3', 'http://127.0.0.1:-1', 'http://127.0.0.1:4317@evil.test',
    'http://user:secret@127.0.0.1:4317', 'http://127.0.0.1.evil.test:4317', 'http://127.0.0.1.:4317',
    'http://%31%32%37.0.0.1:4317', 'blob:' + core + '/id', 'file:///tmp/owntake', 'data:text/html,hi',
  ];
  for (const value of attacks) assert.throws(() => validateOwnedCoreUrl(value), { code: 'DESKTOP_CORE_URL_INVALID' });
});

test('desktop IPC requires the owned webContents, its main frame identity and exact core origin', () => {
  assert.doesNotThrow(() => validateDesktopSender(sender(), 7, core));
  assert.doesNotThrow(() => validateDesktopSender(sender(core), 7, core));
  assert.doesNotThrow(() => validateDesktopSender(sender('http://127.0.0.1/page'), 7, 'http://127.0.0.1:80'));
  const valid = sender();
  const invalid = [
    null, {}, { sender: valid.sender }, { sender: valid.sender, senderFrame: null },
    sender(core + '/', 8), { ...valid, senderFrame: { url: valid.senderFrame.url } },
    { ...valid, senderFrame: { url: core + '/', parent: valid.senderFrame } },
  ];
  for (const value of invalid) assert.throws(() => validateDesktopSender(value, 7, core), { code: 'DESKTOP_IPC_FORBIDDEN' });
  for (const id of [0, -1, NaN, 7.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateDesktopSender(sender(), id, core), { code: 'DESKTOP_IPC_FORBIDDEN' });
  for (const url of [
    'https://127.0.0.1:4317/', 'http://127.0.0.1:4318/', 'http://localhost:4317/', 'http://127.1:4317/',
    'http://2130706433:4317/', 'http://%31%32%37.0.0.1:4317/', 'http://127.0.0.1:04317/',
    'http://user:password@127.0.0.1:4317/', 'http://127.0.0.1:4317@evil.test/',
    'http://127.0.0.1.evil.test:4317/', 'http://127.0.0.1:4317\\@evil.test/',
    core + '/\nprivate', ' ' + core + '/', 'blob:' + core + '/identifier', 'about:blank', 'file:///tmp/index.html',
  ]) assert.throws(() => validateDesktopSender(sender(url), 7, core), { code: 'DESKTOP_IPC_FORBIDDEN' });
});

test('choose-path accepts only fixed kinds, never renderer paths, dialog options or shell instructions', () => {
  for (const kind of ['ffmpeg', 'ffprobe', 'font', 'runtime']) assert.equal(validateChoosePathKind(kind), kind);
  for (const raw of ['directory', 'open', '/etc/passwd', '../../private', 'runtime --yolo', ' ffmpeg', { kind: 'font' }, { kind: 'font', defaultPath: '/private' }, ['font'], null]) {
    assert.throws(() => validateChoosePathKind(raw), { code: 'DESKTOP_PATH_KIND_INVALID' });
  }
});

test('child environment preserves explicit directory pointers and locale while excluding credentials and process injection', () => {
  const source = Object.freeze({
    HOME: '/Users/创作 人', CODEX_HOME: '/Users/创作 人/.codex', CLAUDE_CONFIG_DIR: '/Users/创作 人/.claude',
    PATH: '/custom/bin::.:relative/bin:/usr/bin:/custom/bin', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', TZ: 'Asia/Shanghai', TMPDIR: '/tmp/owntake',
    OWNTAKE_DATA_DIR: '/not-authoritative', OWNTAKE_PROJECTS_DIR: '/not-authoritative/projects', OWNTAKE_PORT: '9999', OWNTAKE_DEV_ORIGIN: 'https://attacker.test',
    NODE_OPTIONS: '--require /tmp/inject.cjs', NODE_PATH: '/tmp/inject', LD_PRELOAD: '/tmp/inject.so', DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    HTTP_PROXY: 'http://user:secret@proxy.test', HTTPS_PROXY: 'http://user:secret@proxy.test', ALL_PROXY: 'http://proxy.test',
    OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', CODEX_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret',
    NPM_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1',
  });
  const before = { ...source };
  const env = buildCoreEnvironment(source, { dataDir: '/Users/创作 人/OwnTake', projectsDir: '/Volumes/影片 & 项目/OwnTake' }, 'darwin');
  assert.deepEqual(source, before);
  for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const) assert.equal(env[key], source[key]);
  assert.equal(env.OWNTAKE_DATA_DIR, '/Users/创作 人/OwnTake');
  assert.equal(env.OWNTAKE_PROJECTS_DIR, '/Volumes/影片 & 项目/OwnTake');
  assert.deepEqual(env.PATH.split(':').slice(0, 2), ['/custom/bin', '/usr/bin']);
  for (const path of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin']) assert(env.PATH.split(':').includes(path));
  assert.equal(new Set(env.PATH.split(':')).size, env.PATH.split(':').length);
  assert(!env.PATH.split(':').some(value => !value || value === '.' || value === 'relative/bin'));
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'PATH', 'OWNTAKE_DATA_DIR', 'OWNTAKE_PROJECTS_DIR'].sort());
  assert.doesNotMatch(JSON.stringify(env), /secret|inject|attacker|proxy\.test/);
});

test('environment construction handles absent PATH and Windows casing without inheriting extra variables', () => {
  const env = buildCoreEnvironment({}, { dataDir: '/tmp/data', projectsDir: '/tmp/projects' }, 'linux');
  assert(env.PATH.includes('/usr/local/bin')); assert(!env.PATH.includes('/opt/homebrew'));
  const windows = buildCoreEnvironment({ Path: 'C:\\Tools;;.;relative;C:\\Tools', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Artist', node_options: 'inject' }, { dataDir: 'C:\\OwnTake', projectsDir: 'D:\\Movies' }, 'win32');
  assert.equal(windows.PATH, 'C:\\Tools;C:\\Windows\\System32;C:\\Windows');
  assert.equal(windows.SYSTEMROOT, 'C:\\Windows'); assert.equal(windows.node_options, undefined);
  assert.equal(windows.Path, undefined);
});

test('invalid configured environment values fail before child launch and cannot silently select another auth home', () => {
  const paths = { dataDir: '/tmp/data', projectsDir: '/tmp/projects' };
  for (const source of [{ HOME: 'relative' }, { CODEX_HOME: '../other-account' }, { CLAUDE_CONFIG_DIR: '/tmp/account\0suffix' }, { PATH: '/bin\n/tmp' }]) {
    assert.throws(() => buildCoreEnvironment(source, paths, 'linux'), { code: 'DESKTOP_ENV_INVALID' });
  }
  for (const changed of [{ dataDir: '../data' }, { projectsDir: '/tmp/projects\0bad' }]) {
    assert.throws(() => buildCoreEnvironment({}, { ...paths, ...changed }, 'linux'), { code: 'DESKTOP_ENV_INVALID' });
  }
  const inherited = Object.create({ HOME: '/inherited/account', CODEX_HOME: '/inherited/auth', NODE_OPTIONS: 'inject' }) as Record<string, string>;
  const env = buildCoreEnvironment(inherited, paths, 'linux');
  assert.equal(env.HOME, undefined); assert.equal(env.CODEX_HOME, undefined); assert.equal(env.NODE_OPTIONS, undefined);
});
