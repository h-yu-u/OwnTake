import { randomUUID } from 'node:crypto';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { BoardSnapshot, Candidate, DraftOperation, Shot, ShotFields, StoryboardDraft } from '../../contracts/src/storyboard.ts';
import { classifyShotChanges, MAX_STORYBOARD_SHOTS, parseDraftOperations, parseShotFields } from '../../domain/src/storyboard.ts';
import type { Store } from './store.ts';
import { integer, json, parseJson, validateId } from './validation.ts';

export interface NewCandidate { projectId: string; shotId: string; visualRevision: number; artifactId: string; planId?: string | null }
export interface NewStoryboardDraft { operations: DraftOperation[]; baseRevision: number; source: 'manual' | 'model' }
type Row = Record<string, unknown>;

function shotFromRow(row: Row): Shot {
  return {
    ...parseJson<ShotFields>(row.fields_json), id: String(row.id), projectId: String(row.project_id), order: Number(row.position),
    revision: Number(row.revision), visualRevision: Number(row.visual_revision), captionRevision: Number(row.caption_revision), editRevision: Number(row.edit_revision),
    selectedArtifactId: row.selected_artifact_id === null ? null : String(row.selected_artifact_id),
    selectedVisualRevision: row.selected_visual_revision === null ? null : Number(row.selected_visual_revision),
    archived: row.archived === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function candidateFromRow(row: Row): Candidate {
  return { id: String(row.id), projectId: String(row.project_id), shotId: String(row.shot_id), visualRevision: Number(row.visual_revision), artifactId: String(row.artifact_id), planId: row.plan_id === null ? null : String(row.plan_id), createdAt: String(row.created_at) };
}

function draftFromRow(row: Row): StoryboardDraft {
  return { id: String(row.id), projectId: String(row.project_id), baseRevision: Number(row.base_revision), status: row.status as StoryboardDraft['status'], operations: parseJson(row.operations_json), acceptedOperationIds: parseJson(row.accepted_operation_ids_json), source: row.source as StoryboardDraft['source'], createdAt: String(row.created_at) };
}

function fieldsOf(shot: Shot): ShotFields {
  return { title: shot.title, purpose: shot.purpose, description: shot.description, action: shot.action, durationMs: shot.durationMs, caption: shot.caption, mode: shot.mode, referenceArtifactIds: shot.referenceArtifactIds };
}

/** Board edits, revision history and published events share the core SQLite transaction. */
export class StoryboardStore {
  private readonly store: Store;
  constructor(store: Store) { this.store = store; }

  private boardRevision(projectId: string): number {
    this.store.getProject(projectId);
    this.store.db.prepare('INSERT INTO boards(project_id,revision,updated_at) VALUES (?,0,?) ON CONFLICT(project_id) DO NOTHING').run(projectId, new Date().toISOString());
    return Number(this.store.db.prepare('SELECT revision FROM boards WHERE project_id=?').get(projectId)?.revision);
  }

  private expectBoard(projectId: string, expected: number): number {
    integer(expected, '期望分镜版本');
    const revision = this.boardRevision(projectId);
    invariant(revision === expected, 'REVISION_CONFLICT', '分镜已被更新，请重新读取后合并修改。', 409);
    return revision;
  }

  private bump(projectId: string, type: string, data: Record<string, unknown>): void {
    this.store.db.prepare('UPDATE boards SET revision=revision+1,updated_at=? WHERE project_id=?').run(new Date().toISOString(), projectId);
    this.store.appendEvent(projectId, type, { ...data, boardRevision: this.boardRevision(projectId) });
  }

  snapshot(projectId: string): BoardSnapshot {
    return this.store.transaction(() => ({
      projectId, revision: this.boardRevision(projectId),
      shots: this.store.db.prepare('SELECT * FROM shots WHERE project_id=? ORDER BY archived,position,created_at,id').all(projectId).map(shotFromRow),
      candidates: this.store.db.prepare('SELECT * FROM candidates WHERE project_id=? ORDER BY created_at,rowid').all(projectId).map(candidateFromRow),
      drafts: this.store.db.prepare('SELECT * FROM storyboard_drafts WHERE project_id=? ORDER BY created_at DESC,rowid DESC').all(projectId).map(draftFromRow),
    }));
  }

  getShot(id: string): Shot {
    validateId(id);
    const row = this.store.db.prepare('SELECT * FROM shots WHERE id=?').get(id);
    if (!row) throw new AppError('SHOT_NOT_FOUND', '镜头不存在。', 404);
    return shotFromRow(row);
  }

  getShotRevision(id: string, revision: number): Shot {
    integer(revision, '镜头版本', 1);
    const current = this.getShot(id);
    if (current.revision === revision) return current;
    const row = this.store.db.prepare('SELECT body_json FROM shot_revisions WHERE shot_id=? AND revision=?').get(id, revision);
    if (!row) throw new AppError('SHOT_REVISION_NOT_FOUND', '镜头修订不存在。', 404);
    return parseJson<Shot>(row.body_json);
  }

  getCandidate(id: string): Candidate {
    validateId(id);
    const row = this.store.db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
    if (!row) throw new AppError('CANDIDATE_NOT_FOUND', '候选不存在。', 404);
    return candidateFromRow(row);
  }

  getDraft(id: string): StoryboardDraft {
    validateId(id);
    const row = this.store.db.prepare('SELECT * FROM storyboard_drafts WHERE id=?').get(id);
    if (!row) throw new AppError('DRAFT_NOT_FOUND', '分镜草稿不存在。', 404);
    return draftFromRow(row);
  }

  private activeShot(id: string, expectedRevision?: number): Shot {
    const shot = this.getShot(id);
    invariant(!shot.archived, 'SHOT_ARCHIVED', '镜头已经归档，不能继续编辑或选择素材。', 409);
    if (expectedRevision !== undefined) {
      integer(expectedRevision, '期望镜头版本', 1);
      invariant(shot.revision === expectedRevision, 'REVISION_CONFLICT', '镜头已被更新，请重新读取后合并修改。', 409);
    }
    return shot;
  }

  private references(projectId: string, fields: ShotFields): void {
    for (const referenceId of fields.referenceArtifactIds) {
      const reference = this.store.getArtifact(referenceId);
      invariant(reference.projectId === projectId, 'INVALID_REFERENCE', '参考素材必须属于当前项目。');
    }
  }

  private checkSize(projectId: string): void {
    const count = Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM shots WHERE project_id=? AND archived=0').get(projectId)?.count);
    invariant(count <= MAX_STORYBOARD_SHOTS, 'STORYBOARD_LIMIT', '一个分镜最多保留 100 个活动镜头。');
  }

  private insertShot(projectId: string, fields: ShotFields): Shot {
    this.references(projectId, fields);
    const id = `shot_${randomUUID()}`;
    const order = Number(this.store.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM shots WHERE project_id=? AND archived=0').get(projectId)?.position);
    const now = new Date().toISOString();
    this.store.db.prepare(`INSERT INTO shots(id,project_id,position,fields_json,revision,visual_revision,caption_revision,edit_revision,selected_artifact_id,selected_visual_revision,archived,created_at,updated_at)
      VALUES (?,?,?,?,1,1,1,1,NULL,NULL,0,?,?)`).run(id, projectId, order, json(fields), now, now);
    return this.getShot(id);
  }

  private persistRevision(current: Shot, next: Shot): void {
    this.store.db.prepare('INSERT INTO shot_revisions(shot_id,project_id,revision,visual_revision,body_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(current.id, current.projectId, current.revision, current.visualRevision, json(current), new Date().toISOString());
    const changed = this.store.db.prepare(`UPDATE shots SET position=?,fields_json=?,revision=?,visual_revision=?,caption_revision=?,edit_revision=?,selected_artifact_id=?,selected_visual_revision=?,archived=?,updated_at=? WHERE id=? AND revision=?`)
      .run(next.order, json(fieldsOf(next)), next.revision, next.visualRevision, next.captionRevision, next.editRevision, next.selectedArtifactId, next.selectedVisualRevision, Number(next.archived), next.updatedAt, current.id, current.revision);
    invariant(Number(changed.changes) === 1, 'REVISION_CONFLICT', '镜头已被更新，请重新读取。', 409);
  }

  private replaceFields(current: Shot, fields: ShotFields): void {
    this.references(current.projectId, fields);
    const changed = classifyShotChanges(current, fields);
    this.persistRevision(current, { ...current, ...fields, revision: current.revision + 1, visualRevision: current.visualRevision + Number(changed.visual), captionRevision: current.captionRevision + Number(changed.caption), editRevision: current.editRevision + Number(changed.edit), updatedAt: new Date().toISOString() });
  }

  private archive(current: Shot): void {
    this.persistRevision(current, { ...current, archived: true, revision: current.revision + 1, editRevision: current.editRevision + 1, updatedAt: new Date().toISOString() });
  }

  addShot(projectId: string, input: ShotFields, expectedBoardRevision: number): BoardSnapshot {
    const fields = parseShotFields(input);
    return this.store.transaction(() => {
      this.expectBoard(projectId, expectedBoardRevision);
      const shot = this.insertShot(projectId, fields);
      this.checkSize(projectId);
      this.bump(projectId, 'storyboard.shot_added', { shotId: shot.id });
      return this.snapshot(projectId);
    });
  }

  updateShot(shotId: string, input: ShotFields, expectedShotRevision: number): BoardSnapshot {
    integer(expectedShotRevision, '期望镜头版本', 1);
    const fields = parseShotFields(input);
    return this.store.transaction(() => {
      const current = this.activeShot(shotId, expectedShotRevision);
      this.replaceFields(current, fields);
      this.bump(current.projectId, 'storyboard.shot_updated', { shotId, shotRevision: current.revision + 1 });
      return this.snapshot(current.projectId);
    });
  }

  archiveShot(shotId: string, expectedShotRevision: number): BoardSnapshot {
    integer(expectedShotRevision, '期望镜头版本', 1);
    return this.store.transaction(() => {
      const current = this.activeShot(shotId, expectedShotRevision);
      this.archive(current);
      this.bump(current.projectId, 'storyboard.shot_archived', { shotId });
      return this.snapshot(current.projectId);
    });
  }

  reorder(projectId: string, shotIds: string[], expectedBoardRevision: number): BoardSnapshot {
    invariant(Array.isArray(shotIds) && shotIds.length <= MAX_STORYBOARD_SHOTS, 'INVALID_STORYBOARD', '镜头顺序必须是有界标识列表。');
    for (const id of shotIds) validateId(id);
    invariant(new Set(shotIds).size === shotIds.length, 'INVALID_STORYBOARD', '镜头顺序不能包含重复项。');
    return this.store.transaction(() => {
      this.expectBoard(projectId, expectedBoardRevision);
      const current = this.store.db.prepare('SELECT * FROM shots WHERE project_id=? AND archived=0').all(projectId).map(shotFromRow);
      const byId = new Map(current.map(shot => [shot.id, shot]));
      invariant(current.length === shotIds.length && shotIds.every(id => byId.has(id)), 'INVALID_REFERENCE', '重排必须恰好包含当前项目的全部活动镜头。');
      shotIds.forEach((id, order) => {
        const shot = byId.get(id)!;
        if (shot.order !== order) this.persistRevision(shot, { ...shot, order, revision: shot.revision + 1, editRevision: shot.editRevision + 1, updatedAt: new Date().toISOString() });
      });
      this.bump(projectId, 'storyboard.reordered', { shotIds });
      return this.snapshot(projectId);
    });
  }

  addCandidate(input: NewCandidate): Candidate {
    invariant(input && typeof input === 'object' && Object.keys(input).every(key => ['projectId', 'shotId', 'visualRevision', 'artifactId', 'planId'].includes(key)), 'INVALID_STORYBOARD', '候选包含不允许的字段。');
    validateId(input.projectId); validateId(input.shotId); validateId(input.artifactId); integer(input.visualRevision, '候选视觉版本', 1);
    const planId = input.planId ?? null;
    if (planId !== null) validateId(planId);
    return this.store.transaction(() => {
      const shot = this.getShot(input.shotId);
      const artifact = this.store.getArtifact(input.artifactId);
      invariant(shot.projectId === input.projectId && artifact.projectId === input.projectId, 'INVALID_REFERENCE', '候选镜头和素材必须属于同一项目。');
      invariant(artifact.kind === 'image' || artifact.kind === 'video', 'INVALID_REFERENCE', '画面候选只能使用图片或视频。');
      invariant(input.visualRevision <= shot.visualRevision, 'REVISION_CONFLICT', '候选不能引用尚不存在的视觉要求版本。', 409);
      const existing = this.store.db.prepare('SELECT * FROM candidates WHERE shot_id=? AND visual_revision=? AND artifact_id=?').get(input.shotId, input.visualRevision, input.artifactId);
      if (existing) {
        invariant(existing.plan_id === planId, 'CANDIDATE_CONFLICT', '同一候选的来源计划不能改写。', 409);
        return candidateFromRow(existing);
      }
      const id = `candidate_${randomUUID()}`;
      this.store.db.prepare('INSERT INTO candidates(id,project_id,shot_id,visual_revision,artifact_id,plan_id,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, input.projectId, input.shotId, input.visualRevision, input.artifactId, planId, new Date().toISOString());
      this.store.appendEvent(input.projectId, 'storyboard.candidate_added', { candidateId: id, shotId: input.shotId, visualRevision: input.visualRevision });
      return this.getCandidate(id);
    });
  }

  selectCandidate(shotId: string, candidateId: string, expectedShotRevision: number): BoardSnapshot {
    integer(expectedShotRevision, '期望镜头版本', 1);
    return this.store.transaction(() => {
      const current = this.activeShot(shotId, expectedShotRevision);
      const candidate = this.getCandidate(candidateId);
      invariant(candidate.shotId === shotId && candidate.projectId === current.projectId, 'INVALID_REFERENCE', '不能选择其他镜头的候选。');
      this.persistRevision(current, { ...current, selectedArtifactId: candidate.artifactId, selectedVisualRevision: candidate.visualRevision, revision: current.revision + 1, editRevision: current.editRevision + 1, updatedAt: new Date().toISOString() });
      this.bump(current.projectId, 'storyboard.candidate_selected', { shotId, candidateId, selectedVisualRevision: candidate.visualRevision });
      return this.snapshot(current.projectId);
    });
  }

  private operationReferences(projectId: string, operations: DraftOperation[]): void {
    for (const operation of operations) {
      if (operation.shotId) invariant(this.getShot(operation.shotId).projectId === projectId, 'INVALID_REFERENCE', '草稿不能修改其他项目的镜头。');
      if (operation.fields) this.references(projectId, operation.fields);
    }
  }

  createDraft(projectId: string, input: NewStoryboardDraft): StoryboardDraft {
    invariant(input && typeof input === 'object' && Object.keys(input).every(key => ['operations', 'baseRevision', 'source'].includes(key)), 'INVALID_STORYBOARD', '草稿包含不允许的字段。');
    integer(input.baseRevision, '草稿基准版本');
    invariant(input.source === 'manual' || input.source === 'model', 'INVALID_STORYBOARD', '草稿来源无效。');
    const operations = parseDraftOperations(input.operations);
    return this.store.transaction(() => {
      const revision = this.boardRevision(projectId);
      invariant(input.baseRevision <= revision, 'REVISION_CONFLICT', '草稿不能基于尚不存在的分镜版本。', 409);
      this.operationReferences(projectId, operations);
      const id = `draft_${randomUUID()}`;
      this.store.db.prepare("INSERT INTO storyboard_drafts(id,project_id,base_revision,status,operations_json,accepted_operation_ids_json,source,created_at) VALUES (?,?,?,'pending',?,'[]',?,?)")
        .run(id, projectId, input.baseRevision, json(operations), input.source, new Date().toISOString());
      this.store.appendEvent(projectId, 'storyboard.draft_created', { draftId: id, baseRevision: input.baseRevision });
      return this.getDraft(id);
    });
  }

  applyDraft(draftId: string, acceptedOperationIds: string[], expectedBoardRevision: number): BoardSnapshot {
    invariant(Array.isArray(acceptedOperationIds) && acceptedOperationIds.length <= 100, 'INVALID_STORYBOARD', '接受的草稿操作必须是有界列表。');
    for (const id of acceptedOperationIds) validateId(id);
    invariant(new Set(acceptedOperationIds).size === acceptedOperationIds.length, 'INVALID_STORYBOARD', '接受的草稿操作不能重复。');
    return this.store.transaction(() => {
      const draft = this.getDraft(draftId);
      invariant(draft.status === 'pending', 'DRAFT_ALREADY_APPLIED', '这份草稿已经审阅应用，不能重复执行。', 409);
      const revision = this.expectBoard(draft.projectId, expectedBoardRevision);
      invariant(draft.baseRevision === revision, 'REVISION_CONFLICT', '草稿基于旧的分镜版本，请重新生成或手工合并。', 409);
      const operations = parseDraftOperations(draft.operations);
      const available = new Set(operations.map(operation => operation.id));
      invariant(acceptedOperationIds.every(id => available.has(id)), 'INVALID_STORYBOARD', '接受列表包含不属于此草稿的操作。');
      const accepted = new Set(acceptedOperationIds);
      for (const operation of operations) {
        if (!accepted.has(operation.id)) continue;
        if (operation.kind === 'add') this.insertShot(draft.projectId, operation.fields!);
        else {
          const current = this.activeShot(operation.shotId!);
          invariant(current.projectId === draft.projectId, 'INVALID_REFERENCE', '草稿不能修改其他项目的镜头。');
          if (operation.kind === 'update') this.replaceFields(current, operation.fields!);
          else this.archive(current);
        }
      }
      this.checkSize(draft.projectId);
      const acceptedIds = operations.filter(operation => accepted.has(operation.id)).map(operation => operation.id);
      this.store.db.prepare("UPDATE storyboard_drafts SET status='applied',accepted_operation_ids_json=? WHERE id=? AND status='pending'").run(json(acceptedIds), draftId);
      this.bump(draft.projectId, 'storyboard.draft_applied', { draftId, acceptedOperationIds: acceptedIds });
      return this.snapshot(draft.projectId);
    });
  }
}
