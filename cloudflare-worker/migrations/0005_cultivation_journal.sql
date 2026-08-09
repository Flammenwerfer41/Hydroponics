PRAGMA foreign_keys = ON;

CREATE TABLE journal_days (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  zone_id TEXT REFERENCES zones(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  journal_date TEXT NOT NULL CHECK (
    length(journal_date) = 10 AND substr(journal_date, 5, 1) = '-' AND substr(journal_date, 8, 1) = '-'
  ),
  common_note TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (site_id, zone_id, journal_date)
);

CREATE TABLE journal_sections (
  id TEXT PRIMARY KEY,
  journal_day_id TEXT NOT NULL REFERENCES journal_days(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  crop_id TEXT NOT NULL REFERENCES crops(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  title TEXT,
  body TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (journal_day_id, crop_id)
);

CREATE TABLE journal_tags (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'activity' CHECK (kind IN ('activity', 'location', 'custom')),
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, slug),
  UNIQUE (site_id, name)
);

CREATE TABLE journal_section_tags (
  journal_section_id TEXT NOT NULL REFERENCES journal_sections(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  tag_id TEXT NOT NULL REFERENCES journal_tags(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  PRIMARY KEY (journal_section_id, tag_id)
);

CREATE TABLE journal_day_values (
  journal_day_id TEXT NOT NULL REFERENCES journal_days(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sensor')),
  qualifier TEXT,
  measured_at TEXT NOT NULL,
  PRIMARY KEY (journal_day_id, metric)
);

CREATE INDEX idx_journal_days_date ON journal_days(site_id, journal_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_journal_sections_crop ON journal_sections(crop_id, journal_day_id);
CREATE INDEX idx_journal_section_tags_tag ON journal_section_tags(tag_id, journal_section_id);

INSERT OR IGNORE INTO crops
  (id, common_name, scientific_name, cultivar, created_at, updated_at)
VALUES
  ('crop-basil', '바질', 'Ocimum basilicum', NULL, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('crop-perilla', '깻잎', 'Perilla frutescens', NULL, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');

INSERT OR IGNORE INTO journal_tags
  (id, site_id, name, slug, kind, color, created_at, updated_at)
VALUES
  ('tag-observation', 'home-lab', '관찰', 'observation', 'activity', '#4f9f75', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tag-nutrient', 'home-lab', '양액 관리', 'nutrient', 'activity', '#2f8ea3', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tag-harvest', 'home-lab', '수확', 'harvest', 'activity', '#c58a24', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tag-pruning', 'home-lab', '가지치기', 'pruning', 'activity', '#8b6cad', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
  ('tag-issue', 'home-lab', '이상 징후', 'issue', 'activity', '#c45b52', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');
