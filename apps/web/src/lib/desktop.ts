import type { DesktopInfo, DesktopPathKind, OwnTakeDesktopBridge } from '../types.ts';

export function desktopBridge(): OwnTakeDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.ownTakeDesktop;
  return bridge && ['info', 'choosePath', 'openProject', 'revealArtifact'].every(key => typeof bridge[key as keyof OwnTakeDesktopBridge] === 'function') ? bridge : null;
}
function requireBridge(): OwnTakeDesktopBridge {
  const bridge = desktopBridge();
  if (!bridge) throw new Error('桌面连接暂不可用，请重新打开桌面工作台。');
  return bridge;
}
function parseInfo(input: unknown): DesktopInfo {
  if (!input || typeof input !== 'object') throw new Error('桌面信息格式不兼容，请检查应用版本。');
  const value = input as Record<string, unknown>;
  if (value.background !== true || !['version', 'electron', 'node', 'platform', 'coreUrl'].every(key => typeof value[key] === 'string' && value[key].length > 0)) throw new Error('桌面信息格式不兼容，请检查应用版本。');
  return { version: value.version as string, electron: value.electron as string, node: value.node as string, platform: value.platform as string, coreUrl: value.coreUrl as string, background: true };
}
export const desktopApi = {
  info: async (): Promise<DesktopInfo> => parseInfo(await requireBridge().info()),
  choosePath: async (kind: DesktopPathKind): Promise<string | null> => {
    const path = await requireBridge().choosePath(kind);
    if (path === null) return null;
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('桌面文件选择没有返回有效路径，请重新选择。');
    return path;
  },
  openProject: (projectId: string) => requireBridge().openProject(projectId),
  revealArtifact: (artifactId: string) => requireBridge().revealArtifact(artifactId),
};
