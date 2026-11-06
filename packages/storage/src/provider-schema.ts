export const providerSchema = `
CREATE TABLE IF NOT EXISTS provider_profiles (
 id TEXT PRIMARY KEY, body_json TEXT NOT NULL CHECK(json_valid(body_json)), credential_ref TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS provider_calls (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
 body_json TEXT NOT NULL CHECK(json_valid(body_json)), credential_ref TEXT,
 UNIQUE(project_id, operation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS provider_calls_status ON provider_calls(status);
`;
