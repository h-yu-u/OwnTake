export const generationSchema = `
CREATE TABLE IF NOT EXISTS generations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), shot_id TEXT NOT NULL REFERENCES shots(id),
 operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
 body_json TEXT NOT NULL CHECK(json_valid(body_json)), UNIQUE(project_id,operation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS generations_status ON generations(status);
CREATE TABLE IF NOT EXISTS reviews (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id),
 body_json TEXT NOT NULL CHECK(json_valid(body_json))
) STRICT;
`;
