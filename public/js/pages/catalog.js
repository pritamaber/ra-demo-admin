import {
  $, $$, api, html, mount, grams, fmtDate, stockBadge, moveBadge, empty, openModal, openLightbox, confirmDialog, onSubmit, toast, debounce, makingText, makingUnit,
  slugify, readImageAsDataUrl,
} from '../lib.js';
import { openStockModal } from './inventory.js';

const GENDERS = ['Men', 'Women', 'Kids', 'Unisex'];

// ------------------------------------------------------------- add / edit form
export function openProductForm({ product = null, categories, purities, makingMethod, onSaved }) {
  const p = product || { gender: 'Women', purity: '22K', metal_type: 'Gold', gross_weight: '', stone_weight: 0, making_charge: '', status: 'active' };
  const catOptions = (sel) => html`${categories.map((c) => html`<option value="${c.id}" ${Number(sel) === c.id ? 'selected' : ''}>${c.name}</option>`)}`;
  const categoryIllustration = (catId) => `/img/category/${slugify(categories.find((c) => c.id === Number(catId))?.name || 'ring')}.svg`;
  openModal({
    title: product ? `Edit ${product.name}` : 'Add product',
    size: 'wide',
    content: html`<form class="form-grid">
      <div class="field full"><label for="p-name">Product name *</label><input id="p-name" name="name" value="${p.name || ''}" required placeholder="e.g. 22K Classic Gold Chain"></div>
      <div class="field"><label for="p-gender">Gender *</label><select id="p-gender" name="gender">${GENDERS.map((g) => html`<option ${g === p.gender ? 'selected' : ''}>${g}</option>`)}</select></div>
      <div class="field"><label for="p-cat">Category *</label><select id="p-cat" name="category_id">${catOptions(p.category_id || categories[0].id)}</select></div>
      <div class="field"><label for="p-sub">Subcategory</label><select id="p-sub" name="subcategory_id"></select></div>
      <div class="field"><label for="p-purity">Purity *</label><select id="p-purity" name="purity">${purities.map((x) => html`<option ${x === p.purity ? 'selected' : ''}>${x}</option>`)}</select></div>
      <div class="field"><label for="p-gross">Gross weight (g) *</label><input id="p-gross" name="gross_weight" type="number" step="0.001" min="0.001" value="${p.gross_weight}" required></div>
      <div class="field"><label for="p-stone">Stone weight (g)</label><input id="p-stone" name="stone_weight" type="number" step="0.001" min="0" value="${p.stone_weight}"></div>
      <div class="field"><label for="p-net">Net gold weight (g)</label><input id="p-net" readonly><div class="hint">Calculated: gross − stone</div></div>
      <div class="field"><label for="p-making">Making charge (${makingUnit(makingMethod)}) *</label><input id="p-making" name="making_charge" type="number" step="0.01" min="0" value="${p.making_charge}" required></div>
      ${product ? '' : html`<div class="field"><label for="p-stock">Opening stock (pieces)</label><input id="p-stock" name="stock_quantity" type="number" min="0" step="1" value="0"></div>`}
      <div class="field"><label for="p-sku">SKU</label><input id="p-sku" name="sku" value="${p.sku || ''}" placeholder="Auto-generated if blank"></div>
      <div class="field"><label for="p-barcode">Barcode</label><input id="p-barcode" name="barcode" value="${p.barcode || ''}" placeholder="Auto-generated if blank"></div>
      <div class="field"><label for="p-status">Status</label><select id="p-status" name="status"><option value="active" ${p.status === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${p.status === 'inactive' ? 'selected' : ''}>Inactive</option></select></div>
      <div class="field full"><label for="p-desc">Description</label><textarea id="p-desc" name="description" rows="3" placeholder="Shown on the public website's product page — e.g. &quot;This gold necklace with filigree cutwork and leaf patterns...&quot;">${p.description || ''}</textarea></div>
      <div class="field full">
        <label>Product photos</label>
        <div class="img-gallery" id="p-gallery"></div>
        <div class="row" style="margin-top:8px">
          <button type="button" class="btn btn-sm" id="p-image-pick">+ Add photos</button>
          <input type="file" id="p-image-file" accept="image/*" multiple style="display:none">
          <div class="hint">JPG or PNG, any number of photos. The first one is used as the thumbnail everywhere. Drag with the arrows to reorder; the site shows the same order.</div>
        </div>
      </div>
      <div class="form-error full"></div>
      <div class="modal-actions full"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">${product ? 'Save changes' : 'Add product'}</button></div>
    </form>`,
    onOpen: (m, close) => {
      const form = $('form', m);
      const fileInput = $('#p-image-file', m);
      const gallery = $('#p-gallery', m);
      const images = [...(product?.images?.length ? product.images : p.image_url ? [p.image_url] : [])];
      const renderGallery = () => {
        mount(gallery, images.length ? images.map((src, i) => html`
          <div class="img-thumb" data-i="${i}">
            <img src="${src}" alt="">
            ${i === 0 ? html`<span class="badge yellow img-thumb-primary">Primary</span>` : ''}
            <div class="img-thumb-actions">
              ${i > 0 ? html`<button type="button" class="icon-btn" data-move="-1" title="Move earlier">←</button>` : ''}
              <button type="button" class="icon-btn" data-remove title="Remove">×</button>
              ${i < images.length - 1 ? html`<button type="button" class="icon-btn" data-move="1" title="Move later">→</button>` : ''}
            </div>
          </div>`) : html`<div class="img-thumb empty"><img src="${categoryIllustration($('#p-cat', m).value)}" alt=""><div class="muted small" style="padding:6px">No photos yet — the category illustration is shown until you add one</div></div>`);
        $$('[data-remove]', gallery).forEach((b) => b.addEventListener('click', () => { images.splice(Number(b.closest('[data-i]').dataset.i), 1); renderGallery(); }));
        $$('[data-move]', gallery).forEach((b) => b.addEventListener('click', () => {
          const i = Number(b.closest('[data-i]').dataset.i);
          const j = i + Number(b.dataset.move);
          [images[i], images[j]] = [images[j], images[i]];
          renderGallery();
        }));
      };
      const syncSubs = () => {
        const cat = categories.find((c) => c.id === Number($('#p-cat', m).value));
        const gender = $('#p-gender', m).value;
        const subs = (cat?.subcategories || []).filter((s) => !s.gender || s.gender === gender || gender === 'Unisex');
        mount($('#p-sub', m), html`<option value="">— none —</option>${subs.map((s) => html`<option value="${s.id}" ${Number(p.subcategory_id) === s.id ? 'selected' : ''}>${s.name}</option>`)}`);
      };
      const syncNet = () => {
        const net = (Number($('#p-gross', m).value) || 0) - (Number($('#p-stone', m).value) || 0);
        $('#p-net', m).value = net > 0 ? net.toFixed(3) : '';
      };
      $('#p-cat', m).addEventListener('change', () => { p.subcategory_id = null; syncSubs(); if (!images.length) renderGallery(); });
      $('#p-gender', m).addEventListener('change', syncSubs);
      $('#p-gross', m).addEventListener('input', syncNet);
      $('#p-stone', m).addEventListener('input', syncNet);
      syncSubs(); syncNet(); renderGallery();
      $('#p-image-pick', m).addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const files = [...fileInput.files].filter((f) => {
          if (!f.type.startsWith('image/')) { toast(`${f.name} is not an image — skipped`, 'error'); return false; }
          return true;
        });
        try {
          const dataUrls = await Promise.all(files.map(readImageAsDataUrl));
          images.push(...dataUrls);
          renderGallery();
        } catch (err) { toast(err.message, 'error'); }
        fileInput.value = '';
      });
      onSubmit(form, async (v) => {
        v.images = images;
        const saved = product ? await api.put(`/api/products/${product.id}`, v) : await api.post('/api/products', v);
        close();
        toast(product ? 'Product updated' : `${saved.name} added to the catalogue`);
        onSaved?.(saved);
      });
    },
  });
}

