-- D1 bills every row a query scans, not just the rows it returns. The every-minute schedule polls these tables
-- for work, and without an index each poll scanned the whole table (and sorted it), which added up to a large
-- share of the free daily read quota even with no visitors. These indexes make an idle poll cost ~0 rows.
CREATE INDEX IF NOT EXISTS mockup_jobs_submitted ON mockup_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS mockup_jobs_pending ON mockup_jobs(status, priority DESC, attempts, product_id);
CREATE INDEX IF NOT EXISTS printful_probe_pending ON printful_probe(status, created_at);
-- Lets the catalog version check (COUNT + MAX(synced_at) per generation) read the index instead of every product row.
CREATE INDEX IF NOT EXISTS catalog_products_synced ON catalog_products(generation, synced_at);
