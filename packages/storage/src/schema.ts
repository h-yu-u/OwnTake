import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../contracts/src/errors.ts';
import { storyboardSchema } from './storyboard-schema.ts';
import { providerSchema } from './provider-schema.ts';

export const SCHEMA_VERSION = 2;

const schema = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL,
  ratio TEXT NOT NULL CHECK (ratio IN ('16:9','9:16','1:1')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('video','image','audio')),
  relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  media_json TEXT NOT NULL CHECK(json_valid(media_json)),
  source TEXT NOT NULL CHECK(source IN ('import','generated','render','composite')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), created_at TEXT NOT NULL,
  UNIQUE(project_id, relative_path)
) STRICT;
CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id, created_at);
CREATE TABLE IF NOT EXISTS timelines (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL CHECK(version > 0), body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  created_at TEXT NOT NULL, UNIQUE(project_id, version)
) STRICT;
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_external','blocked','succeeded','failed','cancel_requested','cancelled')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  dedupe_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)), created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, seq);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL CHECK(json_valid(value_json))
) STRICT;
`;

export function initializeSchema(db: DatabaseSync): void {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new AppError('DATABASE_NEWER', '数据库版本高于当前应用版本，请使用较新的 OwnTake。', 409);
  }
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  if (current === SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (current < 1) db.exec(schema);
    if (current < 2) { db.exec(storyboardSchema); db.exec(providerSchema); }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
