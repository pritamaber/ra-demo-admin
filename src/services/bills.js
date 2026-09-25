'use strict';
/** Final bills. A bill is created automatically when an order is delivered (fully paid) and is stored exactly as issued. */
const { q, tx } = require('../db');
const { notFound, conflict, clock, inr, amountInWords, pad, round2, round3 } = require('../util');
const settings = require('./settings');
const orders = require('./orders');

const { EPS } = orders;

function fiscalYear(dateIso) {
  const [y, m] = dateIso.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${pad((start + 1) % 100, 2)}`;
}

function nextBillNumber(date) {
  const prefix = `RAJ/${fiscalYear(date)}/`;
  const last = q.get('SELECT bill_number FROM bills WHERE bill_number LIKE ? ORDER BY id DESC LIMIT 1', prefix + '%');
  return prefix + pad(last ? Number(last.bill_number.slice(prefix.length)) + 1 : 1, 4);
}

function buildSnapshot(order, billNumber, billDate) {
  const items = orders.itemsOf(order.id);
  const payments = orders.paymentsOf(order.id);
  const kinds = orders.paymentKinds(payments, order);
  const customer = q.get('SELECT * FROM customers WHERE id = ?', order.customer_id);
  const s = settings.getAll();
  const cgst = round2(order.gst / 2);

  return {
    shop: { name: s.shop_name, tagline: s.shop_tagline, address: s.shop_address, phone: s.shop_phone, gstin: s.shop_gstin },
    bill_number: billNumber,
    bill_date: billDate,
    order_number: order.order_number,
    order_kind: order.kind,
    order_date: order.order_date,
    delivery_date: order.actual_delivery_date,
    customer: { id: customer.id, name: customer.name, phone: customer.phone, address: customer.address, city: customer.city },
    gold_rate: order.order_gold_rate,
    items: items.map((it) => ({
      name: it.product_name, description: it.description, sku: it.sku, barcode: it.barcode, metal_type: it.metal_type, purity: it.purity, quantity: it.quantity,
      gross_weight: round3(it.gross_weight * it.quantity), stone_weight: round3(it.stone_weight * it.quantity),
      net_gold_weight: round3(it.net_gold_weight * it.quantity),
      gold_rate: it.gold_rate, gold_value: it.gold_value, making_charge: it.making_charge,
      making_description: `${inr(it.making_rate)}/g × ${round3(it.net_gold_weight * it.quantity).toFixed(3)} g`,
      gst: it.gst, total: it.total,
    })),
    totals: {
      gold_value: order.subtotal, making_charge: order.making_charge, other_charges: order.other_charges, other_charges_note: order.other_charges_note,
      gst_rate: order.gst_rate, gst: order.gst, cgst, sgst: round2(order.gst - cgst),
      total: order.total_amount, amount_in_words: amountInWords(order.total_amount),
    },
    payments: payments.map((p, i) => ({ date: p.payment_date, method: p.payment_method, amount: p.amount, reference: p.reference_number, kind: kinds[i] })),
    total_paid: round2(payments.reduce((sum, p) => sum + p.amount, 0)),
    payment_methods: [...new Set(payments.map((p) => p.payment_method))],
  };
}

/** Called automatically when an order is delivered (the order is then fully paid). Never call it on its own. */
function generate(orderId) {
  return tx(() => {
    const order = orders.orderRow(orderId);
    if (q.get('SELECT id FROM bills WHERE order_id = ?', orderId)) throw conflict('The final bill for this order has already been generated');
    if (order.status !== 'DELIVERED') throw conflict('A final bill is generated when the order is delivered');
    if (order.outstanding_amount > EPS) throw conflict(`${inr(order.outstanding_amount)} is still outstanding on this order`);

    const billDate = clock.today();
    const billNumber = nextBillNumber(billDate);
    const snapshot = buildSnapshot(order, billNumber, billDate);
    const res = q.run(
      `INSERT INTO bills (bill_number, order_id, customer_id, bill_date, total_amount, generated_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      billNumber, orderId, order.customer_id, billDate, order.total_amount, clock.timestamp(), JSON.stringify(snapshot));
    orders.logEvent(orderId, 'BILLED', `Final bill ${billNumber} generated for ${inr(order.total_amount)}`);
    return get(Number(res.lastInsertRowid));
  });
}

function get(id) {
  const row = q.get(
    `SELECT b.*, o.order_number, c.name AS customer_name, c.phone AS customer_phone
     FROM bills b JOIN orders o ON o.id = b.order_id JOIN customers c ON c.id = b.customer_id WHERE b.id = ?`, id);
  if (!row) throw notFound('Bill');
  const { snapshot, ...rest } = row;
  return { ...rest, bill: JSON.parse(snapshot) };
}

function list({ q: search, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (search) {
    where.push('(b.bill_number LIKE ? OR o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    params.push(...Array(4).fill(`%${search}%`));
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const from = 'FROM bills b JOIN orders o ON o.id = b.order_id JOIN customers c ON c.id = b.customer_id';
  const total = q.get(`SELECT COUNT(*) AS n ${from} ${clause}`, ...params).n;
  const items = q.all(
    `SELECT b.id, b.bill_number, b.bill_date, b.total_amount, b.order_id, o.order_number, o.kind, c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
       (SELECT group_concat(oi.product_name, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS products
     ${from} ${clause} ORDER BY b.id DESC LIMIT ? OFFSET ?`, ...params, Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0));
  return { items, total };
}

/** Billing home: bill totals for the shop owner. */
function overview() {
  const totals = q.get('SELECT COUNT(*) AS bills, COALESCE(SUM(total_amount), 0) AS billed_value FROM bills');
  const month = clock.today().slice(0, 7);
  const thisMonth = q.get('SELECT COUNT(*) AS bills, COALESCE(SUM(total_amount), 0) AS billed_value FROM bills WHERE bill_date LIKE ?', month + '%');
  const today = q.get('SELECT COUNT(*) AS bills, COALESCE(SUM(total_amount), 0) AS billed_value FROM bills WHERE bill_date = ?', clock.today());
  return { totals, this_month: thisMonth, today };
}

module.exports = { generate, get, list, overview };
