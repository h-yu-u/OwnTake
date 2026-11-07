/** Global story assets and immutable revisions are independent of project media. */
export const storySchema = `
CREATE TABLE IF NOT EXISTS library_stories (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, genre TEXT NOT NULL, summary TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS library_stories_recent ON library_stories(updated_at DESC);
CREATE TABLE IF NOT EXISTS library_story_versions (
  story_id TEXT NOT NULL REFERENCES library_stories(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  created_at TEXT NOT NULL, PRIMARY KEY(story_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS library_script_versions (
  id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES library_stories(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  source_version INTEGER NOT NULL CHECK(source_version >= 1),
  body TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(story_id,version),
  FOREIGN KEY(story_id,source_version) REFERENCES library_story_versions(story_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS library_story_projects (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  story_id TEXT NOT NULL, story_version INTEGER NOT NULL,
  script_version INTEGER, created_at TEXT NOT NULL,
  FOREIGN KEY(story_id,story_version) REFERENCES library_story_versions(story_id,version),
  FOREIGN KEY(story_id,script_version) REFERENCES library_script_versions(story_id,version)
) STRICT;
CREATE INDEX IF NOT EXISTS library_story_projects_story ON library_story_projects(story_id);
`;
