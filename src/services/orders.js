'use strict';
/**
 * The Order is the central transaction. Everything else hangs off it:
 *   customer -> order -> items (stock) -> payments -> delivery settlement -> final bill.
 *
 * Money columns on `orders` (subtotal / making / gst / total / outstanding) are the *current* figures.
 * They are recomputed by recalcOrder() whenever something that affects them changes (payment, gold rate,
 * pricing rules) and are frozen the moment the order is delivered.
 */
const { q, tx } = require('../db');
const { bad, notFound, conflict, clock, addDays, isIsoDate, inr, num, str, round2, round3, pad } = require('../util');
const settings = require('./settings');
const goldRates = require('./goldrates');
const products = require('./products');
const pricing = require('./pricing');
const customers = require('./customers');

const OPEN = ['CONFIRMED', 'ADVANCE_RECEIVED', 'PARTIALLY_PAID', 'READY_FOR_DELIVERY', 'FULLY_PAID'];
const OPEN_SQL = OPEN.map((s) => `'${s}'`).join(',');
const METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
const EPS = 0.005;

const STATE_PHRASE = { DRAFT: 'still a draft', DELIVERED: 'already delivered', BILLED: 'already billed', CANCELLED: 'cancelled' };
const stateOf = (o) => STATE_PHRASE[o.status] || STATUS_LABELS[o.status].toLowerCase();

const STATUS_LABELS = {
  DRAFT: 'Draft', CONFIRMED: 'Confirmed', ADVANCE_RECEIVED: 'Advance Received', PARTIALLY_PAID: 'Partially Paid',
  READY_FOR_DELIVERY: 'Ready for Delivery', FULLY_PAID: 'Fully Paid', DELIVERED: 'Delivered',
  BILLED: 'Final Bill Generated', CANCELLED: 'Cancelled',
};

// ------------------------------------------------------------------ loading
function orderRow(id) {
  const o = q.get('SELECT * FROM orders WHERE id = ?', id);
  if (!o) throw notFound('Order');
  return o;
}
const itemsOf = (orderId) => q.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', orderId);
const paymentsOf = (orderId) => q.all('SELECT * FROM payments WHERE order_id = ? ORDER BY payment_date, id', orderId);

function logEvent(orderId, type, message) {
  q.run('INSERT INTO order_events (order_id, event_type, message, created_at) VALUES (?, ?, ?, ?)', orderId, type, message, clock.timestamp());
}

// ------------------------------------------------------------------ pricing
const lineNetWeight = (it) => round3(it.net_gold_weight * it.quantity);

function toPricingItems(items, rateFor) {
  return items.map((it) => ({
    quantity: it.quantity,
    net_weight: lineNetWeight(it),
    making_method: it.making_method,
    making_rate: it.making_rate,
    rate: rateFor(it),
    fixed_making: it.making_charge, // the quoted amount; used only when the rule says "fixed from order date"
  }));
}

/** Rules + rates that apply to this order right now (frozen once delivered). */
function pricingContext(order) {
  if (['DELIVERED', 'BILLED'].includes(order.status) && order.pricing_snapshot) {
    const snap = JSON.parse(order.pricing_snapshot);
    return { frozen: true, rules: snap.rules, rateFor: (it) => it.settled_gold_rate ?? it.gold_rate };
  }
  const rules = settings.getRules();
  const today = clock.today();
  return {
    frozen: false,
    rules,
    rateFor: (it) => (rules.gold_rate_settlement === 'delivery_date_rate' ? goldRates.getRate(it.purity, today) : it.gold_rate),
  };
}

function financials(order, items, payments, ctx) {
  const priced = pricing.priceOrder({ items: toPricingItems(items, ctx.rateFor), otherCharges: order.other_charges, rules: ctx.rules });
  const settleRate = ctx.rateFor(items[0]);
  const cr = pricing.computeCredit(payments, ctx.rules, settleRate);
  const balance = round2(priced.total - cr.credit);
  return {
    priced, settleRate, paid: cr.paid, credit: cr.credit, gold_equivalent: cr.gold_equivalent,
    outstanding: Math.max(balance, 0), excess: Math.max(-balance, 0),
  };
}

