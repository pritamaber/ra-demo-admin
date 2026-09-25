'use strict';
/** A gold-rate change re-values the unpaid gold of every open order, so it is applied together, atomically, from here. */
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
    const repriced = orders.recalcOpenOrders(`${rate.purity} gold rate set to ${inr(rate.rate_per_gram)}/g`);
    return { rate, derived, repriced_orders: repriced, current: goldRates.current() };
  });
}

function updateSettings(patch) {
  return tx(() => {
    const all = settings.update(patch);
    return { settings: all };
  });
}

module.exports = { setGoldRate, updateSettings };
