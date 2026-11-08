import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { integer, record, resourceId, text } from '../../../../packages/domain/src/validation.ts';
import { validateSpeechInput } from '../../../../packages/providers/src/speech.ts';
import { requestHash } from '../../../../packages/storage/src/validation.ts';
import { publicStudio } from '../studio-repository.ts';
import type { ApplicationContext } from './context.ts';

/** Register the whole batch atomically before the runner can make any external call. */
export function requestBatchSpeech({ studio, studioRunner }: Pick<ApplicationContext, 'studio' | 'studioRunner'>, id: string, value: unknown) {
  const projectId = resourceId(id), body = record(value);
  invariant(Object.keys(body).every(key => ['clientRequestId', 'targetId', 'expectedTargetUpdatedAt', 'expectedBoardRevision', 'voice', 'speed', 'instructions', 'entries'].includes(key)), 'INVALID_INPUT', '批量配音包含不支持的字段');
  const batchId = resourceId(body.clientRequestId), targetId = resourceId(body.targetId);
  const targetRevision = text(body.expectedTargetUpdatedAt, '配音连接版本', 100);
  const boardRevision = integer(body.expectedBoardRevision, '分镜版本', 0, Number.MAX_SAFE_INTEGER);
  invariant(Array.isArray(body.entries) && body.entries.length > 0 && body.entries.length <= 100, 'INVALID_SPEECH_INPUT', '请选择 1–100 个配音镜头');
  const entries = body.entries.map(value => {
    const entry = record(value);
    invariant(Object.keys(entry).every(key => ['shotId', 'expectedShotRevision', 'text'].includes(key)), 'INVALID_SPEECH_INPUT', '配音镜头包含不支持的字段');
    return { shotId: resourceId(entry.shotId), expectedShotRevision: integer(entry.expectedShotRevision, '镜头版本', 1, Number.MAX_SAFE_INTEGER), text: entry.text };
  });
  invariant(new Set(entries.map(entry => entry.shotId)).size === entries.length, 'INVALID_SPEECH_INPUT', '同一批次不能重复选择一个镜头');
  const hash = requestHash({ ...body, entries });
  const result = studio.store.transaction(() => {
    studio.store.getProject(projectId);
    const existing = studio.all().filter(operation => operation.projectId === projectId && operation.speechBatch?.id === batchId);
    if (existing.length) {
      invariant(existing.length === entries.length && existing.every(operation => operation.batchRequestHash === hash), 'IDEMPOTENCY_CONFLICT', '同一批次标识不能用于不同配音输入', 409);
      return existing.sort((a, b) => a.speechBatch!.index - b.speechBatch!.index).map(publicStudio);
    }
    const board = studio.board.snapshot(projectId);
    invariant(board.revision === boardRevision, 'REVISION_CONFLICT', '分镜已改变，请重新打开批量配音', 409);
    const { profile } = studio.providers.getProfile(targetId);
    invariant(profile.updatedAt === targetRevision, 'TARGET_CHANGED', '配音连接已改变，请重新选择', 409);
    const active = studio.all().filter(operation => operation.projectId === projectId && operation.kind === 'tts' && ['queued', 'submitting', 'received', 'submission_unknown', 'ingest_failed'].includes(operation.status));
    // Validate every entry first, including ownership and frozen revisions.
    const validated = entries.map(entry => {
      const shot = board.shots.find(shot => shot.id === entry.shotId && !shot.archived);
      invariant(shot && shot.revision === entry.expectedShotRevision, 'REVISION_CONFLICT', '镜头已改变或不属于当前项目，请重新打开批量配音', 409);
      invariant(!active.some(operation => operation.source.shotId === shot.id), 'SPEECH_IN_PROGRESS', `镜头「${shot.title}」已有进行中或待核对的配音，请先处理原任务`, 409);
      const input = validateSpeechInput(profile, { text: entry.text, voice: body.voice, speed: body.speed, instructions: body.instructions });
      return { shot, input };
    });
    return validated.map(({ shot, input }, index) => publicStudio(studio.create(projectId, {
      kind: 'tts', targetId, expectedTargetUpdatedAt: targetRevision, clientRequestId: `speech-${requestHash(batchId).slice(0,48)}-${index}`, input,
    }, { source: { id: batchId, index, total: entries.length, shotTitle: shot.title, shotRevision: shot.revision }, shotId: shot.id, requestHash: hash })));
  });
  studioRunner.tick();
  return result;
}

/** Stop unsubmitted segments while allowing the already submitted segment to finish. */
export function cancelBatchSpeech({ studio, studioRunner }: Pick<ApplicationContext, 'studio' | 'studioRunner'>, id: string, batch: string) {
  const projectId = resourceId(id), batchId = resourceId(batch);
  return studio.store.transaction(() => {
    studio.store.getProject(projectId);
    const operations = studio.all().filter(operation => operation.projectId === projectId && operation.speechBatch?.id === batchId);
    invariant(operations.length > 0, 'OPERATION_NOT_FOUND', '配音批次不存在', 404);
    for (const operation of operations) if (operation.status === 'queued') studioRunner.cancel(operation.id);
    return operations.map(operation => publicStudio(studio.get(operation.id)));
  });
}
