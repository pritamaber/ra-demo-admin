'use strict';
/**
 * Pricing engine — pure functions, no database access. One simple formula, locked on the order date:
 *
 *   gold value = net weight (g) × gold rate (₹/g) of that day
 *   making     = net weight (g) × making charge (₹/g)
 *   GST        = GST% × (gold value + making)
 *   total      = gold value + making + GST + other charges        (each amount rounded to the rupee)
 */
const { round2 } = require('../util');

/**
 * items: [{ net_weight (total grams for the line), making_rate (₹/g), rate (₹/g) }]
 * Returns per-line and order-level figures.
 */
function priceOrder({ items, otherCharges = 0, gstRate }) {
  const lines = items.map((it) => {
    const gold_value = Math.round(it.net_weight * it.rate);
    const making = Math.round(it.net_weight * it.making_rate);
    const gst = Math.round(((gold_value + making) * gstRate) / 100);
    return { gold_rate: it.rate, gold_value, making_charge: making, gst, total: gold_value + making + gst };
  });

  const other_charges = Math.round(otherCharges);
  const gold_value = lines.reduce((s, l) => s + l.gold_value, 0);
  const making_charge = lines.reduce((s, l) => s + l.making_charge, 0);
  const gst = lines.reduce((s, l) => s + l.gst, 0);

  return { lines, gold_value, making_charge, other_charges, gst, total: round2(gold_value + making_charge + gst + other_charges) };
}

module.exports = { priceOrder };
