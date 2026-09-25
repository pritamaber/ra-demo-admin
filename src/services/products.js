'use strict';
/** Master catalogue + inventory (stock ledger). Order code moves stock only through reserve / release / sell. */
const { q, tx } = require('../db');
const { bad, notFound, conflict, clock, num, str, pad, ean13, round3 } = require('../util');
const { slugify } = require('../images');
const settings = require('./settings');
const { PURITIES } = require('./goldrates');
const supabase = require('./supabase');

const GENDERS = ['Men', 'Women', 'Kids', 'Unisex'];
const METALS = ['Gold']; // gold rates are the only rate master in the demo

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, sc.name AS subcategory_name,
    (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = p.id AND o.status = 'DELIVERED') AS sold_quantity
  FROM products p
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN categories sc ON sc.id = p.subcategory_id`;

const stockStatus = (available, threshold) => (available <= 0 ? 'OUT_OF_STOCK' : available <= threshold ? 'LOW_STOCK' : 'IN_STOCK');

function decorate(row, threshold) {
  return {
    ...row,
    display_id: 'P-' + pad(row.id, 4),
    image: row.image_url || `/img/category/${slugify(row.category_name)}.svg`,
    stock_status: stockStatus(row.available_quantity, threshold),
    // Total net gold for the pieces on hand is handy for the owner's stock valuation
    net_gold_in_stock: round3(row.net_gold_weight * row.stock_quantity),
  };
}

// ------------------------------------------------------------------- images
const imagesOf = (productId) => q.all('SELECT id, url, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order, id', productId);

/** Replaces a product's whole gallery (the admin UI always sends the full ordered list). First image
 *  also mirrors onto products.image_url so every existing single-image code path keeps working. */
function setProductImages(productId, urls) {
  const clean = (urls || []).map((u) => str(u)).filter(Boolean);
  q.run('DELETE FROM product_images WHERE product_id = ?', productId);
  clean.forEach((url, i) => q.run('INSERT INTO product_images (product_id, url, sort_order, created_at) VALUES (?, ?, ?, ?)', productId, url, i, clock.timestamp()));
  q.run('UPDATE products SET image_url = ?, updated_at = ? WHERE id = ?', clean[0] || null, clock.timestamp(), productId);
  return clean;
}

// ---------------------------------------------------------------- categories
function categoryTree() {
  const rows = q.all('SELECT * FROM categories ORDER BY sort_order, name');
  const counts = Object.fromEntries(q.all('SELECT category_id AS id, COUNT(*) AS n FROM products GROUP BY category_id').map((r) => [r.id, r.n]));
  const subCounts = Object.fromEntries(q.all('SELECT subcategory_id AS id, COUNT(*) AS n FROM products WHERE subcategory_id IS NOT NULL GROUP BY subcategory_id').map((r) => [r.id, r.n]));
  return rows.filter((r) => !r.parent_category_id).map((c) => ({
    ...c,
    slug: slugify(c.name),
    product_count: counts[c.id] || 0,
    subcategories: rows.filter((s) => s.parent_category_id === c.id).map((s) => ({ ...s, product_count: subCounts[s.id] || 0 })),
  }));
}

function saveCategory(input, id = null) {
  const name = str(input.name);
  if (!name) throw bad('Category name is required');
  const parent = input.parent_category_id ? Number(input.parent_category_id) : null;
  if (parent && !q.get('SELECT id FROM categories WHERE id = ? AND parent_category_id IS NULL', parent)) throw bad('Parent must be a top-level category');
  const gender = input.gender || null;
  if (gender && !GENDERS.includes(gender)) throw bad('Invalid gender');
  const status = input.status === 'inactive' ? 'inactive' : 'active';
  const dup = q.get('SELECT id FROM categories WHERE COALESCE(parent_category_id, 0) = ? AND lower(name) = lower(?) AND id != ?', parent || 0, name, id || 0);
  if (dup) throw conflict(`"${name}" already exists at this level`);
  if (id) {
    if (!q.get('SELECT id FROM categories WHERE id = ?', id)) throw notFound('Category');
    q.run('UPDATE categories SET name = ?, parent_category_id = ?, gender = ?, status = ? WHERE id = ?', name, parent, gender, status, id);
    return id;
  }
  const order = q.get('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories').n;
  return q.run('INSERT INTO categories (name, parent_category_id, gender, status, sort_order) VALUES (?, ?, ?, ?, ?)', name, parent, gender, status, order).lastInsertRowid;
}

// ------------------------------------------------------------------ products
function listProducts(f = {}) {
  const threshold = settings.getAll().low_stock_threshold;
  const where = [];
  const params = [];
  if (f.q) {
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)');
    params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  if (f.gender) { where.push('p.gender = ?'); params.push(f.gender); }
  if (f.category_id) { where.push('p.category_id = ?'); params.push(Number(f.category_id)); }
  if (f.subcategory_id) { where.push('p.subcategory_id = ?'); params.push(Number(f.subcategory_id)); }
  if (f.status) { where.push('p.status = ?'); params.push(f.status); }
  if (f.purity) { where.push('p.purity = ?'); params.push(f.purity); }
  if (f.stock_status === 'OUT_OF_STOCK') where.push('p.available_quantity <= 0');
  else if (f.stock_status === 'LOW_STOCK') { where.push('p.available_quantity > 0 AND p.available_quantity <= ?'); params.push(threshold); }
  else if (f.stock_status === 'IN_STOCK') { where.push('p.available_quantity > ?'); params.push(threshold); }
  else if (f.stock_status === 'RESERVED') where.push('p.reserved_quantity > 0');

  const sorts = {
    name: 'p.name', sku: 'p.sku', weight: 'p.net_gold_weight DESC', updated: 'p.updated_at DESC',
    stock: 'p.available_quantity, p.name', category: 'c.sort_order, p.name',
  };
  const orderBy = sorts[f.sort] || sorts.category;
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = q.get(`SELECT COUNT(*) AS n FROM products p JOIN categories c ON c.id = p.category_id ${clause}`, ...params).n;
  const limit = Math.min(Number(f.limit) || 100, 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const items = q.all(`${PRODUCT_SELECT} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, ...params, limit, offset)
    .map((r) => decorate(r, threshold));
  return { items, total, limit, offset };
}

