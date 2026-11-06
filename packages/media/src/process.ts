import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { AppError } from '../../contracts/src/errors.ts';

export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  captureStdout?: boolean;
  cwd?: string;
  onStdout?: (chunk: string) => void;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('JOB_CANCELLED', '媒体任务已取消。', 409);
}

export async function resolveExecutable(command: string): Promise<string> {
  if (!command || command.includes('\0')) throw new AppError('TOOL_UNAVAILABLE', '媒体工具路径无效。', 503);
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [resolve(command)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(directory => {
      const path = resolve(directory, command);
      return process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(command) ? [path + '.exe', path] : [path];
    });
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const path = await realpath(candidate);
      if ((await stat(path)).isFile()) return path;
    } catch { /* Try the next explicit PATH entry. */ }
  }
  throw new AppError('TOOL_UNAVAILABLE', `找不到可执行的媒体工具：${command}`, 503);
}

function toolEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'HOME', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/** Structured arguments only. OwnTake never sends model-produced shell text here. */
export async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(options.signal);
  const executable = await resolveExecutable(command);
  throwIfAborted(options.signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32', cwd: options.cwd, env: toolEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* Process already exited; close will settle the promise. */ }
    };
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = (): void => stop(new AppError('JOB_CANCELLED', '媒体任务已取消。', 409));
    const timeout = setTimeout(() => stop(new AppError('TOOL_TIMEOUT', '媒体处理超时，任务没有发布为成品。', 504)), options.timeoutMs ?? 30_000);
    timeout.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (options.captureStdout !== false) {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > (options.maxStdoutBytes ?? 1024 * 1024)) {
          stop(new AppError('TOOL_OUTPUT_LIMIT', '媒体工具输出超过允许大小。', 502));
          return;
        }
        stdout += chunk;
      }
      try { options.onStdout?.(chunk); }
      catch (error) { stop(error instanceof Error ? error : new Error('Progress callback failed')); }
    });
    // Always drain both pipes. Retain only the diagnostic tail.
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
    child.on('error', () => { failure ??= new AppError('TOOL_UNAVAILABLE', `无法启动媒体工具：${command}`, 503); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new AppError('MEDIA_TOOL_FAILED', '媒体工具执行失败。', 422, { code, signal, stderr }));
      resolveResult({ stdout, stderr });
    });
  });
}
