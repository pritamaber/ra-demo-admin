'use strict';
const { q, tx } = require('../db');
const { bad, notFound, conflict, clock, str, pad, normalizePhone, isIsoDate, round2 } = require('../util');

const OPEN_STATUSES = "('PLACED','ACCEPTED','READY')";
// Orders that count toward a customer's purchases / balance (cancelled orders do not).
const LIVE = "o.status != 'CANCELLED'";

const SUMMARY_SQL = `
  SELECT c.*,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND ${LIVE}) AS total_orders,
    (SELECT COALESCE(SUM(o.total_amount), 0) FROM orders o WHERE o.customer_id = c.id AND ${LIVE}) AS total_purchases,
    (SELECT COALESCE(SUM(o.paid_amount), 0) FROM orders o WHERE o.customer_id = c.id AND ${LIVE}) AS total_paid,
    (SELECT COALESCE(SUM(o.outstanding_amount), 0) FROM orders o WHERE o.customer_id = c.id AND ${LIVE}) AS total_outstanding,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status IN ${OPEN_STATUSES}) AS open_orders
  FROM customers c`;

const decorate = (c) => ({
  ...c,
  display_id: 'C-' + pad(c.id, 4),
  is_premium: !!c.is_premium,
  total_purchases: round2(c.total_purchases), total_paid: round2(c.total_paid), total_outstanding: round2(c.total_outstanding),
});

function list({ q: search, has_outstanding, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (search) {
    const digits = String(search).replace(/\D/g, '');
    if (digits.length >= 3 && digits.length === String(search).replace(/[\s+-]/g, '').length) {
      where.push('(c.phone LIKE ? OR c.alternate_phone LIKE ?)');
      params.push(`%${digits}%`, `%${digits}%`);
    } else {
      where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.city LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const having = has_outstanding ? 'WHERE total_outstanding > 0' : '';
  const rows = q.all(`SELECT * FROM (${SUMMARY_SQL} ${clause}) ${having} ORDER BY name LIMIT ? OFFSET ?`,
    ...params, Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0));
  return { items: rows.map(decorate) };
}

function findByPhone(phone) {
  const digits = normalizePhone(phone);
  const row = q.get(`${SUMMARY_SQL} WHERE c.phone = ? OR c.alternate_phone = ?`, digits, digits);
  return row ? decorate(row) : null;
}

function getSummary(id) {
  const row = q.get(`${SUMMARY_SQL} WHERE c.id = ?`, id);
  if (!row) throw notFound('Customer');
  return decorate(row);
}

/** Full profile: summary + order history + final-bill history + payment history. */
function getProfile(id) {
  const customer = getSummary(id);
  const orders = q.all(
    `SELECT o.id, o.order_number, o.order_date, o.expected_delivery_date, o.actual_delivery_date, o.status, o.kind,
       o.total_amount, o.paid_amount, o.outstanding_amount,
       (SELECT group_concat(oi.product_name || CASE WHEN oi.quantity > 1 THEN ' ×' || oi.quantity ELSE '' END, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS products,
       (SELECT ROUND(SUM(oi.net_gold_weight * oi.quantity), 3) FROM order_items oi WHERE oi.order_id = o.id) AS gold_weight,
       (SELECT b.id FROM bills b WHERE b.order_id = o.id) AS bill_id
     FROM orders o WHERE o.customer_id = ? ORDER BY o.id DESC`, id);
  const bills = q.all(
    `SELECT b.id, b.bill_number, b.bill_date, b.total_amount, o.order_number, o.id AS order_id,
       (SELECT group_concat(oi.product_name, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS products
     FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.customer_id = ? ORDER BY b.id DESC`, id);
  const payments = q.all(
    `SELECT p.id, p.amount, p.payment_method, p.payment_date, p.reference_number, o.order_number, o.id AS order_id
     FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.customer_id = ? ORDER BY p.payment_date DESC, p.id DESC`, id);
  return { customer, orders, bills, payments };
}

function validate(input, existingId = null) {
  const name = str(input.name);
  if (!name) throw bad('Customer name is required');
  const phone = normalizePhone(input.phone);
  if (!/^[6-9]\d{9}$/.test(phone)) throw bad('Enter a valid 10-digit mobile number');
  const alt = input.alternate_phone ? normalizePhone(input.alternate_phone) : null;
  if (alt && !/^\d{10}$/.test(alt)) throw bad('Alternate phone must be 10 digits');
  for (const [field, label] of [['dob', 'Date of birth'], ['anniversary', 'Anniversary']]) {
    if (input[field] && !isIsoDate(input[field])) throw bad(`${label} must be a valid date`);
  }
  const clash = q.get('SELECT id, name FROM customers WHERE phone = ? AND id != ?', phone, existingId || 0);
  if (clash) throw conflict(`Phone ${phone} already belongs to ${clash.name}`, { customer_id: clash.id });
  return {
    name, phone, alternate_phone: alt, address: str(input.address), city: str(input.city),
    dob: str(input.dob), anniversary: str(input.anniversary), notes: str(input.notes),
    is_premium: input.is_premium ? 1 : 0,
  };
}

function create(input) {
  const c = validate(input);
  const now = clock.timestamp();
  const res = q.run(
    `INSERT INTO customers (name, phone, alternate_phone, address, city, dob, anniversary, is_premium, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.name, c.phone, c.alternate_phone, c.address, c.city, c.dob, c.anniversary, c.is_premium, c.notes, now, now);
  return getSummary(Number(res.lastInsertRowid));
}

function update(id, input) {
  if (!q.get('SELECT id FROM customers WHERE id = ?', id)) throw notFound('Customer');
  const c = validate(input, id);
  q.run(
    `UPDATE customers SET name = ?, phone = ?, alternate_phone = ?, address = ?, city = ?, dob = ?, anniversary = ?, is_premium = ?, notes = ?, updated_at = ? WHERE id = ?`,
    c.name, c.phone, c.alternate_phone, c.address, c.city, c.dob, c.anniversary, c.is_premium, c.notes, clock.timestamp(), id);
  return getSummary(id);
}

function remove(id) {
  return tx(() => {
    if (!q.get('SELECT id FROM customers WHERE id = ?', id)) throw notFound('Customer');
    if (q.get('SELECT 1 FROM orders WHERE customer_id = ?', id)) throw conflict('This customer has orders and cannot be deleted.');
    q.run('DELETE FROM customers WHERE id = ?', id);
    return { deleted: true };
  });
}

module.exports = { list, findByPhone, getSummary, getProfile, create, update, remove };
