'use strict';
/**
 * Changes to the gold price or the pricing rules ripple into every open order,
 * so they are applied together, atomically, from here.
 */
const { tx } = require('../db');
const { inr } = require('../util');
const goldRates = require('./goldrates');
const settings = require('./settings');
const orders = require('./orders');

function setGoldRate(input) {
  return tx(() => {
    const rates = goldRates.addAllPurities(input);
    const rate = rates.find((r) => r.purity === input.purity);
    const derived = rates.filter((r) => r.purity !== input.purity);
    const repriced = orders.recalcOpenOrders(`${rate.purity} gold rate set to ${inr(rate.rate_per_gram)}/g (other purities auto-updated)`);
    return { rate, derived, repriced_orders: repriced, current: goldRates.current() };
  });
}

function updateSettings(patch) {
  return tx(() => {
    const all = settings.update(patch);
    const touchesPricing = Object.keys(patch).some((k) => settings.PRICING_KEYS.includes(k) || k === 'min_advance_percent');
    const repriced = touchesPricing ? orders.recalcOpenOrders('pricing rules changed') : 0;
    return { settings: all, repriced_orders: repriced };
  });
}

module.exports = { setGoldRate, updateSettings };
