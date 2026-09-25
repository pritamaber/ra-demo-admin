'use strict';
const { q, tx } = require('../db');
const { bad, clock } = require('../util');

/**
 * Every configurable rule lives here: its default, its allowed values and the text the UI shows.
 * Adding a new rule = adding one entry here and reading it in pricing.js.
 */
const DEFINITIONS = [
  // ---- Pricing: the only number in the price formula that is not read from the product or the gold rate ----
  {
    key: 'gst_rate', group: 'pricing', type: 'number', default: 3, min: 0, max: 28, step: 0.1, suffix: '%',
    label: 'GST rate',
    description: 'Charged on gold value + making charge (3% is the standard rate on gold jewellery).',
  },
  // ---- Business rules ----
  {
    key: 'low_stock_threshold', group: 'business', type: 'number', default: 2, min: 0, step: 1, suffix: 'pcs',
    label: 'Low-stock threshold',
    description: 'A product with this many (or fewer) available pieces is flagged Low Stock.',
  },
  {
    key: 'due_soon_days', group: 'business', type: 'number', default: 3, min: 0, step: 1, suffix: 'days',
    label: 'Due-soon window',
    description: 'Orders whose delivery date is within this many days are flagged Due Soon.',
  },
  // ---- Shop profile (printed on bills) ----
  { key: 'shop_name', group: 'shop', type: 'text', default: 'RA Jewellers', label: 'Shop name', description: '' },
  { key: 'shop_tagline', group: 'shop', type: 'text', default: 'Fine Gold Jewellery · BIS Hallmarked', label: 'Tagline', description: '' },
  { key: 'shop_address', group: 'shop', type: 'text', default: 'Shop 21, Bowbazar Street, Kolkata 700 012', label: 'Address', description: '' },
  { key: 'shop_phone', group: 'shop', type: 'text', default: '033 2211 4455', label: 'Phone', description: '' },
  { key: 'shop_gstin', group: 'shop', type: 'text', default: '19XXXXX0000X1Z5 (demo)', label: 'GSTIN', description: 'Placeholder for the demo.' },
];

const BY_KEY = Object.fromEntries(DEFINITIONS.map((d) => [d.key, d]));
const PRICING_KEYS = DEFINITIONS.filter((d) => d.group === 'pricing').map((d) => d.key);

function seedDefaults() {
  const now = clock.timestamp();
  for (const d of DEFINITIONS) {
    q.run('INSERT OR IGNORE INTO pricing_settings (key, value, updated_at) VALUES (?, ?, ?)', d.key, String(d.default), now);
  }
}

function parse(def, raw) {
  return def.type === 'number' ? Number(raw) : raw;
}

/** All settings as { key: typedValue }. */
function getAll() {
  let rows = q.all('SELECT key, value FROM pricing_settings');
  if (rows.length < DEFINITIONS.length) { // first run, or a rule added since the database was created
    seedDefaults();
    rows = q.all('SELECT key, value FROM pricing_settings');
  }
  const out = {};
  for (const row of rows) {
    const def = BY_KEY[row.key];
    if (def) out[row.key] = parse(def, row.value);
  }
  return out;
}

/** The pricing rules (currently just the GST rate). */
function getRules() {
  const all = getAll();
  return Object.fromEntries(PRICING_KEYS.map((k) => [k, all[k]]));
}

function definitionsForUi() {
  return DEFINITIONS;
}

function update(patch) {
  if (!patch || typeof patch !== 'object') throw bad('Nothing to update');
  return tx(() => {
    const now = clock.timestamp();
    for (const [key, raw] of Object.entries(patch)) {
      const def = BY_KEY[key];
      if (!def) throw bad(`Unknown setting: ${key}`);
      let value = raw;
      if (def.type === 'number') {
        value = Number(raw);
        if (!Number.isFinite(value)) throw bad(`${def.label} must be a number`);
        if (def.min != null && value < def.min) throw bad(`${def.label} must be at least ${def.min}`);
        if (def.max != null && value > def.max) throw bad(`${def.label} must be at most ${def.max}`);
      } else if (def.type === 'select') {
        if (!def.options.some((o) => o.value === raw)) throw bad(`Invalid value for ${def.label}`);
      } else {
        value = String(raw ?? '').trim();
      }
      q.run('UPDATE pricing_settings SET value = ?, updated_at = ? WHERE key = ?', String(value), now, key);
    }
    return getAll();
  });
}

module.exports = { DEFINITIONS, definitionsForUi, getAll, getRules, update, seedDefaults, PRICING_KEYS };
