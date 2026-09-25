'use strict';
/** REST API. Each route is [method, path, handler({ params, query, body })] and returns JSON-serialisable data. */
const { HttpError, bad, notFound } = require('./util');
const settings = require('./services/settings');
const goldRates = require('./services/goldrates');
const products = require('./services/products');
const customers = require('./services/customers');
const orders = require('./services/orders');
const bills = require('./services/bills');
const sales = require('./services/sales');
const dashboard = require('./services/dashboard');
const market = require('./services/market');
const { resetDemo, clearAll } = require('./seed');

const id = (p) => {
  const n = Number(p.id);
  if (!Number.isInteger(n) || n < 1) throw bad('Invalid id');
  return n;
};

module.exports = [
  ['GET', '/api/health', () => ({ ok: true })],

  // ---- dashboard
  ['GET', '/api/dashboard', () => dashboard.overview()],
  ['GET', '/api/dashboard/outstanding', ({ query }) => ({ items: dashboard.outstanding(query) })],

  // ---- customers
  ['GET', '/api/customers', ({ query }) => customers.list(query)],
  ['GET', '/api/customers/lookup', ({ query }) => {
    const c = customers.findByPhone(query.phone);
    if (!c) throw notFound('Customer with this phone number');
    return c;
  }],
  ['GET', '/api/customers/:id', ({ params }) => customers.getProfile(id(params))],
  ['POST', '/api/customers', ({ body }) => customers.create(body)],
  ['PUT', '/api/customers/:id', ({ params, body }) => customers.update(id(params), body)],
  ['DELETE', '/api/customers/:id', ({ params }) => customers.remove(id(params))],

  // ---- public read-only catalogue (CORS-enabled — see server.js — for the separate storefront site)
  ['GET', '/api/public/categories', () => ({ items: products.categoryTree().filter((c) => c.status === 'active').map((c) => ({ name: c.name, slug: c.slug, product_count: c.product_count })) })],
  ['GET', '/api/public/products', ({ query }) => ({ items: products.publicCatalog(query) })],

  // ---- catalogue
  ['GET', '/api/categories', () => ({ items: products.categoryTree(), genders: products.GENDERS, purities: goldRates.PURITIES })],
  ['POST', '/api/categories', ({ body }) => ({ id: products.saveCategory(body) })],
  ['PUT', '/api/categories/:id', ({ params, body }) => ({ id: products.saveCategory(body, id(params)) })],
  ['GET', '/api/products', ({ query }) => products.listProducts(query)],
  ['GET', '/api/products/:id', ({ params }) => products.getProduct(id(params))],
  ['POST', '/api/products', ({ body }) => products.createProduct(body)],
  ['PUT', '/api/products/:id', ({ params, body }) => products.updateProduct(id(params), body)],
  ['DELETE', '/api/products/:id', ({ params }) => products.deleteProduct(id(params))],

  // ---- inventory
  ['POST', '/api/products/:id/stock', ({ params, body }) => products.adjustStock(id(params), body)],
  ['GET', '/api/inventory/summary', () => products.summary()],
  ['GET', '/api/inventory/movements', ({ query }) => products.movements(query)],

  // ---- orders
  ['GET', '/api/orders', ({ query }) => orders.listOrders(query)],
  ['POST', '/api/orders/preview', ({ body }) => orders.previewOrder(body)],
  ['POST', '/api/orders', ({ body }) => orders.createOrder(body)],
  ['GET', '/api/orders/:id', ({ params }) => orders.getOrder(id(params))],
  ['POST', '/api/orders/:id/accept', ({ params }) => orders.acceptOrder(id(params))],
  ['POST', '/api/orders/:id/settlement', ({ params, body }) => orders.previewSettlement(id(params), body.adjust)],
  ['POST', '/api/orders/:id/payments', ({ params, body }) => orders.addPayment(id(params), body)],
  ['POST', '/api/orders/:id/ready', ({ params, body }) => orders.setReady(id(params), body.ready !== false)],
  ['PUT', '/api/orders/:id/delivery-date', ({ params, body }) => orders.updateDeliveryDate(id(params), body.expected_delivery_date)],
  ['POST', '/api/orders/:id/deliver', ({ params, body }) => orders.deliver(id(params), body)],
  ['POST', '/api/orders/:id/cancel', ({ params, body }) => orders.cancelOrder(id(params), body.reason)],

  // ---- billing
  ['GET', '/api/billing/overview', () => bills.overview()],
  ['POST', '/api/sales', ({ body }) => sales.createSale(body)],
  ['GET', '/api/bills', ({ query }) => bills.list(query)],
  ['GET', '/api/bills/:id', ({ params }) => bills.get(id(params))],

  // ---- gold rate master
  ['GET', '/api/gold-rates/current', () => ({ items: goldRates.current() })],
  ['GET', '/api/gold-rates', ({ query }) => ({ items: goldRates.history(query) })],
  ['POST', '/api/gold-rates', ({ body }) => market.setGoldRate(body)],

  // ---- pricing rules & shop settings
  ['GET', '/api/settings', () => ({ values: settings.getAll(), definitions: settings.definitionsForUi() })],
  ['PUT', '/api/settings', ({ body }) => market.updateSettings(body)],

  // ---- demo administration
  ['POST', '/api/admin/reset', () => { resetDemo(); return { ok: true }; }],
  ['POST', '/api/admin/clear', () => { clearAll(); return { ok: true }; }],
];

module.exports.HttpError = HttpError;
