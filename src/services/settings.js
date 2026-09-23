'use strict';
const { q, tx } = require('../db');
const { bad, clock } = require('../util');

const opt = (value, label, hint) => ({ value, label, hint });

/**
 * Every configurable rule lives here: its default, its allowed values and the text the UI shows.
 * Adding a new rule = adding one entry here and reading it in pricing.js.
 */
const DEFINITIONS = [
  // ---- Pricing rules (frozen onto an order when it is delivered) ----
  {
    key: 'gold_rate_settlement', group: 'pricing', type: 'select', default: 'delivery_date_rate',
    label: 'Gold value at settlement',
    description: 'Which gold rate is used to value the gold when the customer settles the order.',
    options: [
      opt('delivery_date_rate', 'Recalculate at delivery-date rate', 'Gold value follows the market until the piece is delivered.'),
      opt('order_date_rate', 'Lock at order-date rate', 'Gold value is fixed on the day the order is placed.'),
    ],
  },
  {
    key: 'advance_treatment', group: 'pricing', type: 'select', default: 'monetary_credit',
    label: 'Treatment of advance payments',
    description: 'How money received before delivery is credited against the final amount.',
    options: [
      opt('monetary_credit', 'Monetary credit', 'Every rupee paid is a rupee of credit, whatever the gold rate does.'),
      opt('gold_equivalent_credit', 'Gold-equivalent credit', 'Each payment is converted to grams at its own gold rate, then valued at the settlement rate.'),
    ],
  },
  {
    key: 'making_charge_method', group: 'pricing', type: 'select', default: 'per_gram',
    label: 'Making charge method',
    description: 'How the product\'s making-charge figure is interpreted for new orders.',
    options: [
      opt('per_gram', 'Rupees per gram of net gold', 'e.g. ₹850/g × net weight'),
      opt('fixed_per_piece', 'Fixed rupees per piece', 'e.g. ₹8,500 per piece'),
      opt('percent_of_gold', 'Percent of gold value', 'e.g. 8% of gold value'),
    ],
  },
  {
    key: 'making_charge_basis', group: 'pricing', type: 'select', default: 'fixed_at_order',
    label: 'Making charge at delivery',
    description: 'Whether the making charge quoted on the order date can change at delivery.',
    options: [
      opt('fixed_at_order', 'Fixed from the order date', 'The quoted making charge never changes.'),
      opt('recalculate_at_delivery', 'Recalculate at delivery', 'Re-computed from the making rate and the settlement gold value.'),
    ],
  },
  {
    key: 'gst_rate', group: 'pricing', type: 'number', default: 3, min: 0, max: 28, step: 0.1, suffix: '%',
    label: 'GST rate',
    description: 'Charged on the GST basis below (3% is the standard rate on gold jewellery).',
  },
  {
    key: 'gst_basis', group: 'pricing', type: 'select', default: 'gold_and_making',
    label: 'GST calculation basis',
    description: 'The amount GST is calculated on.',
    options: [
      opt('gold_only', 'Gold value only'),
      opt('gold_and_making', 'Gold value + making charge'),
      opt('gold_making_other', 'Gold + making + other charges'),
    ],
  },
  {
    key: 'default_other_charges', group: 'pricing', type: 'number', default: 0, min: 0, step: 1, prefix: '₹',
    label: 'Default other charges',
    description: 'Pre-filled on every new order (hallmarking, packaging…). Can be changed per order.',
  },
  {
    key: 'component_rounding', group: 'pricing', type: 'select', default: 'rupee',
    label: 'Rounding of each amount',
    description: 'Applied to gold value, making charge and GST individually.',
    options: [opt('rupee', 'Nearest rupee'), opt('paise', 'Keep paise (2 decimals)')],
  },
  {
    key: 'total_rounding', group: 'pricing', type: 'select', default: 'none',
    label: 'Round-off on the total',
    description: 'Optional round-off applied to the grand total (shown as a separate line).',
    options: [opt('none', 'No round-off'), opt('nearest_10', 'Nearest ₹10'), opt('nearest_100', 'Nearest ₹100')],
  },
  // ---- Business rules (read live, never frozen) ----
  {
    key: 'min_advance_percent', group: 'business', type: 'number', default: 10, min: 0, max: 100, step: 1, suffix: '%',
    label: 'Required advance',
    description: 'Below this share of the estimate an order shows "Advance Received"; at or above it, "Partially Paid".',
  },
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

/** Only the rules that decide how an amount is calculated (these get frozen onto delivered orders). */
function getRules() {
  const all = getAll();
  return Object.fromEntries(PRICING_KEYS.map((k) => [k, all[k]]));
}

/** Human-readable list of the rules, for the UI and the bill. */
function describe(rules) {
  return PRICING_KEYS.map((key) => {
    const def = BY_KEY[key];
    const value = rules[key];
    let text;
    if (def.type === 'select') text = def.options.find((o) => o.value === value)?.label ?? String(value);
    else text = `${def.prefix ?? ''}${value}${def.suffix ?? ''}`;
    return { key, label: def.label, value, text };
  });
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

module.exports = { DEFINITIONS, definitionsForUi, getAll, getRules, describe, update, seedDefaults, PRICING_KEYS };
