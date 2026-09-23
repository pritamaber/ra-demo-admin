'use strict';
const { q } = require('../db');
const { clock, round2 } = require('../util');
const settings = require('./settings');
const goldRates = require('./goldrates');
const products = require('./products');
const orders = require('./orders');

const OPEN_SQL = orders.OPEN.map((s) => `'${s}'`).join(',');
const BOOKED = "o.status NOT IN ('DRAFT','CANCELLED')";

/** Outstanding payments table: open orders with money still due, filtered and sorted for the owner. */
function outstanding({ sort = 'overdue', filter = 'all' } = {}) {
  let rows = orders.listOrders({ view: 'outstanding', sort, limit: 500 }).items;
  if (filter === 'overdue') rows = rows.filter((r) => r.due_flag === 'OVERDUE');
  else if (filter === 'due') rows = rows.filter((r) => r.due_flag === 'DUE_TODAY' || r.due_flag === 'DUE_SOON');
  else if (filter === 'ready') rows = rows.filter((r) => r.is_ready);
  return rows;
}

/** Credit given: orders handed over to the customer while money is still owed, sortable by value or repayment date. */
function creditsGiven({ sort = 'credit_due' } = {}) {
  return orders.listOrders({ view: 'credit', sort, limit: 500 }).items;
}

function overview() {
  const today = clock.today();
  const stock = products.summary();
  const credit = q.get("SELECT COUNT(*) AS n, COALESCE(SUM(outstanding_amount), 0) AS total FROM orders WHERE status = 'DELIVERED' AND outstanding_amount > 0.005");

  const todaysOrders = q.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS total FROM orders o WHERE o.order_date = ? AND ${BOOKED}`, today);
  const collections = q.get('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE payment_date = ?', today);
  const open = q.get(
    `SELECT COUNT(*) AS pending, COALESCE(SUM(outstanding_amount), 0) AS outstanding,
       COALESCE(SUM(CASE WHEN is_ready = 1 THEN 1 ELSE 0 END), 0) AS ready,
       COALESCE(SUM(CASE WHEN expected_delivery_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
       COALESCE(SUM(CASE WHEN outstanding_amount > 0.005 THEN 1 ELSE 0 END), 0) AS with_dues,
       COUNT(DISTINCT CASE WHEN outstanding_amount > 0.005 THEN customer_id END) AS customers_owing
     FROM orders WHERE status IN (${OPEN_SQL})`, today);

  const debtors = q.all(
    `SELECT c.id, c.name, c.phone, ROUND(SUM(o.outstanding_amount), 2) AS due, COUNT(*) AS orders, MIN(o.expected_delivery_date) AS next_delivery
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN (${OPEN_SQL}) AND o.outstanding_amount > 0.005
     GROUP BY c.id ORDER BY due DESC LIMIT 5`);

  const recentPayments = q.all(
    `SELECT p.id, p.amount, p.payment_method, p.payment_date, o.id AS order_id, o.order_number, c.id AS customer_id, c.name AS customer_name
     FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
     ORDER BY p.payment_date DESC, p.id DESC LIMIT 6`);

  return {
    date: today,
    kpis: {
      todays_orders: todaysOrders.n,
      todays_sales: round2(todaysOrders.total),
      todays_collections: round2(collections.total),
      todays_payments: collections.n,
      pending_orders: open.pending,
      outstanding_amount: round2(open.outstanding),
      customers_owing: open.customers_owing,
      ready_for_delivery: open.ready,
      overdue_orders: open.overdue,
      low_stock: stock.low_stock,
      out_of_stock: stock.out_of_stock,
      awaiting_bill: q.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'DELIVERED'").n,
      credit_given_orders: credit.n,
      credit_given_amount: round2(credit.total),
    },
    outstanding: outstanding(),
    credit_given: creditsGiven(),
    debtors,
    recent_payments: recentPayments,
    gold_rates: goldRates.current(),
    low_stock_items: products.listProducts({ stock_status: 'LOW_STOCK', status: 'active', sort: 'stock', limit: 5 }).items,
    out_of_stock_items: products.listProducts({ stock_status: 'OUT_OF_STOCK', status: 'active', sort: 'stock', limit: 5 }).items,
    settings: { due_soon_days: settings.getAll().due_soon_days },
  };
}

module.exports = { overview, outstanding, creditsGiven };
