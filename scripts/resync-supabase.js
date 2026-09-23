'use strict';
// One-off backfill: pushes every product currently in the catalogue to Supabase. Needed after any bulk
// reseed (npm run reset / scripts/reset.js), since bulk reseeding bypasses the normal create/update sync
// hook. Run with:  npm run resync-supabase
const path = require('node:path');
const fs = require('node:fs');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = (m[2] || '').trim().replace(/^["']|["']$/g, '');
  }
}

const products = require('../src/services/products');
const supabase = require('../src/services/supabase');
const goldRates = require('../src/services/goldrates');

async function main() {
  if (!supabase.enabled) {
    console.log('Supabase sync is off (SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env) — nothing to do.');
    return;
  }
  const { items } = products.listProducts({ limit: 500 });
  console.log(`Syncing ${items.length} products...`);
  for (const p of items) {
    const full = products.getProduct(p.id);
    await supabase.syncProduct(full);
    process.stdout.write('.');
  }
  console.log('\nSyncing gold rates...');
  try {
    await supabase.syncGoldRates(goldRates.current());
  } catch (e) {
    console.log(`Skipped (${e.message}) — run the gold_rates_public SQL from README.md, then re-run this script.`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
