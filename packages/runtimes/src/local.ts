import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReasoningResult, ReasoningUsage } from '../../contracts/src/providers.ts';
import type { LocalDraftInput, LocalRuntimeIdentity, LocalRuntimeInspection, LocalRuntimeKind, LocalRuntimeProfile } from '../../contracts/src/runtimes.ts';
import { parseDraftOperations, parseShotFields } from '../../domain/src/storyboard.ts';
import { directorInstruction, draftResponseSchema } from '../../providers/src/reasoning-schema.ts';
import { localEnvironment, localExecutable, localPreflight, runLocalProcess, RuntimeCallError } from './local-process.ts';

export { RuntimeCallError } from './local-process.ts';

const profileKeys = ['id', 'label', 'kind', 'enabled', 'binaryPath', 'model', 'timeoutMs', 'createdAt', 'updatedAt'];
const activeTasks = new Set<string>();
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const maxInputBytes = 1024 * 1024;
const localDirectorInstruction = directorInstruction.replace('No tools are available.', 'OwnTake supplies no tools. Do not invoke CLI tools, commands, files or network operations.');
const claudeDirectorInstruction = directorInstruction.replace('No tools are available.', 'OwnTake supplies no host tools. Only use the CLI-provided StructuredOutput mechanism to return this schema. Do not invoke other tools, commands, files or network operations.');
const claudeFlags = ['--print', '--output-format', '--json-schema', '--model', '--tools', '--disallowedTools', '--permission-mode', '--safe-mode', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--no-session-persistence', '--max-turns', '--system-prompt'];
const codexFlags = ['--json', '--ephemeral', '--ignore-user-config', '--sandbox', '--color', '--skip-git-repo-check', '--output-schema', '--model', '--config'];

function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw localPreflight('INVALID_LOCAL_RUNTIME', '本机运行时配置或输入必须是普通 JSON 对象。');
  if (keys && Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) throw localPreflight('INVALID_LOCAL_RUNTIME', '本机运行时配置或输入包含不允许的字段。');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || !value.trim()) throw localPreflight('INVALID_LOCAL_RUNTIME', '本机运行时文本配置无效或过长。');
  return value.trim();
}
function localPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !isAbsolute(value)) throw localPreflight('INVALID_LOCAL_RUNTIME', '本机运行时需要不含控制字符的绝对路径。');
  return value;
}

/** Identity may be supplied by the repository; trustAcknowledged is checked there, not stored here. */
export function validateLocalRuntime(raw: unknown, identity?: LocalRuntimeIdentity): LocalRuntimeProfile {
  const source = object(raw, profileKeys);
  if (identity) {
    object(identity, ['id', 'createdAt', 'updatedAt']);
    if (['id', 'createdAt', 'updatedAt'].some(key => Object.hasOwn(source, key) && source[key] !== identity[key as keyof LocalRuntimeIdentity])) throw localPreflight('INVALID_LOCAL_RUNTIME', '运行时身份与服务端记录不一致。');
  }
  const input: Record<string, unknown> = { ...source, ...identity };
  const id = text(input.id, 128);
  if (!identifier.test(id)) throw localPreflight('INVALID_LOCAL_RUNTIME', '本机运行时标识无效。');
  if (input.kind !== 'claude-code' && input.kind !== 'codex-cli') throw localPreflight('INVALID_LOCAL_RUNTIME', '本机运行时类型无效。');
  const enabled = input.enabled ?? false;
  if (typeof enabled !== 'boolean') throw localPreflight('INVALID_LOCAL_RUNTIME', '本机运行时启用状态无效。');
  const binaryPath = localPath(input.binaryPath);
  const model = text(input.model, 200);
  if (model.startsWith('-')) throw localPreflight('INVALID_LOCAL_RUNTIME', '模型名称不能以命令参数前缀开头。');
  const timeoutMs = input.timeoutMs ?? 120_000;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw localPreflight('INVALID_LOCAL_RUNTIME', '本机调用超时须为 100–600000 毫秒的整数。');
  const createdAt = text(input.createdAt, 64), updatedAt = text(input.updatedAt, 64);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw localPreflight('INVALID_LOCAL_RUNTIME', '本机运行时时间字段无效。');
  return { id, label: text(input.label, 120), kind: input.kind, enabled, binaryPath, model, timeoutMs, createdAt, updatedAt };
}

