import {
  $, $$, api, html, mount, inr, inr2, grams, perGram, fmtDate, fmtDateTime, relDays, addDaysIso, todayIso, statusBadge, dueBadge, paymentBadge,
  moveBadge, empty, openModal, confirmDialog, onSubmit, toast, navigate, refresh, debounce, initials, slugify, icon, STATUS_FLOW, statusLabel,
} from '../lib.js';
import { openProductDetail } from './catalog.js';
const METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
const methodOptions = (selected = 'UPI') => html`${METHODS.map((m) => html`<option ${m === selected ? 'selected' : ''}>${m}</option>`)}`;

// ======================================================================= list
const TABS = [
  ['all', 'All', {}], ['open', 'Open', { view: 'open' }], ['outstanding', 'Outstanding', { view: 'outstanding' }],
  ['overdue', 'Overdue', { view: 'overdue' }], ['ready', 'Ready for delivery', { view: 'ready' }], ['paid', 'Fully paid', { status: 'FULLY_PAID' }],
  ['awaiting_bill', 'Awaiting bill', { view: 'awaiting_bill' }], ['credit', 'Delivered on credit', { view: 'credit' }],
  ['billed', 'Billed', { status: 'BILLED' }], ['cancelled', 'Cancelled', { status: 'CANCELLED' }], ['draft', 'Drafts', { status: 'DRAFT' }],
];
const tabKey = (q) => (TABS.find(([k, , f]) => (f.view && f.view === q.view) || (f.status && f.status === q.status)) || TABS[0])[0];