/** Read-only, public-safe view of the catalogue: active products only, no cost/stock-count internals.
 *  Used by the /api/public route so the separate storefront can query this server directly if it's
 *  reachable, as an alternative/fallback to the Supabase mirror. */
function publicCatalog(f = {}) {
  const where = ["p.status = 'active'"];
  const params = [];
  if (f.gender) { where.push('p.gender = ?'); params.push(f.gender); }
  if (f.category_id) { where.push('p.category_id = ?'); params.push(Number(f.category_id)); }
  const clause = 'WHERE ' + where.join(' AND ');
  const rows = q.all(`${PRODUCT_SELECT} ${clause} ORDER BY c.sort_order, p.name LIMIT 500`, ...params);
  return rows.map((r) => {
    const gallery = imagesOf(r.id).map((i) => i.url);
    return {
      id: r.id, name: r.name, slug: slugify(r.name), sku: r.sku, gender: r.gender,
      category: r.category_name, subcategory: r.subcategory_name || null,
      metal_type: r.metal_type, purity: r.purity, net_gold_weight: r.net_gold_weight, making_charge: r.making_charge,
      description: r.description || null,
      images: gallery.length ? gallery : [r.image_url || `/img/category/${slugify(r.category_name)}.svg`],
      in_stock: r.available_quantity > 0,
    };
  });
}

function getProduct(id) {
  const row = q.get(`${PRODUCT_SELECT} WHERE p.id = ?`, id);
  if (!row) throw notFound('Product');
  return { ...decorate(row, settings.getAll().low_stock_threshold), images: imagesOf(id).map((i) => i.url) };
}

function validateProduct(input, existing = null) {
  const v = { ...(existing || {}), ...input };
  const name = str(v.name);
  if (!name) throw bad('Product name is required');
  if (!GENDERS.includes(v.gender)) throw bad('Gender must be Men, Women, Kids or Unisex');
  const category = q.get('SELECT * FROM categories WHERE id = ? AND parent_category_id IS NULL', Number(v.category_id));
  if (!category) throw bad('Choose a valid category');
  let subcategoryId = null;
  if (v.subcategory_id) {
    const sub = q.get('SELECT * FROM categories WHERE id = ?', Number(v.subcategory_id));
    if (!sub || sub.parent_category_id !== category.id) throw bad('Subcategory does not belong to the chosen category');
    subcategoryId = sub.id;
  }
  if (!METALS.includes(v.metal_type || 'Gold')) throw bad(`Metal type must be ${METALS.join(' / ')}`);
  if (!PURITIES.includes(v.purity)) throw bad(`Purity must be one of ${PURITIES.join(', ')}`);
  const gross = round3(num(v.gross_weight, 'Gross weight', { min: 0.001 }));
  const stone = round3(num(v.stone_weight ?? 0, 'Stone weight', { min: 0 }));
  if (stone > gross) throw bad('Stone weight cannot exceed gross weight');
  const making = num(v.making_charge ?? 0, 'Making charge', { min: 0 });
  const sku = str(v.sku);
  const barcode = str(v.barcode);
  return {
    name, gender: v.gender, category, category_id: category.id, subcategory_id: subcategoryId,
    metal_type: v.metal_type || 'Gold', purity: v.purity, gross_weight: gross, stone_weight: stone,
    making_charge: making, sku, barcode, image_url: str(v.image_url), status: v.status === 'inactive' ? 'inactive' : 'active',
    description: str(v.description),
  };
}

