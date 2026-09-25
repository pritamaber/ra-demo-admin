'use strict';
/**
 * The Order is the central transaction. Everything else hangs off it:
 *   customer -> order -> items (stock) -> payments -> delivery -> final bill.
 *
 * Lifecycle:   Placed -> Accepted -> Ready -> Delivered   (or Cancelled while still open)
 * Payments:    tracked separately as Unpaid / Partly paid / Paid; any number of payments, in any amounts.
 * Gold:        every payment buys gold at its own day's rate; the gold still unpaid is valued at today's rate
 *              (see pricing.js). The order's current figures are refreshed whenever the gold rate moves.
 * Delivery:    needs the balance to be zero; the final bill is created automatically at that moment.
 */
const { q, tx } = require('../db');
const { bad, notFound, conflict, clock, addDays, isIsoDate, inr, num, str, round2, round3, pad } = require('../util');
const settings = require('./settings');
const goldRates = require('./goldrates');
const products = require('./products');
const pricing = require('./pricing');
const customers = require('./customers');

const OPEN = ['PLACED', 'ACCEPTED', 'READY'];
const OPEN_SQL = OPEN.map((s) => `'${s}'`).join(',');
const METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
const EPS = 0.005;

const STATUS_LABELS = { PLACED: 'Order Placed', ACCEPTED: 'Accepted', READY: 'Ready for Delivery', DELIVERED: 'Delivered', CANCELLED: 'Cancelled' };
const STATE_PHRASE = { DELIVERED: 'already delivered', CANCELLED: 'cancelled' };
const stateOf = (o) => STATE_PHRASE[o.status] || STATUS_LABELS[o.status].toLowerCase();

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

const lineNetWeight = (it) => round3(it.net_gold_weight * it.quantity);
const netWeightTotal = (items) => round3(items.reduce((sum, it) => sum + lineNetWeight(it), 0));

/** Value of the WHOLE order's gold on `date` at that day's market rate for each purity — so a gold-rate change is
 *  picked up straight away, even on the day the order was placed. The one exception is a rate the shopkeeper
 *  negotiated for an item at booking: that is kept for the order date itself. */
function goldValueOn(order, items, date) {
  return round2(items.reduce((sum, it) => {
    const rate = it.gold_rate_locked && date <= order.order_date ? it.gold_rate : goldRates.getRate(it.purity, date);
    return sum + lineNetWeight(it) * rate;
  }, 0));
}

/** Where the order stands on `date` (default today): gold paid so far, gold still owed at that day's rate, total, balance. */
function settlementOf(order, items, payments, date = clock.today()) {
  return pricing.settle({
    netWeight: netWeightTotal(items), goldValueToday: goldValueOn(order, items, date),
    makingCharge: order.making_charge, otherCharges: order.other_charges, gstRate: order.gst_rate, payments,
  });
}

/** Brings an open order's current figures up to today's gold rate. Returns true if the total moved. */
function recalcOrder(id, reason = null) {
  const order = orderRow(id);
  if (!OPEN.includes(order.status)) return false;
  const st = settlementOf(order, itemsOf(id), paymentsOf(id));
  const next = { subtotal: st.gold_value, gst: st.gst, round_off: st.round_off, total_amount: st.total, paid_amount: st.paid, outstanding_amount: st.outstanding };
  if (!Object.entries(next).some(([key, value]) => Math.abs(order[key] - value) > 0.0001)) return false;
  q.run('UPDATE orders SET subtotal = ?, gst = ?, round_off = ?, total_amount = ?, paid_amount = ?, outstanding_amount = ?, updated_at = ? WHERE id = ?',
    next.subtotal, next.gst, next.round_off, next.total_amount, next.paid_amount, next.outstanding_amount, clock.timestamp(), id);
  const moved = Math.abs(order.total_amount - st.total) > EPS;
  if (moved && reason) logEvent(id, 'REPRICED', `Unpaid gold valued at ${inr(st.gold_rate_today)}/g — total ${inr(order.total_amount)} → ${inr(st.total)} (${reason})`);
  return moved;
}

