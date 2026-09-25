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
const sales = require('../src/services/sales');
const dashboard = require('../src/services/dashboard');
const market = require('../src/services/market');
const settings = require('../src/services/settings');
const goldRates = require('../src/services/goldrates');
const pricing = require('../src/services/pricing');

seed();

const rahul = () => customers.findByPhone('9876543210');
const rahulOrder = () => orders.getOrder(orders.listOrders({ customer_id: rahul().id, view: 'open' }).items[0].id);
const product = (name) => products.listProducts({ q: name }).items[0];

test('price formula: gold + making + GST on both, rounded to the rupee', () => {
  const p = pricing.priceOrder({ items: [{ net_weight: 10, making_rate: 850, rate: 14720 }], otherCharges: 0, gstRate: 3 });
  assert.equal(p.gold_value, 147200);
  assert.equal(p.making_charge, 8500);
  assert.equal(p.gst, 4671); // 3% of 155,700
  assert.equal(p.total, 160371);

  const withOther = pricing.priceOrder({ items: [{ net_weight: 10, making_rate: 850, rate: 14720 }], otherCharges: 500, gstRate: 3 });
  assert.equal(withOther.gst, 4671, 'other charges carry no GST');
  assert.equal(withOther.total, 160871);
});

test('amounts keep their paise; only the grand total is rounded and the round-off is its own line', () => {
  // 15.6 g bracelet: 15.6 × ₹14,720 = 229,632 · 15.6 × ₹750 = 11,700 · GST 3% of 241,332 = 7,239.96
  const p = pricing.priceOrder({ items: [{ net_weight: 15.6, making_rate: 750, rate: 14720 }], otherCharges: 0, gstRate: 3 });
  assert.equal(p.gold_value, 229632);
  assert.equal(p.making_charge, 11700);
  assert.equal(p.gst, 7239.96, 'GST is not rounded to the rupee');
  assert.equal(p.round_off, 0.04);
  assert.equal(p.total, 248572);
  assert.equal(p.total, Math.round((p.gold_value + p.making_charge + p.gst + p.other_charges + p.round_off) * 100) / 100);

  // rounding down gives a negative round-off; an exact total has none
  const down = pricing.priceOrder({ items: [{ net_weight: 2.35, making_rate: 1050, rate: 14720 }], otherCharges: 0, gstRate: 3 });
  assert.equal(down.making_charge, 2467.5);
  assert.equal(down.gst, 1111.79);
  assert.equal(down.round_off, -0.29);
  assert.equal(down.total, 38171);
  assert.equal(pricing.priceOrder({ items: [{ net_weight: 10, making_rate: 850, rate: 14720 }], gstRate: 3 }).round_off, 0);
});

test('net gold weight is derived from gross - stone, never stored by hand', () => {
  const ring = product("Men's Gold Ring");
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
  assert.equal(orders.listOrders({ view: 'delivered' }).total, 4); // three booked orders + one walk-in bill
  assert.equal(bills.list().total, 4, 'every delivered order has its bill');
  assert.ok(orders.listOrders({ status: 'PLACED' }).total >= 1, 'a placed order still waiting for the shop to accept it');
});

test('Rahul Das: order at ₹14,720/g with ₹50,000 paid is accepted and partly paid', () => {
  const r = rahulOrder();
  assert.equal(r.customer.name, 'Rahul Das');
  assert.equal(r.order.status, 'ACCEPTED');
  assert.equal(r.order.payment_status, 'PARTIAL');
  assert.equal(r.order.order_gold_rate, 14720);
  assert.equal(r.order.total_amount, 160371);
  assert.equal(r.order.paid_amount, 50000);
  assert.equal(r.order.outstanding_amount, 110371);
  assert.equal(r.bill, null, 'no bill before delivery');
  assert.equal(r.payments[0].amount, 50000);
  assert.equal(r.payments[0].kind, 'Advance');
  assert.deepEqual(r.price.lines[0], {
    item_id: r.price.lines[0].item_id, name: '22K Classic Gold Chain', quantity: 1, purity: '22K', net_weight: 10,
    gold_rate: 14720, gold_value: 147200, making_rate: 850, making_charge: 8500, gst: 4671, total: 160371,
  });
});

