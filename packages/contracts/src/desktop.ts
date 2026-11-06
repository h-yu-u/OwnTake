/** Optional desktop capabilities. The browser app works without this bridge. */
export type DesktopPathKind = 'ffmpeg' | 'ffprobe' | 'font' | 'runtime';

export interface DesktopInfo {
  version: string;
  electron: string;
  node: string;
  platform: string;
  coreUrl: string;
  background: true;
}

/** Fixed operations only; filesystem locations are resolved by the desktop host. */
export interface OwnTakeDesktopBridge {
  info(): Promise<DesktopInfo>;
  choosePath(kind: DesktopPathKind): Promise<string | null>;
  openProject(projectId: string): Promise<void>;
  revealArtifact(artifactId: string): Promise<void>;
}