function deriveStatus(order, f, minAdvancePercent) {
  if (!OPEN.includes(order.status)) return order.status;
  if (f.paid > 0 && f.outstanding <= EPS) return 'FULLY_PAID';
  if (order.is_ready) return 'READY_FOR_DELIVERY';
  if (f.paid > 0) {
    const required = (order.estimated_total * minAdvancePercent) / 100;
    return f.paid + EPS >= required ? 'PARTIALLY_PAID' : 'ADVANCE_RECEIVED';
  }
  return 'CONFIRMED';
}

/** A delivered order still carries a balance ("delivered on credit") until it is repaid down to zero. */
const isCreditOutstanding = (order) => order.status === 'DELIVERED' && order.outstanding_amount > EPS;

/** Re-derives amounts, outstanding balance and status of one open order. Returns true if the total moved.
 *  A delivered-on-credit order only has its paid/outstanding figures refreshed — its price is frozen. */
function recalcOrder(id, reason = null) {
  const order = orderRow(id);
  if (isCreditOutstanding(order)) {
    const items = itemsOf(id);
    const f = financials(order, items, paymentsOf(id), pricingContext(order));
    q.run('UPDATE orders SET paid_amount = ?, outstanding_amount = ?, updated_at = ? WHERE id = ?', f.paid, f.outstanding, clock.timestamp(), id);
    if (f.outstanding <= EPS) logEvent(id, 'CREDIT_CLEARED', 'Credit fully repaid — ready for the final bill');
    return false;
  }
  if (!OPEN.includes(order.status)) return false;
  const items = itemsOf(id);
  const ctx = pricingContext(order);
  const f = financials(order, items, paymentsOf(id), ctx);
  const status = deriveStatus(order, f, settings.getAll().min_advance_percent);
  const p = f.priced;
  q.run(
    `UPDATE orders SET status = ?, subtotal = ?, making_charge = ?, gst = ?, round_off = ?, total_amount = ?,
       paid_amount = ?, credit_applied = ?, outstanding_amount = ?, applied_gold_rate = ?, updated_at = ? WHERE id = ?`,
    status, p.gold_value, p.making_charge, p.gst, p.round_off, p.total, f.paid, f.credit, f.outstanding, f.settleRate, clock.timestamp(), id);
  const moved = Math.abs(p.total - order.total_amount) > EPS;
  if (moved && reason) logEvent(id, 'REPRICED', `Amount payable re-priced ${inr(order.total_amount)} → ${inr(p.total)} (${reason})`);
  if (status !== order.status) logEvent(id, 'STATUS', `Status changed to ${STATUS_LABELS[status]}${reason ? ` (${reason})` : ''}`);
  return moved;
}

/** Called after a gold-rate or pricing-rule change. Returns how many open orders were re-priced. */
function recalcOpenOrders(reason) {
  const ids = q.all(`SELECT id FROM orders WHERE status IN (${OPEN_SQL})`).map((r) => r.id);
  let moved = 0;
  for (const id of ids) if (recalcOrder(id, reason)) moved++;
  return moved;
}

// -------------------------------------------------------------------- quote
function normalizeLines(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw bad('Add at least one product to the order');
  const merged = new Map();
  for (const raw of rawItems) {
    const productId = num(raw.product_id, 'Product', { integer: true, min: 1 });
    const quantity = num(raw.quantity ?? 1, 'Quantity', { integer: true, min: 1, max: 100 });
    merged.set(productId, (merged.get(productId) || 0) + quantity);
  }
  return [...merged].map(([product_id, quantity]) => ({ product_id, quantity }));
}

function buildQuote(rawItems, otherChargesInput) {
  const lines = normalizeLines(rawItems);
  const rules = settings.getRules();
  const today = clock.today();
  const rows = lines.map((l) => {
    const product = products.getProduct(l.product_id);
    if (product.status !== 'active') throw conflict(`${product.name} is inactive and cannot be ordered`);
    return { product, quantity: l.quantity, rate: goldRates.getRate(product.purity, today) };
  });
  const otherCharges = otherChargesInput == null || otherChargesInput === ''
    ? rules.default_other_charges
    : num(otherChargesInput, 'Other charges', { min: 0 });
  const priced = pricing.priceOrder({
    items: rows.map((r) => ({
      quantity: r.quantity,
      net_weight: round3(r.product.net_gold_weight * r.quantity),
      making_method: rules.making_charge_method,
      making_rate: r.product.making_charge,
      rate: r.rate,
    })),
    otherCharges,
    rules,
  });
  return { rules, rows, priced, otherCharges, today };
}

