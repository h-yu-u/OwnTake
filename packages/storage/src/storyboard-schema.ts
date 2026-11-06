export const storyboardSchema = `
CREATE TABLE boards (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX artifacts_identity_project ON artifacts(id, project_id);
CREATE TABLE shots (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES boards(project_id),
  position INTEGER NOT NULL CHECK(position >= 0), fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
  revision INTEGER NOT NULL CHECK(revision > 0), visual_revision INTEGER NOT NULL CHECK(visual_revision > 0),
  caption_revision INTEGER NOT NULL CHECK(caption_revision > 0), edit_revision INTEGER NOT NULL CHECK(edit_revision > 0),
  selected_artifact_id TEXT, selected_visual_revision INTEGER,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id,project_id),
  FOREIGN KEY(selected_artifact_id,project_id) REFERENCES artifacts(id,project_id),
  CHECK((selected_artifact_id IS NULL AND selected_visual_revision IS NULL) OR (selected_artifact_id IS NOT NULL AND selected_visual_revision IS NOT NULL AND selected_visual_revision > 0 AND selected_visual_revision <= visual_revision))
) STRICT;
CREATE INDEX shots_project_position ON shots(project_id, archived, position);
CREATE TABLE shot_revisions (
  shot_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  visual_revision INTEGER NOT NULL CHECK(visual_revision > 0), body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(shot_id,revision), FOREIGN KEY(shot_id,project_id) REFERENCES shots(id,project_id)
) STRICT;
CREATE TABLE candidates (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), shot_id TEXT NOT NULL,
  visual_revision INTEGER NOT NULL CHECK(visual_revision > 0), artifact_id TEXT NOT NULL, plan_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(shot_id,project_id) REFERENCES shots(id,project_id),
  FOREIGN KEY(artifact_id,project_id) REFERENCES artifacts(id,project_id),
  UNIQUE(shot_id,visual_revision,artifact_id)
) STRICT;
CREATE INDEX candidates_project_shot ON candidates(project_id,shot_id,created_at);
CREATE TABLE storyboard_drafts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES boards(project_id), base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending','applied')),
  operations_json TEXT NOT NULL CHECK(json_valid(operations_json)),
  accepted_operation_ids_json TEXT NOT NULL CHECK(json_valid(accepted_operation_ids_json)),
  source TEXT NOT NULL CHECK(source IN ('manual','model')), created_at TEXT NOT NULL
) STRICT;
CREATE INDEX storyboard_drafts_project ON storyboard_drafts(project_id,created_at);
`;