test('a gold-rate change never re-prices a placed order', () => {
  const before = rahulOrder().order;
  const rate = goldRates.getRate('22K');
  market.setGoldRate({ purity: '22K', rate_per_gram: rate + 400 });
  const after = rahulOrder().order;
  assert.equal(after.total_amount, before.total_amount);
  assert.equal(after.outstanding_amount, before.outstanding_amount);
  assert.equal(after.order_gold_rate, 14720);
  // ...but a new order picks up the new rate
  const chain = product('Classic Gold Chain');
  assert.equal(orders.previewOrder({ items: [{ product_id: chain.id }] }).lines[0].gold_rate, rate + 400);
});

test('payments are append-only and cannot be overpaid', () => {
  const r = rahulOrder();
  assert.throws(() => orders.addPayment(r.order.id, { amount: 999999, payment_method: 'Cash' }), /more than the/);
  assert.throws(() => orders.addPayment(r.order.id, { amount: 100, payment_method: 'Bitcoin' }), /Payment method/);
  const pay = r.payments[0];
  assert.throws(() => q.run('UPDATE payments SET amount = 1 WHERE id = ?', pay.id), /immutable/);
  assert.throws(() => q.run('DELETE FROM payments WHERE id = ?', pay.id), /cannot be deleted/);
});

test('a part payment updates order, customer and dashboard together', () => {
  const r = rahulOrder();
  const custBefore = customers.getSummary(rahul().id);
  const dashBefore = dashboard.overview().kpis;
  const res = orders.addPayment(r.order.id, { amount: 20000, payment_method: 'Cash' });
  assert.equal(res.order.paid_amount, 70000);
  assert.equal(res.order.outstanding_amount, 90371);
  assert.equal(res.payments[1].kind, 'Part payment');
  const custAfter = customers.getSummary(rahul().id);
  assert.equal(custAfter.total_outstanding, custBefore.total_outstanding - 20000);
  assert.equal(custAfter.total_paid, custBefore.total_paid + 20000);
  const dashAfter = dashboard.overview().kpis;
  assert.equal(dashAfter.outstanding_amount, dashBefore.outstanding_amount - 20000);
  assert.equal(dashAfter.todays_collections, dashBefore.todays_collections + 20000);
});

test('delivery is refused while money is due, and rolls back cleanly', () => {
  const r = rahulOrder();
  const chain = product('Classic Gold Chain');
  const stock = products.getProduct(chain.id);
  assert.throws(() => orders.deliver(r.order.id, {}), /still due/);
  assert.throws(() => orders.deliver(r.order.id, { payment: { amount: 1000, payment_method: 'Cash' } }), /still due/);
  const after = orders.getOrder(r.order.id);
  assert.equal(after.order.status, 'ACCEPTED');
  assert.equal(after.order.paid_amount, r.order.paid_amount, 'the failed attempt left no payment behind');
  assert.equal(products.getProduct(chain.id).stock_quantity, stock.stock_quantity);
});