/** Called after a gold-rate change (with a reason) and before the owner's lists are read. Returns how many totals moved. */
function recalcOpenOrders(reason = null) {
  let moved = 0;
  for (const { id } of q.all(`SELECT id FROM orders WHERE status IN (${OPEN_SQL})`)) if (recalcOrder(id, reason)) moved++;
  return moved;
}

// ------------------------------------------------------------ agreed adjustments
/**
 * The shopkeeper can change what was agreed while taking a payment — e.g. the customer bargains the making charge
 * from ₹7,500 to ₹7,000. Only the making charge and the other charges can be edited; the gold always follows the rates.
 * `adjust` = { making_charge?, other_charges? } (the new TOTAL for the order). Returns what would change.
 */
function parseAdjustment(order, adjust) {
  const out = {};
  if (!adjust) return out;
  if (adjust.making_charge != null && adjust.making_charge !== '') {
    const v = round2(num(adjust.making_charge, 'Making charge', { min: 0 }));
    if (Math.abs(v - order.making_charge) > EPS) out.making_charge = v;
  }
  if (adjust.other_charges != null && adjust.other_charges !== '') {
    const v = round2(num(adjust.other_charges, 'Other charges', { min: 0 }));
    if (Math.abs(v - order.other_charges) > EPS) out.other_charges = v;
  }
  return out;
}

/** Spreads a new making-charge total over the items in proportion to what each carried. */
function scaleItemMaking(items, total) {
  const current = items.reduce((sum, it) => sum + it.making_charge, 0);
  const weight = netWeightTotal(items) || 1;
  let left = total;
  items.forEach((it, i) => {
    const share = current > 0 ? it.making_charge / current : lineNetWeight(it) / weight;
    const value = i === items.length - 1 ? left : round2(total * share);
    left = round2(left - value);
    q.run('UPDATE order_items SET making_charge = ? WHERE id = ?', value, it.id);
  });
}

function applyAdjustment(orderId, adjust, reason = null) {
  const order = orderRow(orderId);
  const change = parseAdjustment(order, adjust);
  if (!Object.keys(change).length) return false;
  const why = str(reason) ? ` (${str(reason)})` : ' (agreed with the customer)';
  if (change.making_charge != null) {
    scaleItemMaking(itemsOf(orderId), change.making_charge);
    q.run('UPDATE orders SET making_charge = ? WHERE id = ?', change.making_charge, orderId);
    logEvent(orderId, 'ADJUSTED', `Making charge changed ${inr(order.making_charge)} → ${inr(change.making_charge)}${why}`);
  }
  if (change.other_charges != null) {
    q.run('UPDATE orders SET other_charges = ? WHERE id = ?', change.other_charges, orderId);
    logEvent(orderId, 'ADJUSTED', `Other charges changed ${inr(order.other_charges)} → ${inr(change.other_charges)}${why}`);
  }
  recalcOrder(orderId);
  if (orderRow(orderId).paid_amount > orderRow(orderId).total_amount + EPS) {
    throw conflict('The new amounts are lower than what has already been paid. Adjust to at least the amount already received.');
  }
  return true;
}

/** What the order would look like with the given adjustment — nothing is saved. Powers the live breakup in the payment dialog. */
function previewSettlement(id, adjust) {
  const order = orderRow(id);
  if (!OPEN.includes(order.status)) throw conflict(`This order is ${stateOf(order)}`);
  const change = parseAdjustment(order, adjust);
  const items = itemsOf(id);
  const trial = { ...order, ...change };
  const settlement = buildSettlement(trial, items, paymentsOf(id));
  return { settlement, changed: Object.keys(change) };
}

// -------------------------------------------------------------------- quote
/**
 * Each line is a catalogue product plus optional per-order edits: name, description, purity, gross and stone
 * weight, making rate (₹/g) and gold rate (₹/g). Edits change only this order — never the catalogue product.
 */
