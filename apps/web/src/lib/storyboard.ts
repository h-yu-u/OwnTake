import type { Artifact, BoardSnapshot, DraftOperation, Shot, ShotFields, StoryboardDraft } from '../types.ts';

export const shotFieldLabels: Record<keyof ShotFields, string> = {
  title: '镜头名称', purpose: '叙事目的', description: '画面描述', action: '镜头与人物动作',
  durationMs: '时长', caption: '字幕', mode: '素材方式', referenceArtifactIds: '参考素材',
};
export const shotModeLabels = { import: '使用已有素材', generate_image: '计划生成图片', generate_video: '计划生成视频' };
export function emptyShotFields(order = 0): ShotFields { return { title: `镜头 ${String(order + 1).padStart(2, '0')}`, purpose: '', description: '', action: '', durationMs: 3000, caption: '', mode: 'import', referenceArtifactIds: [] }; }
export function shotFields(shot: ShotFields): ShotFields {
  return { title: shot.title, purpose: shot.purpose, description: shot.description, action: shot.action,
    durationMs: shot.durationMs, caption: shot.caption, mode: shot.mode, referenceArtifactIds: [...shot.referenceArtifactIds] };
}
export function activeShots(board: BoardSnapshot | null): Shot[] { return (board?.shots || []).filter(shot => !shot.archived).sort((a, b) => a.order - b.order); }
export function shotProblems(fields: ShotFields): string[] {
  const problems: string[] = [];
  if (!fields.title.trim()) problems.push('请为镜头填写名称。');
  if (fields.title.length > 200) problems.push('镜头名称不能超过 200 字。');
  if (!Number.isInteger(fields.durationMs) || fields.durationMs < 100 || fields.durationMs > 600000) problems.push('镜头时长须为 0.1–600 秒。');
  if (fields.referenceArtifactIds.length > 20) problems.push('参考素材最多可选 20 个。');
  return problems;
}
export function storyboardProblems(shots: Shot[], artifacts: Artifact[]): string[] {
  if (!shots.length) return ['先添加一个镜头，再把分镜保存到时间线。'];
  return shots.flatMap((shot, index) => {
    if (shot.caption.length > 2000) return [`镜头 ${index + 1} 的字幕超过单条合成的 2000 字限制，请先精简或分段处理。`];
    const artifact = artifacts.find(item => item.id === shot.selectedArtifactId);
    if (!artifact) return [`镜头 ${index + 1}「${shot.title}」尚未选用素材。`];
    if (artifact.kind === 'audio') return [`镜头 ${index + 1} 需要图片或视频。`];
    if (artifact.kind === 'video' && shot.durationMs > artifact.media.durationMs) return [`镜头 ${index + 1} 时长超过选用视频，请缩短镜头时长。`];
    return [];
  });
}
export function operationTitle(operation: DraftOperation, shots: Shot[]): string {
  return operation.fields?.title || shots.find(shot => shot.id === operation.shotId)?.title || '已归档的镜头';
}
export function fieldChanges(operation: DraftOperation, shots: Shot[]): { key: keyof ShotFields; label: string; before: string; after: string }[] {
  const previous = shots.find(shot => shot.id === operation.shotId);
  const keys = Object.keys(shotFieldLabels) as (keyof ShotFields)[];
  function describe(key: keyof ShotFields, fields?: ShotFields): string {
    if (!fields) return '—';
    if (key === 'durationMs') return `${fields.durationMs / 1000} 秒`;
    if (key === 'mode') return shotModeLabels[fields.mode];
    if (key === 'referenceArtifactIds') return fields.referenceArtifactIds.length ? `${fields.referenceArtifactIds.length} 个素材：${fields.referenceArtifactIds.join('、')}` : '无';
    return String(fields[key]) || '（留空）';
  }
  return keys.filter(key => operation.kind !== 'update' || JSON.stringify(previous?.[key]) !== JSON.stringify(operation.fields?.[key]))
    .map(key => ({ key, label: shotFieldLabels[key], before: describe(key, operation.kind === 'add' ? undefined : previous), after: describe(key, operation.kind === 'delete' ? undefined : operation.fields) }));
}
export function renewDraftOperations(draft: StoryboardDraft): DraftOperation[] {
  return draft.operations.map(operation => ({ ...operation, id: crypto.randomUUID(), ...(operation.fields ? { fields: shotFields(operation.fields) } : {}) }));
}
