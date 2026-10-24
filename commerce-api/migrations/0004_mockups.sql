CREATE TABLE IF NOT EXISTS mockup_jobs (
  product_id TEXT PRIMARY KEY,
  layer_json TEXT NOT NULL CHECK (json_valid(layer_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','done','error','hold')),
  priority INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  colors_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
