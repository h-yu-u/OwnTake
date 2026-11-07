export const shotCastSchema=`
CREATE TABLE IF NOT EXISTS library_shot_cast(
 shot_id TEXT NOT NULL REFERENCES shots(id),
 role_id TEXT NOT NULL REFERENCES library_project_roles(id),
 reference_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
 visual_version INTEGER NOT NULL CHECK(visual_version>=1),
 character_id TEXT NOT NULL REFERENCES library_characters(id),
 look_id TEXT REFERENCES library_character_looks(id),
 created_at TEXT NOT NULL,
 PRIMARY KEY(shot_id,role_id)
) STRICT;
CREATE INDEX IF NOT EXISTS library_shot_cast_shot ON library_shot_cast(shot_id);
`;
