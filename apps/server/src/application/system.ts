import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { record, text } from '../../../../packages/domain/src/validation.ts';
import { fontHealth, toolHealth } from '../../../../packages/media/src/index.ts';
import type { ServerConfig } from '../config.ts';
import { APPLICATION_VERSION } from '../config/application.ts';
import type { ApplicationContext } from './context.ts';

type SystemContext = Pick<ApplicationContext, 'store'>;

export async function readHealth({ store }: SystemContext, config: Pick<ServerConfig, 'dataDir' | 'projectsDir'>) {
  const settings = store.getSettings();
  const [ffmpeg, ffprobe] = await Promise.all([toolHealth(settings.ffmpegPath), toolHealth(settings.ffprobePath)]);
  const subtitleFont = settings.subtitleFontPath ? await fontHealth(settings.subtitleFontPath) : undefined;
  return { status: ffmpeg.available && ffprobe.available ? 'ok' : 'degraded', version: APPLICATION_VERSION, schemaVersion: store.schemaVersion, ffmpeg, ffprobe, subtitleFont, dataDir: config.dataDir, projectsDir: config.projectsDir };
}

export async function updateSettings({ store }: SystemContext, value: unknown) {
  const body = record(value);
  const ffmpegPath = text(body.ffmpegPath, 'FFmpeg 路径', 1000), ffprobePath = text(body.ffprobePath, 'ffprobe 路径', 1000);
  for (const path of [ffmpegPath, ffprobePath]) {
    invariant(!path.includes('\0') && (isAbsolute(path) || ['ffmpeg', 'ffprobe'].includes(path)), 'INVALID_TOOL_PATH', '请填写绝对工具路径或默认命令名');
  }
  const subtitleFontPath = body.subtitleFontPath === undefined ? undefined : text(body.subtitleFontPath, '字幕字体路径', 2048, true);
  if (subtitleFontPath) {
    invariant(isAbsolute(subtitleFontPath), 'INVALID_FONT_PATH', '字体需为绝对文件路径');
    const font = await fontHealth(subtitleFontPath);
    invariant(font.available, 'FONT_UNAVAILABLE', font.error || '字体不可用');
  }
  store.updateSettings({ ffmpegPath, ffprobePath, ...(subtitleFontPath === undefined ? {} : { subtitleFontPath }) });
  return store.getSettings();
}

export function readDiagnostics({ store }: SystemContext) {
  return { version: APPLICATION_VERSION, schemaVersion: store.schemaVersion, projectCount: store.listProjects().length, at: new Date().toISOString(), traceId: randomUUID() };
}
