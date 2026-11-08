export const openaiSchema = `
CREATE TABLE IF NOT EXISTS openai_connections (
 id TEXT PRIMARY KEY, body_json TEXT NOT NULL CHECK(json_valid(body_json)), credential_ref TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS openai_connection_profiles (
 connection_id TEXT NOT NULL REFERENCES openai_connections(id),
 capability TEXT NOT NULL CHECK(capability IN ('reasoning','image','speech')),
 provider_id TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id),
 PRIMARY KEY(connection_id, capability)
) STRICT;
`;
