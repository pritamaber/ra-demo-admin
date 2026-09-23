'use strict';
process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');

const { q } = require('../src/db');
const { seed } = require('../src/seed');
const { clock } = require('../src/util');
const customers = require('../src/services/customers');
const products = require('../src/services/products');
const orders = require('../src/services/orders');
const bills = require('../src/services/bills');
const dashboard = require('../src/services/dashboard');
const market = require('../src/services/market');
const settings = require('../src/services/settings');
const goldRates = require('../src/services/goldrates');
const pricing = require('../src/services/pricing');

seed();

const rahul = () => customers.findByPhone('9876543210');
const rahulOrder = () => {
  const row = orders.listOrders({ customer_id: rahul().id, view: 'open' }).items[0];
  return orders.getOrder(row.id);
};
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 0.005, `${msg}: expected ${expected}, got ${actual}`);

test('pricing engine: gold + making + GST from configured rules', () => {
  const rules = settings.getRules();
  const p = pricing.priceOrder({
    items: [{ quantity: 1, net_weight: 10, making_method: 'per_gram', making_rate: 850, rate: 14720 }],
    otherCharges: 0, rules,
  });
  assert.equal(p.gold_value, 147200);
  assert.equal(p.making_charge, 8500);
  assert.equal(p.gst, 4671); // 3% of 155,700
  assert.equal(p.total, 160371);

  const goldOnly = pricing.priceOrder({
    items: [{ quantity: 1, net_weight: 10, making_method: 'per_gram', making_rate: 850, rate: 14720 }],
    otherCharges: 0, rules: { ...rules, gst_basis: 'gold_only' },
  });
  assert.equal(goldOnly.gst, 4416);
});

test('net gold weight is derived from gross - stone, never stored by hand', () => {
  const ring = products.listProducts({ q: "Men's Gold Ring" }).items[0];
  assert.equal(ring.gross_weight, 10.25);
  assert.equal(ring.stone_weight, 0.25);
  assert.equal(ring.net_gold_weight, 10);
  assert.throws(() => q.run('UPDATE products SET net_gold_weight = 1 WHERE id = ?', ring.id), /generated column/i);
});

test('seed data has the shape the demo needs', () => {
  assert.equal(products.listProducts({ limit: 500 }).total, 28);
  assert.ok(products.listProducts({ stock_status: 'OUT_OF_STOCK' }).total >= 2);
  assert.ok(products.listProducts({ stock_status: 'LOW_STOCK' }).total >= 2);
  const outstanding = dashboard.outstanding();
  assert.ok(outstanding.length >= 4);
  assert.ok(outstanding.some((o) => o.due_flag === 'OVERDUE'));
  assert.ok(outstanding.some((o) => o.due_flag === 'DUE_TODAY'));
  assert.equal(orders.listOrders({ view: 'completed' }).total, 3);
  assert.equal(bills.list().total, 2);
});

test("Rahul Das: day-one order at ₹14,720/g with ₹50,000 advance is Partially Paid", () => {
  const r = rahulOrder();
  assert.equal(r.customer.name, 'Rahul Das');
  assert.equal(r.order.status, 'PARTIALLY_PAID');
  assert.equal(r.order.order_gold_rate, 14720);
  assert.equal(r.order.estimated_total, 160371);
  assert.equal(r.order.paid_amount, 50000);
  assert.equal(r.order.outstanding_amount, 110371);
  assert.equal(r.bill, null, 'no bill before delivery');
  // the payment keeps its rupee value; grams are informational, kept at full precision
  const pay = r.payments[0];
  assert.equal(pay.amount, 50000);
  assert.equal(pay.gold_rate_at_payment, 14720);
  assert.equal(pay.gold_equivalent, 50000 / 14720);
  assert.equal(r.settlement.payments.total_paid, 50000);
});

