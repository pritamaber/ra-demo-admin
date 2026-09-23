'use strict';
/**
 * Pricing engine — pure functions, no database access.
 * Every amount is derived from (weights, rates, rules); nothing here assumes a particular shop policy.
 * The rules object comes from settings.getRules() (or the snapshot frozen on a delivered order).
 */
const { round2 } = require('../util');

const componentRounder = (rules) => (rules.component_rounding === 'paise' ? round2 : Math.round);

function totalRounder(rules) {
  switch (rules.total_rounding) {
    case 'nearest_10': return (v) => Math.round(v / 10) * 10;
    case 'nearest_100': return (v) => Math.round(v / 100) * 100;
    default: return round2;
  }
}

function makingCharge(item, goldValue, rules) {
  const method = item.making_method;
  switch (method) {
    case 'fixed_per_piece': return item.quantity * item.making_rate;
    case 'percent_of_gold': return (goldValue * item.making_rate) / 100;
    case 'per_gram':
    default: return item.net_weight * item.making_rate;
  }
}

/**
 * item: { quantity, net_weight (total for the line), making_method, making_rate, rate, fixed_making? }
 * Returns per-line and order-level figures.
 */
function priceOrder({ items, otherCharges = 0, rules }) {
  const rnd = componentRounder(rules);
  const fixMaking = rules.making_charge_basis === 'fixed_at_order';
  const gstFraction = rules.gst_rate / 100;

  const lines = items.map((it) => {
    const gold_value = rnd(it.net_weight * it.rate);
    const making = fixMaking && it.fixed_making != null ? it.fixed_making : rnd(makingCharge(it, gold_value, rules));
    const gstBase = rules.gst_basis === 'gold_only' ? gold_value : gold_value + making;
    const gst = rnd(gstBase * gstFraction);
    return { gold_rate: it.rate, gold_value, making_charge: making, gst, total: round2(gold_value + making + gst) };
  });

  const other_charges = rnd(otherCharges);
  const gstOnOther = rules.gst_basis === 'gold_making_other' ? rnd(other_charges * gstFraction) : 0;

  const gold_value = round2(lines.reduce((s, l) => s + l.gold_value, 0));
  const making_charge = round2(lines.reduce((s, l) => s + l.making_charge, 0));
  const gst = round2(lines.reduce((s, l) => s + l.gst, 0) + gstOnOther);
  const before = round2(gold_value + making_charge + other_charges + gst);
  const total = totalRounder(rules)(before);

  return { lines, gold_value, making_charge, other_charges, gst, round_off: round2(total - before), total };
}

/**
 * How much of the bill the payments cover.
 *  - monetary_credit:        credit = money paid.
 *  - gold_equivalent_credit: credit = grams bought at each payment's own rate, valued at the settlement rate.
 * `payments` are the untouched records; the actual amount paid is always reported separately.
 */
function computeCredit(payments, rules, settlementRate) {
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
  const goldEquivalent = payments.reduce((s, p) => s + p.gold_equivalent, 0); // full precision
  const credit = rules.advance_treatment === 'gold_equivalent_credit' ? round2(goldEquivalent * settlementRate) : paid;
  return { paid, gold_equivalent: goldEquivalent, credit };
}

module.exports = { priceOrder, computeCredit };
