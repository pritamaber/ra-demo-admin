'use strict';
/** Gold rate and settings changes. Placed orders are priced on their order date, so nothing here touches them. */
const { tx } = require('../db');
const goldRates = require('./goldrates');
const settings = require('./settings');

function setGoldRate(input) {
  return tx(() => {
    const rates = goldRates.addAllPurities(input);
    const rate = rates.find((r) => r.purity === input.purity);
    const derived = rates.filter((r) => r.purity !== input.purity);
    return { rate, derived, current: goldRates.current() };
  });
}

function updateSettings(patch) {
  return { settings: settings.update(patch) };
}

module.exports = { setGoldRate, updateSettings };
