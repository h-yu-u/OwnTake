import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './routes.ts';
import { parseShotFields, parseDraftOperations } from '../../../packages/domain/src/storyboard.ts';
import { invariant } from '../../../packages/contracts/src/errors.ts';
import { integer, record, resourceId } from '../../../packages/domain/src/validation.ts';
import { json, jsonBody } from './http.ts';
import { resolveAsset } from './assets.ts';
import type { TimelineDraft } from '../../../packages/contracts/src/index.ts';
export async function storyboardRoutes(request: IncomingMessage, response: ServerResponse, url: URL, context: RouteContext): Promise<boolean> {
  const { store, board } = context, method = request.method, path = url.pathname;
  const get = /^\/api\/projects\/([^/]+)\/storyboard$/.exec(path);
  if (get && method === 'GET') { json(response, board.snapshot(resourceId(get[1]))); return true; }
  const create = /^\/api\/projects\/([^/]+)\/shots$/.exec(path);
  if (create && method === 'POST') { const b = record(await jsonBody(request)); json(response, board.addShot(resourceId(create[1]), parseShotFields(b.fields), integer(b.expectedBoardRevision, '分镜版本', 0, Number.MAX_SAFE_INTEGER)), 201); return true; }
  const edit = /^\/api\/shots\/([^/]+)$/.exec(path);
  if (edit && method === 'PUT') { const b = record(await jsonBody(request)); json(response, board.updateShot(resourceId(edit[1]), parseShotFields(b.fields), integer(b.expectedShotRevision, '镜头版本', 1, Number.MAX_SAFE_INTEGER))); return true; }
  const archive = /^\/api\/shots\/([^/]+)\/archive$/.exec(path);
  if (archive && method === 'POST') { const b = record(await jsonBody(request)); json(response, board.archiveShot(resourceId(archive[1]), integer(b.expectedShotRevision, '镜头版本', 1, Number.MAX_SAFE_INTEGER))); return true; }
  const reorder = /^\/api\/projects\/([^/]+)\/shots\/reorder$/.exec(path);
  if (reorder && method === 'POST') { const b = record(await jsonBody(request)); invariant(Array.isArray(b.shotIds), 'INVALID_INPUT', '需要镜头顺序数组'); json(response, board.reorder(resourceId(reorder[1]), b.shotIds.map(resourceId), integer(b.expectedBoardRevision, '分镜版本', 0, Number.MAX_SAFE_INTEGER))); return true; }
  const candidate = /^\/api\/shots\/([^/]+)\/candidates$/.exec(path);
  if (candidate && method === 'POST') { const b = record(await jsonBody(request)), shot = board.getShot(resourceId(candidate[1])); json(response, board.addCandidate({ projectId: shot.projectId, shotId: shot.id, visualRevision: shot.visualRevision, artifactId: resourceId(b.artifactId) }), 201); return true; }
  const select = /^\/api\/shots\/([^/]+)\/select$/.exec(path);
  if (select && method === 'POST') { const b = record(await jsonBody(request)); json(response, board.selectCandidate(resourceId(select[1]), resourceId(b.candidateId), integer(b.expectedShotRevision, '镜头版本', 1, Number.MAX_SAFE_INTEGER))); return true; }
  const draft = /^\/api\/projects\/([^/]+)\/drafts$/.exec(path);
  if (draft && method === 'POST') { const b = record(await jsonBody(request)); json(response, board.createDraft(resourceId(draft[1]), { operations: parseDraftOperations(b.operations), baseRevision: integer(b.baseRevision, '草稿基础版本', 0, Number.MAX_SAFE_INTEGER), source: 'manual' }), 201); return true; }
  const apply = /^\/api\/drafts\/([^/]+)\/apply$/.exec(path);
  if (apply && method === 'POST') { const b = record(await jsonBody(request)); invariant(Array.isArray(b.acceptedOperationIds), 'INVALID_INPUT', '请选择接受的变更'); json(response, board.applyDraft(resourceId(apply[1]), b.acceptedOperationIds.map(resourceId), integer(b.expectedBoardRevision, '分镜版本', 0, Number.MAX_SAFE_INTEGER))); return true; }
  const timeline = /^\/api\/projects\/([^/]+)\/storyboard\/timeline$/.exec(path);
  if (timeline && method === 'POST') {
    const projectId = resourceId(timeline[1]), b = record(await jsonBody(request)), snapshot = board.snapshot(projectId), project = store.getProject(projectId);
    const shots = snapshot.shots.filter(s => !s.archived).sort((a, b) => a.order - b.order);
    invariant(shots.length > 0, 'EMPTY_STORYBOARD', '请先创建镜头');
    const size = project.ratio === '9:16' ? [720,1280] : project.ratio === '1:1' ? [720,720] : [1280,720];
    const clips: TimelineDraft['clips'] = [];
    for (const shot of shots) {
      invariant(shot.selectedArtifactId, 'MISSING_SELECTION', `镜头「${shot.title}」尚未选择素材`, 409);
      const { artifact } = await resolveAsset(store, shot.selectedArtifactId);
      invariant(artifact.kind !== 'audio' && artifact.projectId === projectId, 'INVALID_ASSET', '所选画面素材不合法');
      invariant(artifact.kind === 'image' || shot.durationMs <= artifact.media.durationMs + 100, 'INVALID_RANGE', `镜头「${shot.title}」时长超过素材，请先调整镜头时长`, 409);
      clips.push({ artifactId: artifact.id, sourceInMs: 0, durationMs: shot.durationMs, fit: 'contain', muteSource: false, shotId: shot.id });
    }
    invariant(board.snapshot(projectId).revision === snapshot.revision, 'REVISION_CONFLICT', '分镜在保存期间已改变，请重试', 409);
    json(response, store.saveTimeline(projectId, { width: size[0]!, height: size[1]!, fps: 24, clips, captions: [], audio: [] }, integer(b.expectedVersion, '时间线版本', 0, Number.MAX_SAFE_INTEGER))); return true;
  }
  return false;
}
