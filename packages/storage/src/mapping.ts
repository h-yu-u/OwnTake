import type { AppEvent, Artifact, Job, Project, Timeline, TimelineDraft } from '../../contracts/src/index.ts';
import { parseJson } from './validation.ts';

type Row = Record<string, unknown>;

export function projectFromRow(row: Row): Project {
  return { id: String(row.id), name: String(row.name), brief: String(row.brief), ratio: row.ratio as Project['ratio'], revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
export function artifactFromRow(row: Row): Artifact {
  return { id: String(row.id), projectId: String(row.project_id), name: String(row.name), kind: row.kind as Artifact['kind'], relativePath: String(row.relative_path), sha256: String(row.sha256), sizeBytes: Number(row.size_bytes), media: parseJson(row.media_json), source: row.source as Artifact['source'], metadata: parseJson(row.metadata_json), createdAt: String(row.created_at) };
}
export function timelineFromRow(row: Row): Timeline {
  return { ...parseJson<TimelineDraft>(row.body_json), id: String(row.id), projectId: String(row.project_id), version: Number(row.version), createdAt: String(row.created_at) };
}
export function jobFromRow(row: Row): Job {
  return { id: String(row.id), projectId: String(row.project_id), type: String(row.type), status: row.status as Job['status'], payload: parseJson(row.payload_json), result: row.result_json === null ? null : parseJson(row.result_json), progress: Number(row.progress), error: row.error_json === null ? null : parseJson(row.error_json), dedupeKey: String(row.dedupe_key), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
export function eventFromRow(row: Row): AppEvent {
  return { seq: Number(row.seq), projectId: String(row.project_id), type: String(row.type), data: parseJson(row.data_json), createdAt: String(row.created_at) };
}
