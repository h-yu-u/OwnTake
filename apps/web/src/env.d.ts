/// <reference types="vite/client" />
import type { OwnTakeDesktopBridge } from '../../../packages/contracts/src/desktop.ts';

declare global {
  interface Window { ownTakeDesktop?: OwnTakeDesktopBridge }
}
