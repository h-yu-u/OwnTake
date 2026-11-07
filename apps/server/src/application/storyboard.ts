import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { parseDraftOperations, parseShotFields } from '../../../../packages/domain/src/storyboard.ts';
import { integer, record, resourceId } from '../../../../packages/domain/src/validation.ts';
import type { ApplicationContext } from './context.ts';

type BoardContext = Pick<ApplicationContext, 'board'>;

export function addShot({ board }: BoardContext, id: string, value: unknown) {
  const body = record(value);
  return board.addShot(resourceId(id), parseShotFields(body.fields), integer(body.expectedBoardRevision, '分镜版本', 0, Number.MAX_SAFE_INTEGER));
}

export function updateShot({ board }: BoardContext, id: string, value: unknown) {
  const body = record(value);
  return board.updateShot(resourceId(id), parseShotFields(body.fields), integer(body.expectedShotRevision, '镜头版本', 1, Number.MAX_SAFE_INTEGER));
}

export function archiveShot({ board }: BoardContext, id: string, value: unknown) {
  const body = record(value);
  return board.archiveShot(resourceId(id), integer(body.expectedShotRevision, '镜头版本', 1, Number.MAX_SAFE_INTEGER));
}

export function reorderShots({ board }: BoardContext, id: string, value: unknown) {
  const body = record(value);
  invariant(Array.isArray(body.shotIds), 'INVALID_INPUT', '需要镜头顺序数组');
  return board.reorder(resourceId(id), body.shotIds.map(resourceId), integer(body.expectedBoardRevision, '分镜版本', 0, Number.MAX_SAFE_INTEGER));
}

export function addCandidate({ board }: BoardContext, id: string, value: unknown) {
  const body = record(value), shot = board.getShot(resourceId(id));
  return board.addCandidate({ projectId: shot.projectId, shotId: shot.id, visualRevision: shot.visualRevision, artifactId: resourceId(body.artifactId) });
}

export function selectCandidate({ board }: BoardContext, id: string, value: unknown) {
  const body = record(value);
  return board.selectCandidate(resourceId(id), resourceId(body.candidateId), integer(body.expectedShotRevision, '镜头版本', 1, Number.MAX_SAFE_INTEGER));
}

export function createDraft({ board }: BoardContext, id: string, value: unknown) {
  const body = record(value);
  return board.createDraft(resourceId(id), { operations: parseDraftOperations(body.operations), baseRevision: integer(body.baseRevision, '草稿基础版本', 0, Number.MAX_SAFE_INTEGER), source: 'manual' });
}

export function applyDraft({ board }: BoardContext, id: string, value: unknown) {
  const body = record(value);
  invariant(Array.isArray(body.acceptedOperationIds), 'INVALID_INPUT', '请选择接受的变更');
  return board.applyDraft(resourceId(id), body.acceptedOperationIds.map(resourceId), integer(body.expectedBoardRevision, '分镜版本', 0, Number.MAX_SAFE_INTEGER));
}
