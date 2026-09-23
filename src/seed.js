'use strict';
/**
 * Demo data. History is replayed through the real services with a back-dated clock, so stock movements,
 * payments, statuses and bills are produced by the same code the app uses — not hand-inserted.
 * Dates are relative to "today", so the overdue / due-today / due-soon flags always look right.
 * Events below are in strict chronological order (oldest first).
 */
const fs = require('node:fs');
const path = require('node:path');
const { q, tx, migrate, dropAll, dropTables } = require('./db');
const { clock, addDays } = require('./util');
const settings = require('./services/settings');
const goldRates = require('./services/goldrates');
const products = require('./services/products');
const customers = require('./services/customers');
const orders = require('./services/orders');
const bills = require('./services/bills');

const CATEGORIES = {
  Ring: ['Plain Band', 'Stone Studded'],
  Necklace: ['Choker', 'Haar'],
  Bangle: ['Daily Wear', 'Bridal', 'Kada'],
  Churi: ['Daily Wear Set', 'Designer'],
  Pendant: ['Religious', 'Fancy'],
  Earrings: ['Jhumka', 'Studs'],
  Chain: ['Box Chain', 'Rope Chain', 'Kids Chain'],
  Bracelet: ['Baby Bracelet', "Men's Bracelet"],
  Mangalsutra: ['Short', 'Long'],
  'Nose Pin': ['Stud', 'Floral'],
};
const SUB_GENDER = { Kada: 'Men', 'Kids Chain': 'Kids', 'Baby Bracelet': 'Kids', "Men's Bracelet": 'Men' };

// Real shop photos live in public/img/products/<folder>, one folder per jewellery category —
// see PRODUCTS below for which product each category's photos get distributed across.
const CATEGORY_PHOTO_DIR = {
  Ring: 'rings', Necklace: 'necklace', Bangle: 'bangle', Churi: 'churi', Pendant: 'pendant',
  Earrings: 'earring', Chain: 'chain', Bracelet: 'bracelet', Mangalsutra: 'mangalsutra', 'Nose Pin': 'nosepin',
};
const PRODUCT_IMG_ROOT = path.join(__dirname, '..', 'public', 'img', 'products');
function categoryPhotos(folder) {
  const dir = path.join(PRODUCT_IMG_ROOT, folder);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().map((f) => `/img/products/${folder}/${f}`);
}

// name, gender, category, subcategory, purity, gross g, stone g, making ₹/g, opening stock
const PRODUCTS = [
  ['22K Classic Gold Chain', 'Men', 'Chain', 'Box Chain', '22K', 10.0, 0, 850, 4],
  ['22K Rope Chain', 'Men', 'Chain', 'Rope Chain', '22K', 12.4, 0, 800, 3],
  ['22K Lightweight Ladies Chain', 'Women', 'Chain', 'Box Chain', '22K', 4.8, 0, 900, 5],
  ['22K Baby Chain', 'Kids', 'Chain', 'Kids Chain', '22K', 2.35, 0, 1000, 4],
  ['22K Floral Pendant', 'Women', 'Pendant', 'Fancy', '22K', 3.65, 0.15, 1100, 7],
  ['22K Om Pendant', 'Unisex', 'Pendant', 'Religious', '22K', 2.35, 0, 1050, 8],
  ['22K Ganesh Pendant', 'Unisex', 'Pendant', 'Religious', '22K', 4.1, 0.1, 1000, 3],
  ["22K Women's Gold Ring", 'Women', 'Ring', 'Stone Studded', '22K', 3.25, 0.25, 1200, 5],
  ["22K Men's Gold Ring", 'Men', 'Ring', 'Stone Studded', '22K', 10.25, 0.25, 950, 4],
  ['22K Plain Band Ring', 'Unisex', 'Ring', 'Plain Band', '22K', 4.8, 0, 900, 6],
  ['22K Kids Ring', 'Kids', 'Ring', 'Plain Band', '22K', 1.85, 0.05, 1100, 4],
  ['18K Rose Gold Couple Band', 'Unisex', 'Ring', 'Plain Band', '18K', 5.2, 0, 1500, 3],
  ['22K Daily Wear Bangle', 'Women', 'Bangle', 'Daily Wear', '22K', 12.4, 0, 750, 4],
  ['22K Bridal Bangle', 'Women', 'Bangle', 'Bridal', '22K', 18.5, 0.5, 800, 3],
  ['22K Traditional Kada', 'Men', 'Bangle', 'Kada', '22K', 25.2, 0, 700, 3],
  ['22K Daily Wear Churi Set', 'Women', 'Churi', 'Daily Wear Set', '22K', 7.25, 0, 850, 6],
  ['22K Designer Churi Pair', 'Women', 'Churi', 'Designer', '22K', 14.8, 0.3, 900, 1],
  ['22K Jhumka Earrings', 'Women', 'Earrings', 'Jhumka', '22K', 8.6, 0.4, 1150, 5],
  ['22K Stud Earrings', 'Women', 'Earrings', 'Studs', '22K', 2.35, 0.05, 1200, 4],
  ['22K Kids Earrings', 'Kids', 'Earrings', 'Studs', '22K', 1.2, 0, 1300, 5],
  ['22K Rani Haar Necklace', 'Women', 'Necklace', 'Haar', '22K', 38.5, 1.5, 750, 2],
  ['22K Gold Choker', 'Women', 'Necklace', 'Choker', '22K', 24.3, 0.3, 800, 2],
  ['22K Baby Bracelet', 'Kids', 'Bracelet', 'Baby Bracelet', '22K', 3.8, 0, 1000, 4],
  ["22K Men's Bracelet", 'Men', 'Bracelet', "Men's Bracelet", '22K', 15.6, 0, 750, 4],
  ['22K Traditional Mangalsutra', 'Women', 'Mangalsutra', 'Short', '22K', 9.75, 0.25, 950, 4],
  ['22K Long Mangalsutra', 'Women', 'Mangalsutra', 'Long', '22K', 16.4, 0.4, 900, 1],
  ['22K Gold Nose Pin', 'Women', 'Nose Pin', 'Stud', '22K', 0.85, 0.05, 1500, 10],
  ['22K Floral Nose Pin', 'Women', 'Nose Pin', 'Floral', '22K', 1.25, 0.05, 1400, 7],
];