function normalizeLines(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw bad('Add at least one product to the order');
  return rawItems.map((raw, i) => {
    const at = `Item ${i + 1}`;
    const line = {
      product_id: num(raw.product_id, `${at}: product`, { integer: true, min: 1 }),
      quantity: num(raw.quantity ?? 1, `${at}: quantity`, { integer: true, min: 1, max: 100 }),
    };
    const name = str(raw.name);
    if (name) line.name = name.slice(0, 150);
    const description = str(raw.description);
    if (description) line.description = description.slice(0, 500);
    if (raw.purity != null && raw.purity !== '') {
      if (!goldRates.PURITIES.includes(raw.purity)) throw bad(`${at}: purity must be one of ${goldRates.PURITIES.join(', ')}`);
      line.purity = raw.purity;
    }
    const numeric = (key, label, opts) => { if (raw[key] != null && raw[key] !== '') line[key] = num(raw[key], `${at}: ${label}`, opts); };
    numeric('gross_weight', 'gross weight', { min: 0.001, max: 100000 });
    numeric('stone_weight', 'stone weight', { min: 0, max: 100000 });
    numeric('making_rate', 'making charge', { min: 0 });
    numeric('gold_rate', 'gold rate', { min: 1 });
    return line;
  });
}

/** Price the given products at today's gold rate (unless a line carries its own rate). This is exactly what gets saved. */
function buildQuote(rawItems, otherChargesInput) {
  const lines = normalizeLines(rawItems);
  const gstRate = settings.getRules().gst_rate;
  const today = clock.today();
  const demand = new Map();
  for (const l of lines) demand.set(l.product_id, (demand.get(l.product_id) || 0) + l.quantity);
  const rows = lines.map((l, i) => {
    const product = products.getProduct(l.product_id);
    if (product.status !== 'active') throw conflict(`${product.name} is inactive and cannot be ordered`);
    const gross = round3(l.gross_weight ?? product.gross_weight);
    const stone = round3(l.stone_weight ?? product.stone_weight);
    if (stone > gross) throw bad(`Item ${i + 1}: stone weight cannot be more than the gross weight`);
    const net = round3(gross - stone);
    if (net <= 0) throw bad(`Item ${i + 1}: net gold weight must be above zero`);
    const purity = l.purity ?? product.purity;
    const rate = l.gold_rate ?? goldRates.getRate(purity, today);
    const making_rate = l.making_rate ?? product.making_charge;
    const name = l.name ?? product.name;
    const description = l.description ?? null;
    const edited = name !== product.name || purity !== product.purity || gross !== product.gross_weight || stone !== product.stone_weight
      || making_rate !== product.making_charge || l.gold_rate != null || description != null;
    return { product, quantity: l.quantity, name, description, purity, gross, stone, net, making_rate, rate, negotiated: l.gold_rate != null, edited, demand: demand.get(l.product_id) };
  });
  const otherCharges = otherChargesInput == null || otherChargesInput === '' ? 0 : num(otherChargesInput, 'Other charges', { min: 0 });
  const priced = pricing.priceOrder({
    items: rows.map((r) => ({ net_weight: round3(r.net * r.quantity), making_rate: r.making_rate, rate: r.rate })),
    otherCharges,
    gstRate,
  });
  return { gstRate, rows, priced, today };
}

