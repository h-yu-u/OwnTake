import type { ProviderCapabilities, ProviderInputMode, ProviderKind } from '../../contracts/src/providers.ts';

export interface AutomaticModelCapabilities {
  capabilities: ProviderCapabilities;
  sourceUrl: string;
  notes: string[];
}
const sourceUrl = 'https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh';
interface ArkModelRule { ids: string[]; modes: ProviderInputMode[]; minSeconds: number; maxSeconds: number; references: number; notes?: string[] }
/** Explicit documented versions and aliases only. Unknown future versions require manual configuration. */
const rules: ArkModelRule[] = [
  { ids: ['doubao-seedance-1-0-pro-fast-251015', 'doubao-seedance-1-0-pro-fast', 'doubao-seedance-1.0-pro-fast'], modes: ['text', 'first_frame'], minSeconds: 2, maxSeconds: 12, references: 1 },
  { ids: ['doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-pro', 'doubao-seedance-1.0-pro'], modes: ['text', 'first_frame', 'first_last_frame'], minSeconds: 2, maxSeconds: 12, references: 2 },
  { ids: ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0', 'doubao-seedance-2.0', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-fast', 'doubao-seedance-2.0-fast', 'doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-mini', 'doubao-seedance-2.0-mini'], modes: ['text', 'first_frame', 'first_last_frame', 'references'], minSeconds: 4, maxSeconds: 15, references: 9 },
  { ids: ['doubao-seedance-2-5-260628', 'doubao-seedance-2-5', 'doubao-seedance-2.5'], modes: ['text', 'references'], minSeconds: 4, maxSeconds: 30, references: 16,
    notes: ['模型最多支持 30 张参考图，OwnTake 当前最多接收 16 张。', '此模型的首帧与首尾帧要求自适应画幅，当前适配器暂不开放这两种输入。'] },
];

/** Available adapter subset of documented capabilities; never verifies the key or changes saved profiles. */
export function automaticModelCapabilities(kind: ProviderKind, model: string): AutomaticModelCapabilities | null {
  if (kind !== 'ark-video') return null;
  const rule = rules.find(rule => rule.ids.includes(model.trim()));
  if (!rule) return null;
  return {
    capabilities: { inputModes: [...rule.modes], ratios: ['16:9', '9:16', '1:1'], durationsSec: Array.from({ length: rule.maxSeconds - rule.minSeconds + 1 }, (_, index) => rule.minSeconds + index), maxReferences: rule.references },
    sourceUrl, notes: ['仅列出 OwnTake 当前可提交的能力，账号权限仍以实际调用为准。', ...rule.notes || []],
  };
}
