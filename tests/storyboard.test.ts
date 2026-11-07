import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError } from '../packages/contracts/src/errors.ts';
import type { Artifact } from '../packages/contracts/src/index.ts';
import type { ShotFields } from '../packages/contracts/src/storyboard.ts';
import { parseDraftOperations, parseShotFields } from '../packages/domain/src/storyboard.ts';
import { Store, restoreBackup, SCHEMA_VERSION } from '../packages/storage/src/index.ts';
import { createBackup } from '../packages/storage/src/backup.ts';
import { StoryboardStore } from '../packages/storage/src/storyboard.ts';

const fields: ShotFields = { title: '开场', purpose: '建立地点', description: '清晨的城市街道', action: '镜头缓慢推进', durationMs: 4000, caption: '新的开始', mode: 'import', referenceArtifactIds: [] };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'owntake-board-'));
  const options = { dataDir: join(root, 'data'), projectsDir: join(root, 'projects') };
  const store = new Store(options);
  const board = new StoryboardStore(store);
  const project = store.createProject({ name: '分镜测试' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, options, store, board, project };
}

function errorCode(code: string, status?: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && (status === undefined || error.status === status);
}

function asset(store: Store, projectId: string, kind: 'image' | 'audio' = 'image'): Artifact {
  const id = `artifact_${randomUUID()}`;
  const relativePath = `assets/${id}/original.${kind === 'image' ? 'png' : 'wav'}`;
  const file = join(store.getProjectDir(projectId), relativePath);
  const bytes = Buffer.from(`media fixture ${id}`);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
  return store.addArtifact({
    id, projectId, name: `参考.${kind === 'image' ? 'png' : 'wav'}`, kind, relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, source: 'import', metadata: {},
    media: kind === 'image'
      ? { kind, durationMs: 0, width: 1280, height: 720, hasAudio: false, format: 'png' }
      : { kind, durationMs: 5000, hasAudio: true, format: 'wav' },
  });
}

test('strict storyboard schemas reject arbitrary commands, unknown fields, partial fields and ambiguous operations', () => {
  assert.equal(parseShotFields(fields).title, fields.title);
  assert.throws(() => parseShotFields({ ...fields, command: 'rm -rf /' }), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseShotFields({ title: 'partial' }), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseShotFields({ ...fields, durationMs: Number.NaN }), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseShotFields({ ...fields, referenceArtifactIds: ['artifact_a', 'artifact_a'] }), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseDraftOperations([{ id: 'op_a', kind: 'execute', fields }]), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseDraftOperations([{ id: 'op_a', kind: 'add', fields, tool: 'shell' }]), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseDraftOperations([{ id: 'op_a', kind: 'add', fields, shotId: 'shot_a' }]), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseDraftOperations([{ id: 'op_a', kind: 'delete', shotId: 'shot_a', fields }]), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseDraftOperations([{ id: 'op_a', kind: 'update', shotId: 'shot_a', fields }, { id: 'op_b', kind: 'delete', shotId: 'shot_a' }]), errorCode('INVALID_STORYBOARD'));
  assert.throws(() => parseDraftOperations([{ id: 'op_a', kind: 'add', fields }, { id: 'op_a', kind: 'add', fields }]), errorCode('INVALID_STORYBOARD'));
});

test('caption, visual and edit changes advance only their own dependency revisions and preserve old shot snapshots', t => {
  const { store, board, project } = fixture(t);
  assert.equal(board.snapshot(project.id).revision, 0);
  const first = board.addShot(project.id, fields, 0).shots[0]!;
  assert.deepEqual([first.revision, first.visualRevision, first.captionRevision, first.editRevision], [1, 1, 1, 1]);
  board.updateShot(first.id, { ...fields, caption: '字幕改写' }, 1);
  const caption = board.getShot(first.id);
  assert.deepEqual([caption.revision, caption.visualRevision, caption.captionRevision, caption.editRevision], [2, 1, 2, 1]);
  board.updateShot(first.id, { ...fields, caption: '字幕改写', title: '新的标题', durationMs: 6000 }, 2);
  const edit = board.getShot(first.id);
  assert.deepEqual([edit.revision, edit.visualRevision, edit.captionRevision, edit.editRevision], [3, 1, 2, 2]);
  const reference = asset(store, project.id);
  board.updateShot(first.id, { ...fields, caption: '字幕改写', title: '新的标题', durationMs: 6000, purpose: '展示人物', description: '阳光下的人群', action: '跟随主人公', mode: 'generate_video', referenceArtifactIds: [reference.id] }, 3);
  const visual = board.getShot(first.id);
  assert.deepEqual([visual.revision, visual.visualRevision, visual.captionRevision, visual.editRevision], [4, 2, 2, 2]);
  assert.deepEqual(board.getShotRevision(first.id, 1), first);
  assert.deepEqual(board.getShotRevision(first.id, 2), caption);
  assert.deepEqual(board.getShotRevision(first.id, 3), edit);
  assert.equal(board.snapshot(project.id).revision, 4);
});

