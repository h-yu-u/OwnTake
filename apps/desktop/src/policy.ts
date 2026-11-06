import { posix, win32 } from 'node:path';
import { AppError } from '../../../packages/contracts/src/errors.ts';
import type { DesktopPathKind } from '../../../packages/contracts/src/desktop.ts';

function forbidden(): never {
  throw new AppError('DESKTOP_IPC_FORBIDDEN', '桌面能力仅允许当前 OwnTake 主窗口的主框架调用。', 403);
}

/** Only the exact origin announced by our owned loopback core is accepted. */
export function validateOwnedCoreUrl(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('DESKTOP_CORE_URL_INVALID', '本地服务地址无效。');
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[1]) > 65535) throw new AppError('DESKTOP_CORE_URL_INVALID', '本地服务必须提供精确的 IPv4 回环地址与有效端口。');
  return value;
}

/** Pass the Electron event itself, never a renderer-provided sender descriptor. */
export function validateDesktopSender(event: unknown, expectedWebContentsId: number, coreUrl: string): void {
  const expected = new URL(validateOwnedCoreUrl(coreUrl));
  if (!Number.isSafeInteger(expectedWebContentsId) || expectedWebContentsId < 1 || !event || typeof event !== 'object') forbidden();
  const value = event as { sender?: { id?: unknown; mainFrame?: unknown }; senderFrame?: unknown };
  if (value.sender?.id !== expectedWebContentsId || !value.senderFrame || value.senderFrame !== value.sender.mainFrame || typeof value.senderFrame !== 'object') forbidden();
  const url = (value.senderFrame as { url?: unknown }).url;
  if (typeof url !== 'string' || url.length > 16_384 || /[\u0000-\u0020\u007f\\]/.test(url)) forbidden();
  // URL() normalises numeric/encoded host aliases and blob: origins. Require
  // the literal transport and host before comparing their parsed origin.
  const authority = /^http:\/\/127\.0\.0\.1(?::([1-9][0-9]{0,4}))?(?:\/|$)/.exec(url);
  if (!authority || Number(authority[1] ?? 80) !== Number(expected.port || 80)) forbidden();
  try {
    const parsed = new URL(url);
    if (parsed.origin !== expected.origin || parsed.username || parsed.password) forbidden();
  } catch { forbidden(); }
}

export function validateChoosePathKind(value: unknown): DesktopPathKind {
  if (value !== 'ffmpeg' && value !== 'ffprobe' && value !== 'font' && value !== 'runtime') throw new AppError('DESKTOP_PATH_KIND_INVALID', '只允许选择已声明的媒体工具、字体或本机运行时。');
  return value;
}

function environmentError(): never {
  throw new AppError('DESKTOP_ENV_INVALID', '本地服务环境包含无效的路径或环境值。');
}

/** Pure construction; never mutates the parent environment or reads credentials. */
export function buildCoreEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  paths: { dataDir: string; projectsDir: string },
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (!source || typeof source !== 'object' || Array.isArray(source) || !paths || typeof paths !== 'object') environmentError();
  const pathApi = platform === 'win32' ? win32 : posix;
  const absolute = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 32_768 || /[\u0000-\u001f\u007f]/.test(value) || !pathApi.isAbsolute(value)) environmentError();
    return value;
  };
  const get = (key: string): string | undefined => {
    if (!Object.hasOwn(source, key) || source[key] === undefined) return undefined;
    const value = source[key];
    if (typeof value !== 'string' || value.length > 32_768 || /[\u0000-\u001f\u007f]/.test(value)) environmentError();
    return value;
  };
  const env: Record<string, string> = {
    OWNTAKE_DATA_DIR: absolute(paths.dataDir),
    OWNTAKE_PROJECTS_DIR: absolute(paths.projectsDir),
  };
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR', 'TMP', 'TEMP']) {
    const value = get(key);
    if (value !== undefined) env[key] = value === '' ? '' : absolute(value);
  }
  for (const key of ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    const value = get(key);
    if (value !== undefined) env[key] = value;
  }
  if (platform === 'win32') {
    for (const key of ['SYSTEMROOT', 'WINDIR']) {
      const value = get(key) ?? get(key === 'SYSTEMROOT' ? 'SystemRoot' : 'windir');
      if (value !== undefined) env[key] = absolute(value);
    }
  }
  const separator = platform === 'win32' ? ';' : ':';
  const inheritedPath = get('PATH') ?? (platform === 'win32' ? get('Path') : undefined) ?? '';
  // Empty/relative PATH entries search the current directory and are excluded.
  const inherited = inheritedPath.split(separator).filter(value => value && pathApi.isAbsolute(value));
  const defaults = platform === 'win32'
    ? (env.SYSTEMROOT ? [win32.join(env.SYSTEMROOT, 'System32'), env.SYSTEMROOT] : [])
    : [...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : []), '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  env.PATH = [...new Set([...inherited, ...defaults])].join(separator);
  return env;
}
