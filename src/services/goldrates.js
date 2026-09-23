'use strict';
const { q } = require('../db');
const { bad, conflict, clock, isIsoDate, num, str, round2 } = require('../util');
const supabase = require('./supabase');

const PURITIES = ['24K', '22K', '18K'];
// Fineness (purity fraction) used to derive the other two rates from whichever one is entered.
const FINENESS = { '24K': 0.9999, '22K': 0.916, '18K': 0.75 };

/** Rate applicable on `asOf`: the latest entry effective on or before that date. History is never overwritten. */
function getRate(purity, asOf = clock.today()) {
  const row = q.get(
    `SELECT rate_per_gram FROM gold_rates WHERE purity = ? AND effective_date <= ?
     ORDER BY effective_date DESC, id DESC LIMIT 1`, purity, asOf);
  if (row) return row.rate_per_gram;
  const first = q.get('SELECT rate_per_gram FROM gold_rates WHERE purity = ? ORDER BY effective_date, id LIMIT 1', purity);
  if (first) return first.rate_per_gram;
  throw conflict(`No gold rate has been set for ${purity}. Add one in the Gold Rate master first.`);
}

function current() {
  const today = clock.today();
  return PURITIES.map((purity) => {
    const latest = q.get(
      `SELECT * FROM gold_rates WHERE purity = ? AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`, purity, today);
    if (!latest) return { purity, rate_per_gram: null };
    const prev = q.get(
      `SELECT rate_per_gram FROM gold_rates WHERE purity = ? AND (effective_date < ? OR (effective_date = ? AND id < ?))
       ORDER BY effective_date DESC, id DESC LIMIT 1`, purity, latest.effective_date, latest.effective_date, latest.id);
    const previous = prev?.rate_per_gram ?? null;
    return {
      purity,
      rate_per_gram: latest.rate_per_gram,
      effective_date: latest.effective_date,
      updated_at: latest.created_at,
      note: latest.note,
      previous_rate: previous,
      change: previous == null ? null : round2(latest.rate_per_gram - previous),
      change_percent: previous == null ? null : round2(((latest.rate_per_gram - previous) / previous) * 100),
    };
  });
}

function history({ purity, limit = 60 } = {}) {
  const params = [];
  let where = '';
  if (purity) { where = 'WHERE purity = ?'; params.push(purity); }
  return q.all(`SELECT * FROM gold_rates ${where} ORDER BY effective_date DESC, id DESC LIMIT ?`, ...params, Math.min(Number(limit) || 60, 500));
}

function add(input) {
  const purity = input.purity;
  if (!PURITIES.includes(purity)) throw bad(`Purity must be one of ${PURITIES.join(', ')}`);
  const rate = round2(num(input.rate_per_gram, 'Rate per gram', { min: 1 }));
  const effective = input.effective_date || clock.today();
  if (!isIsoDate(effective)) throw bad('Effective date must be a valid date');
  const res = q.run(
    'INSERT INTO gold_rates (purity, rate_per_gram, effective_date, note, created_at) VALUES (?, ?, ?, ?, ?)',
    purity, rate, effective, str(input.note), clock.timestamp());
  return q.get('SELECT * FROM gold_rates WHERE id = ?', res.lastInsertRowid);
}

/** Enter one purity's rate and the other two are derived from it by fineness, so a single entry keeps
 *  all three in step (e.g. 22K = 91.6% pure, 24K = 99.99%, 18K = 75%). */
function addAllPurities(input) {
  const purity = input.purity;
  if (!PURITIES.includes(purity)) throw bad(`Purity must be one of ${PURITIES.join(', ')}`);
  const enteredRate = round2(num(input.rate_per_gram, 'Rate per gram', { min: 1 }));
  const pureRate = enteredRate / FINENESS[purity];
  const rows = PURITIES.map((p) => {
    const rate_per_gram = p === purity ? enteredRate : Math.round((pureRate * FINENESS[p]) / 10) * 10;
    const note = p === purity ? input.note : `Auto-calculated from ${purity} @ ${enteredRate}/g`;
    return add({ purity: p, rate_per_gram, effective_date: input.effective_date, note });
  });
  supabase.syncGoldRates(rows).catch((e) => console.error('Supabase gold-rate sync failed:', e.message));
  return rows;
}

module.exports = { PURITIES, FINENESS, getRate, current, history, add, addAllPurities };
