'use strict';
/**
 * Pricing engine — pure functions, no database access. One simple formula, locked on the order date:
 *
 *   gold value = net weight (g) × gold rate (₹/g) of that day
 *   making     = net weight (g) × making charge (₹/g)
 *   GST        = GST% × (gold value + making)
 *   before     = gold value + making + GST + other charges
 *   total      = before, rounded to the nearest rupee — the difference is the "round off", shown as its own line
 *
 * Every amount above is kept to the paisa; only the grand total is rounded.
 */
const { round2 } = require('../util');

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

module.exports = { priceOrder };