test('candidate provenance is immutable and old visual candidates remain explicitly old after a visual edit or late arrival', t => {
  const { store, board, project } = fixture(t);
  const media = asset(store, project.id);
  const shot = board.addShot(project.id, fields, 0).shots[0]!;
  const candidate = board.addCandidate({ projectId: project.id, shotId: shot.id, visualRevision: 1, artifactId: media.id, planId: 'plan_v1' });
  assert.equal(board.snapshot(project.id).revision, 1);
  board.selectCandidate(shot.id, candidate.id, 1);
  board.updateShot(shot.id, { ...fields, description: '改为夜景' }, 2);
  const changed = board.getShot(shot.id);
  assert.equal(changed.visualRevision, 2);
  assert.equal(changed.selectedArtifactId, media.id);
  assert.equal(changed.selectedVisualRevision, 1);
  assert.deepEqual(board.addCandidate({ projectId: project.id, shotId: shot.id, visualRevision: 1, artifactId: media.id, planId: 'plan_v1' }), candidate);
  assert.throws(() => board.addCandidate({ projectId: project.id, shotId: shot.id, visualRevision: 1, artifactId: media.id, planId: 'plan_v2' }), errorCode('CANDIDATE_CONFLICT', 409));
  board.selectCandidate(shot.id, candidate.id, changed.revision);
  assert.equal(board.getShot(shot.id).selectedVisualRevision, 1);
  assert.deepEqual(board.getCandidate(candidate.id), candidate);
  assert.equal(board.snapshot(project.id).candidates.length, 1);
});

test('references, candidate selection and reorder stay within the project and reject audio as visual candidates', t => {
  const { store, board, project } = fixture(t);
  const other = store.createProject({ name: '其他项目' });
  const otherMedia = asset(store, other.id);
  const audio = asset(store, project.id, 'audio');
  assert.throws(() => board.addShot(project.id, { ...fields, referenceArtifactIds: [otherMedia.id] }, 0), errorCode('INVALID_REFERENCE'));
  const first = board.addShot(project.id, fields, 0).shots[0]!;
  const second = board.addShot(other.id, fields, 0).shots[0]!;
  assert.throws(() => board.addCandidate({ projectId: project.id, shotId: first.id, visualRevision: 1, artifactId: otherMedia.id }), errorCode('INVALID_REFERENCE'));
  assert.throws(() => board.addCandidate({ projectId: project.id, shotId: first.id, visualRevision: 1, artifactId: audio.id }), errorCode('INVALID_REFERENCE'));
  const media = asset(store, project.id);
  assert.throws(() => board.addCandidate({ projectId: project.id, shotId: first.id, visualRevision: 2, artifactId: media.id }), errorCode('REVISION_CONFLICT', 409));
  const candidate = board.addCandidate({ projectId: other.id, shotId: second.id, visualRevision: 1, artifactId: otherMedia.id });
  assert.throws(() => board.selectCandidate(first.id, candidate.id, 1), errorCode('INVALID_REFERENCE'));
  assert.throws(() => board.reorder(project.id, [second.id], 1), errorCode('INVALID_REFERENCE'));
  assert.throws(() => board.createDraft(project.id, { baseRevision: 1, source: 'model', operations: [{ id: 'op_cross', kind: 'delete', shotId: second.id }] }), errorCode('INVALID_REFERENCE'));
  assert.equal(board.snapshot(project.id).revision, 1);
});

test('partial draft acceptance performs only selected changes once and advances the board once', t => {
  const { board, project } = fixture(t);
  const first = board.addShot(project.id, fields, 0).shots[0]!;
  const second = board.addShot(project.id, { ...fields, title: '保留镜头' }, 1).shots[1]!;
  const draft = board.createDraft(project.id, {
    baseRevision: 2, source: 'model', operations: [
      { id: 'op_add', kind: 'add', fields: { ...fields, title: '接受的新镜头' } },
      { id: 'op_skip', kind: 'add', fields: { ...fields, title: '拒绝的新镜头' } },
      { id: 'op_edit', kind: 'update', shotId: first.id, fields: { ...fields, caption: '接受的字幕' } },
      { id: 'op_delete', kind: 'delete', shotId: second.id },
    ],
  });
  assert.equal(board.snapshot(project.id).revision, 2);
  const result = board.applyDraft(draft.id, ['op_edit', 'op_add'], 2);
  assert.equal(result.revision, 3);
  assert.equal(result.shots.length, 3);
  assert.equal(result.shots.filter(shot => shot.title === '拒绝的新镜头').length, 0);
  assert.equal(board.getShot(first.id).caption, '接受的字幕');
  assert.equal(board.getShot(second.id).archived, false);
  assert.deepEqual(board.getDraft(draft.id).acceptedOperationIds, ['op_add', 'op_edit']);
  assert.equal(board.getDraft(draft.id).status, 'applied');
  assert.throws(() => board.applyDraft(draft.id, ['op_add'], 3), errorCode('DRAFT_ALREADY_APPLIED', 409));
  assert.equal(board.snapshot(project.id).shots.length, 3);
});