const CUSTOMERS = [
  { name: 'Rahul Das', phone: '9876543210', alternate_phone: '9836512345', address: 'Flat 4B, Lake View Apartments, Sector II, Salt Lake', city: 'Kolkata', dob: '1988-03-14', anniversary: '2015-02-07', notes: 'Regular customer — chains and rings. Prefers UPI.' },
  { name: 'Sneha Banerjee', phone: '9830123456', address: '22/1 Gariahat Road, Ballygunge', city: 'Kolkata', dob: '1991-07-22', anniversary: '2018-12-02', notes: "Earrings for her sister's wedding." },
  { name: 'Ananya Mukherjee', phone: '9831234567', address: '14 Hazra Lane, Bhowanipore', city: 'Kolkata', dob: '1986-11-05', anniversary: '2012-01-20' },
  { name: 'Arjun Sen', phone: '9433012345', address: 'B-27, Baguiati Housing Estate', city: 'Kolkata', dob: '1979-09-30' },
  { name: 'Meera Agarwal', phone: '9903456789', alternate_phone: '9903456790', address: '102 Rabindra Sarani, Burrabazar', city: 'Kolkata', anniversary: '2000-11-25', notes: "Daughter's wedding in December — asking about a bridal set." },
  { name: 'Rohan Ghosh', phone: '9748123456', address: '5/2 Ramkrishna Road, Shibpur', city: 'Howrah', dob: '1994-01-18' },
  { name: 'Kavita Jain', phone: '9007123456', address: 'Mahavir Tower, Park Street', city: 'Kolkata', dob: '1983-05-09', anniversary: '2009-04-26', notes: 'Buys for festivals. Likes light-weight designs.' },
  { name: 'Sourav Dutta', phone: '9123408765', address: '31 B.T. Road, Barrackpore', city: 'Barrackpore', dob: '1990-12-03' },
];

// 22K rate history (₹/g) as [days ago, rate]. 24K and 18K move in step with it.
const RATE_22K = [[30, 14480], [24, 14510], [20, 14540], [18, 14560], [14, 14580], [12, 14600], [10, 14650], [8, 14640], [6, 14670], [3, 14720], [0, 14720]];

// Categories/pricing survive `clearAll()`, so they're the right signal for "has this database been set up
// at all" — checking `customers` would cause a server restart to silently re-seed fake data after a clear.
function hasData() {
  return q.get('SELECT COUNT(*) AS n FROM categories').n > 0;
}