function previewOrder(input) {
  const quote = buildQuote(input.items, input.other_charges);
  const p = quote.priced;
  return {
    order_date: quote.today,
    gst_rate: quote.gstRate,
    lines: quote.rows.map((r, i) => ({
      product_id: r.product.id, name: r.name, description: r.description, sku: r.product.sku, purity: r.purity, image: r.product.image,
      quantity: r.quantity, gross_weight: r.gross, stone_weight: r.stone,
      net_weight_each: r.net, net_weight_total: round3(r.net * r.quantity),
      making_rate: r.making_rate, edited: r.edited,
      available: r.product.available_quantity, shortage: r.product.available_quantity < r.demand,
      ...p.lines[i],
    })),
    totals: { gold_value: p.gold_value, making_charge: p.making_charge, other_charges: p.other_charges, gst: p.gst, round_off: p.round_off, total: p.total },
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
  const demand = new Map();
  for (const r of rows) demand.set(r.product.id, (demand.get(r.product.id) || 0) + r.quantity);
  for (const [productId, quantity] of demand) {
    const p = products.getProduct(productId);
    if (p.available_quantity < quantity) {
      throw conflict(`${p.name}: only ${p.available_quantity} available (${p.reserved_quantity} reserved for other orders). Restock it in Inventory first.`,
        { product_id: p.id, available: p.available_quantity });
    }
  }
}

function insertItem(orderId, row, line) {
  const p = row.product;
  q.run(
    `INSERT INTO order_items (order_id, product_id, product_name, description, sku, barcode, metal_type, purity, quantity, gross_weight, stone_weight,
       making_rate, gold_rate, gold_rate_locked, gold_value, making_charge, gst, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    orderId, p.id, row.name, row.description, p.sku, p.barcode, p.metal_type, row.purity, row.quantity, row.gross, row.stone,
    row.making_rate, line.gold_rate, row.negotiated ? 1 : 0, line.gold_value, line.making_charge, line.gst, line.total);
}

/**
 * Places an order: prices it at today's rate, reserves the stock and (optionally) records a first payment.
 * kind 'SALE' is a walk-in bill — created by sales.js, which pays and delivers it in the same step.
 */
function createOrder(input, kind = 'ORDER') {
  return tx(() => {
    const customerId = resolveCustomer(input);
    const quote = buildQuote(input.items, input.other_charges);
    checkAvailability(quote.rows);

    const orderDate = quote.today;
    const expected = input.expected_delivery_date || (kind === 'SALE' ? orderDate : addDays(orderDate, 7));
    if (!isIsoDate(expected) || expected < orderDate) throw bad('Delivery date cannot be before the order date');

    const p = quote.priced;
    const primaryRate = quote.rows[0].rate;
    const now = clock.timestamp();
    const res = q.run(
      `INSERT INTO orders (order_number, customer_id, kind, status, order_date, expected_delivery_date, order_gold_rate,
         subtotal, making_charge, gst, gst_rate, other_charges, other_charges_note, round_off, total_amount, booked_total, outstanding_amount, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nextOrderNumber(), customerId, kind, 'PLACED', orderDate, expected, primaryRate,
      p.gold_value, p.making_charge, p.gst, quote.gstRate, p.other_charges, str(input.other_charges_note), p.round_off, p.total, p.total, p.total,
      str(input.notes), now, now);
    const orderId = Number(res.lastInsertRowid);
    quote.rows.forEach((row, i) => insertItem(orderId, row, p.lines[i]));

    const number = orderRow(orderId).order_number;
    for (const r of quote.rows) products.reserve(r.product.id, r.quantity, orderId, `Reserved for ${number}`);
    logEvent(orderId, 'PLACED', `${kind === 'SALE' ? 'Bill started' : 'Order placed'} — ${inr(p.total)} at ${inr(primaryRate)}/g (${quote.rows.length} item${quote.rows.length > 1 ? 's' : ''}), delivery ${expected}`);
    const first = input.payment || input.advance;
    if (first && Number(first.amount) > 0) addPayment(orderId, first);
    return getOrder(orderId);
  });
}

// ---------------------------------------------------------------- lifecycle
/** The shop accepts a placed order. */
function acceptOrder(id) {
  return tx(() => {
    const order = orderRow(id);
    if (order.status !== 'PLACED') throw conflict(`Only a newly placed order can be accepted: this order is ${stateOf(order)}`);
    q.run("UPDATE orders SET status = 'ACCEPTED', updated_at = ? WHERE id = ?", clock.timestamp(), id);
    logEvent(id, 'ACCEPTED', 'Order accepted by the shop');
    return getOrder(id);
  });
}

/** The piece is prepared and waiting for the customer. `ready = false` undoes it. */
function setReady(id, ready = true) {
  return tx(() => {
    const order = orderRow(id);
    if (ready) {
      if (order.status === 'PLACED') throw conflict('Accept the order first, then mark it ready');
      if (order.status !== 'ACCEPTED') throw conflict(`Cannot mark ready: this order is ${stateOf(order)}`);
    } else if (order.status !== 'READY') throw conflict('This order is not marked ready');
    const status = ready ? 'READY' : 'ACCEPTED';
    q.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, clock.timestamp(), id);
    logEvent(id, 'READY', ready ? 'Marked ready for delivery' : 'Ready mark removed');
    return getOrder(id);
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
      logEvent(id, 'DELIVERY_DATE', `Delivery date changed from ${order.expected_delivery_date} to ${date}`);
    }
    return getOrder(id);
  });
}