test('gold rate change re-prices the open order but preserves history', () => {
  const before = rahulOrder();
  const res = market.setGoldRate({ purity: '22K', rate_per_gram: 15000, note: 'Market move' });
  assert.ok(res.repriced_orders >= 1);

  const after = rahulOrder();
  assert.equal(after.order.order_gold_rate, 14720, 'order-date rate is preserved');
  assert.equal(after.order.estimated_total, 160371, 'original estimate is preserved');
  assert.equal(after.payments[0].gold_rate_at_payment, 14720, 'payment keeps the rate it was made at');
  assert.equal(after.settlement.delivery.gold_rate, 15000);
  assert.equal(after.settlement.delivery.gold_value, 150000);
  assert.equal(after.settlement.delivery.making_charge, 8500, 'making charge is fixed from the order date');
  assert.equal(after.settlement.delivery.gst, 4755);
  assert.equal(after.order.total_amount, 163255);
  assert.equal(after.order.outstanding_amount, 113255);
  assert.ok(after.order.outstanding_amount > before.order.outstanding_amount);

  // history keeps every entry
  const hist = goldRates.history({ purity: '22K' });
  assert.ok(hist.some((h) => h.rate_per_gram === 14650));
  assert.ok(hist.some((h) => h.rate_per_gram === 14720));
  assert.equal(goldRates.getRate('22K'), 15000);
  assert.equal(goldRates.getRate('22K', '2026-01-01'), 14480, 'before history starts falls back to the earliest rate');

  // dashboard total moved with it
  assert.ok(dashboard.overview().outstanding.find((o) => o.id === after.order.id).outstanding_amount === 113255);
});

test('payments are append-only and cannot be overpaid', () => {
  const r = rahulOrder();
  assert.throws(() => q.run('UPDATE payments SET amount = 1 WHERE order_id = ?', r.order.id), /immutable/);
  assert.throws(() => q.run('DELETE FROM payments WHERE order_id = ?', r.order.id), /cannot be deleted/);
  assert.throws(() => orders.addPayment(r.order.id, { amount: 999999, payment_method: 'Cash' }), /more than the/);
  assert.throws(() => orders.addPayment(r.order.id, { amount: 100, payment_method: 'Barter' }), /Payment method/);
});

test('a part payment updates order, customer and dashboard together', () => {
  const r = rahulOrder();
  const custBefore = rahul();
  const dashBefore = dashboard.overview().kpis;
  const updated = orders.addPayment(r.order.id, { amount: 20000, payment_method: 'Cash', notes: 'Part payment' });
  assert.equal(updated.order.paid_amount, 70000);
  assert.equal(updated.order.outstanding_amount, 93255);
  assert.equal(updated.payments.length, 2, 'earlier payment is still there');
  assert.equal(rahul().total_outstanding, custBefore.total_outstanding - 20000);
  const dashAfter = dashboard.overview().kpis;
  near(dashAfter.outstanding_amount, dashBefore.outstanding_amount - 20000, 'dashboard outstanding');
  assert.equal(dashAfter.todays_collections, dashBefore.todays_collections + 20000);
});

test('delivery is refused while money is due, and rolls back cleanly', () => {
  const r = rahulOrder();
  const paymentsBefore = q.get('SELECT COUNT(*) AS n FROM payments').n;
  assert.throws(() => orders.deliver(r.order.id, { payment: { amount: 1000, payment_method: 'Cash' } }), /still due/);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM payments').n, paymentsBefore, 'attempted payment was rolled back');
  assert.equal(orders.getOrder(r.order.id).order.status, 'PARTIALLY_PAID');
  assert.throws(() => bills.generate(r.order.id), /delivered/);
});