function previewOrder(input) {
  const quote = buildQuote(input.items, input.other_charges);
  const pct = settings.getAll().min_advance_percent;
  return {
    order_date: quote.today,
    rules: settings.describe(quote.rules),
    other_charges: quote.priced.other_charges,
    lines: quote.rows.map((r, i) => ({
      product_id: r.product.id, name: r.product.name, sku: r.product.sku, purity: r.product.purity, image: r.product.image,
      quantity: r.quantity, gross_weight: r.product.gross_weight, stone_weight: r.product.stone_weight,
      net_weight_each: r.product.net_gold_weight, net_weight_total: round3(r.product.net_gold_weight * r.quantity),
      making_method: quote.rules.making_charge_method, making_rate: r.product.making_charge,
      available: r.product.available_quantity, shortage: r.product.available_quantity < r.quantity,
      ...quote.priced.lines[i],
    })),
    totals: {
      gold_value: quote.priced.gold_value, making_charge: quote.priced.making_charge, other_charges: quote.priced.other_charges,
      gst: quote.priced.gst, round_off: quote.priced.round_off, total: quote.priced.total,
    },
    min_advance_percent: pct,
    min_advance_amount: Math.ceil((quote.priced.total * pct) / 100),
  };
}

// ------------------------------------------------------------------ create
function nextOrderNumber() {
  const prefix = `ORD-${clock.today().slice(0, 4)}-`;
  const last = q.get('SELECT order_number FROM orders WHERE order_number LIKE ? ORDER BY id DESC LIMIT 1', prefix + '%');
  const seq = last ? Number(last.order_number.slice(prefix.length)) + 1 : 1;
  return prefix + pad(seq, 4);
}

function resolveCustomer(input) {
  if (input.customer_id) {
    if (!q.get('SELECT id FROM customers WHERE id = ?', Number(input.customer_id))) throw bad('Customer not found');
    return Number(input.customer_id);
  }
  if (input.customer && input.customer.phone) {
    const existing = customers.findByPhone(input.customer.phone);
    return existing ? existing.id : customers.create(input.customer).id;
  }
  throw bad('Select a customer (search by phone number) or enter new customer details');
}

function checkAvailability(rows) {
  for (const r of rows) {
    const p = products.getProduct(r.product_id ?? r.product.id);
    if (p.available_quantity < r.quantity) {
      throw conflict(`${p.name}: only ${p.available_quantity} available (${p.reserved_quantity} reserved for other orders). Restock it in Inventory first.`,
        { product_id: p.id, available: p.available_quantity });
    }
  }
}

function insertItem(orderId, row, quoteLine, rules) {
  const p = row.product;
  q.run(
    `INSERT INTO order_items (order_id, product_id, product_name, sku, barcode, metal_type, purity, quantity, gross_weight, stone_weight,
       making_method, making_rate, gold_rate, gold_value, making_charge, gst, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    orderId, p.id, p.name, p.sku, p.barcode, p.metal_type, p.purity, row.quantity, p.gross_weight, p.stone_weight,
    rules.making_charge_method, p.making_charge, quoteLine.gold_rate, quoteLine.gold_value, quoteLine.making_charge, quoteLine.gst, quoteLine.total);
}

function createOrder(input) {
  return tx(() => {
    const draft = input.mode === 'draft';
    const customerId = resolveCustomer(input);
    const quote = buildQuote(input.items, input.other_charges);
    if (!draft) checkAvailability(quote.rows);

    const orderDate = quote.today;
    const expected = input.expected_delivery_date || addDays(orderDate, 7);
    if (!isIsoDate(expected) || expected < orderDate) throw bad('Expected delivery date cannot be before the order date');

    const p = quote.priced;
    const primaryRate = quote.rows[0].rate;
    const now = clock.timestamp();
    const estimate = {
      rules: quote.rules, gold_rate: primaryRate, gold_value: p.gold_value, making_charge: p.making_charge,
      other_charges: p.other_charges, gst: p.gst, round_off: p.round_off, total: p.total,
    };
    const res = q.run(
      `INSERT INTO orders (order_number, customer_id, status, order_date, expected_delivery_date, order_gold_rate, applied_gold_rate,
         subtotal, making_charge, gst, other_charges, other_charges_note, round_off, total_amount, estimated_total, outstanding_amount,
         estimate_json, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nextOrderNumber(), customerId, draft ? 'DRAFT' : 'CONFIRMED', orderDate, expected, primaryRate, primaryRate,
      p.gold_value, p.making_charge, p.gst, p.other_charges, str(input.other_charges_note), p.round_off, p.total, p.total, p.total,
      JSON.stringify(estimate), str(input.notes), now, now);
    const orderId = Number(res.lastInsertRowid);
    quote.rows.forEach((row, i) => insertItem(orderId, row, p.lines[i], quote.rules));

    const number = orderRow(orderId).order_number;
    if (draft) {
      logEvent(orderId, 'CREATED', `Draft saved — estimated ${inr(p.total)} at ${inr(primaryRate)}/g`);
      return getOrder(orderId);
    }
    confirmStock(orderId, number, quote.rows);
    logEvent(orderId, 'CONFIRMED', `Order confirmed — estimated ${inr(p.total)} at ${inr(primaryRate)}/g (${quote.rows.length} item${quote.rows.length > 1 ? 's' : ''})`);
    if (input.advance && Number(input.advance.amount) > 0) addPayment(orderId, input.advance);
    recalcOrder(orderId);
    return getOrder(orderId);
  });
}