function seed() {
  clock.reset();
  const today = clock.today();
  const d = (n) => addDays(today, -n); // n days ago (negative = in the future)
  const at = (n, time = '11:00') => clock.setNow(`${d(n)}T${time}:00`);

  try {
    tx(() => {
      settings.seedDefaults();

      // ---- categories
      const catId = {};
      let sort = 0;
      for (const [name, subs] of Object.entries(CATEGORIES)) {
        const id = Number(q.run('INSERT INTO categories (name, gender, status, sort_order) VALUES (?, NULL, ?, ?)', name, 'active', ++sort).lastInsertRowid);
        catId[name] = id;
        for (const sub of subs) {
          catId[`${name}/${sub}`] = Number(q.run(
            'INSERT INTO categories (name, parent_category_id, gender, status, sort_order) VALUES (?, ?, ?, ?, ?)',
            sub, id, SUB_GENDER[sub] || null, 'active', ++sort).lastInsertRowid);
        }
      }

      // ---- gold rate history (effective-dated, so orders placed on a given day price at that day's rate)
      for (const [daysAgo, rate22] of RATE_22K) {
        at(daysAgo, '09:30');
        const purityRates = [
          ['24K', Math.round((rate22 * 24) / 22 / 10) * 10],
          ['22K', rate22],
          ['18K', Math.round((rate22 * 18) / 22 / 10) * 10],
        ];
        for (const [purity, rate] of purityRates) {
          goldRates.add({ purity, rate_per_gram: rate, effective_date: d(daysAgo), note: daysAgo === 0 ? 'Morning rate' : null });
        }
      }

      // ---- d30: customers & catalogue
      at(30, '10:00');
      const cust = {};
      for (const c of CUSTOMERS) cust[c.name] = customers.create(c).id;
      // Spread each category's real photos across its products (round-robin keeps every product
      // photographed even when a category has fewer photos than products).
      const productImages = {};
      for (const [category, folder] of Object.entries(CATEGORY_PHOTO_DIR)) {
        const names = PRODUCTS.filter((p) => p[2] === category).map((p) => p[0]);
        const photos = categoryPhotos(folder);
        photos.forEach((url, i) => (productImages[names[i % names.length]] ??= []).push(url));
      }

      const prod = {};
      for (const [name, gender, category, sub, purity, gross, stone, making, stock] of PRODUCTS) {
        prod[name] = products.createProduct({
          name, gender, category_id: catId[category], subcategory_id: catId[`${category}/${sub}`],
          purity, gross_weight: gross, stone_weight: stone, making_charge: making, stock_quantity: stock,
          images: productImages[name] || [],
        }).id;
      }
      const item = (name, quantity = 1) => ({ product_id: prod[name], quantity });
      const due = (id) => orders.getOrder(id).settlement.delivery.outstanding;

      // ---- d25: Kavita Jain — pendant + studs (will be billed)
      at(25, '11:20');
      const kavita = orders.createOrder({
        customer_id: cust['Kavita Jain'], items: [item('22K Floral Pendant'), item('22K Stud Earrings')],
        expected_delivery_date: d(20), notes: 'Diwali gift set',
        advance: { amount: 30000, payment_method: 'UPI', reference_number: 'UPI 4021 5839 2716' },
      }).order;

      // ---- d22: restock
      at(22, '15:10');
      products.adjustStock(prod['22K Stud Earrings'], { type: 'RESTOCK', quantity: 4, reason: 'Restocked from karigar — batch 14' });

      // ---- d20: Kavita collects and pays the balance; bill issued
      at(20, '17:05');
      orders.deliver(kavita.id, { payment: { amount: due(kavita.id), payment_method: 'Card', reference_number: 'Card ****4417 / Auth 884120' } });
      bills.generate(kavita.id);

      // ---- d18: Rohan Ghosh — men's ring (will be billed)
      at(18, '12:15');
      const rohan = orders.createOrder({
        customer_id: cust['Rohan Ghosh'], items: [item("22K Men's Gold Ring")], expected_delivery_date: d(12),
        advance: { amount: 60000, payment_method: 'Cash' },
      }).order;

      // ---- d15: stock adjustment outside any order
      at(15, '12:40');
      products.adjustStock(prod['22K Long Mangalsutra'], { type: 'ADJUSTMENT', quantity: -1, reason: 'Sent to karigar for remodelling' });

      // ---- d12: Rohan collects; bill issued
      at(12, '16:30');
      orders.deliver(rohan.id, { payment: { amount: due(rohan.id), payment_method: 'UPI', reference_number: 'UPI 4188 2093 7714' } });
      bills.generate(rohan.id);

      // ---- d10: Sneha Banerjee — jhumka; delivery date already passed today, so she is overdue
      at(10, '13:00');
      const sneha = orders.createOrder({
        customer_id: cust['Sneha Banerjee'], items: [item('22K Jhumka Earrings')], expected_delivery_date: d(3),
        notes: 'Wants the pair polished before delivery.',
        advance: { amount: 30000, payment_method: 'Cash' },
      }).order;

      // ---- d9: Sourav Dutta — designer churi pair (delivered, bill still to be generated)
      at(9, '14:25');
      const sourav = orders.createOrder({
        customer_id: cust['Sourav Dutta'], items: [item('22K Designer Churi Pair')], expected_delivery_date: d(5),
        advance: { amount: 100000, payment_method: 'Bank Transfer', reference_number: 'NEFT SBIN52609170023' },
      }).order;

      // ---- d7 / d6: Arjun Sen's kada order is placed, then cancelled (stock is reserved, then released)
      at(7, '18:00');
      const kada = orders.createOrder({ customer_id: cust['Arjun Sen'], items: [item('22K Traditional Kada')], expected_delivery_date: d(-7) }).order;
      at(6, '11:45');
      orders.cancelOrder(kada.id, 'Customer changed the design');

      // ---- d6: Ananya Mukherjee — mangalsutra + nose pin
      at(6, '15:40');
      const ananya = orders.createOrder({
        customer_id: cust['Ananya Mukherjee'], items: [item('22K Traditional Mangalsutra'), item('22K Gold Nose Pin')],
        expected_delivery_date: d(-2),
        advance: { amount: 40000, payment_method: 'Card', reference_number: 'Card ****2290 / Auth 501877' },
      }).order;

      // ---- d5: Sourav pays in instalments and takes delivery
      at(5, '10:30');
      orders.addPayment(sourav.id, { amount: 100000, payment_method: 'UPI', reference_number: 'UPI 4209 7715 3308' });
      at(5, '10:50');
      orders.deliver(sourav.id, { payment: { amount: due(sourav.id), payment_method: 'Cash' } });

      // ---- d4: Sneha's second payment
      at(4, '12:20');
      orders.addPayment(sneha.id, { amount: 20000, payment_method: 'UPI', reference_number: 'UPI 4301 1187 5502' });

      // ---- d3: Rahul Das — the reference scenario: 22K Classic Gold Chain, 10 g at ₹14,720/g, ₹50,000 advance
      at(3, '11:35');
      orders.createOrder({
        customer_id: cust['Rahul Das'], items: [item('22K Classic Gold Chain')], expected_delivery_date: d(0),
        notes: 'Anniversary gift. Will collect on the delivery date.',
        advance: { amount: 50000, payment_method: 'UPI', reference_number: 'UPI 4327 9901 2264' },
      });

      // ---- d2: Ananya's second payment; Meera Agarwal books a Rani Haar with a token advance
      at(2, '13:10');
      orders.addPayment(ananya.id, { amount: 35000, payment_method: 'UPI', reference_number: 'UPI 4355 6120 8873' });
      at(2, '16:00');
      orders.createOrder({
        customer_id: cust['Meera Agarwal'], items: [item('22K Rani Haar Necklace')], expected_delivery_date: d(-14),
        notes: 'Wedding gift — final design to be confirmed.',
        advance: { amount: 25000, payment_method: 'Cash' },
      });

      // ---- d1: Ananya's piece is ready; Arjun Sen books a bracelet without an advance
      at(1, '11:00');
      orders.setReady(ananya.id, true);
      at(1, '17:30');
      orders.createOrder({ customer_id: cust['Arjun Sen'], items: [item("22K Men's Bracelet")], expected_delivery_date: d(-9) });
    });
  } finally {
    clock.reset();
  }
  orders.recalcOpenOrders(); // bring open orders up to today's rate
}

/** Wipes everything and reloads the demo data. */
function resetDemo() {
  clock.reset();
  dropAll();
  migrate();
  seed();
}

/** Wipes all business data (customers, products, orders, payments, bills, stock, gold rates) for a clean start.
 *  Keeps the category taxonomy and pricing configuration, since those are shop setup, not demo data.
 *  Drops the tables outright rather than DELETE, since bills/payments are guarded by immutability triggers. */
function clearAll() {
  dropTables(['bills', 'payments', 'order_items', 'order_events', 'orders', 'stock_movements', 'products', 'customers', 'gold_rates']);
}

module.exports = { seed, hasData, resetDemo, clearAll };