function nextSku(categoryName) {
  const code = categoryName.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase();
  let n = q.get('SELECT COUNT(*) AS n FROM products WHERE sku LIKE ?', `RAJ-${code}-%`).n + 1;
  while (q.get('SELECT 1 FROM products WHERE sku = ?', `RAJ-${code}-${pad(n, 3)}`)) n++;
  return `RAJ-${code}-${pad(n, 3)}`;
}

function createProduct(input) {
  const created = tx(() => {
    const p = validateProduct(input);
    const opening = input.stock_quantity == null || input.stock_quantity === '' ? 0 : num(input.stock_quantity, 'Opening stock', { min: 0, integer: true });
    const sku = p.sku || nextSku(p.category.name);
    if (q.get('SELECT 1 FROM products WHERE sku = ?', sku)) throw conflict(`SKU ${sku} is already used`);
    if (p.barcode && q.get('SELECT 1 FROM products WHERE barcode = ?', p.barcode)) throw conflict(`Barcode ${p.barcode} is already used`);
    const now = clock.timestamp();
    const res = q.run(
      `INSERT INTO products (sku, barcode, name, gender, category_id, subcategory_id, image_url, description, metal_type, purity,
         gross_weight, stone_weight, making_charge, stock_quantity, reserved_quantity, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      sku, p.barcode, p.name, p.gender, p.category_id, p.subcategory_id, p.image_url, p.description, p.metal_type, p.purity,
      p.gross_weight, p.stone_weight, p.making_charge, p.status, now, now);
    const id = Number(res.lastInsertRowid);
    if (!p.barcode) q.run('UPDATE products SET barcode = ? WHERE id = ?', ean13('8904500' + pad(id, 5)), id);
    if (opening > 0) applyMovement(id, { type: 'OPENING', stockDelta: opening, reason: 'Opening stock' });
    setProductImages(id, input.images && input.images.length ? input.images : (p.image_url ? [p.image_url] : []));
    return getProduct(id);
  });
  supabase.syncProduct(created).catch((e) => console.error('Supabase sync failed:', e.message));
  return created;
}

function updateProduct(id, input) {
  const updated = tx(() => {
    const existing = q.get('SELECT * FROM products WHERE id = ?', id);
    if (!existing) throw notFound('Product');
    const p = validateProduct(input, existing);
    const sku = p.sku || existing.sku;
    if (q.get('SELECT 1 FROM products WHERE sku = ? AND id != ?', sku, id)) throw conflict(`SKU ${sku} is already used`);
    if (p.barcode && q.get('SELECT 1 FROM products WHERE barcode = ? AND id != ?', p.barcode, id)) throw conflict(`Barcode ${p.barcode} is already used`);
    q.run(
      `UPDATE products SET sku = ?, barcode = ?, name = ?, gender = ?, category_id = ?, subcategory_id = ?, image_url = ?, description = ?,
         metal_type = ?, purity = ?, gross_weight = ?, stone_weight = ?, making_charge = ?, status = ?, updated_at = ? WHERE id = ?`,
      sku, p.barcode || existing.barcode, p.name, p.gender, p.category_id, p.subcategory_id, p.image_url, p.description, p.metal_type, p.purity,
      p.gross_weight, p.stone_weight, p.making_charge, p.status, clock.timestamp(), id);
    if (input.images) setProductImages(id, input.images);
    return getProduct(id);
  });
  supabase.syncProduct(updated).catch((e) => console.error('Supabase sync failed:', e.message));
  return updated;
}

function deleteProduct(id) {
  const result = tx(() => {
    if (!q.get('SELECT id FROM products WHERE id = ?', id)) throw notFound('Product');
    if (q.get('SELECT 1 FROM order_items WHERE product_id = ?', id)) {
      throw conflict('This product appears on orders and cannot be deleted. Mark it inactive instead.');
    }
    q.run('DELETE FROM product_images WHERE product_id = ?', id);
    q.run('DELETE FROM stock_movements WHERE product_id = ?', id);
    q.run('DELETE FROM products WHERE id = ?', id);
    return { deleted: true };
  });
  supabase.removeProduct(id).catch((e) => console.error('Supabase sync failed:', e.message));
  return result;
}

// ----------------------------------------------------------------- inventory
/**
 * The single place stock changes. Logs one ledger row per event:
 *  - RESTOCK/OPENING/ADJUSTMENT/SALE log the on-hand ('stock') counter,
 *  - RESERVE/RELEASE log the 'reserved' counter.
 */
function applyMovement(productId, { type, stockDelta = 0, reservedDelta = 0, orderId = null, reason = null }) {
  const p = q.get('SELECT name, stock_quantity, reserved_quantity FROM products WHERE id = ?', productId);
  if (!p) throw notFound('Product');
  const stock = p.stock_quantity + stockDelta;
  const reserved = p.reserved_quantity + reservedDelta;
  if (stock < 0) throw conflict(`Cannot remove ${-stockDelta} from ${p.name}: only ${p.stock_quantity} on hand`);
  if (reserved < 0 || reserved > stock) {
    throw conflict(`${p.name}: ${p.reserved_quantity} piece(s) are reserved for open orders, so on-hand stock cannot drop below that`);
  }
  q.run('UPDATE products SET stock_quantity = ?, reserved_quantity = ?, updated_at = ? WHERE id = ?', stock, reserved, clock.timestamp(), productId);
  const counter = ['RESERVE', 'RELEASE'].includes(type) ? 'reserved' : 'stock';
  const prev = counter === 'stock' ? p.stock_quantity : p.reserved_quantity;
  const delta = counter === 'stock' ? stockDelta : reservedDelta;
  q.run(
    `INSERT INTO stock_movements (product_id, counter, movement_type, previous_quantity, quantity, new_quantity, reference_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    productId, counter, type, prev, delta, prev + delta, orderId, reason, clock.timestamp());
  supabase.syncProduct(getProduct(productId)).catch((e) => console.error('Supabase sync failed:', e.message));
}

const reserve = (productId, qty, orderId, reason) => applyMovement(productId, { type: 'RESERVE', reservedDelta: qty, orderId, reason });
const release = (productId, qty, orderId, reason) => applyMovement(productId, { type: 'RELEASE', reservedDelta: -qty, orderId, reason });
const sell = (productId, qty, orderId, reason) => applyMovement(productId, { type: 'SALE', stockDelta: -qty, reservedDelta: -qty, orderId, reason });

/** Owner-facing stock change: restock (+) or manual adjustment (+/-). */
function adjustStock(productId, input) {
  return tx(() => {
    const type = input.type === 'ADJUSTMENT' ? 'ADJUSTMENT' : 'RESTOCK';
    const quantity = num(input.quantity, 'Quantity', { integer: true });
    if (type === 'RESTOCK' && quantity <= 0) throw bad('Restock quantity must be at least 1');
    if (quantity === 0) throw bad('Quantity cannot be zero');
    const reason = str(input.reason) || (type === 'RESTOCK' ? 'Restocked' : 'Manual adjustment');
    const before = getProduct(productId);
    applyMovement(productId, { type, stockDelta: quantity, reason });
    return { before: { stock_quantity: before.stock_quantity, available_quantity: before.available_quantity }, product: getProduct(productId) };
  });
}

function movements(f = {}) {
  const where = [];
  const params = [];
  if (f.product_id) { where.push('m.product_id = ?'); params.push(Number(f.product_id)); }
  if (f.type) { where.push('m.movement_type = ?'); params.push(f.type); }
  if (f.order_id) { where.push('m.reference_id = ?'); params.push(Number(f.order_id)); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = q.get(`SELECT COUNT(*) AS n FROM stock_movements m ${clause}`, ...params).n;
  const limit = Math.min(Number(f.limit) || 100, 500);
  const items = q.all(
    `SELECT m.*, p.name AS product_name, p.sku, o.order_number
     FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN orders o ON o.id = m.reference_id
     ${clause} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...params, limit, Math.max(Number(f.offset) || 0, 0));
  return { items, total };
}

function summary() {
  const threshold = settings.getAll().low_stock_threshold;
  return q.get(
    `SELECT COUNT(*) AS products,
       COALESCE(SUM(stock_quantity), 0) AS units_on_hand,
       COALESCE(SUM(reserved_quantity), 0) AS units_reserved,
       COALESCE(SUM(available_quantity), 0) AS units_available,
       COALESCE(SUM(CASE WHEN available_quantity <= 0 THEN 1 ELSE 0 END), 0) AS out_of_stock,
       COALESCE(SUM(CASE WHEN available_quantity > 0 AND available_quantity <= ? THEN 1 ELSE 0 END), 0) AS low_stock,
       (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'DELIVERED') AS units_sold
     FROM products WHERE status = 'active'`, threshold);
}

module.exports = {
  GENDERS, categoryTree, saveCategory, listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  adjustStock, movements, summary, reserve, release, sell, applyMovement, publicCatalog,
};