// ---------------------------------------------------------------- payments
/**
 * A payment buys gold at that day's rate (grams = amount ÷ rate). Gold is paid first; once all the gold is paid for,
 * the rest goes towards making charge and GST. Never more than what is still due.
 */
function addPayment(orderId, input) {
  return tx(() => {
    const order = orderRow(orderId);
    if (!OPEN.includes(order.status)) throw conflict(`Payments cannot be added: this order is ${stateOf(order)}`);
    const amount = round2(num(input.amount, 'Payment amount', { min: 0.01 }));
    if (!METHODS.includes(input.payment_method)) throw bad(`Payment method must be one of ${METHODS.join(', ')}`);
    const date = input.payment_date || clock.today();
    if (!isIsoDate(date)) throw bad('Payment date must be a valid date');
    if (date > clock.today()) throw bad('Payment date cannot be in the future');
    if (date < order.order_date) throw bad('Payment date cannot be before the order date');

    if (input.adjust) applyAdjustment(orderId, input.adjust, input.adjust.reason);
    const items = itemsOf(orderId);
    const before = settlementOf(orderRow(orderId), items, paymentsOf(orderId));
    if (amount > before.outstanding + EPS) {
      throw conflict(`${inr(amount)} is more than the ${inr(before.outstanding)} due on this order.`, { outstanding: before.outstanding });
    }

    const weight = netWeightTotal(items);
    const goldValueNow = goldValueOn(order, items, date);
    const alloc = pricing.allocatePayment({ amount, goldFractionPaid: before.gold_paid_fraction, goldValueNow });
    q.run(
      `INSERT INTO payments (order_id, amount, payment_method, payment_date, gold_rate, gold_fraction, gold_amount, reference_number, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId, amount, input.payment_method, date, weight > 0 ? round2(goldValueNow / weight) : 0, alloc.gold_fraction, alloc.gold_amount,
      str(input.reference_number), str(input.notes), clock.timestamp());

    recalcOrder(orderId);
    const after = orderRow(orderId);
    const grams = round3(alloc.gold_fraction * weight);
    logEvent(orderId, 'PAYMENT',
      `Payment of ${inr(amount)} received via ${input.payment_method}${input.reference_number ? ` (ref ${str(input.reference_number)})` : ''}`
      + `${grams > 0 ? ` — bought ${grams.toFixed(3)} g of gold at ${inr(weight > 0 ? round2(goldValueNow / weight) : 0)}/g` : ''}`
      + ` — ${after.outstanding_amount > EPS ? `${inr(after.outstanding_amount)} still due` : 'paid in full'}`);
    return getOrder(orderId);
  });
}

// ---------------------------------------------------------------- delivery
/** Spreads the final gold value and GST across the order's items (by their booked value) for the bill. */
function settleItems(order, items, st) {
  const bookedGold = items.reduce((sum, it) => sum + it.gold_value, 0) || 1;
  const taxable = items.reduce((sum, it) => sum + it.gold_value + it.making_charge, 0) || 1;
  let goldLeft = st.gold_value;
  let gstLeft = st.gst;
  items.forEach((it, i) => {
    const last = i === items.length - 1;
    const gold = last ? goldLeft : round2(st.gold_value * (it.gold_value / bookedGold));
    const gst = last ? gstLeft : round2(st.gst * ((it.gold_value + it.making_charge) / taxable));
    goldLeft = round2(goldLeft - gold);
    gstLeft = round2(gstLeft - gst);
    q.run('UPDATE order_items SET settled_gold_rate = ?, settled_gold_value = ?, settled_gst = ?, settled_total = ? WHERE id = ?',
      round2(gold / lineNetWeight(it)), gold, gst, round2(gold + it.making_charge + gst), it.id);
  });
}

/**
 * Hand the piece over. The order must be accepted and paid in full — the last payment can be taken in the
 * same step. Delivery locks the final gold value, reduces stock and generates the final bill automatically.
 */
function deliver(id, input = {}) {
  return tx(() => {
    let order = orderRow(id);
    if (!OPEN.includes(order.status)) throw conflict(`Cannot deliver: this order is ${stateOf(order)}`);
    if (order.status === 'PLACED') throw conflict('Accept the order before delivering it');
    recalcOrder(id); // value the unpaid gold at today's rate before settling
    if (input.adjust) applyAdjustment(id, input.adjust, input.adjust.reason);
    const pay = input.payment;
    if (pay && Number(pay.amount) > 0) addPayment(id, pay);

    order = orderRow(id);
    if (order.outstanding_amount > EPS) {
      throw conflict(`${inr(order.outstanding_amount)} is still due at today's gold rate. Collect the full payment before handing over the piece.`, { outstanding: order.outstanding_amount });
    }

    const items = itemsOf(id);
    const st = settlementOf(order, items, paymentsOf(id));
    settleItems(order, items, st);
    const today = clock.today();
    q.run("UPDATE orders SET status = 'DELIVERED', actual_delivery_date = ?, updated_at = ? WHERE id = ?", today, clock.timestamp(), id);
    for (const it of items) products.sell(it.product_id, it.quantity, id, `Delivered on ${order.order_number}`);
    logEvent(id, 'DELIVERED', `Delivered to the customer — final amount ${inr(order.total_amount)} paid in full (${st.net_weight.toFixed(3)} g gold, ${inr(st.gold_value)})`);
    require('./bills').generate(id); // lazy: bills.js depends on this module
    return getOrder(id);
  });
}

