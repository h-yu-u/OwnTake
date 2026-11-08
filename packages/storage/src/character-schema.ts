/** Bounded immutable reference images live in the SQLite backup itself. */
export const characterSchema = `
CREATE TABLE IF NOT EXISTS library_characters (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, biography TEXT NOT NULL,
 appearance TEXT NOT NULL, style TEXT NOT NULL, voice_preset TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1), locked_visual_version INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS library_characters_name ON library_characters(name);
CREATE TABLE IF NOT EXISTS library_character_visuals (
 id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES library_characters(id),
 version INTEGER NOT NULL CHECK(version>=1),
 mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
 sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=16777216),
 width INTEGER NOT NULL CHECK(width>0), height INTEGER NOT NULL CHECK(height>0),
 content BLOB NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(character_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS library_character_looks (
 id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES library_characters(id),
 name TEXT NOT NULL, outfit TEXT NOT NULL, mood TEXT NOT NULL,
 visual_version INTEGER NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(character_id,visual_version) REFERENCES library_character_visuals(character_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS library_project_roles (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 character_id TEXT NOT NULL REFERENCES library_characters(id),
 visual_version INTEGER NOT NULL, look_id TEXT REFERENCES library_character_looks(id),
 role_name TEXT NOT NULL, artifact_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,character_id),
 FOREIGN KEY(character_id,visual_version) REFERENCES library_character_visuals(character_id,version),
 FOREIGN KEY(artifact_id,project_id) REFERENCES artifacts(id,project_id)
) STRICT;
CREATE INDEX IF NOT EXISTS library_roles_project ON library_project_roles(project_id);
`;
