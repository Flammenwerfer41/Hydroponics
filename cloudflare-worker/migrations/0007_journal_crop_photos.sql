PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS journal_crop_photos (
  id TEXT PRIMARY KEY,
  journal_day_id TEXT NOT NULL REFERENCES journal_days(id) ON DELETE CASCADE,
  crop_id TEXT NOT NULL REFERENCES crops(id) ON DELETE RESTRICT,
  full_object_key TEXT NOT NULL UNIQUE,
  thumbnail_object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'image/webp' CHECK (mime_type = 'image/webp'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 1000000),
  thumbnail_byte_size INTEGER NOT NULL CHECK (thumbnail_byte_size > 0 AND thumbnail_byte_size <= 100000),
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 1920),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 1920),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0 AND sort_order < 6),
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (journal_day_id, crop_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_journal_crop_photos_day_crop
  ON journal_crop_photos (journal_day_id, crop_id, sort_order);