function cancelOrder(id, reason) {
  return tx(() => {
    const order = orderRow(id);
    if (!OPEN.includes(order.status)) throw conflict(`Cannot cancel: this order is ${stateOf(order)}`);
    for (const it of itemsOf(id)) products.release(it.product_id, it.quantity, id, `Cancelled ${order.order_number}`);
    q.run(
      `UPDATE orders SET status = 'CANCELLED', outstanding_amount = 0, cancel_reason = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
      str(reason), clock.timestamp(), clock.timestamp(), id);
    const held = order.paid_amount > 0 ? ` ${inr(order.paid_amount)} already received stays in the payment history and must be refunded or adjusted outside this demo.` : '';
    logEvent(id, 'CANCELLED', `Order cancelled${reason ? ` — ${str(reason)}` : ''}. Reserved stock released.${held}`);
    return getOrder(id);
  });
}

// ------------------------------------------------------------------- views
const paymentStatus = (o) => (o.paid_amount <= 0 ? 'UNPAID' : o.outstanding_amount <= EPS ? 'PAID' : 'PARTIAL');

function dueFlag(o, today, soonDays) {
  if (!OPEN.includes(o.status) || !o.expected_delivery_date) return null;
  if (o.expected_delivery_date < today) return 'OVERDUE';
  if (o.expected_delivery_date === today) return 'DUE_TODAY';
  if (o.expected_delivery_date <= addDays(today, soonDays)) return 'DUE_SOON';
  return null;
}

function decorateOrder(o, s = settings.getAll(), today = clock.today()) {
  return {
    ...o,
    status_label: STATUS_LABELS[o.status],
    payment_status: paymentStatus(o),
    due_flag: dueFlag(o, today, s.due_soon_days),
    is_overdue: OPEN.includes(o.status) && !!o.expected_delivery_date && o.expected_delivery_date < today,
    days_to_delivery: o.expected_delivery_date ? Math.round((new Date(o.expected_delivery_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null,
  };
}

function listOrders(f = {}) {
  recalcOpenOrders(); // open orders are valued at today's gold rate
  const today = clock.today();
  const where = [];
  const params = [];
  const view = f.view || 'all';
  if (view === 'open') where.push(`o.status IN (${OPEN_SQL})`);
  else if (view === 'outstanding') where.push(`o.status IN (${OPEN_SQL}) AND o.outstanding_amount > 0.005`);
  else if (view === 'overdue') { where.push(`o.status IN (${OPEN_SQL}) AND o.expected_delivery_date < ?`); params.push(today); }
  else if (view === 'ready') where.push("o.status = 'READY'");
  else if (view === 'delivered') where.push("o.status = 'DELIVERED'");
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
  }[f.sort] || 'o.id DESC';
  const sortParams = f.sort === 'overdue' ? [today] : [];
  const sql = `FROM orders o JOIN customers c ON c.id = o.customer_id ${clause}`;
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

/** Advance / Part payment / Final payment — derived from where each payment falls in the running total. */
function paymentKinds(payments, order) {
  let running = 0;
  return payments.map((p, i) => {
    running = round2(running + p.amount);
    const completes = running >= order.total_amount - EPS;
    if (completes) return i === 0 ? 'Full payment' : 'Final payment';
    return i === 0 ? 'Advance' : 'Part payment';
  });
}

/** The current price by item: the final (settled) figures once delivered, the booked ones before. */
function priceBreakdown(order, items) {
  return {
    gst_rate: order.gst_rate,
    gold_rate: order.order_gold_rate,
    gold_value: order.subtotal,
    making_charge: order.making_charge,
    other_charges: order.other_charges,
    other_charges_note: order.other_charges_note,
    gst: order.gst,
    round_off: order.round_off,
    total: order.total_amount,
    lines: items.map((it) => ({
      item_id: it.id, name: it.product_name, quantity: it.quantity, purity: it.purity, net_weight: lineNetWeight(it),
      gold_rate: it.settled_gold_rate ?? it.gold_rate, gold_value: it.settled_gold_value ?? it.gold_value, making_rate: it.making_rate,
      making_charge: it.making_charge, gst: it.settled_gst ?? it.gst, total: it.settled_total ?? it.total,
    })),
  };
}

/** The gold-first picture for the order screen: what was booked, what each payment bought, what is still owed today. */
function buildSettlement(order, items, payments) {
  const st = settlementOf(order, items, payments);
  const weight = st.net_weight;
  return {
    ...st,
    is_final: order.status === 'DELIVERED',
    booked: {
      date: order.order_date, gold_rate: order.order_gold_rate, total: order.booked_total || order.total_amount,
      gold_value: round2(items.reduce((sum, it) => sum + it.gold_value, 0)),
      making_charge: round2(items.reduce((sum, it) => sum + it.making_rate * lineNetWeight(it), 0)),
      gst: round2(items.reduce((sum, it) => sum + it.gst, 0)),
    },
    total_change: round2(order.total_amount - (order.booked_total || order.total_amount)),
    gold_purchases: payments.filter((p) => p.gold_fraction > 0).map((p) => ({
      payment_id: p.id, date: p.payment_date, amount: p.gold_amount, rate: p.gold_rate, grams: round3(p.gold_fraction * weight),
    })),
  };
}

function availableActions(order) {
  const due = order.outstanding_amount > EPS;
  switch (order.status) {
    case 'PLACED': return ['accept', ...(due ? ['add_payment'] : []), 'edit_delivery_date', 'cancel'];
    case 'ACCEPTED': return [...(due ? ['add_payment'] : []), 'mark_ready', 'deliver', 'edit_delivery_date', 'cancel'];
    case 'READY': return [...(due ? ['add_payment'] : []), 'deliver', 'unmark_ready', 'edit_delivery_date', 'cancel'];
    case 'DELIVERED': return ['view_bill'];
    default: return [];
  }
}

function getOrder(id) {
  recalcOrder(id); // an open order is always shown at today's gold rate
  const order = orderRow(id);
  const items = itemsOf(id);
  const payments = paymentsOf(id);
  const kinds = paymentKinds(payments, order);
  const weight = netWeightTotal(items);
  return {
    order: decorateOrder(order),
    customer: customers.getSummary(order.customer_id),
    items: items.map((it) => ({ ...it, net_weight_total: lineNetWeight(it), image: products.getProduct(it.product_id).image })),
    payments: payments.map((p, i) => ({ ...p, kind: kinds[i], gold_grams: round3(p.gold_fraction * weight) })),
    price: priceBreakdown(order, items),
    settlement: buildSettlement(order, items, payments),
    events: q.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', id),
    stock_movements: products.movements({ order_id: id }).items,
    bill: q.get('SELECT id, bill_number, bill_date FROM bills WHERE order_id = ?', id) || null,
    actions: availableActions(order),
  };
}

module.exports = {
  OPEN, OPEN_SQL, METHODS, STATUS_LABELS, EPS,
  previewOrder, previewSettlement, createOrder, acceptOrder, setReady, updateDeliveryDate, addPayment, deliver, cancelOrder,
  getOrder, listOrders, orderRow, itemsOf, paymentsOf, logEvent, paymentKinds, recalcOrder, recalcOpenOrders,
};
