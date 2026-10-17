export class Store {
  constructor(db) { this.db = db; }
  first(sql,...values) { return this.db.prepare(sql).bind(...values).first(); }
  async all(sql,...values) { return (await this.db.prepare(sql).bind(...values).all()).results; }
  run(sql,...values) { return this.db.prepare(sql).bind(...values).run(); }
  batch(statements) { return this.db.batch(statements.map(([sql,...values]) => this.db.prepare(sql).bind(...values))); }
  async activeGeneration() { return (await this.first("SELECT value FROM commerce_settings WHERE key='active_catalog'"))?.value; }
  order(id) { return this.first('SELECT * FROM commerce_orders WHERE id=?',id); }
  orderBySession(id) { return this.first('SELECT * FROM commerce_orders WHERE stripe_session_id=?',id); }
}
