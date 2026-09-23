import {
  $, $$, api, html, mount, grams, fmtDateTime, stockBadge, moveBadge, empty, openModal, onSubmit, toast, navigate, debounce,
} from '../lib.js';

// ------------------------------------------------------------ restock modal
export function openStockModal({ product: p, onDone }) {
  openModal({
    title: `Restock · ${p.name}`,
    content: html`<form>
      <div class="weights" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
        <div><div class="k">On hand</div><div class="v">${p.stock_quantity}</div></div>
        <div><div class="k">Reserved</div><div class="v">${p.reserved_quantity}</div></div>
        <div><div class="k">Available</div><div class="v">${p.available_quantity}</div></div>
      </div>
      <div class="form-grid">
        <div class="field full"><div class="lbl">What happened?</div>
          <div class="row">
            <label class="radio-card" style="flex:1"><input type="radio" name="type" value="RESTOCK" checked><div><div class="t">Restock</div><div class="h">New pieces received</div></div></label>
            <label class="radio-card" style="flex:1"><input type="radio" name="type" value="ADJUSTMENT"><div><div class="t">Adjustment</div><div class="h">Correct the count (+ or −)</div></div></label>
          </div></div>
        <div class="field"><label for="s-qty">Quantity</label><input id="s-qty" name="quantity" type="number" step="1" min="1" value="1" required></div>
        <div class="field"><label>New stock on hand</label><input id="s-new" readonly></div>
        <div class="field full"><label for="s-reason">Reason</label><input id="s-reason" name="reason" placeholder="e.g. Received from karigar, batch 15"></div>
      </div>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save stock change</button></div>
    </form>`,
    onOpen: (m, close) => {
      const qty = $('#s-qty', m);
      const sync = () => {
        const adjust = $('[name=type]:checked', m).value === 'ADJUSTMENT';
        qty.min = adjust ? '' : '1';
        const n = Number(qty.value) || 0;
        $('#s-new', m).value = `${p.stock_quantity + n}  (available ${p.available_quantity + n})`;
      };
      $$('[name=type]', m).forEach((r) => r.addEventListener('change', sync));
      qty.addEventListener('input', sync);
      sync();
      onSubmit($('form', m), async (v) => {
        const res = await api.post(`/api/products/${p.id}/stock`, { type: v.type, quantity: Number(v.quantity), reason: v.reason });
        close();
        toast(`${p.name}: stock ${res.before.stock_quantity} → ${res.product.stock_quantity}`);
        onDone?.(res.product);
      });
    },
  });
}

// ------------------------------------------------------------------- page
export async function inventoryPage({ el, params, isCurrent }) {
  const tab = ['low', 'out', 'moves'].includes(params[0]) ? params[0] : 'stock';
  const sum = await api.get('/api/inventory/summary');
  if (!isCurrent()) return;
  const tabs = [['stock', 'All stock'], ['low', 'Low stock', sum.low_stock], ['out', 'Out of stock', sum.out_of_stock], ['moves', 'Stock movements']];

  mount(el, html`
    <div class="page-head">
      <div><h1>Inventory</h1><div class="sub">What is in the shop, what is reserved for open orders, and what needs restocking.</div></div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Products</div><div class="kpi-value">${sum.products}</div><div class="kpi-note">active in catalogue</div></div>
      <div class="kpi"><div class="kpi-label">On hand</div><div class="kpi-value">${sum.units_on_hand}</div><div class="kpi-note">pieces in the shop</div></div>
      <div class="kpi"><div class="kpi-label">Reserved</div><div class="kpi-value">${sum.units_reserved}</div><div class="kpi-note">held for open orders</div></div>
      <div class="kpi"><div class="kpi-label">Available</div><div class="kpi-value">${sum.units_available}</div><div class="kpi-note">free to sell</div></div>
      <div class="kpi"><div class="kpi-label">Sold</div><div class="kpi-value">${sum.units_sold}</div><div class="kpi-note">delivered to customers</div></div>
      <a class="kpi ${sum.low_stock ? 'warn' : ''}" href="#/inventory/low"><div class="kpi-label">Low stock</div><div class="kpi-value">${sum.low_stock}</div><div class="kpi-note">products</div></a>
      <a class="kpi ${sum.out_of_stock ? 'danger' : ''}" href="#/inventory/out"><div class="kpi-label">Out of stock</div><div class="kpi-value">${sum.out_of_stock}</div><div class="kpi-note">products</div></a>
    </div>
    <div class="tabs">${tabs.map(([k, label, n]) => html`<button class="tab ${k === tab ? 'on' : ''}" data-tab="${k}">${label}${n != null ? html`<span class="n ${n ? 'alert' : ''}">${n}</span>` : ''}</button>`)}</div>
    <div id="inv-body"></div>`);
  $$('.tabs .tab', el).forEach((b) => b.addEventListener('click', () => navigate(`/inventory${b.dataset.tab === 'stock' ? '' : '/' + b.dataset.tab}`)));

  const body = $('#inv-body', el);
  if (tab === 'moves') return movementsTab(body, isCurrent);
  return stockTab(body, tab, isCurrent);
}

