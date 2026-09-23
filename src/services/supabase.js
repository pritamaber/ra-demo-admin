'use strict';
/**
 * Optional one-way mirror of the public catalogue into Supabase, so the separate public website
 * (a different codebase/host — e.g. a Vercel + Next.js site) can read products directly from
 * Supabase's auto-generated REST API instead of needing this admin server to be publicly reachable.
 *
 * Fully optional: with no env vars set, every call here is a silent no-op and the admin app behaves
 * exactly as before. Set SUPABASE_URL + SUPABASE_SERVICE_KEY to turn it on.
 *
 * What it needs on the Supabase side (run once in the SQL editor — see README "Public website" section):
 *   - a `products_public` table matching PUBLIC_COLUMNS below
 *   - a public storage bucket named by SUPABASE_IMAGE_BUCKET (default "product-images")
 */
const fs = require('node:fs');
const path = require('node:path');
const { str } = require('../util');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_IMAGE_BUCKET || 'product-images';
const enabled = !!(URL && KEY);
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const EXT_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

if (!enabled) {
  console.log('Supabase sync is off (set SUPABASE_URL and SUPABASE_SERVICE_KEY to enable it — see README).');
}

async function request(path, opts = {}) {
  const res = await fetch(`${URL}${path}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...opts.headers },
  });
  if (!res.ok) throw new Error(`Supabase ${opts.method || 'GET'} ${path} failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res;
}

async function uploadToStorage(objectPath, mime, body) {
  await request(`/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { 'Content-Type': mime, 'x-upsert': 'true' },
    body,
  });
  return `${URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

/** Resolves one image to a URL Supabase's own readers (the public website) can actually load:
 *  - a data: URL (uploaded from the browser) is uploaded to Storage and swapped for its public URL.
 *  - a local path served by this admin app (e.g. /img/products/..., or a legacy /img/category/*.svg
 *    illustration) is meaningless off this server's own origin, so it's read from disk and uploaded too.
 *  - anything already an absolute http(s) URL (a previous Storage upload, or an external image) passes through. */
async function ensureHostedUrl(url, productId, index) {
  if (!enabled || !url || /^https?:\/\//.test(url)) return url;
  const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (dataMatch) {
    const [, mime, base64] = dataMatch;
    const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    return uploadToStorage(`products/${productId}/${index}-${Date.now()}.${ext}`, mime, Buffer.from(base64, 'base64'));
  }
  if (url.startsWith('/')) {
    const ext = path.extname(url).toLowerCase();
    const mime = EXT_MIME[ext];
    if (!mime) return url; // e.g. a category .svg illustration — not worth hosting
    const localFile = path.join(PUBLIC_DIR, url);
    if (!localFile.startsWith(PUBLIC_DIR) || !fs.existsSync(localFile)) return url;
    const body = fs.readFileSync(localFile);
    return uploadToStorage(`products/${productId}/${index}-${Date.now()}${ext}`, mime, body);
  }
  return url;
}

/** Upserts a row, dropping any column Postgres doesn't recognise yet and retrying — so a mirror table
 *  that predates a newer field (e.g. `description`, added after the one-time setup in the README) keeps
 *  working today and fills in automatically once its owner runs the matching `alter table`. */
async function upsertRow(path, row) {
  try {
    await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(row),
    });
  } catch (e) {
    const missingColumn = /Could not find the '(\w+)' column/.exec(e.message)?.[1];
    if (missingColumn && missingColumn in row) {
      const rest = { ...row };
      delete rest[missingColumn];
      return upsertRow(path, rest);
    }
    throw e;
  }
}

/** Upserts one product (and uploads any new base64 images) into the public mirror table. */
async function syncProduct(product) {
  if (!enabled) return;
  const images = await Promise.all((product.images && product.images.length ? product.images : [product.image]).map((u, i) => ensureHostedUrl(u, product.id, i)));
  const row = {
    id: product.id,
    name: product.name,
    slug: str(product.name)?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    sku: product.sku,
    gender: product.gender,
    category: product.category_name,
    subcategory: product.subcategory_name || null,
    metal_type: product.metal_type,
    purity: product.purity,
    net_gold_weight: product.net_gold_weight,
    making_charge: product.making_charge,
    description: product.description || null,
    images,
    in_stock: product.available_quantity > 0,
    is_active: product.status === 'active',
    updated_at: new Date().toISOString(),
  };
  await upsertRow('/rest/v1/products_public?on_conflict=id', row);
}

async function removeProduct(id) {
  if (!enabled) return;
  await request(`/rest/v1/products_public?id=eq.${id}`, { method: 'DELETE' });
}

/** Mirrors the current 24K/22K/18K rates (one row per purity, upserted) so the storefront always shows
 *  today's price without needing to talk to this admin server. */
async function syncGoldRates(rates) {
  if (!enabled) return;
  const rows = rates.filter((r) => r.rate_per_gram != null).map((r) => ({
    purity: r.purity, rate_per_gram: r.rate_per_gram, effective_date: r.effective_date, updated_at: new Date().toISOString(),
  }));
  if (!rows.length) return;
  await request('/rest/v1/gold_rates_public?on_conflict=purity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
}

module.exports = { enabled, syncProduct, removeProduct, syncGoldRates };
