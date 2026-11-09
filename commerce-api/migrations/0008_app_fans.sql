-- Nino's Mobile App (owner, Nov 8, 2026): rewards for shirts bought through the app, 24-hour early access to new
-- designs, and a design-ideas board for fans (fans.mjs). The app keeps a random member key on the phone; only its
-- SHA-256 is stored here.

-- One row per app member: shirts counted toward the reward ladder (a free 8x10 canvas at the 3rd shirt, a free hoodie
-- at the 6th, then the ladder starts again).
CREATE TABLE IF NOT EXISTS app_members (
  member_hash TEXT PRIMARY KEY,
  shirts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per paid order made from the app: what it added (idempotent per order).
CREATE TABLE IF NOT EXISTS app_stamps (
  order_id TEXT PRIMARY KEY,
  member_hash TEXT NOT NULL,
  shirts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_stamps_member ON app_stamps(member_hash, created_at);

-- A reward earned by an order. status: waiting (its order isn't confirmed at Printful yet) -> sent (its own Printful
-- order placed; draft_only = waiting for the owner to confirm it in Printful) | failed (owner emailed, sent by hand).
CREATE TABLE IF NOT EXISTS app_rewards (
  id TEXT PRIMARY KEY,
  member_hash TEXT NOT NULL,
  order_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('canvas','hoodie')),
  status TEXT NOT NULL DEFAULT 'waiting',
  printful_order_id TEXT,
  draft_only INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (order_id, tier)
);
CREATE INDEX IF NOT EXISTS app_rewards_open ON app_rewards(status, updated_at);
CREATE INDEX IF NOT EXISTS app_rewards_member ON app_rewards(member_hash, created_at);

-- When each design first appeared in the shop. The website shows a design 24 hours after this; the app right away.
CREATE TABLE IF NOT EXISTS design_releases (
  product_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL
);

-- Fans' design ideas. status: pending (waiting for Nino's OK) -> live | hidden.
CREATE TABLE IF NOT EXISTS app_ideas (
  id TEXT PRIMARY KEY,
  member_hash TEXT NOT NULL,
  name TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  votes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_ideas_live ON app_ideas(status, votes DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS app_ideas_member ON app_ideas(member_hash, created_at);

CREATE TABLE IF NOT EXISTS app_idea_votes (
  idea_id TEXT NOT NULL,
  member_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (idea_id, member_hash)
);