test('order lifecycle: placed -> accepted -> ready -> delivered, bill created automatically', () => {
  const buyer = rahul();
  const ring = product('Plain Band Ring');
  const before = products.getProduct(ring.id);
  const placed = orders.createOrder({ customer_id: buyer.id, items: [{ product_id: ring.id }], expected_delivery_date: clock.today(), payment: { amount: 5000, payment_method: 'UPI' } });
  const id = placed.order.id;
  assert.equal(placed.order.status, 'PLACED');
  assert.equal(products.getProduct(ring.id).reserved_quantity, before.reserved_quantity + 1);
  assert.throws(() => orders.setReady(id, true), /Accept the order first/);
  assert.throws(() => orders.deliver(id, {}), /Accept the order/);

  assert.equal(orders.acceptOrder(id).order.status, 'ACCEPTED');
  assert.throws(() => orders.acceptOrder(id), /newly placed/);
  assert.equal(orders.setReady(id, true).order.status, 'READY');
  assert.equal(orders.setReady(id, false).order.status, 'ACCEPTED');
  orders.setReady(id, true);

  // the delivery date stays editable until delivery
  const moved = orders.updateDeliveryDate(id, '2099-01-01');
  assert.equal(moved.order.expected_delivery_date, '2099-01-01');
  assert.throws(() => orders.updateDeliveryDate(id, '2000-01-01'), /before the order date/);

  const due = orders.getOrder(id).order.outstanding_amount;
  const done = orders.deliver(id, { payment: { amount: due, payment_method: 'Card', reference_number: 'AUTH 1' } });
  assert.equal(done.order.status, 'DELIVERED');
  assert.equal(done.order.outstanding_amount, 0);
  assert.equal(done.order.actual_delivery_date, clock.today());
  assert.ok(done.bill, 'a final bill was generated automatically');
  assert.match(done.bill.bill_number, /^RAJ\/\d{4}-\d{2}\/\d{4}$/);
  assert.deepEqual(done.payments.map((p) => p.kind), ['Advance', 'Final payment']);

  const after = products.getProduct(ring.id);
  assert.equal(after.stock_quantity, before.stock_quantity - 1);
  assert.equal(after.reserved_quantity, before.reserved_quantity);
  const moves = products.movements({ order_id: id }).items.map((m) => m.movement_type).sort();
  assert.deepEqual(moves, ['RESERVE', 'SALE']);

  // it is history now: nothing else can change
  assert.throws(() => orders.addPayment(id, { amount: 1, payment_method: 'Cash' }), /already delivered/);
  assert.throws(() => orders.cancelOrder(id, 'x'), /already delivered/);
  assert.throws(() => orders.updateDeliveryDate(id, '2099-02-02'), /already delivered/);

  // bill: exact snapshot, immutable
  const bill = bills.get(done.bill.id);
  assert.equal(bill.bill.totals.total, done.order.total_amount);
  assert.equal(bill.bill.total_paid, done.order.total_amount);
  assert.equal(bill.bill.customer.phone, '9876543210');
  assert.throws(() => q.run('UPDATE bills SET total_amount = 1 WHERE id = ?', bill.id), /immutable/);
  assert.throws(() => bills.generate(id), /already been generated/);

  // customer history and dashboard
  const profile = customers.getProfile(buyer.id);
  assert.ok(profile.bills.some((b) => b.id === bill.id));
  assert.ok(!dashboard.outstanding().some((o) => o.id === id));
});

test('walk-in bill: paid in full, delivered and billed in one step', () => {
  const buyer = customers.findByPhone('9007123456');
  const pin = product('Floral Nose Pin');
  const before = products.getProduct(pin.id);
  assert.throws(() => sales.createSale({ customer_id: buyer.id, items: [{ product_id: pin.id }] }), /how the customer is paying/);

  const sale = sales.createSale({ customer_id: buyer.id, items: [{ product_id: pin.id, quantity: 2 }], payment: { payment_method: 'UPI', reference_number: 'UPI 1' } });
  assert.equal(sale.order.kind, 'SALE');
  assert.equal(sale.order.status, 'DELIVERED');
  assert.equal(sale.order.outstanding_amount, 0);
  assert.equal(sale.payments.length, 1);
  assert.equal(sale.payments[0].kind, 'Full payment');
  assert.ok(sale.bill);
  assert.equal(products.getProduct(pin.id).stock_quantity, before.stock_quantity - 2);
  assert.equal(products.getProduct(pin.id).reserved_quantity, before.reserved_quantity);
  assert.throws(() => sales.createSale({ customer_id: buyer.id, items: [{ product_id: pin.id }], payment: { payment_method: 'Cash', amount: 5 } }), /paid in full/);
  // a failed sale leaves nothing behind
  const count = orders.listOrders({}).total;
  assert.throws(() => sales.createSale({ customer_id: buyer.id, items: [{ product_id: pin.id, quantity: 90 }], payment: { payment_method: 'Cash' } }), /only \d+ available/);
  assert.equal(orders.listOrders({}).total, count);
});