test('drafts based on old revisions stay reviewable but cannot overwrite newer edits', t => {
  const { board, project } = fixture(t);
  const shot = board.addShot(project.id, fields, 0).shots[0]!;
  const old = board.createDraft(project.id, { baseRevision: 1, source: 'model', operations: [{ id: 'op_edit', kind: 'update', shotId: shot.id, fields: { ...fields, title: '模型旧建议' } }] });
  board.updateShot(shot.id, { ...fields, title: '用户新修改' }, 1);
  const before = board.snapshot(project.id);
  assert.throws(() => board.applyDraft(old.id, ['op_edit'], 2), errorCode('REVISION_CONFLICT', 409));
  assert.deepEqual(board.snapshot(project.id), before);
  const late = board.createDraft(project.id, { baseRevision: 1, source: 'model', operations: [{ id: 'op_late', kind: 'add', fields }] });
  assert.equal(late.baseRevision, 1);
  assert.throws(() => board.applyDraft(late.id, ['op_late'], 2), errorCode('REVISION_CONFLICT', 409));
  assert.equal(board.getShot(shot.id).title, '用户新修改');
});

test('interruption during apply rolls back shots, revision history, accepted state and emitted events together', t => {
  const { store, board, project } = fixture(t);
  const shot = board.addShot(project.id, fields, 0).shots[0]!;
  const draft = board.createDraft(project.id, { baseRevision: 1, source: 'manual', operations: [{ id: 'op_add', kind: 'add', fields }, { id: 'op_edit', kind: 'update', shotId: shot.id, fields: { ...fields, caption: '尚未提交' } }] });
  const before = board.snapshot(project.id);
  const eventCursor = store.getEventCursor();
  store.db.exec("CREATE TEMP TRIGGER fail_draft_apply BEFORE UPDATE ON storyboard_drafts BEGIN SELECT RAISE(ABORT, 'simulate interruption'); END;");
  assert.throws(() => board.applyDraft(draft.id, ['op_add', 'op_edit'], 1), /simulate interruption/);
  assert.deepEqual(board.snapshot(project.id), before);
  assert.equal(store.getEventCursor(), eventCursor);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM shot_revisions').get()?.count, 0);
  store.db.exec('DROP TRIGGER fail_draft_apply');
  assert.equal(board.applyDraft(draft.id, ['op_add', 'op_edit'], 1).shots.length, 2);
});

test('archiving preserves shots, historical revisions and candidates; reordering only changes edit dependencies', t => {
  const { store, board, project } = fixture(t);
  const first = board.addShot(project.id, fields, 0).shots[0]!;
  const second = board.addShot(project.id, { ...fields, title: '第二镜' }, 1).shots[1]!;
  const candidate = board.addCandidate({ projectId: project.id, shotId: first.id, visualRevision: 1, artifactId: asset(store, project.id).id });
  board.reorder(project.id, [second.id, first.id], 2);
  const reordered = board.getShot(first.id);
  assert.deepEqual([reordered.order, reordered.revision, reordered.visualRevision, reordered.captionRevision, reordered.editRevision], [1, 2, 1, 1, 2]);
  const result = board.archiveShot(first.id, 2);
  assert.equal(result.revision, 4);
  assert.equal(result.shots.length, 2);
  assert.equal(board.getShot(first.id).archived, true);
  assert.deepEqual(board.getShotRevision(first.id, 1), first);
  assert.deepEqual(board.getCandidate(candidate.id), candidate);
  assert.throws(() => board.updateShot(first.id, fields, 3), errorCode('SHOT_ARCHIVED', 409));
  assert.throws(() => board.selectCandidate(first.id, candidate.id, 3), errorCode('SHOT_ARCHIVED', 409));
  assert.equal(board.reorder(project.id, [second.id], 4).revision, 5);
});

test('optimistic mutation conflicts leave the board and event cursor unchanged', t => {
  const { store, board, project } = fixture(t);
  const shot = board.addShot(project.id, fields, 0).shots[0]!;
  const before = board.snapshot(project.id);
  const cursor = store.getEventCursor();
  assert.throws(() => board.addShot(project.id, fields, 0), errorCode('REVISION_CONFLICT', 409));
  assert.throws(() => board.updateShot(shot.id, fields, 2), errorCode('REVISION_CONFLICT', 409));
  assert.throws(() => board.updateShot(shot.id, fields, undefined as unknown as number), errorCode('INVALID_INPUT'));
  assert.throws(() => board.archiveShot(shot.id, 2), errorCode('REVISION_CONFLICT', 409));
  assert.throws(() => board.reorder(project.id, [shot.id], 0), errorCode('REVISION_CONFLICT', 409));
  assert.deepEqual(board.snapshot(project.id), before);
  assert.equal(store.getEventCursor(), cursor);
});

