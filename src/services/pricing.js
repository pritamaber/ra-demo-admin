'use strict';
/**
 * Pricing engine — pure functions, no database access.
 *
 * BOOKING QUOTE (priceOrder), at the gold rate of the order date:
 *   gold value = net weight (g) × gold rate (₹/g)
 *   making     = net weight (g) × making charge (₹/g)
 *   GST        = GST% × (gold value + making)
 *   total      = gold + making + GST + other charges, rounded to the nearest rupee (the difference is the "round off")
 *
 * GOLD-FIRST SETTLEMENT (allocatePayment / settle) — how the customer actually pays:
 *   Every payment buys gold at that day's rate:  grams = amount ÷ gold rate of the payment day.
 *   Gold already bought is locked at the rate it was bought at. The gold still unpaid is valued at today's rate,
 *   so it moves with the market until it is paid. Making charge and GST come on top; GST is worked out on the
 *   final gold value + making. Once all the gold is paid for, the total stops moving.
 *
 * Every amount is kept to the paisa; only the grand total is rounded.
 */
const { round2, round3 } = require('../util');

/**
 * items: [{ net_weight (total grams for the line), making_rate (₹/g), rate (₹/g) }]
 * Returns per-line and order-level figures.
 */
function priceOrder({ items, otherCharges = 0, gstRate }) {
  const lines = items.map((it) => {
    const gold_value = round2(it.net_weight * it.rate);
    const making = round2(it.net_weight * it.making_rate);
    const gst = round2(((gold_value + making) * gstRate) / 100);
    return { gold_rate: it.rate, gold_value, making_charge: making, gst, total: round2(gold_value + making + gst) };
  });

  const other_charges = round2(otherCharges);
  const gold_value = round2(lines.reduce((s, l) => s + l.gold_value, 0));
  const making_charge = round2(lines.reduce((s, l) => s + l.making_charge, 0));
  const gst = round2(lines.reduce((s, l) => s + l.gst, 0));
  const before = round2(gold_value + making_charge + gst + other_charges);
  const total = Math.round(before);

  return { lines, gold_value, making_charge, other_charges, gst, round_off: round2(total - before), total };
}

/**
 * How much of a payment buys gold. Gold is paid first; whatever is left over (once all the gold is paid for)
 * goes towards making charge and GST.
 *   goldFractionPaid — share of the order's gold already paid for (0..1)
 *   goldValueNow     — value of the WHOLE order's gold at the payment day's rate
 * Returns { gold_amount (₹ that bought gold), gold_fraction (share of the order's gold this payment bought) }.
 */
function allocatePayment({ amount, goldFractionPaid, goldValueNow }) {
  const remainingFraction = Math.max(1 - goldFractionPaid, 0);
  const remainingValue = remainingFraction * goldValueNow;
  if (remainingFraction < 1e-9 || goldValueNow <= 0) return { gold_amount: 0, gold_fraction: 0 };
  if (amount >= remainingValue - 0.005) return { gold_amount: Math.min(amount, round2(remainingValue)), gold_fraction: remainingFraction };
  return { gold_amount: amount, gold_fraction: amount / goldValueNow };
}

/**
 * Where an order stands, valued at `goldValueToday` (the value of the whole order's gold at today's rate).
 *   netWeight — total net gold weight of the order (g)
 *   payments  — [{ amount, gold_fraction, gold_amount }] as stored when each payment was taken
 */
function settle({ netWeight, goldValueToday, makingCharge, otherCharges, gstRate, payments }) {
  const paidFraction = Math.min(payments.reduce((s, p) => s + p.gold_fraction, 0), 1);
  const remainingFraction = paidFraction > 1 - 1e-9 ? 0 : 1 - paidFraction;
  const goldPaidAmount = round2(payments.reduce((s, p) => s + p.gold_amount, 0));
  const remainingGoldValue = remainingFraction === 0 ? 0 : round2(remainingFraction * goldValueToday);

  const gold_value = round2(goldPaidAmount + remainingGoldValue);
  const gst = round2(((gold_value + makingCharge) * gstRate) / 100);
  const before = round2(gold_value + makingCharge + gst + otherCharges);
  const total = Math.round(before);
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));

  // Money beyond the gold pays making charge first, then other charges, then GST.
  const beyondGold = Math.max(round2(paid - goldPaidAmount), 0);
  const makingPaid = Math.min(beyondGold, makingCharge);
  const otherPaid = Math.min(round2(beyondGold - makingPaid), otherCharges);
  const gstPaid = Math.min(round2(beyondGold - makingPaid - otherPaid), gst);

  return {
    remaining: {
      gold_grams: round3(remainingFraction * netWeight),
      gold_value: remainingGoldValue,
      making_charge: round2(makingCharge - makingPaid),
      other_charges: round2(otherCharges - otherPaid),
      gst: round2(gst - gstPaid),
      round_off: round2(total - before),
    },
    net_weight: netWeight,
    gold_paid_fraction: paidFraction,
    gold_paid_grams: round3(paidFraction * netWeight),
    gold_paid_amount: goldPaidAmount,
    gold_remaining_grams: round3(remainingFraction * netWeight),
    gold_remaining_value: remainingGoldValue,
    gold_rate_today: netWeight > 0 ? round2(goldValueToday / netWeight) : 0,
    gold_value, making_charge: makingCharge, other_charges: otherCharges, gst,
    round_off: round2(total - before), total,
    paid,
    outstanding: Math.max(round2(total - paid), 0),
    excess: Math.max(round2(paid - total), 0),
  };
}

module.exports = { priceOrder, allocatePayment, settle };
