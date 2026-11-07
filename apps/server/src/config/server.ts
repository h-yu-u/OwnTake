import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4317;
const DEFAULT_UPLOAD_BYTES = 256 * 1024 * 1024;
const LOG_LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export interface ServerConfig {
  dataDir: string;
  projectsDir: string;
  port: number;
  host: '127.0.0.1';
  webDir: string;
  devOrigin?: string;
  maxUploadBytes: number;
  logLevel: typeof LOG_LEVELS[number];
}

export function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'OwnTake')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'owntake');
  const dataDir = resolve(overrides.dataDir || process.env.OWNTAKE_DATA_DIR || base);
  const defaultProjects = process.platform === 'darwin' && !overrides.dataDir && !process.env.OWNTAKE_DATA_DIR
    ? join(homedir(), 'Movies', 'OwnTake', 'Projects')
    : join(dataDir, 'projects');
  const config: ServerConfig = {
    port: Number(process.env.OWNTAKE_PORT || DEFAULT_PORT),
    host: '127.0.0.1',
    devOrigin: process.env.OWNTAKE_DEV_ORIGIN,
    maxUploadBytes: DEFAULT_UPLOAD_BYTES,
    logLevel: (process.env.OWNTAKE_LOG_LEVEL || 'info') as ServerConfig['logLevel'],
    ...overrides,
    dataDir,
    projectsDir: resolve(overrides.projectsDir || process.env.OWNTAKE_PROJECTS_DIR || defaultProjects),
    webDir: resolve(overrides.webDir ?? fileURLToPath(new URL('../../../web/dist', import.meta.url))),
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('OWNTAKE_PORT must be a valid port');
  }
  if (config.host !== '127.0.0.1') throw new Error('OwnTake only binds to 127.0.0.1');
  if (!Number.isSafeInteger(config.maxUploadBytes) || config.maxUploadBytes < 1) {
    throw new Error('maxUploadBytes must be a positive safe integer');
  }
  if (!LOG_LEVELS.includes(config.logLevel)) throw new Error('OWNTAKE_LOG_LEVEL must be a supported log level');
  if (config.devOrigin) {
    const origin = new URL(config.devOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.devOrigin) {
      throw new Error('OWNTAKE_DEV_ORIGIN must be an exact HTTP origin');
    }
  }
  return config;
}
