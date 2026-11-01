-- Nino newsletter (newsletter.mjs). Each issue is drafted automatically, emailed to the owner for approval, and
-- sent only after he taps Approve (owner decision, Oct 31, 2026). status:
--   awaiting -> approval email sent;  sending -> approved, going out in batches (cursor = last address sent);
--   sent | skipped | replaced (a redraft from "Ask for changes" took its place) | expired (no answer in 7 days).
CREATE TABLE IF NOT EXISTS newsletter_issues (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('monthly','holiday')),
  status TEXT NOT NULL,
  subject TEXT NOT NULL,
  content_json TEXT NOT NULL,
  design_ids_json TEXT NOT NULL,
  token TEXT NOT NULL,
  owner_note TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  sent_at INTEGER,
  cursor TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS newsletter_issues_status ON newsletter_issues(status, created_at);