test('the shopkeeper can edit an item for one order without touching the catalogue', () => {
  const chain = product('Classic Gold Chain'); // 10 g, 22K, ₹850/g making
  const before = products.getProduct(chain.id);
  const edits = {
    product_id: chain.id, name: 'Custom Rope Chain (heavier)', description: 'Extra 2 g, matte finish',
    gross_weight: 12.5, stone_weight: 0.5, making_rate: 700, gold_rate: 14000, purity: '22K',
  };
  const preview = orders.previewOrder({ items: [edits] });
  const l = preview.lines[0];
  assert.equal(l.name, 'Custom Rope Chain (heavier)');
  assert.equal(l.net_weight_each, 12, 'net = gross - stone');
  assert.equal(l.gold_value, 168000);   // 12 g × ₹14,000
  assert.equal(l.making_charge, 8400);  // 12 g × ₹700
  assert.equal(l.gst, 5292);            // 3% of 176,400
  assert.equal(l.edited, true);
  assert.equal(preview.lines.length, 1);
  assert.equal(orders.previewOrder({ items: [{ product_id: chain.id }] }).lines[0].edited, false, 'untouched line is not flagged');

  // saved on the order item and carried onto the bill; the catalogue product is unchanged
  const buyer = customers.findByPhone('9748123456');
  const o = orders.createOrder({ customer_id: buyer.id, items: [edits], payment: { amount: 1000, payment_method: 'Cash' } });
  const item = o.items[0];
  assert.equal(item.product_name, 'Custom Rope Chain (heavier)');
  assert.equal(item.description, 'Extra 2 g, matte finish');
  assert.equal(item.gross_weight, 12.5);
  assert.equal(item.net_gold_weight, 12);
  assert.equal(o.order.total_amount, 181692);
  assert.deepEqual(products.getProduct(chain.id).gross_weight, before.gross_weight);
  assert.equal(products.getProduct(chain.id).name, before.name);
  assert.equal(products.getProduct(chain.id).making_charge, before.making_charge);
  orders.acceptOrder(o.order.id);
  const done = orders.deliver(o.order.id, { payment: { amount: o.order.outstanding_amount, payment_method: 'UPI' } });
  const billItem = bills.get(done.bill.id).bill.items[0];
  assert.equal(billItem.name, 'Custom Rope Chain (heavier)');
  assert.equal(billItem.description, 'Extra 2 g, matte finish');
  assert.equal(billItem.net_gold_weight, 12);
  assert.equal(billItem.gold_rate, 14000);

  // sensible validation
  assert.throws(() => orders.previewOrder({ items: [{ product_id: chain.id, gross_weight: 1, stone_weight: 2 }] }), /stone weight cannot be more/);
  assert.throws(() => orders.previewOrder({ items: [{ product_id: chain.id, purity: '21K' }] }), /purity must be one of/);
  assert.throws(() => orders.previewOrder({ items: [{ product_id: chain.id, gold_rate: 0 }] }), /gold rate/);
});

test('the same product can appear on two lines with different edits; stock is checked across both', () => {
  const kada = product('Traditional Kada'); // 3 in stock, none reserved
  const buyer = customers.findByPhone('9433012345');
  const two = orders.previewOrder({ items: [{ product_id: kada.id, gross_weight: 25 }, { product_id: kada.id, gross_weight: 30 }] });
  assert.equal(two.lines.length, 2, 'lines are not merged');
  assert.notEqual(two.lines[0].gold_value, two.lines[1].gold_value);
  assert.throws(() => orders.createOrder({ customer_id: buyer.id, items: [{ product_id: kada.id, quantity: 2 }, { product_id: kada.id, quantity: 2 }] }), /only 3 available/);
  const o = orders.createOrder({ customer_id: buyer.id, items: [{ product_id: kada.id, quantity: 1, gross_weight: 25 }, { product_id: kada.id, quantity: 2, gross_weight: 30 }] });
  assert.equal(o.items.length, 2);
  assert.equal(products.getProduct(kada.id).reserved_quantity, 3);
  orders.cancelOrder(o.order.id, 'test');
  assert.equal(products.getProduct(kada.id).reserved_quantity, 0);
});

