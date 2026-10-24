CREATE TABLE IF NOT EXISTS printful_probe (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL DEFAULT 'GET',
  path TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE printful_probe ADD COLUMN store_id TEXT;
