'use strict';
/** Final bills. A bill is only ever generated from a delivered, fully-settled order and is stored exactly as issued. */
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

function makingDescription(it) {
  switch (it.making_method) {
    case 'fixed_per_piece': return `${inr(it.making_rate)} per piece`;
    case 'percent_of_gold': return `${it.making_rate}% of gold value`;
    default: return `${inr(it.making_rate)}/g × ${round3(it.net_gold_weight * it.quantity).toFixed(3)} g`;
  }
}

function buildSnapshot(order, billNumber, billDate) {
  const items = orders.itemsOf(order.id);
  const payments = orders.paymentsOf(order.id);
  const customer = q.get('SELECT * FROM customers WHERE id = ?', order.customer_id);
  const s = settings.getAll();
  const frozen = JSON.parse(order.pricing_snapshot);
  const gst = order.gst;
  const cgst = round2(gst / 2);

  const finalPayment = payments.length ? payments[payments.length - 1] : null;
  const previous = payments.slice(0, -1);
  const pay = (p, i) => ({
    date: p.payment_date, method: p.payment_method, amount: p.amount, reference: p.reference_number,
    gold_rate_at_payment: p.gold_rate_at_payment, gold_equivalent: p.gold_equivalent,
    kind: i === 0 && payments.length > 1 ? 'Advance' : i === payments.length - 1 ? (payments.length === 1 ? 'Full payment' : 'Final payment') : 'Part payment',
  });

  return {
    shop: { name: s.shop_name, tagline: s.shop_tagline, address: s.shop_address, phone: s.shop_phone, gstin: s.shop_gstin },
    bill_number: billNumber,
    bill_date: billDate,
    order_number: order.order_number,
    order_date: order.order_date,
    delivery_date: order.actual_delivery_date,
    customer: { id: customer.id, name: customer.name, phone: customer.phone, address: customer.address, city: customer.city },
    order_gold_rate: order.order_gold_rate,
    delivery_gold_rate: order.delivery_gold_rate,
    items: items.map((it) => ({
      name: it.product_name, sku: it.sku, barcode: it.barcode, metal_type: it.metal_type, purity: it.purity, quantity: it.quantity,
      gross_weight: round3(it.gross_weight * it.quantity), stone_weight: round3(it.stone_weight * it.quantity),
      net_gold_weight: round3(it.net_gold_weight * it.quantity),
      gold_rate: it.settled_gold_rate, gold_value: it.settled_gold_value, making_charge: it.settled_making_charge,
      making_description: makingDescription(it), gst: it.settled_gst, total: it.settled_total,
    })),
    totals: {
      gold_value: order.subtotal, making_charge: order.making_charge, other_charges: order.other_charges, other_charges_note: order.other_charges_note,
      gst_rate: frozen.rules.gst_rate, gst, cgst, sgst: round2(gst - cgst), round_off: order.round_off,
      total: order.total_amount, amount_in_words: amountInWords(order.total_amount),
    },
    payments: payments.map(pay),
    previous_payments: { count: previous.length, total: round2(previous.reduce((sum, p) => sum + p.amount, 0)) },
    final_payment: finalPayment ? pay(finalPayment, payments.length - 1) : null,
    total_paid: round2(payments.reduce((sum, p) => sum + p.amount, 0)),
    credit_applied: order.credit_applied,
    payment_methods: [...new Set(payments.map((p) => p.payment_method))],
    rules: settings.describe(frozen.rules),
  };
}

function generate(orderId) {
  return tx(() => {
    const order = orders.orderRow(orderId);
    if (order.status === 'BILLED') throw conflict('The final bill for this order has already been generated');
    if (order.status !== 'DELIVERED') throw conflict('A final bill can only be generated once the order is delivered and fully settled');
    if (order.outstanding_amount > EPS) throw conflict(`${inr(order.outstanding_amount)} is still outstanding on this order`);

    const billDate = clock.today();
    const billNumber = nextBillNumber(billDate);
    const snapshot = buildSnapshot(order, billNumber, billDate);
    const res = q.run(
      `INSERT INTO bills (bill_number, order_id, customer_id, bill_date, total_amount, generated_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      billNumber, orderId, order.customer_id, billDate, order.total_amount, clock.timestamp(), JSON.stringify(snapshot));
    q.run("UPDATE orders SET status = 'BILLED', updated_at = ? WHERE id = ?", clock.timestamp(), orderId);
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
    `SELECT b.id, b.bill_number, b.bill_date, b.total_amount, b.order_id, o.order_number, c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
       (SELECT group_concat(oi.product_name, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS products
     ${from} ${clause} ORDER BY b.id DESC LIMIT ? OFFSET ?`, ...params, Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0));
  return { items, total };
}

/** Billing home: what is waiting to be billed, what is close to it, and the bill archive totals. */
function overview() {
  const awaitingBill = orders.listOrders({ view: 'awaiting_bill', sort: 'order_date' }).items;
  const readyToSettle = orders.listOrders({ status: 'FULLY_PAID', sort: 'delivery' }).items;
  const totals = q.get('SELECT COUNT(*) AS bills, COALESCE(SUM(total_amount), 0) AS billed_value FROM bills');
  const month = clock.today().slice(0, 7);
  const thisMonth = q.get('SELECT COUNT(*) AS bills, COALESCE(SUM(total_amount), 0) AS billed_value FROM bills WHERE bill_date LIKE ?', month + '%');
  return { awaiting_bill: awaitingBill, ready_to_settle: readyToSettle, totals, this_month: thisMonth };
}

module.exports = { generate, get, list, overview };