function confirmStock(orderId, number, rows) {
  for (const r of rows) products.reserve(r.product?.id ?? r.product_id, r.quantity, orderId, `Reserved for ${number}`);
}

/** Turn a saved draft into a real order: re-quote at today's rates, reserve stock, optionally take an advance. */
function confirmDraft(id, input = {}) {
  return tx(() => {
    const order = orderRow(id);
    if (order.status !== 'DRAFT') throw conflict('Only draft orders can be confirmed');
    const items = itemsOf(id);
    checkAvailability(items);
    const rules = settings.getRules();
    const today = clock.today();
    const rateFor = (it) => goldRates.getRate(it.purity, today);
    const priced = pricing.priceOrder({
      items: items.map((it) => ({
        quantity: it.quantity, net_weight: lineNetWeight(it), making_method: it.making_method, making_rate: it.making_rate, rate: rateFor(it),
      })),
      otherCharges: order.other_charges,
      rules,
    });
    items.forEach((it, i) => {
      const l = priced.lines[i];
      q.run('UPDATE order_items SET gold_rate = ?, gold_value = ?, making_charge = ?, gst = ?, total = ? WHERE id = ?', l.gold_rate, l.gold_value, l.making_charge, l.gst, l.total, it.id);
    });
    const expected = input.expected_delivery_date || (order.expected_delivery_date >= today ? order.expected_delivery_date : addDays(today, 7));
    if (!isIsoDate(expected) || expected < today) throw bad('Expected delivery date cannot be before today');
    const primaryRate = priced.lines[0].gold_rate;
    const estimate = { rules, gold_rate: primaryRate, gold_value: priced.gold_value, making_charge: priced.making_charge, other_charges: priced.other_charges, gst: priced.gst, round_off: priced.round_off, total: priced.total };
    q.run(
      `UPDATE orders SET status = 'CONFIRMED', order_date = ?, expected_delivery_date = ?, order_gold_rate = ?, applied_gold_rate = ?, estimated_total = ?,
         total_amount = ?, outstanding_amount = ?, estimate_json = ?, updated_at = ? WHERE id = ?`,
      today, expected, primaryRate, primaryRate, priced.total, priced.total, priced.total, JSON.stringify(estimate), clock.timestamp(), id);
    confirmStock(id, order.order_number, items);
    logEvent(id, 'CONFIRMED', `Draft confirmed — estimated ${inr(priced.total)} at ${inr(primaryRate)}/g`);
    if (input.advance && Number(input.advance.amount) > 0) addPayment(id, input.advance);
    recalcOrder(id);
    return getOrder(id);
  });
}

function deleteDraft(id) {
  return tx(() => {
    if (orderRow(id).status !== 'DRAFT') throw conflict('Only draft orders can be deleted. Cancel the order instead.');
    q.run('DELETE FROM orders WHERE id = ?', id);
    return { deleted: true };
  });
}