test('a full board backup restores candidate provenance, pending drafts and immutable shot history', async t => {
  const { store, root, board, project } = fixture(t);
  const media = asset(store, project.id);
  const shot = board.addShot(project.id, fields, 0).shots[0]!;
  const candidate = board.addCandidate({ projectId: project.id, shotId: shot.id, visualRevision: 1, artifactId: media.id, planId: 'plan_original' });
  board.selectCandidate(shot.id, candidate.id, 1);
  board.updateShot(shot.id, { ...fields, description: '仍需生成的新画面' }, 2);
  board.createDraft(project.id, { baseRevision: 3, source: 'model', operations: [{ id: 'op_pending', kind: 'add', fields }] });
  const expected = board.snapshot(project.id);
  const backup = join(root, 'board-backup');
  await store.backupTo(backup);
  const target = { dataDir: join(root, 'board-restored-data'), projectsDir: join(root, 'board-restored-projects') };
  await restoreBackup(backup, target);
  const restored = new Store(target);
  try {
    const restoredBoard = new StoryboardStore(restored);
    assert.deepEqual(restoredBoard.snapshot(project.id), expected);
    assert.deepEqual(restoredBoard.getShotRevision(shot.id, 1), shot);
    assert.equal(restoredBoard.getShot(shot.id).selectedVisualRevision, 1);
    assert.equal(restoredBoard.getShot(shot.id).visualRevision, 2);
  } finally { restored.close(); }
});

test('version 1 data and backups upgrade transactionally to the current schema without losing projects or artifacts', async t => {
  const { store, root, options, project } = fixture(t);
  const media = asset(store, project.id);
  const job = store.createJob({ projectId: project.id, type: 'render', payload: {}, dedupeKey: 'legacy-job' });
  // Recreate the exact P1 table set, retaining actual P1 records, constraints and files.
  store.db.exec('DROP TABLE library_shot_cast;');
  store.db.exec('DROP TABLE library_project_roles; DROP TABLE library_character_looks; DROP TABLE library_character_visuals; DROP TABLE library_characters;');
  store.db.exec('DROP TABLE library_story_projects; DROP TABLE library_script_versions; DROP TABLE library_story_versions; DROP TABLE library_stories;');
  store.db.exec('DROP TABLE studio_receipts; DROP TABLE studio_frames; DROP TABLE studio_operations; DROP TABLE runtime_profiles; DROP TABLE reviews; DROP TABLE generations;');
  store.db.exec('DROP TABLE storyboard_drafts; DROP TABLE candidates; DROP TABLE shot_revisions; DROP TABLE shots; DROP TABLE boards; DROP TABLE provider_calls; DROP TABLE provider_profiles; DROP INDEX artifacts_identity_project; PRAGMA user_version=1;');
  assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), ['artifacts', 'events', 'jobs', 'projects', 'settings', 'timelines']);
  const backup = join(root, 'legacy-backup');
  const manifest = await createBackup({ db: store.db, dataDir: store.dataDir, projectsDir: store.projectsDir, schemaVersion: 1 }, backup);
  assert.equal(manifest.schemaVersion, 1);
  store.close();
  const migrated = new Store(options);
  try {
    assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
    assert.equal(migrated.getArtifact(media.id).sha256, media.sha256);
    assert.equal(migrated.getJob(job.id).status, 'queued');
    assert.equal(new StoryboardStore(migrated).snapshot(project.id).revision, 0);
    assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM provider_calls').get()?.count, 0);
  } finally { migrated.close(); }
  const manifestPath = join(backup, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: SCHEMA_VERSION }));
  const target = { dataDir: join(root, 'restored-data'), projectsDir: join(root, 'restored-projects') };
  await assert.rejects(() => restoreBackup(backup, target), errorCode('BACKUP_VERSION', 409));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await restoreBackup(backup, target);
  const restored = new Store(target);
  try {
    assert.equal(restored.schemaVersion, SCHEMA_VERSION);
    assert.equal(restored.getProject(project.id).name, project.name);
    assert.deepEqual(readFileSync(restored.resolveArtifactPath(media.id)), readFileSync(join(options.projectsDir, project.id, media.relativePath)));
    assert.equal(new StoryboardStore(restored).addShot(project.id, fields, 0).revision, 1);
  } finally { restored.close(); }
});