test('settle & deliver: stock, status, bill and purchase history all update', () => {
  const r = rahulOrder();
  const chain = products.getProduct(r.items[0].product_id);
  assert.equal(chain.reserved_quantity, 1);
  const stockBefore = chain.stock_quantity;

  const due = r.settlement.delivery.outstanding;
  assert.equal(due, 93255);
  const delivered = orders.deliver(r.order.id, { payment: { amount: due, payment_method: 'Card', reference_number: 'Card ****1111' } });
  assert.equal(delivered.order.status, 'DELIVERED');
  assert.equal(delivered.order.delivery_gold_rate, 15000);
  assert.equal(delivered.order.outstanding_amount, 0);
  assert.equal(delivered.settlement.is_final, true);
  assert.equal(delivered.payments.at(-1).kind, 'Final payment');

  const after = products.getProduct(chain.id);
  assert.equal(after.stock_quantity, stockBefore - 1, 'stock reduced on delivery');
  assert.equal(after.reserved_quantity, 0, 'reservation consumed');
  assert.equal(after.sold_quantity, chain.sold_quantity + 1);
  const move = products.movements({ product_id: chain.id }).items[0];
  assert.equal(move.movement_type, 'SALE');
  assert.equal(move.order_number, delivered.order.order_number);

  // no longer outstanding anywhere
  assert.ok(!dashboard.outstanding().some((o) => o.id === r.order.id));
  // frozen: a later rate change no longer touches it
  market.setGoldRate({ purity: '22K', rate_per_gram: 15500 });
  assert.equal(orders.getOrder(r.order.id).order.total_amount, 163255);
  assert.throws(() => orders.addPayment(r.order.id, { amount: 1, payment_method: 'Cash' }), /cannot be added/);

  // final bill
  const bill = bills.generate(r.order.id);
  assert.match(bill.bill_number, /^RAJ\/\d{4}-\d{2}\/\d{4}$/);
  assert.equal(bill.total_amount, 163255);
  assert.equal(bill.bill.items[0].gold_value, 150000);
  assert.equal(bill.bill.items[0].net_gold_weight, 10);
  assert.equal(bill.bill.totals.cgst + bill.bill.totals.sgst, 4755);
  assert.equal(bill.bill.previous_payments.count, 2);
  assert.equal(bill.bill.final_payment.amount, 93255);
  assert.equal(bill.bill.total_paid, 163255);
  assert.match(bill.bill.totals.amount_in_words, /^Rupees One Lakh Sixty Three Thousand Two Hundred Fifty Five Only$/);
  assert.throws(() => bills.generate(r.order.id), /already/);
  assert.equal(orders.getOrder(r.order.id).order.status, 'BILLED');

  // customer purchase history
  const profile = customers.getProfile(rahul().id);
  assert.ok(profile.bills.some((b) => b.bill_number === bill.bill_number));
  assert.equal(profile.customer.total_outstanding, 0);
  assert.throws(() => q.run('UPDATE bills SET total_amount = 1 WHERE id = ?', bill.id), /immutable/);
});

test('restocking an out-of-stock product records history and clears the flag', () => {
  const churi = products.listProducts({ q: 'Designer Churi' }).items[0];
  assert.equal(churi.stock_status, 'OUT_OF_STOCK');
  assert.equal(churi.stock_quantity, 0);
  const res = products.adjustStock(churi.id, { type: 'RESTOCK', quantity: 5, reason: 'New batch' });
  assert.equal(res.product.stock_quantity, 5);
  assert.equal(res.product.stock_status, 'IN_STOCK');
  const m = products.movements({ product_id: churi.id }).items[0];
  assert.deepEqual([m.movement_type, m.previous_quantity, m.quantity, m.new_quantity], ['RESTOCK', 0, 5, 5]);
  assert.throws(() => products.adjustStock(churi.id, { type: 'RESTOCK', quantity: 0 }), /at least 1/);
});

test('orders cannot reserve more than is available; cancelling releases stock', () => {
  const choker = products.listProducts({ q: 'Gold Choker' }).items[0];
  const buyer = customers.findByPhone('9748123456');
  assert.throws(() => orders.createOrder({ customer_id: buyer.id, items: [{ product_id: choker.id, quantity: 3 }] }), /only 2 available/);

  const o = orders.createOrder({ customer_id: buyer.id, items: [{ product_id: choker.id, quantity: 2 }], advance: { amount: 10000, payment_method: 'UPI' } });
  assert.equal(products.getProduct(choker.id).available_quantity, 0);
  assert.equal(products.getProduct(choker.id).stock_status, 'OUT_OF_STOCK');
  assert.equal(o.order.status, 'ADVANCE_RECEIVED'); // 10,000 is under the 10% required advance

  orders.setReady(o.order.id, true);
  assert.equal(orders.getOrder(o.order.id).order.status, 'READY_FOR_DELIVERY');
  const cancelled = orders.cancelOrder(o.order.id, 'Test');
  assert.equal(cancelled.order.status, 'CANCELLED');
  assert.equal(products.getProduct(choker.id).available_quantity, 2, 'reservation released');
  assert.equal(cancelled.order.paid_amount, 10000, 'payment history is kept');
});

