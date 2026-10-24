CREATE TABLE IF NOT EXISTS image_masters (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_class TEXT NOT NULL CHECK (access_class IN ('public','private')),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  original_size BIGINT NOT NULL CHECK (original_size > 0),
  stored_size BIGINT NOT NULL CHECK (stored_size > 0),
  stored_sha256 TEXT NOT NULL CHECK (stored_sha256 ~ '^[a-f0-9]{64}$'),
  content_encoding TEXT CHECK (content_encoding IS NULL OR content_encoding='gzip'),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id,access_class,source_sha256)
);
CREATE TABLE IF NOT EXISTS image_master_uploads (
  user_id TEXT NOT NULL,
  access_class TEXT NOT NULL,
  upload_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  PRIMARY KEY(user_id,access_class,upload_key),
  FOREIGN KEY(user_id,access_class,source_sha256) REFERENCES image_masters(user_id,access_class,source_sha256) ON DELETE CASCADE
);
