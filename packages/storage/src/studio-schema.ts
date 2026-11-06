export const studioSchema = `
CREATE TABLE runtime_profiles (
  id TEXT PRIMARY KEY, body_json TEXT NOT NULL CHECK(json_valid(body_json))
) STRICT;
CREATE TABLE studio_operations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, status TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  UNIQUE(project_id, operation_id)
) STRICT;
CREATE INDEX studio_project ON studio_operations(project_id);
CREATE TABLE studio_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES studio_operations(id),
  data BLOB NOT NULL CHECK(length(data) > 0 AND length(data) <= 33554432),
  sha256 TEXT NOT NULL, mime TEXT NOT NULL
) STRICT;
CREATE TABLE studio_frames (
  operation_id TEXT NOT NULL REFERENCES studio_operations(id), frame_id TEXT NOT NULL,
  data BLOB NOT NULL CHECK(length(data) > 0 AND length(data) <= 2097152),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), PRIMARY KEY(operation_id, frame_id)
) STRICT;
`;
