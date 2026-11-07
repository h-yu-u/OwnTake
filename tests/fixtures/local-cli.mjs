#!/usr/bin/env node
// Offline protocol fixture. It never reads CLI credentials or contacts a model.
import { appendFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(await readFile(join(root, 'fixture-settings.json'), 'utf8'));
const args = process.argv.slice(2);
const log = value => appendFile(join(root, 'invocations.jsonl'), JSON.stringify(value) + '\n');
const requiredFlags = settings.kind === 'codex-cli'
  ? ['--json', '--ephemeral', '--ignore-user-config', '--sandbox', '--color', '--skip-git-repo-check', '--output-schema', '--model', '--config']
  : ['--print', '--output-format', '--json-schema', '--model', '--tools', '--disallowedTools', '--permission-mode', '--safe-mode', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--no-session-persistence', '--max-turns', '--system-prompt'];

if (args.includes('--version')) {
  await log({ check: 'version' });
  process.stdout.write(settings.badVersion ? 'not-a-cli fixture-secret' : settings.kind === 'codex-cli' ? 'codex-cli 0.999.0\n' : '2.999.0 (Claude Code)\n');
  process.exit(0);
}
if (args.includes('--help')) {
  await log({ check: 'help', args });
  if (args[0] === 'debug' && args[1] === 'models' && settings.bundledModels) {
    process.stdout.write('--bundled\n'); process.exit(0);
  }
  if (settings.hiddenMaxTurns && args.includes('--max-turns') && !Number.isFinite(Number(args[args.indexOf('--max-turns') + 1]))) process.exit(2);
  process.stdout.write(requiredFlags.filter(flag => flag !== settings.missingFlag && !(settings.hiddenMaxTurns && flag === '--max-turns')).map(flag => '  ' + flag + ' <value>').join('\n'));
  if (settings.kind === 'claude-code' && settings.missingFlag !== '--effort') process.stdout.write('\n  --effort <level> (low, medium, high, xhigh, max)\n');
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'models' && args[2] === '--bundled' && settings.bundledModels) {
  await log({ check: 'bundled', args });
  process.stdout.write(JSON.stringify({ models: settings.bundledModels })); process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const mode = args[args.indexOf('--model') + 1];
const schema = settings.kind === 'codex-cli' ? JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8')) : JSON.parse(args[args.indexOf('--json-schema') + 1]);
await log({ run: true, pid: process.pid, args, input, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), schema });

const fields = { title: '你好，晨光', purpose: '建立环境', description: '街道泛起晨光', action: '镜头缓缓前移', durationMs: 4000, caption: '早安，OwnTake', mode: 'generate_video', referenceArtifactIds: [] };
const operations = [{ id: 'operation_1', kind: 'add', fields }];
let draft = { operations };
if (mode === 'injected-field') draft = { operations: [{ ...operations[0], shell: 'fixture-secret: never execute this' }] };
if (mode === 'unknown-shot') draft = { operations: [{ id: 'remove_missing', kind: 'delete', shotId: 'not_in_snapshot' }] };
if (mode === 'unknown-reference') draft = { operations: [{ ...operations[0], fields: { ...fields, referenceArtifactIds: ['not_in_snapshot'] } }] };

async function write(stream, content) {
  if (!stream.write(content)) await once(stream, 'drain');
}
if (mode === 'hang' || mode === 'timeout') {
  process.on('SIGTERM', () => {});
  if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    await log({ descendant: child.pid });
  }
  await write(process.stderr, 'fixture-secret must never reach an error\n');
  setInterval(() => {}, 1000);
} else if (mode === 'bad-json') {
  await write(process.stdout, '{fixture-secret invalid JSON');
} else if (mode === 'oversize') {
  await write(process.stdout, 'x'.repeat(5 * 1024 * 1024));
} else if (mode === 'exit-failed') {
  await write(process.stderr, 'fixture-secret request credentials / private prompt');
  process.exitCode = 7;
} else {
  if (mode === 'stderr-noise') await write(process.stderr, 'fixture-secret noisy diagnostics\n'.repeat(60_000));
  let response;
  if (settings.kind === 'claude-code') {
    response = JSON.stringify({ type: 'result', subtype: mode === 'reported-error' ? 'error_max_turns' : 'success', is_error: mode === 'reported-error', ...(mode === 'missing-output' ? {} : { structured_output: draft }), usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } });
  } else {
    const events = [
      { type: 'thread.started', thread_id: 'thread_fixture' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'reasoning_1', type: 'reasoning', text: 'Bounded fixture reasoning' } },
      { type: 'item.completed', item: { id: 'answer_1', type: 'agent_message', text: JSON.stringify(draft) } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50 } },
    ];
    if (mode === 'unknown-event') events.splice(2, 0, { type: 'new_unsupported_event', secret: 'fixture-secret' });
    if (mode === 'tool-event') events.splice(2, 0, { type: 'item.completed', item: { id: 'tool_1', type: 'command_execution', command: 'fixture-secret never execute' } });
    if (mode === 'reported-error') events.splice(2, 0, { type: 'error', message: 'fixture-secret remote outcome unclear' });
    if (mode === 'truncated') events.pop();
    if (mode === 'duplicate-result') events.splice(-1, 0, events[3]);
    response = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  }
  if (mode === 'split-utf8') {
    const bytes = Buffer.from(response);
    for (let offset = 0; offset < bytes.length; offset += 7) await write(process.stdout, bytes.subarray(offset, offset + 7));
  } else await write(process.stdout, response);
}