// --------------------------------------------------------- product detail view
export async function openProductDetail(productId, opts = {}) {
  let { categories, purities, makingMethod, onSaved } = opts;
  const needMeta = !categories || !purities || !makingMethod;
  const [p, mv, meta] = await Promise.all([
    api.get(`/api/products/${productId}`),
    api.get('/api/inventory/movements', { product_id: productId, limit: 6 }),
    needMeta ? Promise.all([api.get('/api/categories'), api.get('/api/settings')]) : null,
  ]);
  if (needMeta) {
    categories = categories || meta[0].items;
    purities = purities || meta[0].purities;
    makingMethod = makingMethod || meta[1].values.making_charge_method;
  }
  const { close } = openModal({
    title: p.name,
    size: 'xl',
    content: html`<div class="pdetail">
      <div><div class="pd-image-wrap">
          <img src="${p.image}" alt="" id="pd-main-image">
          <button type="button" class="pd-zoom-btn" data-zoom aria-label="View full screen"><svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg></button>
        </div>
        ${p.images?.length > 1 ? html`<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px">${p.images.map((src, i) => html`<img src="${src}" class="pd-thumb ${i === 0 ? 'on' : ''}" alt="" data-full="${src}">`)}</div>` : ''}
        <div style="margin-top:12px" class="stack">
        <a class="btn btn-primary" style="justify-content:center;width:100%" href="#/orders/new?product=${p.id}" data-close>Create order</a>
        <button class="btn" style="justify-content:center;width:100%" data-restock>Restock / adjust</button>
        <button class="btn" style="justify-content:center;width:100%" data-edit>Edit product</button>
        <button class="btn" style="justify-content:center;width:100%" data-toggle>${p.status === 'active' ? 'Mark inactive' : 'Mark active'}</button>
      </div></div>
      <div class="stack">
        <div class="row">${stockBadge(p.stock_status)}<span class="badge ${p.status === 'active' ? 'green' : 'gray'}">${p.status === 'active' ? 'Active' : 'Inactive'}</span><span class="badge gray">${p.gender}</span></div>
        <div class="weights">
          <div><div class="k">Gross weight</div><div class="v">${grams(p.gross_weight)}</div></div>
          <div><div class="k">− Stone weight</div><div class="v">${grams(p.stone_weight)}</div></div>
          <div><div class="k">= Net gold weight</div><div class="v">${grams(p.net_gold_weight)}</div></div>
        </div>
        <div class="meta-grid">
          ${[['Product ID', p.display_id], ['SKU', p.sku], ['Barcode', p.barcode], ['Category', p.category_name], ['Subcategory', p.subcategory_name || '—'], ['Metal · purity', `${p.metal_type} · ${p.purity}`],
            ['Making charge', makingText(makingMethod, p.making_charge)], ['Created', fmtDate(p.created_at)], ['Updated', fmtDate(p.updated_at)]]
            .map(([k, v]) => html`<div class="meta"><div class="k">${k}</div><div class="v ${k === 'SKU' || k === 'Barcode' ? 'mono' : ''}">${v}</div></div>`)}
        </div>
        ${p.description ? html`<div><div class="muted small">Description (shown on the website)</div><div>${p.description}</div></div>` : ''}
        <div class="weights" style="grid-template-columns:repeat(4,1fr)">
          <div><div class="k">On hand</div><div class="v">${p.stock_quantity}</div></div>
          <div><div class="k">Reserved</div><div class="v">${p.reserved_quantity}</div></div>
          <div><div class="k">Available</div><div class="v">${p.available_quantity}</div></div>
          <div><div class="k">Sold</div><div class="v">${p.sold_quantity}</div></div>
        </div>
        <div><h3 style="margin-bottom:8px">Recent stock movements</h3>${mv.items.length ? html`<table class="tbl"><tbody>${mv.items.map((m) => html`<tr>
          <td class="nowrap">${fmtDate(m.created_at, false)}</td><td>${moveBadge(m.movement_type)}</td>
          <td>${m.counter === 'reserved' ? 'Reserved' : 'On hand'} ${m.previous_quantity} → ${m.new_quantity}</td><td class="muted">${m.reason || ''}</td></tr>`)}</tbody></table>` : html`<div class="muted">No movements yet.</div>`}</div>
        <div><button class="btn btn-danger btn-sm" data-delete>Delete product</button></div>
      </div></div>`,
    onOpen: (m) => {
      const gallery = p.images?.length ? p.images : [p.image];
      let activeIndex = 0;
      const openZoom = () => openLightbox(gallery, activeIndex, p.name);
      $('#pd-main-image', m).addEventListener('click', openZoom);
      $('[data-zoom]', m).addEventListener('click', openZoom);
      $$('.pd-thumb', m).forEach((t, i) => t.addEventListener('click', () => {
        activeIndex = i;
        $('#pd-main-image', m).src = t.dataset.full;
        $$('.pd-thumb', m).forEach((x) => x.classList.toggle('on', x === t));
      }));
      $('[data-restock]', m).onclick = () => { close(); openStockModal({ product: p, onDone: onSaved }); };
      $('[data-edit]', m).onclick = () => { close(); openProductForm({ product: p, categories, purities, makingMethod, onSaved }); };
      $('[data-toggle]', m).onclick = async () => {
        try { await api.put(`/api/products/${p.id}`, { status: p.status === 'active' ? 'inactive' : 'active' }); close(); toast(`${p.name} is now ${p.status === 'active' ? 'inactive' : 'active'}`); onSaved?.(); } catch (e) { toast(e.message, 'error'); }
      };
      $('[data-delete]', m).onclick = async () => {
        if (!(await confirmDialog({ title: 'Delete product', message: `Delete ${p.name}? Products that appear on orders cannot be deleted — mark them inactive instead.`, confirmLabel: 'Delete', danger: true }))) return;
        try { await api.del(`/api/products/${p.id}`); close(); toast('Product deleted'); onSaved?.(); } catch (e) { toast(e.message, 'error'); }
      };
    },
  });
}

// ------------------------------------------------------------------- catalogue
export async function catalogPage({ el, isCurrent }) {
  const [{ items: categories, purities }, settings] = await Promise.all([api.get('/api/categories'), api.get('/api/settings')]);
  if (!isCurrent()) return;
  const makingMethod = settings.values.making_charge_method;
  const f = { gender: '', category_id: '', subcategory_id: '', purity: '', stock_status: '', q: '' };

  mount(el, html`
    <div class="page-head">
      <div><h1>Master Catalog</h1><div class="sub">Every piece the shop sells — by customer, category and subcategory.</div></div>
      <div class="page-actions"><button class="btn btn-primary" id="add-product">+ Add product</button></div>
    </div>
    <div class="filters card">
      <div class="chips" id="gender-chips">
        ${['', ...GENDERS].map((g) => html`<button class="chip ${g === '' ? 'on' : ''}" data-gender="${g}">${g || 'All'}</button>`)}</div>
      <span class="filters-sep"></span>
      <select id="f-sub" aria-label="Subcategory" disabled><option value="">All subcategories</option></select>
      <select id="f-purity" aria-label="Purity"><option value="">Any purity</option>${purities.map((x) => html`<option>${x}</option>`)}</select>
      <select id="f-stock" aria-label="Stock"><option value="">Any stock</option><option value="IN_STOCK">In stock</option><option value="LOW_STOCK">Low stock</option><option value="OUT_OF_STOCK">Out of stock</option></select>
      <input id="f-q" aria-label="Search" placeholder="Search name, SKU or barcode" style="flex:1;min-width:180px">
    </div>
    <div class="chips" id="cat-chips" style="margin:-4px 0 14px">
      <button class="chip on" data-cat="">All categories</button>
      ${categories.map((c) => html`<button class="chip" data-cat="${c.id}">${c.name} <span class="muted">(${c.product_count})</span></button>`)}
    </div>
    <div class="muted small" id="prod-count" style="margin-bottom:10px"></div>
    <div id="prod-grid"></div>`);

  let products = [];
  async function load() {
    const res = await api.get('/api/products', { ...f, limit: 200, sort: 'category' });
    if (!isCurrent()) return;
    products = res.items;
    $('#prod-count', el).textContent = `${res.total} product${res.total === 1 ? '' : 's'}`;
    // Group into consecutive runs by category (the list is already sorted that way) so each category gets its own heading.
    const groups = [];
    for (const p of products) {
      const last = groups[groups.length - 1];
      if (last && last.category === p.category_name) last.items.push(p);
      else groups.push({ category: p.category_name, items: [p] });
    }
    mount($('#prod-grid', el), groups.length ? groups.map((g) => html`
      <div class="cat-group">
        <h2 class="cat-heading">${g.category}<span class="muted small">${g.items.length} product${g.items.length === 1 ? '' : 's'}</span></h2>
        <div class="products">${g.items.map((p) => html`
          <div class="product" data-id="${p.id}" tabindex="0" role="button" aria-label="Open ${p.name}">
            <img src="${p.image}" alt="" loading="lazy">
            <div class="body">
              <div class="name">${p.name}</div>
              <div class="specs"><span class="spec">${p.gender}</span><span class="spec">${p.category_name}${p.subcategory_name ? ' · ' + p.subcategory_name : ''}</span></div>
              <div class="specs"><span class="spec">${p.purity}</span><span class="spec">Net ${grams(p.net_gold_weight)}</span><span class="spec">Making ${makingText(makingMethod, p.making_charge)}</span></div>
              <div class="foot"><span class="cell-sub mono">${p.sku}</span><span>${stockBadge(p.stock_status)} <b>${p.available_quantity}</b></span></div>
            </div></div>`)}</div>
      </div>`) : empty('No products match these filters'));
    $$('.product', el).forEach((card) => {
      const open = () => openProductDetail(Number(card.dataset.id), { categories, purities, makingMethod, onSaved: load });
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }

  // ---- filters
  $$('#gender-chips .chip', el).forEach((chip) => chip.addEventListener('click', () => {
    f.gender = chip.dataset.gender;
    $$('#gender-chips .chip', el).forEach((c) => c.classList.toggle('on', c === chip));
    load();
  }));
  $$('#cat-chips .chip', el).forEach((chip) => chip.addEventListener('click', () => {
    f.category_id = chip.dataset.cat; f.subcategory_id = '';
    $$('#cat-chips .chip', el).forEach((c) => c.classList.toggle('on', c === chip));
    const cat = categories.find((c) => String(c.id) === chip.dataset.cat);
    const sub = $('#f-sub', el);
    sub.disabled = !cat;
    mount(sub, html`<option value="">All subcategories</option>${(cat?.subcategories || []).map((s) => html`<option value="${s.id}">${s.name} (${s.product_count})</option>`)}`);
    load();
  }));
  $('#f-sub', el).addEventListener('change', (e) => { f.subcategory_id = e.target.value; load(); });
  $('#f-purity', el).addEventListener('change', (e) => { f.purity = e.target.value; load(); });
  $('#f-stock', el).addEventListener('change', (e) => { f.stock_status = e.target.value; load(); });
  $('#f-q', el).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); load(); }, 250));
  $('#add-product', el).addEventListener('click', () => openProductForm({ categories, purities, makingMethod, onSaved: load }));
  await load();
}