test('restocking an out-of-stock product records history and clears the flag', () => {
  const churi = product('Designer Churi');
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
  const choker = product('Gold Choker');
  const buyer = customers.findByPhone('9748123456');
  assert.throws(() => orders.createOrder({ customer_id: buyer.id, items: [{ product_id: choker.id, quantity: 3 }] }), /only 2 available/);

  const o = orders.createOrder({ customer_id: buyer.id, items: [{ product_id: choker.id, quantity: 2 }], payment: { amount: 10000, payment_method: 'UPI' } });
  assert.equal(products.getProduct(choker.id).available_quantity, 0);
  assert.equal(products.getProduct(choker.id).stock_status, 'OUT_OF_STOCK');

  const cancelled = orders.cancelOrder(o.order.id, 'Test');
  assert.equal(cancelled.order.status, 'CANCELLED');
  assert.equal(cancelled.order.outstanding_amount, 0);
  assert.equal(products.getProduct(choker.id).available_quantity, 2, 'reservation released');
  assert.equal(cancelled.order.paid_amount, 10000, 'payment history is kept');
  assert.throws(() => orders.addPayment(o.order.id, { amount: 100, payment_method: 'Cash' }), /cancelled/);
});

test('GST is the one pricing setting and it applies to new orders only', () => {
  assert.deepEqual(Object.keys(settings.getRules()), ['gst_rate']);
  const existing = rahulOrder().order;
  market.updateSettings({ gst_rate: 5 });
  const chain = product('Rope Chain');
  const preview = orders.previewOrder({ items: [{ product_id: chain.id }] });
  assert.equal(preview.gst_rate, 5);
  assert.equal(preview.totals.gst, Math.round((preview.totals.gold_value + preview.totals.making_charge) * 5) / 100);
  assert.equal(rahulOrder().order.total_amount, existing.total_amount, 'a placed order keeps the GST it was priced with');
  assert.throws(() => market.updateSettings({ gst_rate: 90 }), /at most/);
  assert.throws(() => market.updateSettings({ making_charge_method: 'per_gram' }), /Unknown setting/);
  market.updateSettings({ gst_rate: 3 });
});

test('new customers can be created inline and phone numbers stay unique', () => {
  const pendant = product('Om Pendant');
  const o = orders.createOrder({ customer: { name: 'Debjani Roy', phone: '+91 98123 45670', city: 'Kolkata' }, items: [{ product_id: pendant.id }] });
  assert.equal(o.customer.phone, '9812345670');
  assert.equal(customers.findByPhone('98123-45670').name, 'Debjani Roy');
  assert.throws(() => customers.create({ name: 'Someone Else', phone: '9812345670' }), /already belongs/);
  assert.throws(() => customers.create({ name: 'Bad', phone: '12345' }), /10-digit/);
});

test('clock override is reset after seeding', () => {
  const today = new Date();
  assert.equal(clock.now().getDate(), today.getDate());
});

test('the round-off is stored on the order and printed on the bill', () => {
  const bracelet = product("Men's Bracelet"); // 15.6 g, ₹750/g
  const buyer = customers.findByPhone('9433012345');
  const o = orders.createOrder({ customer_id: buyer.id, items: [{ product_id: bracelet.id, gold_rate: 14720 }] }); // rate pinned: earlier tests move the market
  assert.equal(o.order.gst, 7239.96);
  assert.equal(o.order.round_off, 0.04);
  assert.equal(o.order.total_amount, 248572);
  assert.equal(o.price.round_off, 0.04);
  assert.equal(o.order.outstanding_amount, 248572, 'the customer owes the rounded total');
  orders.acceptOrder(o.order.id);
  const done = orders.deliver(o.order.id, { payment: { amount: 248572, payment_method: 'Cash' } });
  const b = bills.get(done.bill.id).bill.totals;
  assert.equal(b.round_off, 0.04);
  assert.equal(b.gst, 7239.96);
  assert.equal(b.total, 248572);
  assert.equal(b.cgst + b.sgst, 7239.96);
});
