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

// Bump when the orders/billing tables change. v2 = simple order lifecycle; v3 = gold-first settlement.
const SCHEMA_VERSION = 3;
const OLDEST_CONVERTIBLE = 2; // anything older is copied aside and reloaded; v2 is converted in place

const userVersion = () => db.prepare('PRAGMA user_version').get().user_version;

/** Version 2 replaced the multi-rule order/settlement model with the simple lifecycle. A database older than that
 *  cannot be converted in place, so it is copied aside (never lost) and the demo data is loaded afresh. */
function upgradeOldDatabase() {
  const version = userVersion();
  const hasOrders = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
  if (!hasOrders || version >= OLDEST_CONVERTIBLE) return;
  if (DB_PATH !== ':memory:') {
    const backup = `${DB_PATH}-backup-pre-v2-${Date.now()}`;
    fs.copyFileSync(DB_PATH, backup);
    console.log(`Database upgraded to the simplified order model. Your previous data was saved to ${backup}`);
  }
  dropAll();
}

/** v2 -> v3: v2 orders were priced at the booking rate, so replay their payments against the booking gold value
 *  to fill in how much gold each payment bought. Payments are immutable, so the guard trigger is lifted for this. */
function backfillGoldAllocation() {
  db.exec('DROP TRIGGER IF EXISTS payments_no_update');
  const orders = db.prepare('SELECT id, subtotal FROM orders').all();
  for (const o of orders) {
    const items = db.prepare('SELECT quantity, net_gold_weight FROM order_items WHERE order_id = ?').all(o.id);
    const weight = items.reduce((s, i) => s + i.net_gold_weight * i.quantity, 0);
    let paidFraction = 0;
    for (const p of db.prepare('SELECT id, amount FROM payments WHERE order_id = ? ORDER BY payment_date, id').all(o.id)) {
      const goldAmount = Math.min(p.amount, (1 - paidFraction) * o.subtotal);
      const fraction = o.subtotal > 0 ? goldAmount / o.subtotal : 0;
      paidFraction += fraction;
      db.prepare('UPDATE payments SET gold_rate = ?, gold_fraction = ?, gold_amount = ? WHERE id = ?').run(weight > 0 ? o.subtotal / weight : 0, fraction, goldAmount, p.id);
    }
  }
  db.exec('UPDATE orders SET booked_total = total_amount');
  db.exec("UPDATE order_items SET settled_gold_rate = gold_rate, settled_gold_value = gold_value, settled_gst = gst, settled_total = total WHERE order_id IN (SELECT id FROM orders WHERE status = 'DELIVERED')");
  db.exec(SCHEMA); // recreates the payments guard trigger
}

function migrate() {
  upgradeOldDatabase();
  const before = userVersion();
  db.exec(SCHEMA);
  const customerCols = db.prepare("PRAGMA table_info(customers)").all().map((c) => c.name);
  if (!customerCols.includes('is_premium')) db.exec('ALTER TABLE customers ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0');
  const orderCols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
  if (!orderCols.includes('round_off')) db.exec('ALTER TABLE orders ADD COLUMN round_off REAL NOT NULL DEFAULT 0');
  if (!orderCols.includes('booked_total')) db.exec('ALTER TABLE orders ADD COLUMN booked_total REAL NOT NULL DEFAULT 0');
  const itemCols = db.prepare("PRAGMA table_info(order_items)").all().map((c) => c.name);
  if (!itemCols.includes('description')) db.exec('ALTER TABLE order_items ADD COLUMN description TEXT');
  if (!itemCols.includes('gold_rate_locked')) db.exec('ALTER TABLE order_items ADD COLUMN gold_rate_locked INTEGER NOT NULL DEFAULT 0');
  for (const col of ['settled_gold_rate', 'settled_gold_value', 'settled_gst', 'settled_total']) {
    if (!itemCols.includes(col)) db.exec(`ALTER TABLE order_items ADD COLUMN ${col} REAL`);
  }
  const paymentCols = db.prepare("PRAGMA table_info(payments)").all().map((c) => c.name);
  for (const col of ['gold_rate', 'gold_fraction', 'gold_amount']) {
    if (!paymentCols.includes(col)) db.exec(`ALTER TABLE payments ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  }
  const productCols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  if (!productCols.includes('description')) db.exec('ALTER TABLE products ADD COLUMN description TEXT');
  if (before === 2) backfillGoldAllocation();
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
