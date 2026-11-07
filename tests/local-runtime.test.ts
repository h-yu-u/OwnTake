import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { LocalRuntimeKind, LocalRuntimeProfile } from '../packages/contracts/src/runtimes.ts';
import { inspectLocalRuntime, runLocalDraft, RuntimeCallError, validateLocalRuntime } from '../packages/runtimes/src/local.ts';

const date = '2026-11-06T00:00:00.000Z';
const identity = { id: 'runtime_fixture', createdAt: date, updatedAt: date };
const fixtureSource = fileURLToPath(new URL('./fixtures/local-cli.mjs', import.meta.url));

function profile(binaryPath: string, kind: LocalRuntimeKind = 'claude-code', model = 'success'): LocalRuntimeProfile {
  return { ...identity, label: '离线协议夹具', kind, enabled: true, binaryPath, model, timeoutMs: 5000 };
}
async function withFixture(kind: LocalRuntimeKind, run: (value: { root: string; workDir: string; profile: LocalRuntimeProfile; logs: () => Promise<any[]>; settings: (extra: object) => Promise<void> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'owntake 本机 $; 夹具-'));
  const binaryPath = join(root, '本机 CLI.mjs');
  const workDir = join(root, '工作目录 [draft]');
  const settings = (extra: object): Promise<void> => writeFile(join(root, 'fixture-settings.json'), JSON.stringify({ kind, ...extra }));
  const logs = async (): Promise<any[]> => (await readFile(join(root, 'invocations.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await copyFile(fixtureSource, binaryPath); await chmod(binaryPath, 0o700); await mkdir(workDir); await settings({});
  try { await run({ root, workDir, profile: profile(binaryPath, kind), logs, settings }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function safeError(classification: string, code?: string): (error: unknown) => boolean {
  return error => {
    assert(error instanceof RuntimeCallError);
    assert.equal(error.classification, classification);
    if (code) assert.equal(error.code, code);
    assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-secret|private prompt|never execute|request credentials/);
    return true;
  };
}
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() >= deadline) assert.fail('Fixture did not start within the bounded wait');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('local runtime profiles default to disabled and reject extra command, env, auth and path fields', () => {
  const input = { label: '本机草稿', kind: 'codex-cli', binaryPath: '/usr/local/bin/codex', model: 'configured-model' };
  const value = validateLocalRuntime(input, identity);
  assert.equal(value.enabled, false); assert.equal(value.timeoutMs, 120_000);
  for (const extra of [{ env: {} }, { authHome: '/tmp/auth' }, { cwd: '/tmp' }, { extraArgs: ['--yolo'] }, { trustAcknowledged: true }, { enabled: 'true' }, { binaryPath: 'codex' }, { binaryPath: '/tmp/cli\n--yolo' }, { model: '--yolo' }, { timeoutMs: 600_001 }, { id: 'different_identity' }]) {
    assert.throws(() => validateLocalRuntime({ ...input, ...extra }, identity), { classification: 'preflight_failed' });
  }
});

test('reasoning effort remains optional for old profiles and rejects unknown or injected levels', () => {
  const input = { label: '本机草稿', kind: 'codex-cli', binaryPath: '/usr/local/bin/codex', model: 'configured-model' };
  assert.equal(validateLocalRuntime(input, identity).reasoningEffort, undefined);
  assert.equal(validateLocalRuntime({ ...input, reasoningEffort: 'max' }, identity).reasoningEffort, 'max');
  for (const reasoningEffort of ['ultra', 'ultracode', '--yolo', 'high\n--tools', 'unknown', 3, null]) assert.throws(() => validateLocalRuntime({ ...input, reasoningEffort }, identity), { classification: 'preflight_failed' });
  assert.throws(() => validateLocalRuntime({ ...input, kind: 'claude-code', reasoningEffort: 'none' }, identity));
});

test('explicit reasoning is passed as a fixed Codex config or Claude flag; defaults omit the override', async () => {
  for (const kind of ['codex-cli', 'claude-code'] as const) await withFixture(kind, async ({ profile, workDir, logs, settings }) => {
    await runLocalDraft({ ...profile, reasoningEffort: 'high' }, { taskId: 'effort_explicit', workDir, brief: '测试强度传递', shots: [] });
    await runLocalDraft(profile, { taskId: 'effort_default', workDir, brief: '保留模型默认', shots: [] });
    const runs = (await logs()).filter(entry => entry.run);
    assert.equal(runs.length, 2);
    if (kind === 'codex-cli') {
      const position = runs[0].args.indexOf('model_reasoning_effort="high"');
      assert(position > 0); assert.equal(runs[0].args[position - 1], '-c');
      assert(!runs[1].args.some((arg: string) => arg.startsWith('model_reasoning_effort=')));
    } else {
      assert.equal(runs[0].args[runs[0].args.indexOf('--effort') + 1], 'high');
      assert(!runs[1].args.includes('--effort'));
      await settings({ missingFlag: '--effort' });
      await assert.rejects(runLocalDraft({ ...profile, reasoningEffort: 'high' }, { taskId: 'effort_unsupported', workDir, brief: '不可静默降级', shots: [] }), safeError('preflight_failed', 'RUNTIME_INCOMPATIBLE'));
      assert.equal((await logs()).filter(entry => entry.run).length, 2);
    }
  });
});

test('inspection runs only version/help, reports compatibility and never claims authentication', async () => {
  for (const kind of ['claude-code', 'codex-cli'] as const) await withFixture(kind, async ({ profile, logs, settings }) => {
    const available = await inspectLocalRuntime({ ...profile, enabled: false });
    assert.equal(available.available, true); assert.equal(available.compatible, true); assert.equal(available.authentication, 'not_checked');
    assert.match(available.version!, /^\d+\.\d+\.\d+$/);
    assert.deepEqual((await logs()).map(entry => entry.check), ['version', 'help']);
    if (kind === 'claude-code') {
      await settings({ hiddenMaxTurns: true });
      assert.equal((await inspectLocalRuntime(profile)).compatible, true, 'a hidden numeric flag must be proven by positive and negative help-only probes');
      await settings({ missingFlag: '--max-turns' });
      assert.equal((await inspectLocalRuntime(profile)).compatible, false, 'help accepting arbitrary unknown flags is insufficient');
    }
    await settings({ missingFlag: kind === 'codex-cli' ? '--ignore-user-config' : '--tools' });
    const incompatible = await inspectLocalRuntime(profile);
    assert.equal(incompatible.available, true); assert.equal(incompatible.compatible, false); assert.equal(incompatible.authentication, 'not_checked');
    await settings({ badVersion: true });
    const wrongBinary = await inspectLocalRuntime(profile);
    assert.equal(wrongBinary.compatible, false); assert.doesNotMatch(JSON.stringify(wrongBinary), /fixture-secret/);
  });
  const missing = await inspectLocalRuntime(profile('/does-not-exist/owntake-cli'));
  assert.equal(missing.available, false); assert.equal(missing.compatible, false); assert.equal(missing.authentication, 'not_checked');
});

test('Claude draft protocol keeps Chinese and shell metacharacters in stdin, uses bounded tools and drains noisy stderr', async () => {
  await withFixture('claude-code', async ({ profile, workDir, logs }) => {
    const brief = '你好，拍一段清晨街景。$(touch 不要执行); `同样是文本`';
    const result = await runLocalDraft({ ...profile, model: 'stderr-noise' }, { taskId: 'claude_protocol', workDir, brief, shots: [] });
    assert.equal(result.operations[0]!.fields!.title, '你好，晨光');
    assert.deepEqual(result.usage, { inputTokens: 115, outputTokens: 50, totalTokens: 165 });
    const runs = (await logs()).filter(entry => entry.run);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.deepEqual(JSON.parse(run.input), { brief, shots: [] });
    assert(!run.args.some((arg: string) => arg.includes(brief)));
    assert.equal(run.args[run.args.indexOf('--tools') + 1], '');
    assert.equal(run.args[run.args.indexOf('--disallowedTools') + 1], 'mcp__*', 'do not blanket-deny the internal StructuredOutput mechanism');
    assert.equal(run.args[run.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(run.args[run.args.indexOf('--max-turns') + 1], '3', 'leave room for the output-tool turn and its final response');
    assert(run.args[run.args.indexOf('--system-prompt') + 1].includes('Only use the CLI-provided StructuredOutput mechanism'));
    assert(run.args.includes('--safe-mode')); assert(run.args.includes('--no-session-persistence'));
    assert(!run.args.includes('--dangerously-skip-permissions'));
    assert.equal(run.schema.additionalProperties, false);
    assert.equal(run.schema.properties.operations.items.anyOf[0].additionalProperties, false);
    assert.equal(resolve(run.cwd, '..'), await realpath(workDir));
    await assert.rejects(readFile(join(run.cwd, 'draft-schema.json')), { code: 'ENOENT' });
  });
});

test('Codex JSONL protocol handles fragmented UTF-8 and applies read-only fixed configuration', async () => {
  await withFixture('codex-cli', async ({ profile, workDir, logs }) => {
    const result = await runLocalDraft({ ...profile, model: 'split-utf8' }, { taskId: 'codex_protocol', workDir, brief: '中文简报与 emoji 🎬', shots: [] });
    assert.equal(result.operations[0]!.fields!.caption, '早安，OwnTake');
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    const runs = (await logs()).filter(entry => entry.run);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.args[0], 'exec'); assert.equal(run.args.at(-1), '-');
    assert.equal(run.args[run.args.indexOf('--sandbox') + 1], 'read-only');
    assert(run.args.includes('--ignore-user-config')); assert(run.args.includes('--ephemeral'));
    for (const config of ['approval_policy="never"', 'features.shell_tool=false', 'features.apps=false', 'web_search="disabled"', 'model_providers.openai.request_max_retries=0', 'model_providers.openai.stream_max_retries=0']) assert(run.args.includes(config));
    assert(!run.args.includes('--yolo')); assert(!run.args.includes('--full-auto'));
    assert(run.input.includes('中文简报与 emoji 🎬'));
    assert.equal(run.schema.required[0], 'operations');
  });
});

test('only the authentication directory references and a small environment whitelist reach the child', async () => {
  const sentinels = { OPENAI_API_KEY: 'fixture-secret-openai', ANTHROPIC_API_KEY: 'fixture-secret-anthropic', OWNTAKE_PROVIDER_KEY: 'fixture-secret-host', NODE_OPTIONS: '--require /fixture-do-not-load', CLAUDE_CODE_RETRY_WATCHDOG: '1' };
  const before = Object.fromEntries(Object.keys(sentinels).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, sentinels);
    for (const kind of ['claude-code', 'codex-cli'] as const) await withFixture(kind, async ({ profile, workDir, logs }) => {
      await runLocalDraft(profile, { taskId: 'environment_' + kind, workDir, brief: '只传明确上下文', shots: [] });
      const run = (await logs()).find(entry => entry.run);
      for (const key of Object.keys(sentinels)) assert(!run.envKeys.includes(key), `${key} must not be inherited`);
      if (process.env.HOME !== undefined) assert(run.envKeys.includes('HOME'));
      if (kind === 'claude-code') { assert(!run.envKeys.includes('CODEX_HOME')); assert(run.envKeys.includes('MAX_STRUCTURED_OUTPUT_RETRIES')); }
      else assert(!run.envKeys.includes('CLAUDE_CONFIG_DIR'));
    });
  } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('disabled, incompatible, cancelled-before-start and invalid-context attempts never start the model process', async () => {
  await withFixture('claude-code', async ({ profile, workDir, logs, settings }) => {
    const input = { taskId: 'preflight', workDir, brief: '任务', shots: [] };
    await assert.rejects(runLocalDraft({ ...profile, enabled: false }, input), safeError('preflight_failed', 'RUNTIME_DISABLED'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runLocalDraft(profile, { ...input, signal: controller.signal }), safeError('preflight_failed', 'RUNTIME_CANCELLED'));
    await assert.rejects(runLocalDraft(profile, { ...input, brief: '' }), safeError('preflight_failed'));
    assert.equal((await logs()).length, 0);
    await settings({ missingFlag: '--tools' });
    await assert.rejects(runLocalDraft(profile, input), safeError('preflight_failed', 'RUNTIME_INCOMPATIBLE'));
    assert.equal((await logs()).filter(entry => entry.run).length, 0);
  });
});

test('invalid JSON, missing output, injected fields and unknown references are rejected without respawn or secret leakage', async () => {
  await withFixture('claude-code', async ({ profile, workDir, logs }) => {
    for (const model of ['bad-json', 'missing-output', 'reported-error', 'injected-field', 'unknown-shot', 'unknown-reference']) {
      const before = (await logs()).filter(entry => entry.run).length;
      await assert.rejects(runLocalDraft({ ...profile, model }, { taskId: 'invalid_' + model, workDir, brief: '安全草稿', shots: [] }), safeError(model === 'reported-error' ? 'submission_unknown' : 'invalid_output'));
      assert.equal((await logs()).filter(entry => entry.run).length, before + 1);
    }
  });
});

test('unknown Codex event surfaces, tool events and incomplete or duplicate final results fail closed', async () => {
  await withFixture('codex-cli', async ({ profile, workDir, logs }) => {
    for (const model of ['unknown-event', 'tool-event', 'truncated', 'duplicate-result', 'reported-error']) {
      const before = (await logs()).filter(entry => entry.run).length;
      await assert.rejects(runLocalDraft({ ...profile, model }, { taskId: 'event_' + model, workDir, brief: '安全草稿', shots: [] }), safeError(model === 'reported-error' ? 'submission_unknown' : 'invalid_output'));
      assert.equal((await logs()).filter(entry => entry.run).length, before + 1);
    }
  });
});

test('abnormal exit, excessive output and timeout retain an unknown submission and never launch a second model process', async () => {
  await withFixture('claude-code', async ({ profile, workDir, logs }) => {
    for (const model of ['exit-failed', 'oversize', 'timeout']) {
      const before = (await logs()).filter(entry => entry.run).length;
      await assert.rejects(runLocalDraft({ ...profile, model, timeoutMs: model === 'timeout' ? 400 : 5000 }, { taskId: 'failure_' + model, workDir, brief: '不可自动重试', shots: [] }), safeError('submission_unknown'));
      assert.equal((await logs()).filter(entry => entry.run).length, before + 1);
    }
  });
});

test('cancellation terminates the owned process group and rejects a concurrent duplicate task', { skip: process.platform === 'win32' }, async () => {
  await withFixture('claude-code', async ({ profile, workDir, logs }) => {
    const controller = new AbortController();
    const input = { taskId: 'cancel_group', workDir, brief: '可取消任务', shots: [], signal: controller.signal };
    const running = runLocalDraft({ ...profile, model: 'hang' }, input);
    const rejected = assert.rejects(running, error => { safeError('submission_unknown', 'RUNTIME_CANCELLED')(error); assert(error instanceof RuntimeCallError && error.cancelled && error.started); return true; });
    await until(async () => (await logs()).some(entry => entry.descendant));
    await assert.rejects(runLocalDraft(profile, input), safeError('preflight_failed', 'RUNTIME_ALREADY_RUNNING'));
    controller.abort();
    await rejected;
    const recorded = await logs();
    assert.equal(recorded.filter(entry => entry.run).length, 1);
    const pids = [recorded.find(entry => entry.run).pid, recorded.find(entry => entry.descendant).descendant];
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
});