async function stockTab(body, tab, isCurrent) {
  const status = { low: 'LOW_STOCK', out: 'OUT_OF_STOCK' }[tab] || '';
  let text = '';
  let categoryId = '';
  const { items: categories } = await api.get('/api/categories');
  if (!isCurrent()) return;
  mount(body, html`
    ${tab === 'out' ? html`<div class="notice info" style="margin-bottom:14px">Out of stock means nothing is available to sell — either none on hand, or every piece is reserved for an open order. Restocking updates availability immediately.</div>` : ''}
    <div class="chips" id="inv-cat-chips" style="margin-bottom:12px">
      <button class="chip on" data-cat="">All categories</button>
      ${categories.map((c) => html`<button class="chip" data-cat="${c.id}">${c.name} <span class="muted">(${c.product_count})</span></button>`)}
    </div>
    <div class="card"><div class="card-head"><input id="inv-search" placeholder="Search name, SKU or barcode…" style="max-width:340px"><span class="muted small" id="inv-count"></span></div><div id="inv-table"></div></div>`);
  let list = [];
  async function load() {
    const res = await api.get('/api/products', { stock_status: status, status: 'active', q: text, category_id: categoryId, sort: status ? 'stock' : 'category', limit: 500 });
    if (!isCurrent()) return;
    list = res.items;
    $('#inv-count', body).textContent = `${res.total} product${res.total === 1 ? '' : 's'}`;
    mount($('#inv-table', body), list.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Product</th><th>Category</th><th class="num">Net gold</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th><th class="num">Sold</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map((p) => html`<tr>
        <td><div class="prod-cell"><img class="thumb" src="${p.image}" alt=""><div><div class="cell-main">${p.name}</div><div class="cell-sub mono">${p.sku}</div></div></div></td>
        <td>${p.category_name}<div class="cell-sub">${p.gender}</div></td><td class="num nowrap">${grams(p.net_gold_weight)}</td>
        <td class="num">${p.stock_quantity}</td><td class="num">${p.reserved_quantity}</td><td class="num bold">${p.available_quantity}</td><td class="num">${p.sold_quantity}</td>
        <td>${stockBadge(p.stock_status)}</td>
        <td class="right"><button class="btn ${p.stock_status === 'OUT_OF_STOCK' ? 'btn-primary' : ''} btn-sm" data-restock="${p.id}">Restock</button></td></tr>`)}</tbody></table></div>`
      : empty(tab === 'stock' ? 'No products found' : 'Nothing here — all good', tab === 'stock' ? '' : 'No product is in this state right now.'));
    $$('[data-restock]', body).forEach((b) => b.addEventListener('click', () => openStockModal({ product: list.find((p) => p.id === Number(b.dataset.restock)), onDone: () => window.dispatchEvent(new Event('app:refresh')) })));
  }
  $('#inv-search', body).addEventListener('input', debounce((e) => { text = e.target.value.trim(); load(); }, 250));
  $$('#inv-cat-chips .chip', body).forEach((chip) => chip.addEventListener('click', () => {
    categoryId = chip.dataset.cat;
    $$('#inv-cat-chips .chip', body).forEach((c) => c.classList.toggle('on', c === chip));
    load();
  }));
  await load();
}

async function movementsTab(body, isCurrent) {
  const { items: products } = await api.get('/api/products', { limit: 500, sort: 'name' });
  const f = { product_id: '', type: '' };
  mount(body, html`
    <div class="card"><div class="card-head"><div class="row">
      <select id="mv-product" style="width:260px" aria-label="Product"><option value="">All products</option>${products.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select>
      <select id="mv-type" style="width:180px" aria-label="Movement type"><option value="">All movement types</option>${['OPENING', 'RESTOCK', 'ADJUSTMENT', 'RESERVE', 'RELEASE', 'SALE'].map((t) => html`<option value="${t}">${t.charAt(0) + t.slice(1).toLowerCase()}</option>`)}</select></div>
      <span class="muted small" id="mv-count"></span></div><div id="mv-table"></div></div>`);
  async function load() {
    const { items, total } = await api.get('/api/inventory/movements', { ...f, limit: 200 });
    if (!isCurrent()) return;
    $('#mv-count', body).textContent = `${total} movement${total === 1 ? '' : 's'}${total > items.length ? ` (latest ${items.length})` : ''}`;
    mount($('#mv-table', body), items.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Date</th><th>Product</th><th>Movement</th><th class="num">Previous</th><th class="num">Change</th><th class="num">New</th><th>Counter</th><th>Reason</th><th>Related order</th></tr></thead>
      <tbody>${items.map((m) => html`<tr>
        <td class="nowrap">${fmtDateTime(m.created_at)}</td>
        <td><span class="cell-main">${m.product_name}</span><div class="cell-sub mono">${m.sku}</div></td>
        <td>${moveBadge(m.movement_type)}</td><td class="num">${m.previous_quantity}</td>
        <td class="num bold ${m.quantity > 0 ? 'up' : 'down'}">${m.quantity > 0 ? '+' : ''}${m.quantity}</td><td class="num">${m.new_quantity}</td>
        <td class="muted">${m.counter === 'stock' ? 'On hand' : 'Reserved'}</td><td>${m.reason || ''}</td>
        <td>${m.order_number ? html`<a href="#/orders/${m.reference_id}">${m.order_number}</a>` : '—'}</td></tr>`)}</tbody></table></div>` : empty('No stock movements match'));
  }
  $('#mv-product', body).addEventListener('change', (e) => { f.product_id = e.target.value; load(); });
  $('#mv-type', body).addEventListener('change', (e) => { f.type = e.target.value; load(); });
  await load();
}
