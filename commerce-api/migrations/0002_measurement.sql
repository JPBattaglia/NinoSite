-- Aggregate action counts only. No visitors, sessions, IPs, addresses or receipt tokens.
CREATE TABLE IF NOT EXISTS shopping_measurement (
  day TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('test','live')),
  event TEXT NOT NULL CHECK (event IN ('page_view','product_view','add_to_cart','checkout_attempt','checkout_opened')),
  product_id TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day,mode,event,product_id)
);

-- Record the first verified payment observation; never infer dates for old orders.
ALTER TABLE commerce_orders ADD COLUMN paid_at INTEGER;
CREATE TRIGGER commerce_payment_observed
AFTER UPDATE OF payment_status,paid_total_cents ON commerce_orders
WHEN NEW.payment_status='paid' AND NEW.paid_at IS NULL
  AND NEW.paid_total_cents IS NOT NULL AND NEW.stripe_payment_intent_id IS NOT NULL
BEGIN
  UPDATE commerce_orders SET paid_at=NEW.updated_at WHERE id=NEW.id;
END;
CREATE INDEX commerce_orders_paid_at ON commerce_orders(paid_at) WHERE live_mode=1 AND payment_status='paid';
