import type { Candidate, GenerationPlan, GenerationRecord, ProviderSummary, Ratio, Shot } from '../types.ts';
import type { GenerationRequest } from './generationApi.ts';
import { initialGenerationPlan } from './generation.ts';

export interface BatchImageRow { shot: Shot; plan: GenerationPlan; skipReason: string | null }
export interface BatchGenerationItem { shotId: string; title: string; request: GenerationRequest }
export type BatchSubmissionResult = { item: BatchGenerationItem; record: GenerationRecord; error?: never }
  | { item: BatchGenerationItem; record?: never; error: unknown };

/** Defaults never turn an existing or uncertain generation into another paid request. */
export function batchImageRows(shots: Shot[], candidates: Candidate[], records: GenerationRecord[], ratio: Ratio, quality: GenerationPlan['imageQuality']): BatchImageRow[] {
  return shots.filter(shot => !shot.archived).map(shot => {
    const previous = records.filter(record => record.shotId === shot.id);
    const current = previous.filter(record => record.visualRevision === shot.visualRevision);
    const plan: GenerationPlan = { ...initialGenerationPlan(shot, ratio), kind: 'image' };
    delete plan.durationSec;
    if (quality) plan.imageQuality = quality;
    else delete plan.imageQuality;
    const skipReason = shot.selectedArtifactId ? '已有选用素材'
      : previous.some(record => record.status === 'submission_unknown') ? '原提交结果不明，请先核对'
      : previous.some(record => !['succeeded', 'failed', 'cancelled', 'download_failed'].includes(record.status)) ? '已有任务正在处理'
      : previous.some(record => record.status === 'download_failed') ? '原结果待恢复，请勿重新生成'
      : previous.some(record => record.status === 'failed' && record.actualAmount === null && record.budgetMode !== 'none') ? '原失败调用费用待核对'
      : candidates.some(candidate => candidate.shotId === shot.id && candidate.visualRevision === shot.visualRevision) || current.some(record => record.status === 'succeeded') ? '已有当前版本候选，请先复核'
      : shot.referenceArtifactIds.length ? '包含参考图，请逐镜设置'
      : !plan.prompt.trim() ? '请先填写画面描述'
      : null;
    return { shot, plan, skipReason };
  });
}

/** Detach every request from live editors before the first local enqueue. */
export function freezeBatchItems(rows: BatchImageRow[], provider: ProviderSummary, operationIds: string[]): BatchGenerationItem[] {
  if (rows.length !== operationIds.length || new Set(operationIds).size !== rows.length || rows.some(row => row.skipReason)) throw new Error('批次镜头或操作标识无效，请重新审阅。');
  return rows.map((row, index) => ({ shotId: row.shot.id, title: row.shot.title, request: {
    providerId: provider.id, expectedProviderUpdatedAt: provider.updatedAt, expectedShotRevision: row.shot.revision,
    plan: { ...row.plan, referenceArtifactIds: [...row.plan.referenceArtifactIds] }, clientRequestId: operationIds[index]!,
  } }));
}

/** Each local POST only registers durable work. Stop on the first lost/rejected acknowledgement; never retry it. */
export async function enqueueBatch(items: BatchGenerationItem[], submit: (shotId: string, request: GenerationRequest) => Promise<GenerationRecord>, onResult: (result: BatchSubmissionResult) => void): Promise<void> {
  for (const item of items) {
    let record: GenerationRecord;
    try { record = await submit(item.shotId, item.request); }
    catch (error) { onResult({ item, error }); return; }
    onResult({ item, record });
    if (record.error || ['failed', 'submission_unknown', 'download_failed', 'cancelled'].includes(record.status)) return;
  }
}