// ---------------------------------------------------------------- payments
function addPayment(orderId, input) {
  return tx(() => {
    const order = orderRow(orderId);
    if (!OPEN.includes(order.status) && !isCreditOutstanding(order)) throw conflict(`Payments cannot be added: this order is ${stateOf(order)}`);
    const items = itemsOf(orderId);
    const amount = round2(num(input.amount, 'Payment amount', { min: 0.01 }));
    if (!METHODS.includes(input.payment_method)) throw bad(`Payment method must be one of ${METHODS.join(', ')}`);
    const date = input.payment_date || clock.today();
    if (!isIsoDate(date)) throw bad('Payment date must be a valid date');
    if (date > clock.today()) throw bad('Payment date cannot be in the future');
    if (date < order.order_date) throw bad('Payment date cannot be before the order date');

    // Informational gold equivalent, kept at full precision. The rupee amount stays the authoritative record.
    const purity = items[0].purity;
    const rate = goldRates.getRate(purity, date);
    const goldEquivalent = amount / rate;

    const ctx = pricingContext(order);
    const existing = paymentsOf(orderId);
    const before = financials(order, items, existing, ctx);
    const after = financials(order, items, [...existing, { amount, gold_equivalent: goldEquivalent }], ctx);
    if (after.excess > EPS) {
      throw conflict(`${inr(amount)} is more than the ${inr(before.outstanding)} due on this order.`, { outstanding: before.outstanding });
    }

    q.run(
      `INSERT INTO payments (order_id, amount, payment_method, payment_date, gold_rate_at_payment, gold_purity, gold_equivalent, reference_number, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId, amount, input.payment_method, date, rate, purity, goldEquivalent, str(input.reference_number), str(input.notes), clock.timestamp());
    logEvent(orderId, 'PAYMENT', `Payment of ${inr(amount)} received via ${input.payment_method}${input.reference_number ? ` (ref ${str(input.reference_number)})` : ''} — ${round3(goldEquivalent)} g equivalent at ${inr(rate)}/g`);
    recalcOrder(orderId);
    return getOrder(orderId);
  });
}

function updateDeliveryDate(id, date) {
  return tx(() => {
    const order = orderRow(id);
    if (!OPEN.includes(order.status)) throw conflict(`Cannot change the delivery date: this order is ${stateOf(order)}`);
    if (!isIsoDate(date)) throw bad('Enter a valid delivery date');
    if (date < order.order_date) throw bad('Delivery date cannot be before the order date');
    if (date !== order.expected_delivery_date) {
      q.run('UPDATE orders SET expected_delivery_date = ?, updated_at = ? WHERE id = ?', date, clock.timestamp(), id);
      logEvent(id, 'DELIVERY_DATE', `Expected delivery date changed from ${order.expected_delivery_date} to ${date}`);
    }
    return getOrder(id);
  });
}

function setReady(id, ready) {
  return tx(() => {
    const order = orderRow(id);
    if (!OPEN.includes(order.status)) throw conflict(`Cannot change the ready mark: this order is ${stateOf(order)}`);
    q.run('UPDATE orders SET is_ready = ?, updated_at = ? WHERE id = ?', ready ? 1 : 0, clock.timestamp(), id);
    logEvent(id, 'READY', ready ? 'Marked ready for delivery' : 'Ready-for-delivery mark removed');
    recalcOrder(id);
    return getOrder(id);
  });
}

// ---------------------------------------------------------------- delivery
/**
 * Final settlement. Optionally takes the last payment in the same step ("Settle & Deliver").
 * If money is still owed after that payment, the shop can hand the piece over anyway by marking it
 * delivered "on credit" with a repayment due date — the order stays open for further payments until
 * the balance reaches zero, at which point the final bill can be generated. Otherwise delivery is
 * blocked and everything rolls back.
 */
function deliver(id, input = {}) {
  return tx(() => {
    let order = orderRow(id);
    if (!OPEN.includes(order.status)) throw conflict(`Cannot deliver: this order is ${stateOf(order)}`);
    recalcOrder(id); // bring figures up to today's rate before settling
    const pay = input.payment;
    if (pay && Number(pay.amount) > 0) addPayment(id, pay);

    order = orderRow(id);
    const items = itemsOf(id);
    const ctx = pricingContext(order);
    const f = financials(order, items, paymentsOf(id), ctx);
    const onCredit = f.outstanding > EPS;
    let creditDueDate = null;
    if (onCredit) {
      creditDueDate = input.credit?.due_date;
      if (!input.credit) throw conflict(`${inr(f.outstanding)} is still due at today's gold rate. Take full payment, or hand it over on credit with a repayment date.`, { outstanding: f.outstanding });
      if (!isIsoDate(creditDueDate) || creditDueDate <= clock.today()) throw bad('Credit repayment date must be a valid date after today');
    }

    const today = clock.today();
    const rates = {};
    items.forEach((it, i) => {
      const l = f.priced.lines[i];
      q.run(
        `UPDATE order_items SET settled_gold_rate = ?, settled_gold_value = ?, settled_making_charge = ?, settled_gst = ?, settled_total = ? WHERE id = ?`,
        l.gold_rate, l.gold_value, l.making_charge, l.gst, l.total, it.id);
      rates[it.purity] = l.gold_rate;
    });
    const p = f.priced;
    q.run(
      `UPDATE orders SET status = 'DELIVERED', actual_delivery_date = ?, delivery_gold_rate = ?, applied_gold_rate = ?,
         subtotal = ?, making_charge = ?, gst = ?, round_off = ?, total_amount = ?, paid_amount = ?, credit_applied = ?, outstanding_amount = ?,
         credit_due_date = ?, pricing_snapshot = ?, updated_at = ? WHERE id = ?`,
      today, f.settleRate, f.settleRate, p.gold_value, p.making_charge, p.gst, p.round_off, p.total, f.paid, f.credit, f.outstanding,
      creditDueDate, JSON.stringify({ rules: ctx.rules, rates, frozen_at: clock.timestamp() }), clock.timestamp(), id);

    for (const it of items) products.sell(it.product_id, it.quantity, id, `Delivered on ${order.order_number}`);
    logEvent(id, 'DELIVERED', onCredit
      ? `Delivered on credit — settled at ${inr(f.settleRate)}/g, ${inr(f.outstanding)} owed, repayment due ${creditDueDate}`
      : `Delivered — settled at ${inr(f.settleRate)}/g, final amount ${inr(p.total)}`);
    return getOrder(id);
  });
}