export async function ordersListPage({ el, query, isCurrent }) {
  let active = tabKey(query);
  let text = query.q || '';
  const counts = await Promise.all(TABS.filter(([k]) => ['open', 'overdue', 'ready', 'awaiting_bill', 'credit', 'draft'].includes(k))
    .map(async ([k, , f]) => [k, (await api.get('/api/orders', { ...f, limit: 1 })).total]));
  if (!isCurrent()) return;
  const countMap = Object.fromEntries(counts);

  mount(el, html`
    <div class="page-head dash-head">
      <div><h1>Orders</h1><div class="sub">Every sale starts here — from advance to delivery to final bill.</div></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/orders/new">+ New Order</a></div>
    </div>
    <div class="tabs" id="order-tabs">
      ${TABS.map(([k, label]) => html`<button class="tab ${k === active ? 'on' : ''}" data-tab="${k}">${label}${countMap[k] != null ? html`<span class="n ${k === 'overdue' && countMap[k] ? 'alert' : ''}">${countMap[k]}</span>` : ''}</button>`)}
    </div>
    <div class="card">
      <div class="card-head"><input id="order-search" placeholder="Search order number, customer, phone or product…" value="${text}" style="max-width:420px"><span class="muted small" id="order-count"></span></div>
      <div id="orders-table"></div>
    </div>`);

  async function load() {
    const filter = TABS.find(([k]) => k === active)[2];
    const sort = active === 'overdue' ? 'delivery' : active === 'outstanding' ? 'outstanding' : active === 'credit' ? 'credit_due' : 'order_date';
    const params = { ...filter, q: text, sort, limit: 200 };
    history.replaceState(null, '', '#/orders?' + new URLSearchParams(Object.entries({ ...filter, q: text }).filter(([, v]) => v)).toString());
    const { items, total } = await api.get('/api/orders', params);
    $('#order-count', el).textContent = `${total} order${total === 1 ? '' : 's'}`;
    mount($('#orders-table', el), items.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Product</th><th class="num">Gold</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Due</th><th>Delivery</th><th>Status</th></tr></thead>
      <tbody>${items.map((o) => html`<tr class="clickable" data-href="#/orders/${o.id}">
        <td><a class="cell-main" href="#/orders/${o.id}">${o.order_number}</a></td>
        <td class="nowrap">${fmtDate(o.order_date)}</td>
        <td><a href="#/customers/${o.customer_id}">${o.customer_name}</a><div class="cell-sub">${o.customer_phone}</div></td>
        <td>${o.products}</td>
        <td class="num nowrap">${grams(o.gold_weight)}</td>
        <td class="num">${inr(o.total_amount)}</td>
        <td class="num">${inr(o.paid_amount)}</td>
        <td class="num ${o.outstanding_amount > 0 ? 'bold' : 'muted'}">${inr(o.outstanding_amount)}</td>
        <td class="nowrap">${o.actual_delivery_date ? html`${fmtDate(o.actual_delivery_date)}<div class="cell-sub">delivered</div>` : html`${fmtDate(o.expected_delivery_date)}<div class="cell-sub">${relDays(o.days_to_delivery)}</div>`}</td>
        <td><div class="row" style="gap:4px">${dueBadge(o.due_flag)}${statusBadge(o.status)}</div></td>
      </tr>`)}</tbody></table></div>` : empty('No orders match', 'Try another tab or search term.'));
    $$('tr[data-href]', el).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; }));
  }
  $$('#order-tabs .tab', el).forEach((b) => b.addEventListener('click', () => {
    active = b.dataset.tab;
    $$('#order-tabs .tab', el).forEach((t) => t.classList.toggle('on', t === b));
    load();
  }));
  $('#order-search', el).addEventListener('input', debounce((e) => { text = e.target.value.trim(); load(); }, 250));
  await load();
}

// ================================================================= new order
export async function orderNewPage({ el, query, isCurrent }) {
  const [{ items: products }, { items: rates }, { values: shopSettings }] = await Promise.all([
    api.get('/api/products', { status: 'active', limit: 500, sort: 'category' }),
    api.get('/api/gold-rates/current'),
    api.get('/api/settings'),
  ]);
  if (!isCurrent()) return;

  const st = { customer: null, newCustomer: null, lines: [{ product_id: query.product || '', quantity: 1 }], preview: null };
  if (query.customer) st.customer = (await api.get(`/api/customers/${query.customer}`)).customer;
  else if (query.phone) st.customer = await api.get('/api/customers/lookup', { phone: query.phone }).catch(() => null);

  // Guided picker: category tiles first (so you're never scrolling hundreds of items), then a small
  // filtered image grid within that category. Typing a search jumps straight to matches across all categories.
  function openProductPicker({ selectedId, onPick }) {
    const byCategory = products.reduce((m, p) => ((m[p.category_name] ||= []).push(p), m), {});
    const categoryNames = Object.keys(byCategory).sort();
    const state = { category: null, text: '' };

    const productCard = (p) => html`
      <div class="product ${p.available_quantity <= 0 ? 'disabled' : ''} ${p.id === selectedId ? 'picked' : ''}" data-id="${p.id}" tabindex="0" role="button" aria-label="${p.name}">
        <img src="${p.image}" alt="" loading="lazy">
        <div class="body">
          <div class="name">${p.name}</div>
          <div class="specs"><span class="spec">${p.category_name}${p.subcategory_name ? ' · ' + p.subcategory_name : ''}</span></div>
          <div class="specs"><span class="spec">${p.purity}</span><span class="spec">Net ${p.net_gold_weight.toFixed(3)} g</span></div>
          <div class="foot"><span class="cell-sub mono">${p.sku}</span>${p.available_quantity > 0 ? html`<b>${p.available_quantity} available</b>` : html`<span class="badge red">Out of stock</span>`}</div>
        </div></div>`;

    const { close } = openModal({
      title: 'Select a product',
      size: 'xl',
      content: html`<input id="pp-search" placeholder="Or search by name, SKU or category…" style="margin-bottom:14px">
        <div id="pp-body"></div>`,
      onOpen: (m) => {
        const render = () => {
          const body = $('#pp-body', m);
          if (!state.text && !state.category) {
            mount(body, html`<div class="pp-cats">${categoryNames.map((cat) => {
              const list = byCategory[cat];
              const outOfStock = list.filter((p) => p.available_quantity <= 0).length;
              return html`<button type="button" class="pp-cat" data-cat="${cat}">
                <img src="/img/category/${slugify(cat)}.svg" alt="">
                <div class="name">${cat}</div>
                <div class="muted small">${list.length} product${list.length === 1 ? '' : 's'}${outOfStock ? ` · ${outOfStock} out of stock` : ''}</div>
              </button>`;
            })}</div>`);
            $$('[data-cat]', body).forEach((b) => b.addEventListener('click', () => { state.category = b.dataset.cat; render(); }));
            return;
          }
          const list = state.text
            ? products.filter((p) => `${p.name} ${p.sku} ${p.category_name} ${p.subcategory_name || ''}`.toLowerCase().includes(state.text.toLowerCase()))
            : byCategory[state.category] || [];
          mount(body, html`
            ${!state.text ? html`<button type="button" class="link-btn" id="pp-back" style="margin-bottom:12px">← All categories</button>` : ''}
            ${list.length ? html`<div class="products" style="max-height:50vh;overflow-y:auto;padding-right:4px">${list.map(productCard)}</div>` : empty('No products match')}`);
          $('#pp-back', body)?.addEventListener('click', () => { state.category = null; render(); });
          $$('.product:not(.disabled)', body).forEach((card) => {
            const pick = () => { onPick(Number(card.dataset.id)); close(); };
            card.addEventListener('click', pick);
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
          });
        };
        render();
        $('#pp-search', m).addEventListener('input', debounce((e) => { state.text = e.target.value; state.category = null; render(); }, 200));
      },
    });
  }

  // Preview: what the bill would look like right now, from the live estimate — nothing is saved by opening this.
  function openBillPreview() {
    if (!st.preview) { toast('Add at least one product to preview the bill', 'error'); return; }
    const p = st.preview;
    const t = p.totals;
    const customerName = st.customer?.name || st.newCustomer?.name || 'Walk-in customer';
    const customerPhone = st.customer?.phone || st.newCustomer?.phone || '';
    const advance = Number($('#f-adv', el).value) || 0;
    const method = $('#f-method', el).value;
    const deliveryDate = $('#f-delivery', el).value;
    const s = shopSettings;
    openModal({
      title: 'Bill preview',
      size: 'xl',
      content: html`
        <div class="notice warn" style="margin-bottom:14px">This is a live preview of the estimate only — nothing is saved yet. The real final bill is generated once the order is delivered and fully settled, using the gold rate applicable at delivery.</div>
        <div class="invoice-wrap"><article class="invoice">
          <header class="inv-head">
            <div><div class="inv-shop">${s.shop_name}</div><div class="inv-tag">${s.shop_tagline}</div>
              <div class="inv-small" style="margin-top:8px">${s.shop_address}<br>Phone: ${s.shop_phone} · GSTIN: ${s.shop_gstin}</div></div>
            <div class="inv-title"><h2>ESTIMATE</h2>
              <div style="margin-top:8px"><b>Preview — not yet saved</b></div>
              <div class="inv-small">Prepared ${fmtDate(todayIso())}</div></div>
          </header>

          <section class="inv-meta">
            <div><h5>Billed to</h5><div class="bold" style="font-size:15px">${customerName}</div>${customerPhone ? html`<div>Phone: ${customerPhone}</div>` : ''}</div>
            <div><h5>Order details</h5>
              <div>Order date: ${fmtDate(todayIso())}</div><div>Expected delivery: ${deliveryDate ? fmtDate(deliveryDate) : '—'}</div>
              <div>Gold rate today: ${[...new Set(p.lines.map((l) => `${l.purity} ${inr(l.gold_rate)}/g`))].join(' · ')}</div></div>
          </section>

          <table class="inv-table">
            <thead><tr><th>Item</th><th>Purity</th><th class="num">Gross wt</th><th class="num">Stone wt</th><th class="num">Net gold wt</th><th class="num">Gold rate</th><th class="num">Gold value</th><th class="num">Making charge</th></tr></thead>
            <tbody>${p.lines.map((l) => html`<tr>
              <td><b>${l.name}</b>${l.quantity > 1 ? ` × ${l.quantity}` : ''}<div class="inv-small" style="margin:2px 0 0">SKU ${l.sku}</div></td>
              <td>${l.purity}</td><td class="num">${grams(l.gross_weight * l.quantity)}</td><td class="num">${grams(l.stone_weight * l.quantity)}</td>
              <td class="num"><b>${grams(l.net_weight_total)}</b></td><td class="num">${perGram(l.gold_rate)}</td><td class="num">${inr2(l.gold_value)}</td>
              <td class="num">${inr2(l.making_charge)}</td></tr>`)}</tbody>
          </table>

          <div class="inv-cols">
            <div class="inv-box">
              <h5>Payment (planned)</h5>
              ${advance > 0 ? html`<div class="kv"><span class="k">Advance now (${method})</span><span class="v">${inr2(advance)}</span></div>` : html`<div class="muted small">No advance entered yet.</div>`}
              <div class="kv total" style="margin-top:8px"><span class="k">Balance after advance</span><span class="v">${inr2(Math.max(t.total - advance, 0))}</span></div>
            </div>
            <div class="inv-box">
              <h5>Amount</h5>
              <div class="kv"><span class="k">Gold value</span><span class="v">${inr2(t.gold_value)}</span></div>
              <div class="kv"><span class="k">Making charges</span><span class="v">${inr2(t.making_charge)}</span></div>
              <div class="kv"><span class="k">Other charges</span><span class="v">${inr2(t.other_charges)}</span></div>
              <div class="kv"><span class="k">GST</span><span class="v">${inr2(t.gst)}</span></div>
              ${t.round_off ? html`<div class="kv"><span class="k">Round off</span><span class="v">${inr2(t.round_off)}</span></div>` : ''}
              <div class="inv-total"><span>Estimated total</span><span>${inr2(t.total)}</span></div>
            </div>
          </div>
          <p class="inv-small"><b>Pricing rules applied:</b> ${p.rules.map((r) => `${r.label}: ${r.text}`).join(' · ')}.</p>
        </article></div>`,
    });
  }

  mount(el, html`
    <div class="crumb"><a href="#/orders">Orders</a> / New</div>
    <div class="page-head"><div><h1>New Order</h1><div class="sub">Select customer → select product → calculate → receive advance → save.</div></div></div>
    <div class="grid split-wide">
      <div class="stack">
        <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">1</span><h2>Customer</h2></div></div>
          <div class="card-body" id="cust-box"></div></div>

        <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">2</span><h2>Products</h2></div>
          <button class="btn btn-sm" id="add-line">+ Add another item</button></div>
          <div class="card-body"><div id="lines-box"></div></div></div>

        <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">3</span><h2>Delivery &amp; extras</h2></div></div>
          <div class="card-body form-grid">
            <div class="field"><label for="f-delivery">Expected delivery date</label><input id="f-delivery" type="date" value="${addDaysIso(todayIso(), 7)}" min="${todayIso()}"></div>
            <div class="field"><label for="f-other">Other charges (₹)</label><input id="f-other" type="number" min="0" step="1" placeholder="0"></div>
            <div class="field"><label for="f-other-note">Other charges note</label><input id="f-other-note" placeholder="e.g. Hallmarking, packaging"></div>
            <div class="field"><label for="f-notes">Order notes</label><input id="f-notes" placeholder="Design remarks, delivery instructions…"></div>
          </div></div>
      </div>

      <div class="summary stack">
        <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">4</span><h2>Estimate</h2></div>
          <div class="row" style="gap:8px"><span class="muted small" id="rate-note"></span><button type="button" class="icon-btn" id="preview-bill" title="Preview the bill for this order" aria-label="Preview bill">${icon('eye')}</button></div></div>
          <div class="card-body" id="summary-figures"><div class="muted">Choose a product to see the calculation.</div></div></div>

        <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">5</span><h2>Advance payment</h2></div></div>
          <div class="card-body">
            <div class="form-grid">
              <div class="field full"><label for="f-adv">Advance amount (₹)</label>
                <div class="input-group"><span>₹</span><input id="f-adv" type="number" min="0" step="1" placeholder="0"></div>
                <div class="hint" id="adv-hint"></div></div>
              <div class="field"><label for="f-method">Method</label><select id="f-method">${methodOptions('UPI')}</select></div>
              <div class="field"><label for="f-ref">Reference no.</label><input id="f-ref" placeholder="UPI / cheque / card ref"></div>
            </div>
            <div class="kv total" style="margin-top:14px"><span class="k">Balance after advance</span><span class="v" id="balance">—</span></div>
            <div class="form-error" id="order-error"></div>
            <div class="row" style="margin-top:14px">
              <button class="btn btn-primary" id="confirm-order" style="flex:1;justify-content:center">Confirm Order</button>
              <button class="btn" id="save-draft">Save as Draft</button>
            </div>
            <p class="muted small" style="margin-top:10px">Confirming reserves the stock and locks today's gold rate as the order-date rate.</p>
          </div></div>
      </div>
    </div>`);

  // ---- customer step
  const custBox = $('#cust-box', el);
  function renderCustomer() {
    if (st.customer) {
      const c = st.customer;
      mount(custBox, html`<div class="cust-card"><div class="avatar">${initials(c.name)}</div>
        <div style="flex:1"><div class="cell-main">${c.name}</div><div class="cell-sub">${c.phone}${c.city ? ' · ' + c.city : ''}</div>
          <div class="cell-sub">${c.total_orders} orders · outstanding ${inr(c.total_outstanding)}</div></div>
        <button class="btn btn-sm" id="change-cust">Change</button></div>`);
      $('#change-cust', custBox).onclick = () => { st.customer = null; st.newCustomer = null; renderCustomer(); };
      return;
    }
    if (st.newCustomer) {
      const c = st.newCustomer;
      mount(custBox, html`<div class="notice info" style="margin-bottom:12px">No customer with <b>${c.phone}</b> yet — add them now and continue.</div>
        <div class="form-grid">
          <div class="field"><label for="nc-name">Full name *</label><input id="nc-name" value="${c.name || ''}"></div>
          <div class="field"><label for="nc-phone">Phone *</label><input id="nc-phone" value="${c.phone}" readonly></div>
          <div class="field"><label for="nc-city">City</label><input id="nc-city" value="${c.city || ''}"></div>
          <div class="field"><label for="nc-addr">Address</label><input id="nc-addr" value="${c.address || ''}"></div>
          <div class="field full"><label class="checkbox-label"><input id="nc-premium" type="checkbox" ${c.is_premium ? 'checked' : ''}> Premium customer</label></div>
        </div><button class="btn btn-sm" id="cancel-new" style="margin-top:12px">Search again</button>`);
      $('#cancel-new', custBox).onclick = () => { st.newCustomer = null; renderCustomer(); };
      return;
    }
    mount(custBox, html`<div class="field"><label for="cust-phone">Customer phone number</label>
      <div class="row"><input id="cust-phone" inputmode="numeric" placeholder="10-digit mobile number" style="max-width:280px"><button class="btn" id="find-cust">Find customer</button></div>
      <div class="hint">Phone number is the unique customer key. New numbers can be added on the spot.</div>
      <div class="form-error" id="cust-error"></div></div>`);
    const find = async () => {
      const phone = $('#cust-phone', custBox).value.replace(/\D/g, '');
      if (phone.length < 10) { $('#cust-error', custBox).textContent = 'Enter the 10-digit mobile number'; return; }
      try { st.customer = await api.get('/api/customers/lookup', { phone }); }
      catch (err) { if (err.status === 404) st.newCustomer = { phone: phone.slice(-10) }; else { $('#cust-error', custBox).textContent = err.message; return; } }
      renderCustomer();
    };
    $('#find-cust', custBox).onclick = find;
    $('#cust-phone', custBox).addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
  }
  renderCustomer();

  // ---- product lines
  const linesBox = $('#lines-box', el);
  function renderLines() {
    mount(linesBox, html`${st.lines.map((l, i) => {
      const chosen = products.find((p) => String(p.id) === String(l.product_id));
      return html`<div class="line-row" data-i="${i}">
        <div class="field"><label>${st.lines.length > 1 ? `Item ${i + 1}` : 'Product'}</label>
          <button type="button" class="product-picker-btn" data-pick>
            ${chosen ? html`<img class="thumb" src="${chosen.image}" alt=""><span>${chosen.name}</span>` : html`<span class="muted">Select a product…</span>`}
          </button>
          <div class="hint" data-hint></div></div>
        <div class="field"><label>Qty</label><input data-f="quantity" type="number" min="1" max="20" value="${l.quantity}"></div>
        <button class="icon-btn" data-remove title="Remove item" ${st.lines.length === 1 ? 'disabled' : ''}>×</button>
      </div>`;
    })}`);
    updateHints();
    $$('.line-row', linesBox).forEach((row) => {
      const i = Number(row.dataset.i);
      $('[data-pick]', row).addEventListener('click', () => {
        openProductPicker({
          selectedId: Number(st.lines[i].product_id) || null,
          onPick: (id) => { st.lines[i].product_id = id; renderLines(); recalc(); },
        });
      });
      $('[data-f=quantity]', row).addEventListener('input', (e) => { st.lines[i].quantity = Math.max(1, Number(e.target.value) || 1); recalc(); });
      $('[data-remove]', row).addEventListener('click', () => { st.lines.splice(i, 1); renderLines(); recalc(); });
    });
  }
  // Per-line hints (weight, making rate, stock) are filled in place so typing is never interrupted.
  function updateHints() {
    $$('.line-row', linesBox).forEach((row) => {
      const l = st.lines[Number(row.dataset.i)];
      const pl = st.preview?.lines?.find((x) => String(x.product_id) === String(l.product_id));
      const making = pl && (pl.making_method === 'per_gram' ? perGram(pl.making_rate) : pl.making_method === 'percent_of_gold' ? `${pl.making_rate}%` : inr(pl.making_rate));
      $('[data-hint]', row).textContent = pl ? `Net ${grams(pl.net_weight_each)} · making ${making} · ${pl.available} available${pl.shortage ? ' — not enough stock' : ''}` : '';
    });
  }
  $('#add-line', el).onclick = () => {
    const i = st.lines.push({ product_id: '', quantity: 1 }) - 1;
    renderLines();
    openProductPicker({ selectedId: null, onPick: (id) => { st.lines[i].product_id = id; renderLines(); recalc(); } });
  };
  $('#preview-bill', el).onclick = openBillPreview;
  renderLines();

  // ---- live pricing (always computed by the server, so it matches what will be saved)
  const figures = $('#summary-figures', el);
  const payload = () => ({
    items: st.lines.filter((l) => l.product_id).map((l) => ({ product_id: Number(l.product_id), quantity: Number(l.quantity) || 1 })),
    other_charges: $('#f-other', el).value === '' ? null : Number($('#f-other', el).value),
  });
  let seq = 0;
  async function recalc() {
    const body = payload();
    if (!body.items.length) { st.preview = null; mount(figures, html`<div class="muted">Choose a product to see the calculation.</div>`); updateBalance(); return; }
    const mine = ++seq;
    try {
      const p = await api.post('/api/orders/preview', body);
      if (mine !== seq) return;
      st.preview = p;
      renderFigures();
      updateHints();
    } catch (err) { if (mine === seq) mount(figures, html`<div class="form-error">${err.message}</div>`); }
  }
  function renderFigures() {
    const p = st.preview;
    const t = p.totals;
    const rateNote = [...new Set(p.lines.map((l) => `${l.purity} ${inr(l.gold_rate)}/g`))].join(' · ');
    $('#rate-note', el).textContent = `Today: ${rateNote}`;
    mount(figures, html`
      ${p.lines.map((l) => html`<div style="margin-bottom:10px">
        <div class="prod-cell"><img class="thumb" src="${l.image}" alt=""><button type="button" class="link-btn cell-main" data-view-product="${l.product_id}">${l.name}</button>${l.quantity > 1 ? ` × ${l.quantity}` : ''}</div>
        <div class="kv sub"><span class="k">${grams(l.net_weight_total)} × ${perGram(l.gold_rate)}</span><span class="v">${inr(l.gold_value)}</span></div>
        <div class="kv sub"><span class="k">Making charge</span><span class="v">${inr(l.making_charge)}</span></div></div>`)}
      <div class="kv"><span class="k">Gold value</span><span class="v">${inr(t.gold_value)}</span></div>
      <div class="kv"><span class="k">Making charge</span><span class="v">${inr(t.making_charge)}</span></div>
      <div class="kv"><span class="k">Other charges</span><span class="v">${inr(t.other_charges)}</span></div>
      <div class="kv"><span class="k">GST</span><span class="v">${inr(t.gst)}</span></div>
      ${t.round_off ? html`<div class="kv"><span class="k">Round off</span><span class="v">${inr2(t.round_off)}</span></div>` : ''}
      <div class="kv total"><span class="k">Estimated total</span><span class="v">${inr(t.total)}</span></div>
      ${p.lines.some((l) => l.shortage) ? html`<div class="notice warn" style="margin-top:10px">Not enough stock for one of the items. Save as a draft, or restock in Inventory.</div>` : ''}
      <details style="margin-top:12px"><summary class="muted small" style="cursor:pointer">Pricing rules applied</summary>
        <div class="rule-chips" style="margin-top:8px">${p.rules.map((r) => html`<div class="rule-chip"><span class="k">${r.label}</span>${r.text}</div>`)}</div></details>`);
    $$('[data-view-product]', figures).forEach((b) => b.addEventListener('click', () => openProductDetail(Number(b.dataset.viewProduct))));
    if (!$('#f-other', el).value) $('#f-other', el).placeholder = String(t.other_charges);
    $('#adv-hint', el).innerHTML = `Suggested minimum: <a href="#" id="use-min">${inr(p.min_advance_amount)}</a> (${p.min_advance_percent}% of the estimate)`;
    $('#use-min', el).onclick = (e) => { e.preventDefault(); $('#f-adv', el).value = p.min_advance_amount; updateBalance(); };
    updateBalance();
  }
  function updateBalance() {
    const total = st.preview?.totals.total;
    const adv = Number($('#f-adv', el).value) || 0;
    $('#balance', el).textContent = total == null ? '—' : inr(Math.max(total - adv, 0));
  }
  $('#f-adv', el).addEventListener('input', updateBalance);
  $('#f-other', el).addEventListener('input', debounce(recalc, 300));
  if (st.lines[0].product_id) recalc();

  // ---- submit
  async function submit(mode) {
    const err = $('#order-error', el);
    err.textContent = '';
    try {
      const body = { mode, ...payload() };
      if (!body.items.length) throw new Error('Add at least one product');
      if (st.customer) body.customer_id = st.customer.id;
      else if (st.newCustomer) {
        const name = $('#nc-name', el)?.value.trim();
        if (!name) throw new Error('Enter the new customer\'s name');
        body.customer = { name, phone: st.newCustomer.phone, city: $('#nc-city', el).value.trim(), address: $('#nc-addr', el).value.trim(), is_premium: $('#nc-premium', el).checked };
      } else throw new Error('Find the customer by phone number first');
      body.expected_delivery_date = $('#f-delivery', el).value;
      body.other_charges_note = $('#f-other-note', el).value;
      body.notes = $('#f-notes', el).value;
      const adv = Number($('#f-adv', el).value) || 0;
      if (mode === 'confirm' && adv > 0) body.advance = { amount: adv, payment_method: $('#f-method', el).value, reference_number: $('#f-ref', el).value };
      $('#confirm-order', el).disabled = $('#save-draft', el).disabled = true;
      const res = await api.post('/api/orders', body);
      toast(mode === 'draft' ? `Draft ${res.order.order_number} saved` : `Order ${res.order.order_number} confirmed${adv ? ` with ${inr(adv)} advance` : ''}`);
      navigate(`/orders/${res.order.id}`);
    } catch (e) {
      err.textContent = e.message;
      $('#confirm-order', el).disabled = $('#save-draft', el).disabled = false;
    }
  }
  $('#confirm-order', el).onclick = () => submit('confirm');
  $('#save-draft', el).onclick = () => submit('draft');
}

// ============================================================== order detail
function kv(k, v, cls = '') { return html`<div class="kv ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`; }

function rateShift(change) {
  if (!change) return html`<span class="rate-shift flat">no change</span>`;
  return html`<span class="rate-shift ${change > 0 ? 'up' : 'down'}">${change > 0 ? '▲' : '▼'} ${inr(Math.abs(change))}/g</span>`;
}

// Shorter labels for the compact status stepper — the full names still show as the header badge.
const SHORT_STATUS = { ADVANCE_RECEIVED: 'Advance Paid', PARTIALLY_PAID: 'Partly Paid', READY_FOR_DELIVERY: 'Ready', BILLED: 'Billed' };

/** "Still owed" line: the outstanding balance broken into grams of gold still unpaid (at today's rate),
 *  then making charge, other charges and GST — the way a jeweller actually thinks about a part-paid order. */
function remainingLine(d) {
  if (!d.remaining) return '';
  const parts = [];
  if (d.remaining.gold_weight > 0.0005) parts.push(`${grams(d.remaining.gold_weight)} gold (${inr(d.remaining.gold_value)})`);
  if (d.remaining.making_charge > 0.005) parts.push(`${inr(d.remaining.making_charge)} making`);
  if (d.remaining.other_charges > 0.005) parts.push(`${inr(d.remaining.other_charges)} other`);
  if (d.remaining.gst > 0.005) parts.push(`${inr(d.remaining.gst)} GST`);
  return html`<div class="settle-simple remaining">Still owed: ${parts.join(' + ')} = <b>${inr(d.outstanding)}</b>
    ${Math.abs(d.remaining.round_off) > 0.005 ? html`<span class="muted">(gram rounding ${d.remaining.round_off > 0 ? '+' : ''}${inr2(d.remaining.round_off)})</span>` : ''}</div>`;
}

/** One plain-language sentence telling the shop owner what to do next with this order. */
function nextStepText(o) {
  if (o.status === 'DRAFT') return 'Next: confirm the order to reserve stock and lock today’s gold rate.';
  if (o.status === 'BILLED') return 'Done — the final bill has been generated.';
  if (o.status === 'DELIVERED') return 'Delivered. Next: generate the final bill.';
  if (o.outstanding_amount > 0) {
    return o.is_ready ? `Piece is ready — collect ${inr(o.outstanding_amount)} when the customer picks it up.` : `Next: collect payment — ${inr(o.outstanding_amount)} still due.`;
  }
  return o.is_ready ? 'Fully paid and ready — hand over the piece to deliver it.' : 'Fully paid. Next: mark ready and deliver when the piece is prepared.';
}

export async function orderDetailPage({ el, params, isCurrent }) {
  const id = params[0];
  const data = await api.get(`/api/orders/${id}`);
  if (!isCurrent()) return;
  const { order: o, customer: c, items, payments, settlement: s, events, stock_movements: moves, bill, actions } = data;
  const has = (a) => actions.includes(a);
  const d = s.delivery;
  const flowIdx = STATUS_FLOW.indexOf(o.status);

  mount(el, html`
    <div class="crumb"><a href="#/orders">Orders</a> / ${o.order_number}</div>
    <div class="order-head">
      <div>
        <div class="order-title"><h1>${o.order_number}</h1>${statusBadge(o.status)}
          ${o.is_ready && o.status !== 'READY_FOR_DELIVERY' && ['FULLY_PAID', 'PARTIALLY_PAID', 'ADVANCE_RECEIVED', 'CONFIRMED'].includes(o.status) ? html`<span class="badge teal">Ready</span>` : ''}
          ${dueBadge(o.due_flag)}</div>
        <div class="muted" style="margin-top:6px"><a href="#/customers/${c.id}" class="bold">${c.name}</a> · <a href="tel:${c.phone}">${c.phone}</a> · placed ${fmtDate(o.order_date)}</div>
      </div>
      <div class="page-actions">
        ${has('confirm') ? html`<button class="btn btn-primary" data-act="confirm">Confirm Order</button>` : ''}
        ${has('add_payment') ? html`<button class="btn" data-act="pay">Record Payment</button>` : ''}
        ${has('mark_ready') ? html`<button class="btn" data-act="ready">Mark Ready</button>` : ''}
        ${has('unmark_ready') ? html`<button class="btn" data-act="unready">Undo Ready</button>` : ''}
        ${has('edit_delivery_date') ? html`<button class="btn" data-act="edit-delivery">Change Delivery Date</button>` : ''}
        ${has('edit_credit_due_date') ? html`<button class="btn" data-act="edit-credit-date">Change Repayment Date</button>` : ''}
        <a class="btn" href="#/orders/${o.id}/slip">${icon('print')} Order Slip</a>
        ${has('deliver') ? html`<button class="btn btn-gold" data-act="deliver">Settle &amp; Deliver</button>` : ''}
        ${has('generate_bill') ? html`<button class="btn btn-gold" data-act="bill">Generate Final Bill</button>` : ''}
        ${has('view_bill') && bill ? html`<a class="btn btn-primary" href="#/bills/${bill.id}">View Final Bill ${bill.bill_number}</a>` : ''}
        ${has('cancel') ? html`<button class="btn btn-danger" data-act="cancel">Cancel</button>` : ''}
        ${has('delete') ? html`<button class="btn btn-danger" data-act="delete">Delete Draft</button>` : ''}
      </div>
    </div>

    ${o.status === 'CANCELLED' ? html`<div class="notice warn" style="margin-top:16px"><b>Cancelled</b> ${fmtDate(o.cancelled_at)}${o.cancel_reason ? ' — ' + o.cancel_reason : ''}. Reserved stock was released.${o.paid_amount > 0 ? ` ${inr(o.paid_amount)} received earlier remains in the payment history below and needs to be refunded or adjusted.` : ''}</div>` :
      html`<div class="notice next-step" style="margin-top:16px">${nextStepText(o)}</div>
      <div class="card card-body" style="margin-top:12px"><div class="flow">${STATUS_FLOW.map((k, i) => html`<div class="flow-step ${i < flowIdx ? 'done' : ''} ${i === flowIdx ? 'now' : ''}" data-label="Step ${i + 1} of ${STATUS_FLOW.length} · ${SHORT_STATUS[k] || statusLabel(k)}">${SHORT_STATUS[k] || statusLabel(k)}</div>`)}</div></div>`}

    ${o.is_credit ? html`<div class="notice warn" style="margin-top:16px"><b>Delivered on credit</b> — ${inr(o.outstanding_amount)} still owed${o.credit_due_date ? html`, repayment due ${fmtDate(o.credit_due_date)} (${relDays(o.days_to_credit_due)})` : ''}. The piece has already left the shop; record payments here as they come in.</div>` : ''}

    <div class="kpis order-kpis" style="margin-top:18px">
      <div class="kpi"><div class="kpi-label">${s.is_final ? 'Final bill amount' : 'Total bill amount'}</div><div class="kpi-value">${inr(o.total_amount)}</div>
        <div class="kpi-note">${o.total_amount === o.estimated_total ? `at ${perGram(d.gold_rate)}` : `was ${inr(o.estimated_total)} when booked — recalculated at today's ${perGram(d.gold_rate)}`}</div></div>
      <div class="kpi"><div class="kpi-label">Paid so far</div><div class="kpi-value" style="color:var(--green)">${inr(o.paid_amount)}</div><div class="kpi-note">${payments.length} payment${payments.length === 1 ? '' : 's'}</div></div>
      <div class="kpi ${o.outstanding_amount > 0 ? 'hero' : ''}"><div class="kpi-label">Due now</div><div class="kpi-value">${inr(o.outstanding_amount)}</div>
        <div class="kpi-note">${o.status === 'CANCELLED' ? 'cancelled' : o.outstanding_amount > 0 ? paymentBadge(o.payment_status) : 'Fully paid ✓'}</div></div>
      <div class="kpi"><div class="kpi-label">${o.actual_delivery_date ? 'Delivered on' : 'Expected delivery'}</div><div class="kpi-value" style="font-size:19px">${fmtDate(o.actual_delivery_date || o.expected_delivery_date)}</div>
        <div class="kpi-note">${o.actual_delivery_date ? '' : relDays(o.days_to_delivery)}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Items</h2></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Product</th><th>SKU · Barcode</th><th>Purity</th><th class="num">Qty</th><th class="num">Gross</th><th class="num">Stone</th><th class="num">Net gold</th></tr></thead>
        <tbody>${items.map((i) => html`<tr>
          <td><div class="prod-cell"><img class="thumb" src="${i.image}" alt=""><button type="button" class="link-btn cell-main" data-view-product="${i.product_id}">${i.product_name}</button></div></td>
          <td><span class="mono">${i.sku}</span><div class="cell-sub mono">${i.barcode || ''}</div></td>
          <td>${i.purity} ${i.metal_type}</td><td class="num">${i.quantity}</td>
          <td class="num">${grams(i.gross_weight * i.quantity)}</td><td class="num">${grams(i.stone_weight * i.quantity)}</td>
          <td class="num bold">${grams(i.net_weight_total)}</td></tr>`)}</tbody></table></div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-head"><h2>Price breakdown</h2></div>
      <div class="card-body">
        <div class="settle-simple">
          ${inr(d.gold_value)} gold + ${inr(d.making_charge)} making${d.other_charges ? ` + ${inr(d.other_charges)} other` : ''} + ${inr(d.gst)} GST = <b>${inr(d.amount_payable)}</b>
          <span class="muted">at ${perGram(d.gold_rate)}${d.rate_change ? html` — gold rate moved ${rateShift(d.rate_change)} since the order was booked` : ''}</span>
        </div>
        ${remainingLine(d)}
        <details class="settle-details">
          <summary>Show full calculation (order-date price, payments applied, rounding)</summary>
          <div class="settle" style="margin-top:14px">
            <div class="settle-col">
              <h4><span class="step">1</span>Original order</h4>
              ${s.original ? html`
                ${s.lines.map((l) => kv(`${l.name}${l.quantity > 1 ? ' ×' + l.quantity : ''}`, grams(l.net_weight), 'sub'))}
                ${kv('Order-date gold rate', perGram(s.original.gold_rate))}
                ${kv('Original gold value', inr(s.original.gold_value))}
                ${kv('Making charge', inr(s.original.making_charge))}
                ${kv('GST', inr(s.original.gst))}
                ${s.original.other_charges ? kv('Other charges', inr(s.original.other_charges)) : ''}
                ${s.original.round_off ? kv('Round off', inr2(s.original.round_off)) : ''}
                ${kv('Estimated total', inr(s.original.total), 'total')}` : ''}
            </div>
            <div class="settle-col">
              <h4><span class="step">2</span>Payments received</h4>
              ${payments.length ? payments.map((p, i) => html`${kv(`Payment ${i + 1} · ${p.payment_method}`, inr(p.amount))}
                <div class="kv sub"><span class="k">${fmtDate(p.payment_date)} · ${p.kind}</span><span class="v">${p.gold_equivalent.toFixed(3)} g @ ${inr(p.gold_rate_at_payment)}</span></div>`) : html`<div class="muted">No payments yet.</div>`}
              ${kv('Total advance / paid', inr(s.payments.total_paid), 'total')}
              ${s.payments.treatment === 'gold_equivalent_credit' ? html`${kv('Gold bought so far', grams(s.payments.gold_equivalent), 'sub')}${kv(`Credit at ${perGram(d.gold_rate)}`, inr(s.payments.credit_applied), 'credit')}`
                : html`<div class="kv sub"><span class="k">Treated as monetary credit</span><span class="v"></span></div>`}
            </div>
            <div class="settle-col">
              <h4><span class="step">3</span>Delivery settlement</h4>
              ${kv(s.is_final ? 'Delivery-date gold rate' : "Today's gold rate", html`${perGram(d.gold_rate)} ${rateShift(d.rate_change)}`)}
              ${kv('Applicable gold value', inr(d.gold_value))}
              ${kv('Making charge', inr(d.making_charge))}
              ${kv('GST', inr(d.gst))}
              ${d.other_charges ? kv('Other charges', inr(d.other_charges)) : ''}
              ${d.round_off ? kv('Round off', inr2(d.round_off)) : ''}
              ${kv('Final amount payable', inr(d.amount_payable), 'total')}
              ${d.change_vs_estimate ? html`<div class="kv sub"><span class="k">vs original estimate</span><span class="v">${d.change_vs_estimate > 0 ? '+' : '−'}${inr(Math.abs(d.change_vs_estimate))}</span></div>` : ''}
              ${kv('Previous payments', '− ' + inr(d.previous_payments), 'credit')}
              ${o.status === 'CANCELLED' ? '' : kv('Final outstanding', inr(d.outstanding), `due ${d.outstanding <= 0.005 ? 'zero' : ''}`)}
              ${d.excess_paid > 0 ? html`<div class="notice warn" style="margin-top:8px">Customer has paid ${inr(d.excess_paid)} more than the amount payable.</div>` : ''}
            </div>
          </div>
        </details>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-head"><h2>Payment history</h2><span class="muted small">Records are never edited or removed.</span></div>
      ${payments.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>Payment</th><th>Date</th><th>Type</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th class="num">Gold rate</th><th class="num">Gold equivalent</th><th>Notes</th></tr></thead>
        <tbody>${payments.map((p) => html`<tr><td class="mono">PAY-${String(p.id).padStart(4, '0')}</td><td class="nowrap">${fmtDate(p.payment_date)}</td><td>${p.kind}</td><td>${p.payment_method}</td>
          <td class="mono">${p.reference_number || '—'}</td><td class="num bold">${inr(p.amount)}</td><td class="num">${perGram(p.gold_rate_at_payment)}</td>
          <td class="num">${grams(p.gold_equivalent)}</td><td>${p.notes || ''}</td></tr>`)}</tbody>
        <tfoot><tr><td colspan="5">Total paid</td><td class="num">${inr(o.paid_amount)}</td><td colspan="3"></td></tr></tfoot></table></div>` : empty('No payments recorded yet')}
    </div>

    <div class="grid cols-2" style="margin-top:18px">
      <div class="card"><div class="card-head"><h2>Activity</h2></div><div class="card-body"><ul class="timeline">
        ${[...events].reverse().map((e) => html`<li class="${e.event_type}"><div>${e.message}</div><div class="when">${fmtDateTime(e.created_at)}</div></li>`)}</ul></div></div>
      <div class="card"><div class="card-head"><h2>Stock impact</h2></div>
        ${moves.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Product</th><th>Movement</th><th class="num">Change</th></tr></thead>
          <tbody>${moves.map((m) => html`<tr><td class="nowrap">${fmtDate(m.created_at, false)}</td><td>${m.product_name}</td><td>${moveBadge(m.movement_type)}</td>
            <td class="num">${m.counter === 'reserved' ? 'Reserved' : 'On hand'} ${m.previous_quantity} → ${m.new_quantity}</td></tr>`)}</tbody></table></div>` : empty('No stock movements', 'Stock is reserved when the order is confirmed.')}
        ${o.notes ? html`<div class="card-body" style="border-top:1px solid var(--line-2)"><div class="muted small">Order notes</div><div>${o.notes}</div></div>` : ''}
      </div>
    </div>`);

  // ---- actions
  const act = (name) => $(`[data-act=${name}]`, el);
  act('pay')?.addEventListener('click', () => openPaymentModal(data));
  act('deliver')?.addEventListener('click', () => openDeliverModal(data));
  act('confirm')?.addEventListener('click', () => openConfirmDraftModal(data));
  act('ready')?.addEventListener('click', () => post(`/api/orders/${o.id}/ready`, { ready: true }, 'Marked ready for delivery'));
  act('unready')?.addEventListener('click', () => post(`/api/orders/${o.id}/ready`, { ready: false }, 'Ready mark removed'));
  act('edit-delivery')?.addEventListener('click', () => openEditDeliveryDateModal(data));
  act('edit-credit-date')?.addEventListener('click', () => openEditCreditDueDateModal(data));
  act('bill')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Generate final bill', message: `Generate the final bill for ${o.order_number} (${inr(o.total_amount)})? Issued bills cannot be edited.`, confirmLabel: 'Generate bill' }))) return;
    try { const b = await api.post(`/api/orders/${o.id}/bill`); toast(`Bill ${b.bill_number} generated`); navigate(`/bills/${b.id}`); } catch (e) { toast(e.message, 'error'); }
  });
  act('cancel')?.addEventListener('click', () => openCancelModal(data));
  $$('[data-view-product]', el).forEach((b) => b.addEventListener('click', () => openProductDetail(Number(b.dataset.viewProduct), { onSaved: refresh })));
  act('delete')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Delete draft', message: `Delete draft ${o.order_number}? It has no payments or stock reserved.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.del(`/api/orders/${o.id}`); toast('Draft deleted'); navigate('/orders'); } catch (e) { toast(e.message, 'error'); }
  });
}

async function post(url, body, okMessage) {
  try { await api.post(url, body); toast(okMessage); refresh(); } catch (e) { toast(e.message, 'error'); }
}

async function currentRate(purity) {
  const { items } = await api.get('/api/gold-rates/current');
  return items.find((r) => r.purity === purity)?.rate_per_gram;
}

function openPaymentModal(data) {
  const { order: o, items, settlement: s } = data;
  const due = s.delivery.outstanding;
  const purity = items[0].purity;
  const netWeight = items.reduce((sum, i) => sum + i.net_weight_total, 0);
  openModal({
    title: `Record payment · ${o.order_number}`,
    content: html`<form class="form-grid">
      <div class="notice full" style="grid-column:1/-1">Outstanding right now: <b>${inr(due)}</b> at ${perGram(s.delivery.gold_rate)}.</div>
      <div class="field full"><label for="p-amount">Amount received (₹)</label>
        <div class="input-group"><span>₹</span><input id="p-amount" name="amount" type="number" min="1" step="0.01" max="${due}" value="" required></div>
        <div class="hint"><a href="#" id="p-full">Pay full outstanding (${inr(due)})</a> · <span id="p-gold"></span></div></div>
      <div class="field"><label for="p-method">Payment method</label><select id="p-method" name="payment_method">${methodOptions('UPI')}</select></div>
      <div class="field"><label for="p-date">Payment date</label><input id="p-date" name="payment_date" type="date" value="${todayIso()}" min="${o.order_date}" max="${todayIso()}"></div>
      <div class="field full"><label for="p-ref">Reference number</label><input id="p-ref" name="reference_number" placeholder="UPI ref, card auth code, cheque no."></div>
      <div class="field full"><label for="p-notes">Notes</label><input id="p-notes" name="notes"></div>
      <div class="form-error full" style="grid-column:1/-1"></div>
      <div class="modal-actions full" style="grid-column:1/-1"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save payment</button></div>
    </form>`,
    onOpen: async (m, close) => {
      const form = $('form', m);
      const amount = $('#p-amount', m);
      const rate = await currentRate(purity);
      // Converting the whole payment to grams only makes sense up to the order's actual gold weight —
      // beyond that the rest of the money is paying for making charge and GST, not more gold.
      const showGold = () => {
        const a = Number(amount.value);
        if (!(a > 0 && rate)) { $('#p-gold', m).textContent = ''; return; }
        const eqGrams = a / rate;
        $('#p-gold', m).textContent = eqGrams > netWeight + 0.0005
          ? `≈ ${netWeight.toFixed(3)} g of ${purity} gold (this order's full net weight) — the rest covers making charge & GST (informational)`
          : `≈ ${eqGrams.toFixed(3)} g of ${purity} at today's ${inr(rate)}/g (informational)`;
      };
      amount.addEventListener('input', showGold);
      $('#p-full', m).onclick = (e) => { e.preventDefault(); amount.value = due; showGold(); };
      onSubmit(form, async (v) => {
        await api.post(`/api/orders/${o.id}/payments`, v);
        close();
        toast(`Payment of ${inr(Number(v.amount))} recorded`);
        refresh();
      });
    },
  });
}

function openDeliverModal(data) {
  const { order: o, settlement: s } = data;
  const d = s.delivery;
  const due = d.outstanding;
  openModal({
    title: `Settle & deliver · ${o.order_number}`,
    size: 'wide',
    content: html`<form>
      <div class="card" style="box-shadow:none"><div class="card-body">
        ${kv("Today's gold rate", html`${perGram(d.gold_rate)} ${rateShift(d.rate_change)}`)}
        ${kv('Gold value', inr(d.gold_value))}${kv('Making charge', inr(d.making_charge))}${kv('GST', inr(d.gst))}
        ${d.other_charges ? kv('Other charges', inr(d.other_charges)) : ''}
        ${kv('Final amount payable', inr(d.amount_payable), 'total')}
        ${kv('Previous payments', '− ' + inr(d.previous_payments), 'credit')}
        ${kv('Balance to collect now', inr(due), `due ${due <= 0.005 ? 'zero' : ''}`)}
      </div></div>
      ${due > 0.005 ? html`<div class="form-grid" style="margin-top:14px">
        <div class="field"><label for="d-amount">Amount received now (₹)</label><div class="input-group"><span>₹</span><input id="d-amount" name="amount" type="number" step="0.01" min="0" max="${due}" value="${due}"></div>
          <div class="hint">Lower this to hand the piece over on credit for the rest, or use <b>Record Payment</b> for a part payment without delivering.</div></div>
        <div class="field"><label for="d-method">Payment method</label><select id="d-method" name="payment_method">${methodOptions('UPI')}</select></div>
        <div class="field full"><label for="d-ref">Reference number</label><input id="d-ref" name="reference_number"></div>
        <div class="field full" id="credit-box" style="display:none">
          <label for="d-credit-date">Credit repayment due date</label>
          <input id="d-credit-date" name="credit_due_date" type="date" min="${addDaysIso(todayIso(), 1)}">
          <div class="hint">The remaining balance stays on this order as credit and shows up on the Dashboard until it's repaid.</div>
        </div>
      </div>` : html`<p class="muted" style="margin-top:12px">Nothing more to collect — delivery will lock the final settlement.</p>`}
      <p class="muted small" style="margin-top:12px">On confirmation the gold rate and pricing rules are frozen for this order, stock is reduced and the order becomes <b>Delivered</b>.</p>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-gold" type="submit" id="deliver-submit">${due > 0.005 ? 'Take payment & deliver' : 'Confirm delivery'}</button></div>
    </form>`,
    onOpen: (m, close) => {
      const amountInput = $('#d-amount', m);
      const creditBox = $('#credit-box', m);
      const creditDate = $('#d-credit-date', m);
      const submitBtn = $('#deliver-submit', m);
      const syncCredit = () => {
        if (!amountInput) return;
        const remaining = due - (Number(amountInput.value) || 0);
        const onCredit = remaining > 0.005;
        creditBox.style.display = onCredit ? '' : 'none';
        creditDate.required = onCredit;
        submitBtn.textContent = onCredit ? 'Deliver on credit' : 'Take payment & deliver';
      };
      amountInput?.addEventListener('input', syncCredit);
      syncCredit();
      onSubmit($('form', m), async (v) => {
        const amount = Number(v.amount) || 0;
        const remaining = due - amount;
        const body = {};
        if (amount > 0) body.payment = { amount, payment_method: v.payment_method, reference_number: v.reference_number };
        if (remaining > 0.005) body.credit = { due_date: v.credit_due_date };
        await api.post(`/api/orders/${o.id}/deliver`, body);
        close();
        toast(remaining > 0.005 ? `${o.order_number} delivered on credit — ${inr(remaining)} still due` : `${o.order_number} delivered. You can now generate the final bill.`);
        refresh();
      });
    },
  });
}

function openConfirmDraftModal(data) {
  const { order: o, settlement: s } = data;
  openModal({
    title: `Confirm ${o.order_number}`,
    content: html`<form class="form-grid">
      <div class="notice" style="grid-column:1/-1">Confirming re-prices this draft at today's gold rate, reserves the stock and locks the order-date rate.</div>
      <div class="field"><label for="c-date">Expected delivery</label><input id="c-date" name="expected_delivery_date" type="date" value="${o.expected_delivery_date >= todayIso() ? o.expected_delivery_date : addDaysIso(todayIso(), 7)}" min="${todayIso()}"></div>
      <div class="field"><label for="c-adv">Advance (₹, optional)</label><input id="c-adv" name="amount" type="number" min="0" step="1"></div>
      <div class="field"><label for="c-method">Method</label><select id="c-method" name="payment_method">${methodOptions('UPI')}</select></div>
      <div class="field"><label for="c-ref">Reference</label><input id="c-ref" name="reference_number"></div>
      <div class="form-error" style="grid-column:1/-1"></div>
      <div class="modal-actions" style="grid-column:1/-1"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Confirm order</button></div>
    </form>`,
    onOpen: (m, close) => onSubmit($('form', m), async (v) => {
      const body = { expected_delivery_date: v.expected_delivery_date };
      if (Number(v.amount) > 0) body.advance = { amount: Number(v.amount), payment_method: v.payment_method, reference_number: v.reference_number };
      await api.post(`/api/orders/${o.id}/confirm`, body);
      close(); toast('Order confirmed'); refresh();
    }),
  });
}

function openEditDeliveryDateModal(data) {
  const { order: o } = data;
  openModal({
    title: `Change delivery date · ${o.order_number}`,
    content: html`<form>
      <div class="field"><label for="dd-date">Expected delivery date</label><input id="dd-date" name="expected_delivery_date" type="date" value="${o.expected_delivery_date}" min="${o.order_date}" required></div>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save date</button></div>
    </form>`,
    onOpen: (m, close) => onSubmit($('form', m), async (v) => {
      await api.put(`/api/orders/${o.id}/delivery-date`, { expected_delivery_date: v.expected_delivery_date });
      close(); toast('Delivery date updated'); refresh();
    }),
  });
}

function openEditCreditDueDateModal(data) {
  const { order: o } = data;
  openModal({
    title: `Change repayment date · ${o.order_number}`,
    content: html`<form>
      <p class="modal-text">${inr(o.outstanding_amount)} is still owed on this order, delivered on credit.</p>
      <div class="field"><label for="cd-date">Repayment due date</label><input id="cd-date" name="credit_due_date" type="date" value="${o.credit_due_date || ''}" min="${todayIso()}" required></div>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save date</button></div>
    </form>`,
    onOpen: (m, close) => onSubmit($('form', m), async (v) => {
      await api.put(`/api/orders/${o.id}/credit-due-date`, { credit_due_date: v.credit_due_date });
      close(); toast('Repayment date updated'); refresh();
    }),
  });
}

function openCancelModal(data) {
  const { order: o } = data;
  openModal({
    title: `Cancel ${o.order_number}`,
    content: html`<form>
      <p class="modal-text">Reserved stock will be released.${o.paid_amount > 0 ? html` <b>${inr(o.paid_amount)}</b> already received stays in the payment history — refund or adjust it with the customer separately.` : ''}</p>
      <div class="field" style="margin-top:12px"><label for="x-reason">Reason</label><input id="x-reason" name="reason" placeholder="e.g. Customer changed the design"></div>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Keep order</button><button class="btn btn-solid-danger" type="submit">Cancel order</button></div>
    </form>`,
    onOpen: (m, close) => onSubmit($('form', m), async (v) => { await api.post(`/api/orders/${o.id}/cancel`, { reason: v.reason }); close(); toast('Order cancelled'); refresh(); }),
  });
}

// =================================================================== order slip
export async function orderSlipPage({ el, params, isCurrent }) {
  const data = await api.get(`/api/orders/${params[0]}`);
  if (!isCurrent()) return;
  const { order: o, items, payments, settlement: s } = data;
  const d = s.delivery;

  mount(el, html`
    <div class="no-print">
      <div class="crumb"><a href="#/orders/${o.id}">${o.order_number}</a> / Order Slip</div>
      <div class="page-head">
        <div><h1>Order Slip · ${o.order_number}</h1><div class="sub">Internal / workshop copy — no customer details</div></div>
        <div class="page-actions">
          <a class="btn" href="#/orders/${o.id}">Back to order</a>
          <button class="btn btn-primary" id="print-slip">${icon('print')} Print / Save as PDF</button>
        </div>
      </div>
    </div>

    <div class="invoice-wrap"><article class="invoice">
      <header class="inv-head">
        <div><div class="inv-shop">Order Slip</div><div class="inv-tag">Internal use — workshop / delivery copy</div></div>
        <div class="inv-title"><h2>${o.order_number}</h2>
          <div style="margin-top:8px">${statusBadge(o.status)}</div>
          <div class="inv-small" style="margin-top:6px">Order date: ${fmtDate(o.order_date)}</div>
          <div class="inv-small">${o.actual_delivery_date ? `Delivered: ${fmtDate(o.actual_delivery_date)}` : `Expected delivery: ${fmtDate(o.expected_delivery_date)}`}</div>
        </div>
      </header>

      <table class="inv-table">
        <thead><tr><th>Item</th><th>Purity</th><th class="num">Gross wt</th><th class="num">Stone wt</th><th class="num">Net gold wt</th><th class="num">Gold rate</th><th class="num">Gold value</th><th class="num">Making charge</th></tr></thead>
        <tbody>${items.map((i) => html`<tr>
          <td><b>${i.product_name}</b>${i.quantity > 1 ? ` × ${i.quantity}` : ''}<div class="inv-small" style="margin:2px 0 0">SKU ${i.sku} · Barcode ${i.barcode || '—'}</div></td>
          <td>${i.purity} ${i.metal_type}</td><td class="num">${grams(i.gross_weight * i.quantity)}</td><td class="num">${grams(i.stone_weight * i.quantity)}</td>
          <td class="num"><b>${grams(i.net_weight_total)}</b></td>
          <td class="num">${perGram(i.settled_gold_rate || i.gold_rate)}</td><td class="num">${inr2(i.settled_gold_value || i.gold_value)}</td>
          <td class="num">${inr2(i.settled_making_charge || i.making_charge)}</td></tr>`)}</tbody>
      </table>

      <div class="inv-cols">
        <div class="inv-box">
          <h5>Payments</h5>
          ${payments.length ? html`<table class="inv-table"><thead><tr><th>Date</th><th>Type</th><th>Method</th><th class="num">Amount</th></tr></thead>
            <tbody>${payments.map((p) => html`<tr><td>${fmtDate(p.payment_date)}</td><td>${p.kind}</td><td>${p.payment_method}</td><td class="num">${inr2(p.amount)}</td></tr>`)}</tbody></table>`
            : html`<div class="muted">No payments yet.</div>`}
          <div class="kv total" style="margin-top:8px"><span class="k">Total paid</span><span class="v">${inr2(o.paid_amount)}</span></div>
          <div class="kv sub"><span class="k">Outstanding</span><span class="v">${inr2(o.outstanding_amount)}</span></div>
        </div>
        <div class="inv-box">
          <h5>Amount</h5>
          <div class="kv"><span class="k">Gold value</span><span class="v">${inr2(d.gold_value)}</span></div>
          <div class="kv"><span class="k">Making charges</span><span class="v">${inr2(d.making_charge)}</span></div>
          ${d.other_charges ? html`<div class="kv"><span class="k">Other charges</span><span class="v">${inr2(d.other_charges)}</span></div>` : ''}
          <div class="kv"><span class="k">GST</span><span class="v">${inr2(d.gst)}</span></div>
          ${d.round_off ? html`<div class="kv"><span class="k">Round off</span><span class="v">${inr2(d.round_off)}</span></div>` : ''}
          <div class="inv-total"><span>${s.is_final ? 'Final amount' : 'Payable'}</span><span>${inr2(o.total_amount)}</span></div>
        </div>
      </div>

      <div class="inv-foot">
        <div class="inv-small" style="margin:0;max-width:430px">Internal order slip for workshop and delivery use. Deliberately excludes customer name, address and phone number.</div>
        <div class="sign">Prepared by<br><span class="muted">RA Jewellers</span></div>
      </div>
    </article></div>`);

  $('#print-slip', el).addEventListener('click', () => window.print());
}
