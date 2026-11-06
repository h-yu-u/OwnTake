import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AppError } from '../../contracts/src/errors.ts';
import type { LocalRuntimeKind, RuntimeFailureClassification } from '../../contracts/src/runtimes.ts';

/** Never contains a CLI's stdout, stderr, prompt, environment or credential values. */
export class RuntimeCallError extends AppError {
  readonly classification: RuntimeFailureClassification;
  readonly started: boolean;
  readonly cancelled: boolean;
  constructor(classification: RuntimeFailureClassification, code: string, message: string, options: { started?: boolean; cancelled?: boolean } = {}) {
    super(code, message, classification === 'preflight_failed' ? 400 : 502);
    this.name = 'RuntimeCallError';
    this.classification = classification;
    this.started = options.started ?? classification !== 'preflight_failed';
    this.cancelled = options.cancelled ?? false;
  }
}

export function localPreflight(code: string, message: string, cancelled = false): RuntimeCallError {
  return new RuntimeCallError('preflight_failed', code, message, { started: false, cancelled });
}

export async function localExecutable(path: string): Promise<string> {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw localPreflight('RUNTIME_BINARY_INVALID', '本机运行时需要有效的绝对可执行路径。');
  try {
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isFile()) throw new Error();
    if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(resolved)) throw new Error();
    await access(resolved, constants.X_OK);
    return resolved;
  } catch { throw localPreflight('RUNTIME_UNAVAILABLE', '找不到可执行的本机运行时，请检查已配置的文件路径。'); }
}

/** A whitelist: it never discovers or reads authentication files. */
export function localEnvironment(kind: LocalRuntimeKind): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const authDirectory = kind === 'codex-cli' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  if (process.env[authDirectory] !== undefined) env[authDirectory] = process.env[authDirectory];
  env.NO_COLOR = '1';
  if (kind === 'claude-code') {
    env.CLAUDE_CODE_MAX_RETRIES = '0';
    env.MAX_STRUCTURED_OUTPUT_RETRIES = '1';
    env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1';
    env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0';
  }
  return env;
}

export interface LocalProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  input?: string;
  /** False only for --version / --help checks, which do not submit a model task. */
  modelInvocation: boolean;
}

/** One spawn; never retries. Limits and drains both pipes and owns its process group. */
export async function runLocalProcess(executable: string, args: readonly string[], options: LocalProcessOptions): Promise<string> {
  if (options.signal?.aborted) throw localPreflight('RUNTIME_CANCELLED', '本机调用在提交前已取消。', true);
  return new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn(executable, [...args], {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: options.cwd, env: options.env,
        detached: process.platform !== 'win32', windowsHide: true,
      });
    } catch { reject(localPreflight('RUNTIME_SPAWN_FAILED', '本机运行时无法启动。')); return; }
    const modelStarted = options.modelInvocation && child.pid !== undefined;
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let failure: RuntimeCallError | undefined;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    const processFailure = (code: string, message: string, cancelled = false): RuntimeCallError =>
      new RuntimeCallError(modelStarted ? 'submission_unknown' : 'preflight_failed', code, message, { started: modelStarted, cancelled });
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* The group may already have exited. */ }
    };
    const cleanup = (): void => {
      finished = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      options.signal?.removeEventListener('abort', abort);
      // Diagnostics stay in memory and are never included in public errors.
      stderrTail.fill(0);
      stderrTail = Buffer.alloc(0);
    };
    const stop = (error: RuntimeCallError): void => {
      if (finished || failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        // An external executable can escape a process group. Bound our wait even
        // if it leaves a pipe open; this is not an operating-system containment claim.
        closeTimer = setTimeout(() => {
          if (finished) return;
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          child.unref(); cleanup(); reject(failure);
        }, 1000);
        closeTimer.unref();
      }, 1000);
      killTimer.unref();
    };
    const abort = (): void => stop(processFailure('RUNTIME_CANCELLED', modelStarted ? '本机进程已请求停止，远端提交或费用结果仍可能未知。' : '本机调用在提交前已取消。', true));
    const timeout = setTimeout(() => stop(processFailure('RUNTIME_TIMEOUT', modelStarted ? '本机调用超时，提交或费用结果未知；不会自动再次启动。' : '本机运行时兼容检查超时。')), options.timeoutMs);
    timeout.unref();
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (finished) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        stop(processFailure('RUNTIME_OUTPUT_LIMIT', '本机运行时输出超过允许大小，已停止跟踪本次调用。'));
        return;
      }
      if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (finished) return;
      const tail = chunk.length > 16_384 ? chunk.subarray(-16_384) : chunk;
      stderrTail = Buffer.concat([stderrTail, tail]).subarray(-16_384);
    });
    child.stdin.on('error', () => stop(processFailure('RUNTIME_INPUT_FAILED', '本机运行时未完整接收输入，提交结果无法确认。')));
    child.on('error', () => stop(processFailure('RUNTIME_SPAWN_FAILED', '本机运行时无法启动或执行。')));
    child.on('close', (code, signal) => {
      if (finished) return;
      const error = failure ?? (code !== 0 || signal !== null ? processFailure('RUNTIME_EXIT_FAILED', '本机运行时异常退出；不会自动再次启动。') : undefined);
      cleanup();
      if (error) { reject(error); return; }
      try { resolveResult(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new RuntimeCallError(modelStarted ? 'invalid_output' : 'preflight_failed', 'RUNTIME_INVALID_ENCODING', '本机运行时输出不是有效的 UTF-8 文本。', { started: modelStarted })); }
    });
    if (options.signal?.aborted) abort();
    try { child.stdin.end(failure ? undefined : options.input); }
    catch { stop(processFailure('RUNTIME_INPUT_FAILED', '本机运行时未完整接收输入，提交结果无法确认。')); }
  });
}
