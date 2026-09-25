'use strict';
/**
 * Walk-in sale ("New Bill"): the customer is in the shop, picks the pieces, pays in full and takes them home.
 * It is the same Order underneath — placed, accepted, paid, delivered and billed in one atomic step — so stock,
 * payments, customer history and the final bill all behave exactly as they do for a booked order.
 */
const { tx } = require('../db');
const { bad, num, round2 } = require('../util');
const orders = require('./orders');

function createSale(input) {
  const pay = input.payment;
  if (!pay || !pay.payment_method) throw bad('Choose how the customer is paying');
  return tx(() => {
    const placed = orders.createOrder({ ...input, payment: null, advance: null }, 'SALE');
    const id = placed.order.id;
    orders.acceptOrder(id);
    // The customer pays the whole bill now; an optional amount is only accepted if it matches the total.
    const total = orders.orderRow(id).total_amount;
    if (pay.amount != null && pay.amount !== '' && round2(num(pay.amount, 'Amount')) !== round2(total)) {
      throw bad(`A walk-in bill is paid in full — the total is ${total}`);
    }
    return orders.deliver(id, { payment: { amount: total, payment_method: pay.payment_method, reference_number: pay.reference_number, payment_date: pay.payment_date } });
  });
}

module.exports = { createSale };