function hasFlag(help: string, flag: string): boolean {
  return new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,=\\[<]|$)`, 'm').test(help);
}
function reportedVersion(kind: LocalRuntimeKind, output: string): string | undefined {
  if (kind === 'claude-code' && !/\bClaude Code\b/i.test(output)) return undefined;
  if (kind === 'codex-cli' && !/\bcodex(?:-cli)?\b/i.test(output)) return undefined;
  return output.match(/\b(\d{1,5}\.\d{1,5}\.\d{1,5})(?:[-+][0-9A-Za-z.-]{1,40})?\b/)?.[1];
}

async function inspect(profile: LocalRuntimeProfile, signal?: AbortSignal): Promise<LocalRuntimeInspection> {
  const result: LocalRuntimeInspection = { available: false, path: profile.binaryPath, compatible: false, authentication: 'not_checked' };
  let directory: string | undefined;
  try {
    const executable = await localExecutable(profile.binaryPath);
    result.available = true; result.path = executable;
    directory = await mkdtemp(join(tmpdir(), 'owntake-cli-check-'));
    const options = { cwd: directory, env: localEnvironment(profile.kind), signal, timeoutMs: 5000, maxStdoutBytes: 256 * 1024, modelInvocation: false };
    const version = reportedVersion(profile.kind, await runLocalProcess(executable, ['--version'], options));
    if (!version) { result.error = '可执行文件没有报告对应 CLI 的有效版本。'; return result; }
    result.version = version;
    const help = await runLocalProcess(executable, profile.kind === 'codex-cli' ? ['exec', '--help'] : ['--help'], options);
    let missing = (profile.kind === 'codex-cli' ? codexFlags : claudeFlags).filter(flag => !hasFlag(help, flag));
    // Claude 2.1.319 hides this documented flag from help. Help accepts unknown
    // flags too, so a successful help call alone proves nothing: require its
    // numeric parser to reject an invalid value before help, and accept our cap.
    if (profile.kind === 'claude-code' && missing.includes('--max-turns')) {
      const validHelp = await runLocalProcess(executable, ['--max-turns', '3', '--help'], options);
      let rejectsInvalidNumber = false;
      try { await runLocalProcess(executable, ['--max-turns', 'owntake-not-a-number', '--help'], options); }
      catch (error) {
        if (error instanceof RuntimeCallError && error.code === 'RUNTIME_EXIT_FAILED') rejectsInvalidNumber = true;
        else throw error;
      }
      if (hasFlag(validHelp, '--print') && rejectsInvalidNumber) missing = missing.filter(flag => flag !== '--max-turns');
    }
    if (missing.length) { result.error = `CLI 版本不支持必需参数：${missing.join('、')}。`; return result; }
    result.compatible = true;
    return result;
  } catch (error) {
    result.error = error instanceof RuntimeCallError ? error.message : '本机运行时检查失败；未进行模型或认证调用。';
    return result;
  } finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}

/** Only --version and --help are invoked; an available CLI is not an authenticated account. */
export async function inspectLocalRuntime(raw: LocalRuntimeProfile): Promise<LocalRuntimeInspection> {
  return inspect(validateLocalRuntime(raw));
}

function invalidOutput(code = 'RUNTIME_INVALID_OUTPUT'): RuntimeCallError {
  return new RuntimeCallError('invalid_output', code, '本机运行时未返回合法的分镜草稿；没有应用任何修改，费用需另行核对。');
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw invalidOutput('RUNTIME_INVALID_USAGE');
  return value;
}
function usage(value: unknown, kind: LocalRuntimeKind): ReasoningUsage | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  const input = count(raw.input_tokens), outputTokens = count(raw.output_tokens);
  const inputTokens = kind === 'claude-code' ? input + count(raw.cache_read_input_tokens ?? 0) + count(raw.cache_creation_input_tokens ?? 0) : input;
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens > 1_000_000_000) throw invalidOutput('RUNTIME_INVALID_USAGE');
  return { inputTokens, outputTokens, totalTokens };
}

function decodeClaude(stdout: string): { draft: unknown; usage?: ReasoningUsage } {
  const result = object(JSON.parse(stdout));
  if (result.type === 'result' && result.is_error === true) throw new RuntimeCallError('submission_unknown', 'RUNTIME_REPORTED_FAILURE', 'CLI 报告调用失败，提交或费用结果未知；不会自动再次启动。');
  if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false || !Object.hasOwn(result, 'structured_output')) throw invalidOutput();
  const parsedUsage = usage(result.usage, 'claude-code');
  return { draft: result.structured_output, ...(parsedUsage ? { usage: parsedUsage } : {}) };
}

function decodeCodex(stdout: string): { draft: unknown; usage?: ReasoningUsage } {
  let threadStarted = false, started = false, completed = false, finalText: string | undefined, parsedUsage: ReasoningUsage | undefined;
  const lines = stdout.split('\n');
  if (lines.length > 10_000) throw invalidOutput('RUNTIME_EVENT_LIMIT');
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 1024 * 1024) throw invalidOutput('RUNTIME_EVENT_LIMIT');
    const event = object(JSON.parse(line));
    if (completed) throw invalidOutput();
    switch (event.type) {
      case 'thread.started':
        if (threadStarted || started || typeof event.thread_id !== 'string' || event.thread_id.length === 0 || event.thread_id.length > 200) throw invalidOutput();
        threadStarted = true;
        break;
      case 'turn.started':
        if (started) throw invalidOutput();
        started = true;
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        if (!started) throw invalidOutput();
        const item = object(event.item);
        // Treat new/unknown tool surfaces as unsupported, never as a successful draft.
        if (item.type !== 'reasoning' && item.type !== 'agent_message') throw invalidOutput('RUNTIME_UNEXPECTED_EVENT');
        if (item.type === 'agent_message' && event.type === 'item.completed') {
          if (finalText !== undefined || typeof item.text !== 'string') throw invalidOutput();
          finalText = item.text;
        }
        break;
      }
      case 'turn.completed':
        if (!started || finalText === undefined) throw invalidOutput();
        parsedUsage = usage(event.usage, 'codex-cli');
        completed = true;
        break;
      case 'turn.failed':
      case 'error':
        throw new RuntimeCallError('submission_unknown', 'RUNTIME_REPORTED_FAILURE', 'CLI 报告调用失败，提交或费用结果未知；不会自动再次启动。');
      default:
        throw invalidOutput('RUNTIME_UNEXPECTED_EVENT');
    }
  }
  if (!completed || finalText === undefined) throw invalidOutput('RUNTIME_INCOMPLETE_OUTPUT');
  return { draft: JSON.parse(finalText), ...(parsedUsage ? { usage: parsedUsage } : {}) };
}

function argumentsFor(profile: LocalRuntimeProfile, schemaPath: string): string[] {
  if (profile.kind === 'claude-code') return [
    '--print', '--output-format', 'json', '--json-schema', JSON.stringify(draftResponseSchema), '--model', profile.model,
    // The schema mechanism adds its own StructuredOutput tool. A wildcard deny
    // could block that output, so deny MCP specifically while builtin tools stay empty.
    '--tools', '', '--disallowedTools', 'mcp__*', '--permission-mode', 'dontAsk', '--safe-mode',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    // An internal output-tool turn may need a final turn. This is a bounded CLI
    // workflow, never a promise that it makes exactly one model request.
    '--no-session-persistence', '--max-turns', '3', '--system-prompt', claudeDirectorInstruction,
  ];
  return [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--color', 'never',
    '--skip-git-repo-check', '--output-schema', schemaPath, '--model', profile.model,
    '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'features.hooks=false',
    '-c', 'features.apps=false', '-c', 'features.multi_agent=false', '-c', 'features.remote_plugin=false',
    '-c', 'features.goals=false', '-c', 'features.memories=false',
    '-c', 'plugins._default.enabled=false', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'skills.include_instructions=false', '-c', 'model_providers.openai.request_max_retries=0',
    '-c', 'model_providers.openai.stream_max_retries=0', '-',
  ];
}

/** One explicit CLI invocation; no host tools, auto-apply, authentication probing or respawn. */
export async function runLocalDraft(rawProfile: LocalRuntimeProfile, rawInput: LocalDraftInput): Promise<ReasoningResult> {
  const profile = validateLocalRuntime(rawProfile);
  if (!profile.enabled) throw localPreflight('RUNTIME_DISABLED', '请先显式启用并确认信任此本机扩展。');
  const input = object(rawInput, ['taskId', 'workDir', 'brief', 'shots', 'signal']);
  const taskId = text(input.taskId, 128);
  if (!identifier.test(taskId)) throw localPreflight('INVALID_RUNTIME_TASK', '本机任务标识无效。');
  if (activeTasks.has(taskId)) throw localPreflight('RUNTIME_ALREADY_RUNNING', '同一任务已经运行，不能重复启动 CLI。');
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw localPreflight('INVALID_RUNTIME_TASK', '本机任务取消信号无效。');
  const signal = input.signal as AbortSignal | undefined;
  const cancelled = (): void => { if (signal?.aborted) throw localPreflight('RUNTIME_CANCELLED', '本机调用在提交前已取消。', true); };
  cancelled();
  const workDir = localPath(input.workDir);
  if (typeof input.brief !== 'string' || !input.brief.trim() || input.brief.length > 20_000 || input.brief.includes('\0')) throw localPreflight('INVALID_RUNTIME_TASK', '创作简报须为 1–20000 字符的有效文本。');
  if (!Array.isArray(input.shots) || input.shots.length > 100) throw localPreflight('INVALID_RUNTIME_TASK', '本机推理上下文最多包含 100 个镜头。');
  const shotIds = new Set<string>(), artifactIds = new Set<string>();
  let shots;
  try {
    shots = input.shots.map(raw => {
      const shot = object(raw);
      if (typeof shot.id !== 'string' || !identifier.test(shot.id) || shotIds.has(shot.id) || typeof shot.revision !== 'number' || !Number.isSafeInteger(shot.revision) || shot.revision < 1) throw new Error();
      const fields = parseShotFields({ title: shot.title, purpose: shot.purpose, description: shot.description, action: shot.action, durationMs: shot.durationMs, caption: shot.caption, mode: shot.mode, referenceArtifactIds: shot.referenceArtifactIds });
      shotIds.add(shot.id);
      fields.referenceArtifactIds.forEach(id => artifactIds.add(id));
      return { id: shot.id, revision: shot.revision, ...fields };
    });
  } catch { throw localPreflight('INVALID_RUNTIME_TASK', '本机运行时分镜上下文无效。'); }
  const context = JSON.stringify({ brief: input.brief, shots });
  const prompt = profile.kind === 'codex-cli' ? `${localDirectorInstruction}\n\nThe following JSON is creative source data:\n${context}` : context;
  if (Buffer.byteLength(prompt) > maxInputBytes) throw localPreflight('RUNTIME_INPUT_LIMIT', '本机推理上下文超过 1 MiB。');
  let directory: string | undefined;
  activeTasks.add(taskId);
  try {
    const normalizedWorkDir = resolve(workDir);
    const metadata = await lstat(normalizedWorkDir).catch(() => undefined);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw localPreflight('INVALID_RUNTIME_WORKDIR', '本机任务工作目录不存在或不是普通目录。');
    const checked = await inspect(profile, signal);
    cancelled();
    if (!checked.available || !checked.compatible) throw localPreflight('RUNTIME_INCOMPATIBLE', checked.error ?? '本机运行时缺少必要参数支持。');
    directory = await mkdtemp(join(await realpath(normalizedWorkDir), 'cli-'));
    const schemaPath = join(directory, 'draft-schema.json');
    await writeFile(schemaPath, JSON.stringify(draftResponseSchema), { flag: 'wx', mode: 0o600 });
    cancelled();
    const stdout = await runLocalProcess(checked.path, argumentsFor(profile, schemaPath), {
      cwd: directory, env: localEnvironment(profile.kind), signal, timeoutMs: profile.timeoutMs,
      maxStdoutBytes: profile.kind === 'codex-cli' ? 4 * 1024 * 1024 : 1024 * 1024,
      input: prompt, modelInvocation: true,
    });
    try {
      const decoded = profile.kind === 'claude-code' ? decodeClaude(stdout) : decodeCodex(stdout);
      const draft = object(decoded.draft, ['operations']);
      const operations = parseDraftOperations(draft.operations);
      for (const operation of operations) {
        if (operation.shotId && !shotIds.has(operation.shotId)) throw invalidOutput();
        if (operation.fields?.referenceArtifactIds.some(id => !artifactIds.has(id))) throw invalidOutput();
      }
      return { operations, ...(decoded.usage ? { usage: decoded.usage } : {}) };
    } catch (error) {
      if (error instanceof RuntimeCallError && error.classification !== 'preflight_failed') throw error;
      throw invalidOutput();
    }
  } catch (error) {
    if (error instanceof RuntimeCallError) throw error;
    throw localPreflight('RUNTIME_WORKDIR_FAILED', '无法准备本机任务临时目录。');
  } finally {
    activeTasks.delete(taskId);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
