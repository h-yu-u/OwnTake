import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopPathKind, OwnTakeDesktopBridge } from '../../../packages/contracts/src/desktop.ts';

const bridge: OwnTakeDesktopBridge = Object.freeze({
  info: () => ipcRenderer.invoke('owntake:info'),
  choosePath: (kind: DesktopPathKind) => ipcRenderer.invoke('owntake:choose-path', kind),
  openProject: (id: string) => ipcRenderer.invoke('owntake:open-project', id),
  revealArtifact: (id: string) => ipcRenderer.invoke('owntake:reveal-artifact', id),
});
contextBridge.exposeInMainWorld('ownTakeDesktop', bridge);
