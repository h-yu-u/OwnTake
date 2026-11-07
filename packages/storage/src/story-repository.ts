import { randomUUID } from 'node:crypto';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { Ratio } from '../../contracts/src/index.ts';
import type { ScriptVersion, Story, StoryInput, StoryProjectLink, StoryVersion } from '../../contracts/src/story.ts';
import { validateStory } from '../../domain/src/story.ts';
import { integer, resourceId, text } from '../../domain/src/validation.ts';
import type { Store } from './store.ts';

type Row = Record<string, unknown>;
const json = JSON.stringify;
const decode = <T>(input: unknown): T => JSON.parse(String(input)) as T;
function storyFrom(row: Row): Story {
  return { id: String(row.id), title: String(row.title), genre: String(row.genre), summary: String(row.summary),
    tags: decode<string[]>(row.tags_json), source: decode<Story['source']>(row.source_json),
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function versionFrom(row: Row): StoryVersion {
  return { ...decode<StoryInput>(row.body_json), storyId: String(row.story_id),
    version: Number(row.version), createdAt: String(row.created_at) };
}
function scriptFrom(row: Row): ScriptVersion {
  return { id: String(row.id), storyId: String(row.story_id), version: Number(row.version),
    sourceVersion: Number(row.source_version), text: String(row.body), createdAt: String(row.created_at) };
}
export class StoryRepository {
  constructor(private readonly store: Store) {}
  list(query = ''): Story[] {
    const q = text(query, '检索词', 100, true);
    return this.store.db.prepare(`SELECT * FROM library_stories
      WHERE ? = '' OR instr(title, ?) > 0 OR instr(genre, ?) > 0 OR instr(summary, ?) > 0 OR instr(tags_json, ?) > 0
      ORDER BY updated_at DESC, rowid DESC LIMIT 200`).all(q, q, q, q, q).map(storyFrom);
  }
  get(id: string): Story {
    const row = this.store.db.prepare('SELECT * FROM library_stories WHERE id=?').get(resourceId(id));
    if (!row) throw new AppError('STORY_NOT_FOUND', '故事不存在', 404);
    return storyFrom(row);
  }
  versions(id: string): StoryVersion[] {
    this.get(id);
    return this.store.db.prepare('SELECT * FROM library_story_versions WHERE story_id=? ORDER BY version').all(id).map(versionFrom);
  }
  version(id: string, version: number): StoryVersion {
    this.get(id); integer(version, '故事版本', 1, Number.MAX_SAFE_INTEGER);
    const row = this.store.db.prepare('SELECT * FROM library_story_versions WHERE story_id=? AND version=?').get(id, version);
    if (!row) throw new AppError('STORY_VERSION_NOT_FOUND', '故事版本不存在', 404);
    return versionFrom(row);
  }
  create(raw: unknown): Story {
    const input = validateStory(raw);
    return this.store.transaction(() => {
      const id = `story_${randomUUID()}`, now = new Date().toISOString();
      this.store.db.prepare('INSERT INTO library_stories VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, input.title, input.genre, input.summary, json(input.tags), json(input.source), 1, now, now);
      this.store.db.prepare('INSERT INTO library_story_versions VALUES (?,?,?,?)').run(id, 1, json(input), now);
      return this.get(id);
    });
  }
  update(id: string, raw: unknown, expectedRevision: number): Story {
    const input = validateStory(raw);
    integer(expectedRevision, '故事版本', 1, Number.MAX_SAFE_INTEGER);
    return this.store.transaction(() => {
      const old = this.get(id);
      invariant(old.revision === expectedRevision, 'REVISION_CONFLICT', '故事已更新，请重新载入', 409);
      const next = old.revision + 1, now = new Date().toISOString();
      this.store.db.prepare('UPDATE library_stories SET title=?,genre=?,summary=?,tags_json=?,source_json=?,revision=?,updated_at=? WHERE id=?')
        .run(input.title, input.genre, input.summary, json(input.tags), json(input.source), next, now, id);
      this.store.db.prepare('INSERT INTO library_story_versions VALUES (?,?,?,?)').run(id, next, json(input), now);
      return this.get(id);
    });
  }
  scripts(id: string): ScriptVersion[] {
    this.get(id);
    return this.store.db.prepare('SELECT * FROM library_script_versions WHERE story_id=? ORDER BY version').all(id).map(scriptFrom);
  }
  script(id: string, version: number): ScriptVersion {
    this.get(id); integer(version, '剧本版本', 1, Number.MAX_SAFE_INTEGER);
    const row = this.store.db.prepare('SELECT * FROM library_script_versions WHERE story_id=? AND version=?').get(id, version);
    if (!row) throw new AppError('SCRIPT_VERSION_NOT_FOUND', '剧本版本不存在', 404);
    return scriptFrom(row);
  }
  saveScript(id: string, sourceVersion: number, content: string): ScriptVersion {
    this.version(id, sourceVersion);
    const body = text(content, '剧本内容', 20_000);
    return this.store.transaction(() => {
      const version = Number(this.store.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM library_script_versions WHERE story_id=?').get(id)?.v ?? 0) + 1;
      const uid = `script_${randomUUID()}`, now = new Date().toISOString();
      this.store.db.prepare('INSERT INTO library_script_versions VALUES (?,?,?,?,?,?)').run(uid, id, version, sourceVersion, body, now);
      return this.script(id, version);
    });
  }
  links(id: string): StoryProjectLink[] {
    this.get(id);
    return this.store.db.prepare('SELECT * FROM library_story_projects WHERE story_id=? ORDER BY created_at').all(id).map(row => ({
      storyId: String(row.story_id), storyVersion: Number(row.story_version), scriptVersion: row.script_version == null ? null : Number(row.script_version),
      projectId: String(row.project_id), createdAt: String(row.created_at),
    }));
  }
  createProject(id: string, storyVersion: number, scriptVersion: number | null, ratio: Ratio) {
    const story = this.get(id), draft = this.version(id, storyVersion);
    invariant(story.source.rights === 'original' || story.source.rights === 'licensed',
      'STORY_RIGHTS_REQUIRED', '未确认改编权的外部故事不能直接转为作品，请先创作并保存拥有权利的原创剧本', 409);
    const script = scriptVersion === null ? null : this.script(id, scriptVersion);
    const summary = [draft.summary, ...draft.beats, script?.text ?? ''].filter(Boolean).join('\n\n').slice(0, 20_000);
    return this.store.transaction(() => {
      const project = this.store.createProject({ name: draft.title, brief: summary, ratio });
      this.store.db.prepare('INSERT INTO library_story_projects VALUES (?,?,?,?,?)')
        .run(project.id, id, storyVersion, script?.version ?? null, new Date().toISOString());
      return { project, link: this.links(id).find(link => link.projectId === project.id)! };
    });
  }
}
