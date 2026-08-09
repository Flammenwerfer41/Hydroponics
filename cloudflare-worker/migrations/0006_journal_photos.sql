PRAGMA foreign_keys = ON;

CREATE TABLE journal_photos (
  journal_day_id TEXT PRIMARY KEY REFERENCES journal_days(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  full_object_key TEXT NOT NULL UNIQUE,
  thumbnail_object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 2000000),
  thumbnail_byte_size INTEGER NOT NULL CHECK (
    thumbnail_byte_size > 0 AND thumbnail_byte_size <= 300000
  ),
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 2400),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 2400),
  uploaded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_journal_photos_updated ON journal_photos(updated_at DESC);
