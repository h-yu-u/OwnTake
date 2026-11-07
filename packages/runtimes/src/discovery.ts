import { constants } from 'node:fs';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { DiscoveredLocalRuntime, LocalRuntimeKind, LocalRuntimeModelOption } from '../../contracts/src/runtimes.ts';
import { localReasoningEfforts } from '../../contracts/src/runtimes.ts';
import { inspectLocalRuntime } from './local.ts';
import { localEnvironment, localExecutable, runLocalProcess } from './local-process.ts';

const catalogLimit = 2 * 1024 * 1024;
const runtimeKinds = [
  { kind: 'codex-cli', command: 'codex', label: 'Codex CLI' },
  { kind: 'claude-code', command: 'claude', label: 'Claude Code' },
] as const;

function cleanText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Extract only public model identities and known reasoning capabilities. */
export function parseLocalModelCatalog(raw: unknown): LocalRuntimeModelOption[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const models = (raw as Record<string, unknown>).models;
  if (!Array.isArray(models) || models.length > 1000) return [];
  const result = new Map<string, LocalRuntimeModelOption>();
  for (const entry of models) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { slug, display_name: label, visibility, supported_reasoning_levels: levels, default_reasoning_level: defaultLevel } = entry as Record<string, unknown>;
    if (!cleanText(slug, 200) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(slug) || visibility === 'hide') continue;
    const reasoningEfforts = Array.isArray(levels) ? localReasoningEfforts.filter(effort => levels.some(level => level && typeof level === 'object' && level.effort === effort)) : undefined;
    const defaultReasoningEffort = reasoningEfforts?.find(effort => effort === defaultLevel);
    result.set(slug, { id: slug, label: cleanText(label, 200) ? label.trim() : slug,
      ...(reasoningEfforts ? { reasoningEfforts } : {}), ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) });
    if (result.size === 200) break;
  }
  return [...result.values()];
}

async function cachedModels(directory: string): Promise<LocalRuntimeModelOption[]> {
  // Never inspect config.toml, auth.json, keychains or any other CLI state.
  let file;
  try {
    file = await open(join(directory, 'models_cache.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > catalogLimit) return [];
    const bytes = Buffer.alloc(catalogLimit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > catalogLimit) return [];
    return parseLocalModelCatalog(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } catch { return []; }
  finally { await file?.close(); }
}

async function searchDirectories(): Promise<string[]> {
  const home = homedir();
  const directories = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'), join(home, '.bun', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ];
  const nvmRoot = join(process.env.NVM_DIR && isAbsolute(process.env.NVM_DIR) ? process.env.NVM_DIR : join(home, '.nvm'), 'versions', 'node');
  try {
    const versions = (await readdir(nvmRoot)).filter(name => /^v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 12);
    directories.push(...versions.map(version => join(nvmRoot, version, 'bin')));
  } catch { /* nvm is optional; PATH and standard installations remain searchable. */ }
  // A relative or empty PATH entry must never discover a program in the project cwd.
  return [...new Set(directories.filter(path => isAbsolute(path) && !/[\u0000-\u001f\u007f]/.test(path)))].slice(0, 96);
}

async function bundledModels(binaryPath: string): Promise<LocalRuntimeModelOption[]> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'owntake-cli-models-'));
    const options = { cwd: directory, env: localEnvironment('codex-cli', binaryPath), timeoutMs: 5000, maxStdoutBytes: catalogLimit, modelInvocation: false };
    const executable = await localExecutable(binaryPath);
    const help = await runLocalProcess(executable, ['debug', 'models', '--help'], options);
    if (!/(?:^|\s)--bundled(?=\s|$)/m.test(help)) return [];
    // --bundled explicitly skips refresh: no network, login, prompt or model task.
    return parseLocalModelCatalog(JSON.parse(await runLocalProcess(executable, ['debug', 'models', '--bundled'], options)));
  } catch { return []; }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

async function modelsFor(kind: LocalRuntimeKind, binaryPath: string, codexHome: string): Promise<Pick<DiscoveredLocalRuntime, 'models' | 'modelSource'>> {
  if (kind === 'claude-code') return { models: ['sonnet', 'opus', 'haiku'].map(id => ({ id, label: `${id[0]!.toUpperCase()}${id.slice(1)}` })), modelSource: 'aliases' };
  const cached = await cachedModels(codexHome);
  if (cached.length) return { models: cached, modelSource: 'local-cache' };
  const bundled = await bundledModels(binaryPath);
  return { models: bundled, modelSource: bundled.length ? 'bundled' : 'unavailable' };
}

/** No caller-controlled commands; one PATH-preferred installation per supported CLI. */
export async function discoverLocalRuntimes(options: { searchDirectories?: readonly string[]; codexHome?: string } = {}): Promise<DiscoveredLocalRuntime[]> {
  const directories = options.searchDirectories ?? await searchDirectories();
  const codexHome = options.codexHome ?? (process.env.CODEX_HOME && isAbsolute(process.env.CODEX_HOME) ? process.env.CODEX_HOME : join(homedir(), '.codex'));
  const found = await Promise.all(runtimeKinds.map(async ({ kind, command, label }): Promise<DiscoveredLocalRuntime | undefined> => {
    for (const directory of directories) {
      if (!isAbsolute(directory)) continue;
      const binaryPath = join(directory, command);
      try { await localExecutable(binaryPath); } catch { continue; }
      const now = new Date().toISOString();
      const inspection = await inspectLocalRuntime({ id: 'discovery', label, kind, binaryPath, enabled: false, model: 'discovery-only', timeoutMs: 5000, createdAt: now, updatedAt: now });
      // Keep an incompatible installation visible with its actionable diagnostics.
      const modelCatalog = inspection.version ? await modelsFor(kind, binaryPath, codexHome) : { models: [], modelSource: 'unavailable' as const };
      return { kind, label, binaryPath, inspection, ...modelCatalog };
    }
    return undefined;
  }));
  return found.filter((runtime): runtime is DiscoveredLocalRuntime => runtime !== undefined);
}
