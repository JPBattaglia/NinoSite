PRAGMA foreign_keys = ON;

CREATE TABLE commerce_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE catalog_sync_runs (
  id TEXT PRIMARY KEY,
  product_ids_json TEXT NOT NULL CHECK (json_valid(product_ids_json)),
  cursor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed')),
  lease_until INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_catalog_sync_running ON catalog_sync_runs(status) WHERE status = 'running';
CREATE TABLE catalog_products (
  generation TEXT NOT NULL,
  id TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  image TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (generation,id),
  FOREIGN KEY (generation) REFERENCES catalog_sync_runs(id)
);
CREATE TABLE catalog_variants (
  generation TEXT NOT NULL,
  id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  PRIMARY KEY (generation,id),
  FOREIGN KEY (generation,product_id) REFERENCES catalog_products(generation,id)
);
CREATE INDEX catalog_variants_product ON catalog_variants(generation,product_id);
CREATE TABLE shipping_quotes (
  id TEXT PRIMARY KEY,
  cart_hash TEXT NOT NULL,
  recipient_json TEXT NOT NULL CHECK (json_valid(recipient_json)),
  rates_json TEXT NOT NULL CHECK (json_valid(rates_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE commerce_orders (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  receipt_token TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE,
  checkout_url TEXT,
  checkout_expires_at INTEGER,
  stripe_payment_intent_id TEXT UNIQUE,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  fulfillment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
  live_mode INTEGER NOT NULL,
  recipient_json TEXT CHECK (recipient_json IS NULL OR json_valid(recipient_json)),
  customer_email TEXT,
  paid_total_cents INTEGER,
  paid_tax_cents INTEGER,
  paid_shipping_cents INTEGER,
  printful_order_id TEXT UNIQUE,
  printful_draft_json TEXT CHECK (printful_draft_json IS NULL OR json_valid(printful_draft_json)),
  lease_until INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  fulfillment_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER immutable_commerce_order_snapshot
BEFORE UPDATE OF snapshot_json, request_hash, request_key, live_mode ON commerce_orders
BEGIN SELECT RAISE(ABORT,'Order snapshot is immutable'); END;
CREATE TABLE commerce_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','failed')),
  lease_until INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE TABLE commerce_fulfillment_attempts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  result TEXT NOT NULL,
  printful_order_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES commerce_orders(id)
);
CREATE INDEX commerce_orders_retry ON commerce_orders(fulfillment_status,next_retry_at,lease_until);
CREATE INDEX commerce_webhook_retry ON commerce_webhook_events(status,lease_until);