test('pricing rules are configurable and change the outcome', () => {
  const buyer = customers.findByPhone('9830123456');
  const ring = products.listProducts({ q: 'Plain Band Ring' }).items[0];
  const make = () => orders.createOrder({ customer_id: buyer.id, items: [{ product_id: ring.id }], advance: { amount: 10000, payment_method: 'Cash' } });

  // Gold-equivalent credit: ₹10,000 buys grams at today's rate, valued at the settlement rate.
  const o1 = make();
  const rate1 = goldRates.getRate('22K');
  market.setGoldRate({ purity: '22K', rate_per_gram: rate1 + 500 });
  assert.equal(orders.getOrder(o1.order.id).settlement.payments.credit_applied, 10000, 'monetary credit by default');
  market.updateSettings({ advance_treatment: 'gold_equivalent_credit' });
  const s = orders.getOrder(o1.order.id).settlement;
  near(s.payments.credit_applied, (10000 / rate1) * (rate1 + 500), 'gold-equivalent credit');
  assert.equal(s.payments.total_paid, 10000, 'actual money received is unchanged');
  assert.ok(s.rules.find((r) => r.key === 'advance_treatment').text.includes('Gold-equivalent'));

  // Lock the gold value at the order-date rate.
  market.updateSettings({ advance_treatment: 'monetary_credit', gold_rate_settlement: 'order_date_rate' });
  const locked = orders.getOrder(o1.order.id);
  assert.equal(locked.settlement.delivery.gold_rate, locked.order.order_gold_rate);
  assert.equal(locked.order.total_amount, locked.order.estimated_total);

  market.updateSettings({ gold_rate_settlement: 'delivery_date_rate' });
  assert.throws(() => market.updateSettings({ gst_rate: 90 }), /at most/);
  assert.throws(() => market.updateSettings({ gst_basis: 'nonsense' }), /Invalid value/);
});

test('draft orders reserve nothing until confirmed', () => {
  const buyer = customers.findByPhone('9433012345');
  const bracelet = products.listProducts({ q: "Baby Bracelet" }).items[0];
  const draft = orders.createOrder({ mode: 'draft', customer_id: buyer.id, items: [{ product_id: bracelet.id }] });
  assert.equal(draft.order.status, 'DRAFT');
  assert.equal(products.getProduct(bracelet.id).reserved_quantity, 0);
  assert.throws(() => orders.addPayment(draft.order.id, { amount: 100, payment_method: 'Cash' }), /cannot be added/);
  const confirmed = orders.confirmDraft(draft.order.id, { advance: { amount: 5000, payment_method: 'Cash' } });
  assert.equal(products.getProduct(bracelet.id).reserved_quantity, 1);
  assert.equal(confirmed.order.status, 'ADVANCE_RECEIVED');
  const d2 = orders.createOrder({ mode: 'draft', customer_id: buyer.id, items: [{ product_id: bracelet.id }] });
  assert.deepEqual(orders.deleteDraft(d2.order.id), { deleted: true });
});

test('new customers can be created inline and phone numbers stay unique', () => {
  const ring = products.listProducts({ q: 'Om Pendant' }).items[0];
  const o = orders.createOrder({ customer: { name: 'Debjani Roy', phone: '+91 98123 45670', city: 'Kolkata' }, items: [{ product_id: ring.id }] });
  assert.equal(o.customer.phone, '9812345670');
  assert.equal(customers.findByPhone('98123-45670').name, 'Debjani Roy');
  assert.throws(() => customers.create({ name: 'Someone Else', phone: '9812345670' }), /already belongs/);
  assert.throws(() => customers.create({ name: 'Bad', phone: '12345' }), /10-digit/);
});

test('clock override is reset after seeding', () => {
  const today = new Date();
  assert.equal(clock.now().getDate(), today.getDate());
});
