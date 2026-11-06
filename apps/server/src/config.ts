import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export interface ServerConfig { dataDir: string; projectsDir: string; port: number; host: '127.0.0.1'; webDir: string; devOrigin?: string; maxUploadBytes: number }
export function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'OwnTake') : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'owntake');
  const dataDir = resolve(overrides.dataDir || process.env.OWNTAKE_DATA_DIR || base);
  const defaultProjects = process.platform === 'darwin' && !overrides.dataDir && !process.env.OWNTAKE_DATA_DIR ? join(homedir(), 'Movies', 'OwnTake', 'Projects') : join(dataDir, 'projects');
  const config = { dataDir, projectsDir: resolve(process.env.OWNTAKE_PROJECTS_DIR || defaultProjects), port: Number(process.env.OWNTAKE_PORT || 4317), host: '127.0.0.1' as const, webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)), devOrigin: process.env.OWNTAKE_DEV_ORIGIN, maxUploadBytes: 256 * 1024 * 1024, ...overrides };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('OWNTAKE_PORT must be a valid port');
  if (config.host !== '127.0.0.1') throw new Error('OwnTake only binds to 127.0.0.1');
  return config;
}
