'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'jewellery.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const nullify = (params) => params.map((p) => (p === undefined ? null : p));

const q = {
  all: (sql, ...params) => db.prepare(sql).all(...nullify(params)),
  get: (sql, ...params) => db.prepare(sql).get(...nullify(params)),
  run: (sql, ...params) => db.prepare(sql).run(...nullify(params)),
};

let depth = 0;
/** Runs fn atomically. Nested calls join the outer transaction. */
function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

// Bump when the orders/billing tables change shape in a way that cannot be altered in place.
const SCHEMA_VERSION = 2;

/** Version 2 replaced the multi-rule order/settlement model with the simple lifecycle. An older database
 *  cannot be converted in place, so it is copied aside (never lost) and the demo data is loaded afresh. */
function upgradeOldDatabase() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasOrders = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
  if (!hasOrders || version >= SCHEMA_VERSION) return;
  if (DB_PATH !== ':memory:') {
    const backup = `${DB_PATH}-backup-pre-v${SCHEMA_VERSION}-${Date.now()}`;
    fs.copyFileSync(DB_PATH, backup);
    console.log(`Database upgraded to the simplified order model. Your previous data was saved to ${backup}`);
  }
  dropAll();
}

function migrate() {
  upgradeOldDatabase();
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  const customerCols = db.prepare("PRAGMA table_info(customers)").all().map((c) => c.name);
  if (!customerCols.includes('is_premium')) db.exec('ALTER TABLE customers ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0');
  const itemCols = db.prepare("PRAGMA table_info(order_items)").all().map((c) => c.name);
  if (!itemCols.includes('description')) db.exec('ALTER TABLE order_items ADD COLUMN description TEXT');
  const productCols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  if (!productCols.includes('description')) db.exec('ALTER TABLE products ADD COLUMN description TEXT');
}

/** Drops every table so the demo can be re-seeded from scratch. */
function dropAll() {
  db.exec('PRAGMA foreign_keys = OFF');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  db.exec('PRAGMA foreign_keys = ON');
}

/** Drops just the given tables (bypassing e.g. the bills/payments immutability triggers, which only guard
 *  UPDATE/DELETE, not DROP) and recreates them empty from the schema. Other tables are untouched. */
function dropTables(names) {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const name of names) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
}

migrate();

module.exports = { db, q, tx, migrate, dropAll, dropTables, DB_PATH };
