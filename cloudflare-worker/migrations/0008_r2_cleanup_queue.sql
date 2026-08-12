CREATE TABLE IF NOT EXISTS r2_cleanup_queue (
  id TEXT PRIMARY KEY,
  bucket_name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bucket_name, object_key)
);

CREATE INDEX IF NOT EXISTS idx_r2_cleanup_due
  ON r2_cleanup_queue (next_attempt_at, attempts);