/** Change the repayment due date on an order delivered on credit. */
function updateCreditDueDate(id, date) {
  return tx(() => {
    const order = orderRow(id);
    if (!isCreditOutstanding(order)) throw conflict('This order has no credit balance to schedule a repayment for');
    if (!isIsoDate(date)) throw bad('Enter a valid repayment date');
    q.run('UPDATE orders SET credit_due_date = ?, updated_at = ? WHERE id = ?', date, clock.timestamp(), id);
    logEvent(id, 'CREDIT_DUE_DATE', `Credit repayment date changed to ${date}`);
    return getOrder(id);
  });
}

function cancelOrder(id, reason) {
  return tx(() => {
    const order = orderRow(id);
    if (!OPEN.includes(order.status)) throw conflict(`Cannot cancel: this order is ${stateOf(order)}`);
    for (const it of itemsOf(id)) products.release(it.product_id, it.quantity, id, `Cancelled ${order.order_number}`);
    q.run(
      `UPDATE orders SET status = 'CANCELLED', is_ready = 0, outstanding_amount = 0, cancel_reason = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
      str(reason), clock.timestamp(), clock.timestamp(), id);
    const held = order.paid_amount > 0 ? ` ${inr(order.paid_amount)} already received stays in the payment history and must be refunded or adjusted outside this demo.` : '';
    logEvent(id, 'CANCELLED', `Order cancelled${reason ? ` — ${str(reason)}` : ''}. Reserved stock released.${held}`);
    return getOrder(id);
  });
}

// ------------------------------------------------------------------- views
const paymentStatus = (o) => (o.paid_amount <= 0 ? 'UNPAID' : o.outstanding_amount <= EPS ? 'FULLY_PAID' : 'PARTIALLY_PAID');

function dueFlag(o, today, soonDays) {
  if (!OPEN.includes(o.status) || o.outstanding_amount <= EPS || !o.expected_delivery_date) return null;
  if (o.expected_delivery_date < today) return 'OVERDUE';
  if (o.expected_delivery_date === today) return 'DUE_TODAY';
  if (o.expected_delivery_date <= addDays(today, soonDays)) return 'DUE_SOON';
  return null;
}

/** A delivered order still owing money ("delivered on credit") is judged against its repayment date, not the delivery date. */
function creditDueFlag(o, today, soonDays) {
  if (!isCreditOutstanding(o) || !o.credit_due_date) return null;
  if (o.credit_due_date < today) return 'OVERDUE';
  if (o.credit_due_date === today) return 'DUE_TODAY';
  if (o.credit_due_date <= addDays(today, soonDays)) return 'DUE_SOON';
  return null;
}

function decorateOrder(o, s = settings.getAll(), today = clock.today()) {
  const credit = isCreditOutstanding(o);
  return {
    ...o,
    status_label: STATUS_LABELS[o.status],
    payment_status: paymentStatus(o),
    due_flag: credit ? creditDueFlag(o, today, s.due_soon_days) : dueFlag(o, today, s.due_soon_days),
    is_overdue: (OPEN.includes(o.status) && !!o.expected_delivery_date && o.expected_delivery_date < today) || (credit && !!o.credit_due_date && o.credit_due_date < today),
    is_credit: credit,
    days_to_delivery: o.expected_delivery_date ? Math.round((new Date(o.expected_delivery_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null,
    days_to_credit_due: o.credit_due_date ? Math.round((new Date(o.credit_due_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null,
  };
}

function listOrders(f = {}) {
  const today = clock.today();
  const where = [];
  const params = [];
  const view = f.view || 'all';
  if (view === 'open') where.push(`o.status IN (${OPEN_SQL})`);
  else if (view === 'outstanding') where.push(`o.status IN (${OPEN_SQL}) AND o.outstanding_amount > 0.005`);
  else if (view === 'overdue') { where.push(`o.status IN (${OPEN_SQL}) AND o.expected_delivery_date < ?`); params.push(today); }
  else if (view === 'ready') where.push(`o.status IN (${OPEN_SQL}) AND o.is_ready = 1`);
  else if (view === 'awaiting_bill') where.push("o.status = 'DELIVERED'");
  else if (view === 'completed') where.push("o.status IN ('DELIVERED','BILLED')");
  else if (view === 'credit') where.push("o.status = 'DELIVERED' AND o.outstanding_amount > 0.005");
  if (f.status) { where.push('o.status = ?'); params.push(f.status); }
  if (f.customer_id) { where.push('o.customer_id = ?'); params.push(Number(f.customer_id)); }
  if (f.from) { where.push('o.order_date >= ?'); params.push(f.from); }
  if (f.to) { where.push('o.order_date <= ?'); params.push(f.to); }
  if (f.q) {
    where.push('(o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_name LIKE ?))');
    params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderBy = {
    order_date: 'o.order_date DESC, o.id DESC',
    delivery: "(o.expected_delivery_date IS NULL), o.expected_delivery_date ASC, o.id DESC",
    outstanding: 'o.outstanding_amount DESC',
    customer: 'c.name COLLATE NOCASE ASC, o.id DESC',
    overdue: '(o.expected_delivery_date < @today) DESC, o.expected_delivery_date ASC',
    credit_due: '(o.credit_due_date IS NULL), o.credit_due_date ASC',
  }[f.sort] || 'o.id DESC';
  const sortParams = f.sort === 'overdue' ? [today] : [];
  const sql = `
    FROM orders o JOIN customers c ON c.id = o.customer_id ${clause}`;
  const total = q.get(`SELECT COUNT(*) AS n ${sql}`, ...params).n;
  const limit = Math.min(Number(f.limit) || 100, 500);
  const rows = q.all(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
       (SELECT group_concat(oi.product_name || CASE WHEN oi.quantity > 1 THEN ' ×' || oi.quantity ELSE '' END, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS products,
       (SELECT ROUND(SUM(oi.net_gold_weight * oi.quantity), 3) FROM order_items oi WHERE oi.order_id = o.id) AS gold_weight,
       (SELECT b.id FROM bills b WHERE b.order_id = o.id) AS bill_id
     ${sql} ORDER BY ${orderBy.replace('@today', '?')} LIMIT ? OFFSET ?`,
    ...params, ...sortParams, limit, Math.max(Number(f.offset) || 0, 0));
  const s = settings.getAll();
  return { items: rows.map((r) => decorateOrder(r, s, today)), total };
}

function paymentKind(payments, i, order) {
  if (i === 0 && payments.length > 1) return 'Advance';
  if (i === payments.length - 1 && ['DELIVERED', 'BILLED'].includes(order.status)) return payments.length === 1 ? 'Full payment' : 'Final payment';
  return i === 0 ? 'Advance' : 'Part payment';
}

/** Applies `credit` against ordered cost buckets, gold first — so a jeweller can see the remaining
 *  balance the way they think about it: grams of gold still owed, then making charge, then GST.
 *  Display only: the stored outstanding/credit figures are unaffected and still follow whichever
 *  advance_treatment rule is configured. */
function allocateRemaining(credit, buckets) {
  let left = credit;
  const remaining = {};
  for (const [key, amount] of Object.entries(buckets)) {
    const applied = Math.min(left, amount);
    remaining[key] = round2(amount - applied);
    left = round2(left - applied);
  }
  return remaining;
}

function buildSettlement(order, items, payments) {
  const ctx = pricingContext(order);
  const f = financials(order, items, payments, ctx);
  const estimate = order.estimate_json ? JSON.parse(order.estimate_json) : null;
  const p = f.priced;
  const orderRate = order.order_gold_rate;
  const remaining = allocateRemaining(f.credit, { gold_value: p.gold_value, making_charge: p.making_charge, gst: p.gst, other_charges: p.other_charges });
  const remainingGoldWeight = round3(remaining.gold_value / f.settleRate);
  return {
    is_final: ctx.frozen,
    basis: ctx.frozen ? 'Final settlement (locked at delivery)' : (ctx.rules.gold_rate_settlement === 'delivery_date_rate' ? "Live settlement at today's gold rate — becomes final on delivery" : 'Settlement at the order-date gold rate'),
    rules: settings.describe(ctx.rules),
    original: estimate && {
      gold_rate: estimate.gold_rate, gold_value: estimate.gold_value, making_charge: estimate.making_charge,
      other_charges: estimate.other_charges, gst: estimate.gst, round_off: estimate.round_off, total: order.estimated_total,
      rules: settings.describe(estimate.rules),
    },
    payments: {
      count: payments.length, total_paid: f.paid, gold_equivalent: f.gold_equivalent,
      credit_applied: f.credit, treatment: ctx.rules.advance_treatment,
    },
    delivery: {
      gold_rate: f.settleRate, order_gold_rate: orderRate, rate_change: round2(f.settleRate - orderRate),
      gold_value: p.gold_value, making_charge: p.making_charge, other_charges: p.other_charges, gst: p.gst, round_off: p.round_off,
      total: p.total, previous_payments: f.credit, amount_payable: p.total, outstanding: f.outstanding, excess_paid: f.excess,
      change_vs_estimate: round2(p.total - order.estimated_total),
      remaining: f.outstanding > 0.005 ? {
        gold_weight: remainingGoldWeight, gold_value: remaining.gold_value, making_charge: remaining.making_charge,
        gst: remaining.gst, other_charges: remaining.other_charges,
        round_off: round2(remaining.gold_value - round2(remainingGoldWeight * f.settleRate)),
      } : null,
    },
    lines: items.map((it, i) => ({
      item_id: it.id, name: it.product_name, quantity: it.quantity, net_weight: lineNetWeight(it),
      original_gold_value: it.gold_value, original_making_charge: it.making_charge, original_total: it.total,
      gold_value: p.lines[i].gold_value, making_charge: p.lines[i].making_charge, gst: p.lines[i].gst, total: p.lines[i].total,
    })),
  };
}

function availableActions(order, settlement) {
  switch (order.status) {
    case 'DRAFT': return ['confirm', 'delete'];
    case 'DELIVERED': return settlement.delivery.outstanding <= EPS ? ['generate_bill'] : ['add_payment', 'edit_credit_due_date'];
    case 'BILLED': return ['view_bill'];
    case 'CANCELLED': return [];
    default: return [
      ...(settlement.delivery.outstanding > EPS ? ['add_payment'] : []),
      order.is_ready ? 'unmark_ready' : 'mark_ready',
      'edit_delivery_date', 'deliver', 'cancel',
    ];
  }
}

function getOrder(id) {
  const order = orderRow(id);
  const items = itemsOf(id);
  const payments = paymentsOf(id);
  const settlement = buildSettlement(order, items, payments);
  return {
    order: decorateOrder(order),
    customer: customers.getSummary(order.customer_id),
    items: items.map((it) => ({ ...it, net_weight_total: lineNetWeight(it), image: products.getProduct(it.product_id).image })),
    payments: payments.map((p, i) => ({ ...p, kind: paymentKind(payments, i, order) })),
    settlement,
    events: q.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', id),
    stock_movements: products.movements({ order_id: id }).items,
    bill: q.get('SELECT id, bill_number, bill_date FROM bills WHERE order_id = ?', id) || null,
    actions: availableActions(order, settlement),
  };
}

module.exports = {
  OPEN, METHODS, STATUS_LABELS, EPS,
  previewOrder, createOrder, confirmDraft, deleteDraft, addPayment, setReady, updateDeliveryDate, deliver, updateCreditDueDate, cancelOrder,
  getOrder, listOrders, recalcOrder, recalcOpenOrders, orderRow, itemsOf, paymentsOf, logEvent, pricingContext, financials,
};
