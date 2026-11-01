-- Email signup for the Nino site (marketing plan v2, item 1). Double opt-in: a row starts 'pending' and becomes
-- 'active' only when the address owner clicks the emailed confirm link. 'unsubscribed' rows are kept so a later
-- send can never reach them by mistake; re-subscribing goes through confirmation again.
CREATE TABLE IF NOT EXISTS subscribers (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','active','unsubscribed')),
  token TEXT NOT NULL UNIQUE,
  source TEXT,
  created_at INTEGER NOT NULL,
  confirm_sent_at INTEGER,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER
);
CREATE INDEX IF NOT EXISTS subscribers_status ON subscribers(status, confirmed_at);
-- Per-day counters that keep confirmation emails inside the free mail quota (shared with Menu-made).
CREATE TABLE IF NOT EXISTS signup_limits (
  k TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  n INTEGER NOT NULL
);
