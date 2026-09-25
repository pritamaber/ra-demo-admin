import {
  $, $$, api, html, mount, inr, inr2, grams, perGram, fmtDate, fmtDateTime, relDays, deliveryNote, addDaysIso, todayIso, statusBadge, paymentBadge,
  moveBadge, empty, openModal, onSubmit, toast, navigate, refresh, debounce, initials, slugify, icon, STATUS_FLOW, statusLabel,
} from '../lib.js';
import { openProductDetail } from './catalog.js';
const METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
const methodOptions = (selected = 'UPI') => html`${METHODS.map((m) => html`<option ${m === selected ? 'selected' : ''}>${m}</option>`)}`;
const walkInTag = (o) => (o.kind === 'SALE' ? html`<span class="badge purple">Walk-in bill</span>` : '');

// ======================================================================= list
const TABS = [
  ['all', 'All', {}], ['open', 'Open', { view: 'open' }], ['outstanding', 'Payment due', { view: 'outstanding' }],
  ['overdue', 'Overdue', { view: 'overdue' }], ['ready', 'Ready for delivery', { view: 'ready' }],
  ['delivered', 'Delivered', { view: 'delivered' }], ['cancelled', 'Cancelled', { status: 'CANCELLED' }],
];
const tabKey = (q) => (TABS.find(([k, , f]) => (f.view && f.view === q.view) || (f.status && f.status === q.status)) || TABS[0])[0];

export async function ordersListPage({ el, query, isCurrent }) {
  let active = tabKey(query);
  let text = query.q || '';
  const counts = await Promise.all(TABS.filter(([k]) => ['open', 'outstanding', 'overdue', 'ready'].includes(k))
    .map(async ([k, , f]) => [k, (await api.get('/api/orders', { ...f, limit: 1 })).total]));
  if (!isCurrent()) return;
  const countMap = Object.fromEntries(counts);

  mount(el, html`
    <div class="page-head dash-head">
      <div><h1>Orders</h1><div class="sub">Customers book, pay in instalments and collect on the delivery date.</div></div>
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
    const sort = active === 'overdue' ? 'delivery' : active === 'outstanding' ? 'outstanding' : 'order_date';
    const params = { ...filter, q: text, sort, limit: 200 };
    history.replaceState(null, '', '#/orders?' + new URLSearchParams(Object.entries({ ...filter, q: text }).filter(([, v]) => v)).toString());
    const { items, total } = await api.get('/api/orders', params);
    $('#order-count', el).textContent = `${total} order${total === 1 ? '' : 's'}`;
    mount($('#orders-table', el), items.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Product</th><th class="num">Gold</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Due</th><th>Delivery</th><th>Status</th></tr></thead>
      <tbody>${items.map((o) => html`<tr class="clickable" data-href="#/orders/${o.id}">
        <td><a class="cell-main" href="#/orders/${o.id}">${o.order_number}</a>${o.kind === 'SALE' ? html`<div class="cell-sub">Walk-in bill</div>` : ''}</td>
        <td class="nowrap">${fmtDate(o.order_date)}</td>
        <td><a href="#/customers/${o.customer_id}">${o.customer_name}</a><div class="cell-sub">${o.customer_phone}</div></td>
        <td>${o.products}</td>
        <td class="num nowrap">${grams(o.gold_weight)}</td>
        <td class="num">${inr(o.total_amount)}</td>
        <td class="num">${inr(o.paid_amount)}</td>
        <td class="num ${o.outstanding_amount > 0 ? 'bold' : 'muted'}">${inr(o.outstanding_amount)}</td>
        <td class="nowrap">${o.actual_delivery_date ? html`${fmtDate(o.actual_delivery_date)}<div class="cell-sub">delivered</div>` : html`${fmtDate(o.expected_delivery_date)}<div class="cell-sub">${deliveryNote(o)}</div>`}</td>
        <td>${statusBadge(o.status)}</td>
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

// ============================================================= new order / new bill
/**
 * One form, two flows.
 *   'order' — the customer books ahead: pick a delivery date, optionally pay something now, collect later.
 *   'sale'  — walk-in bill: the customer pays in full now and takes the pieces home; billed on the spot.
 */
function newTransactionPage(mode) {
  const isSale = mode === 'sale';
  return async function page({ el, query, isCurrent }) {
    const onPhone = matchMedia('(max-width: 767px)').matches; // secondary fields start collapsed on a phone
    const [{ items: products }, { items: rates }] = await Promise.all([
      api.get('/api/products', { status: 'active', limit: 500, sort: 'category' }),
      api.get('/api/gold-rates/current'),
    ]);
    if (!isCurrent()) return;

    const st = { customer: null, newCustomer: null, lines: [{ product_id: query.product || '', quantity: 1, edits: {} }], preview: null };
    if (query.customer) st.customer = (await api.get(`/api/customers/${query.customer}`)).customer;
    else if (query.phone) {
      const phone = query.phone.replace(/\D/g, '').slice(-10);
      st.customer = await api.get('/api/customers/lookup', { phone }).catch(() => null);
      if (!st.customer && phone.length === 10) st.newCustomer = { phone }; // unknown number: offer to add them right here
    }

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

    mount(el, html`
      <div class="flow-page">
      <div class="crumb"><a href="${isSale ? '#/billing' : '#/orders'}">${isSale ? 'Billing' : 'Orders'}</a> / New</div>
      <div class="page-head dash-head"><div><h1>${isSale ? 'New Bill' : 'New Order'}</h1>
        <div class="sub">${isSale ? 'Walk-in sale: pick the pieces, take the full payment, done.' : 'Pick the pieces and a delivery date. The customer can pay now or in instalments.'}</div></div></div>
      <div class="grid split-wide">
        <div class="stack">
          <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">1</span><h2>Customer</h2></div></div>
            <div class="card-body" id="cust-box"></div></div>

          <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">2</span><h2>Products</h2></div>
            <button class="btn btn-sm" id="add-line">+ Add another item</button></div>
            <div class="card-body"><div id="lines-box"></div></div></div>

          <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">3</span><h2>${isSale ? 'Extras' : 'Delivery date'}</h2></div></div>
            <div class="card-body">
              ${isSale ? '' : html`<div class="field"><label for="f-delivery">Delivery date</label><input id="f-delivery" type="date" value="${addDaysIso(todayIso(), 7)}" min="${todayIso()}"><div class="hint">You can change it later.</div></div>`}
              <details class="item-details more-opts" ${onPhone ? '' : 'open'}>
                <summary>More options <span class="muted small">— other charges${isSale ? '' : ', notes'}</span></summary>
                <div class="form-grid" style="margin-top:10px">
                  <div class="field"><label for="f-other">Other charges (₹)</label><input id="f-other" type="number" min="0" step="1" placeholder="0"></div>
                  <div class="field"><label for="f-other-note">Other charges note</label><input id="f-other-note" placeholder="e.g. Hallmarking, packaging"></div>
                  ${isSale ? '' : html`<div class="field full"><label for="f-notes">Order notes</label><input id="f-notes" placeholder="Design remarks, delivery instructions…"></div>`}
                </div>
              </details>
            </div></div>
        </div>

        <div class="summary stack">
          <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">4</span><h2>${isSale ? 'Bill total' : 'Price'}</h2></div>
            <div class="row" style="gap:8px"><span class="muted small" id="rate-note"></span>
              <button type="button" class="btn btn-sm" id="preview-btn" title="${isSale ? 'View the bill' : 'View the order slip and bill'} before saving" aria-label="Preview">${icon('eye')} Preview</button></div></div>
            <div class="card-body" id="summary-figures"><div class="muted">Choose a product to see the price.</div></div></div>

          <div class="card"><div class="card-head"><div class="step-title"><span class="step-no">5</span><h2>${isSale ? 'Payment (in full)' : 'Payment now'}</h2></div></div>
            <div class="card-body">
              <div class="form-grid">
                ${isSale ? '' : html`<div class="field full"><label for="f-adv">Amount paid now (₹) — optional</label>
                  <div class="input-group"><span>₹</span><input id="f-adv" type="number" min="0" step="1" placeholder="0"></div>
                  <div class="hint">Any amount secures the pieces. <a href="#" id="pay-full">Pay the full amount</a></div></div>`}
                <div class="field"><label for="f-method">Method</label><select id="f-method">${methodOptions('UPI')}</select></div>
                <details class="item-details more-opts field" ${onPhone ? '' : 'open'}>
                  <summary>Reference no. <span class="muted small">— optional</span></summary>
                  <input id="f-ref" placeholder="UPI / cheque / card ref" style="margin-top:8px">
                </details>
              </div>
              <div class="kv total" style="margin-top:14px"><span class="k">${isSale ? 'Customer pays' : 'Balance after this payment'}</span><span class="v" id="balance">—</span></div>
              <div class="form-error" id="order-error"></div>
              <button class="btn desk-only ${isSale ? 'btn-gold' : 'btn-primary'}" id="submit-btn" style="width:100%;justify-content:center;margin-top:14px">${isSale ? 'Create bill & hand over' : 'Place order'}</button>
              <p class="muted small desk-only" style="margin-top:10px">${isSale
                ? 'The bill is generated immediately, stock is reduced and the sale is added to the customer’s history.'
                : 'Placing the order reserves the stock and locks today’s gold rate for this order.'}</p>
            </div></div>
        </div>
      </div>
      <div class="action-bar">
        <div class="ab-total"><span>${isSale ? 'Bill total' : 'Order total'}</span><b id="bar-total">—</b><small id="bar-sub"></small></div>
        <button type="button" class="btn ${isSale ? 'btn-gold' : 'btn-primary'}" id="bar-submit">${isSale ? 'Create bill' : 'Place order'}</button>
      </div>
      </div>`);

    // ---- customer list: browse or search every customer and tap one to select them
    function openCustomerPicker() {
      const { close } = openModal({
        title: 'Select customer',
        size: 'wide',
        content: html`<input id="cl-search" type="search" placeholder="Search by name, phone or city…" autocomplete="off" style="margin-bottom:12px">
          <div class="muted small" id="cl-count" style="margin-bottom:8px"></div>
          <div class="cust-list" id="cl-body"></div>`,
        onOpen: (m) => {
          let seqNo = 0;
          const load = async (text = '') => {
            const mine = ++seqNo;
            try {
              const { items } = await api.get('/api/customers', { q: text, limit: 200 });
              if (mine !== seqNo) return;
              $('#cl-count', m).textContent = `${items.length} customer${items.length === 1 ? '' : 's'}${text ? ' found' : ''}`;
              mount($('#cl-body', m), items.length ? html`${items.map((c) => html`<button type="button" class="cust-pick" data-id="${c.id}">
                <span class="avatar">${initials(c.name)}</span>
                <span class="cust-pick-main"><b>${c.name}</b><small>${c.phone}${c.city ? ' · ' + c.city : ''}</small></span>
                ${c.total_outstanding > 0 ? html`<span class="cust-pick-due">${inr(c.total_outstanding)} due</span>` : ''}
              </button>`)}` : empty('No customers found', 'Try another name or number — or type a new number to add the customer.'));
              $$('.cust-pick', m).forEach((b) => b.addEventListener('click', () => {
                st.customer = items.find((c) => String(c.id) === b.dataset.id);
                st.newCustomer = null;
                close();
                renderCustomer();
              }));
            } catch (err) { toast(err.message, 'error'); }
          };
          $('#cl-search', m).addEventListener('input', debounce((e) => load(e.target.value.trim()), 200));
          load();
        },
      });
    }

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
        <div class="row"><input id="cust-phone" inputmode="numeric" placeholder="10-digit mobile number" style="max-width:280px"><button class="btn" id="find-cust">Find customer</button>
          <button type="button" class="btn" id="cust-list">${icon('customers')} Customer list</button></div>
        <div class="hint">Type the 10-digit number and the customer is found automatically. New numbers can be added on the spot.</div>
        <div class="form-error" id="cust-error"></div></div>`);
      let searching = false;
      const find = async () => {
        const phone = $('#cust-phone', custBox).value.replace(/\D/g, '');
        if (phone.length < 10) { $('#cust-error', custBox).textContent = 'Enter the 10-digit mobile number'; return; }
        if (searching) return;
        searching = true;
        try { st.customer = await api.get('/api/customers/lookup', { phone }); }
        catch (err) { searching = false; if (err.status === 404) st.newCustomer = { phone: phone.slice(-10) }; else { $('#cust-error', custBox).textContent = err.message; return; } }
        renderCustomer();
      };
      $('#find-cust', custBox).onclick = find;
      $('#cust-list', custBox).onclick = () => openCustomerPicker();
      $('#cust-phone', custBox).addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
      // Search by itself as soon as a full 10-digit number is in the box.
      $('#cust-phone', custBox).addEventListener('input', (e) => {
        $('#cust-error', custBox).textContent = '';
        if (e.target.value.replace(/\D/g, '').length >= 10) find();
      });
    }
    renderCustomer();

    // ---- product lines
    // Every line starts from the catalogue product; whatever the shopkeeper changes is kept in `edits`
    // and applies to this order only. Only edits are sent, so untouched values follow the catalogue / today's rate.
    const PURITIES = ['24K', '22K', '18K'];
    const rateOf = (purity) => rates.find((r) => r.purity === purity)?.rate_per_gram ?? '';
    const productOf = (l) => products.find((p) => String(p.id) === String(l.product_id));
    const defaultsOf = (l) => {
      const p = productOf(l);
      const purity = l.edits.purity ?? p.purity;
      return { name: p.name, description: '', purity: p.purity, gross_weight: p.gross_weight, stone_weight: p.stone_weight, making_rate: p.making_charge, gold_rate: rateOf(purity) };
    };
    const valueOf = (l, key) => (l.edits[key] !== undefined ? l.edits[key] : defaultsOf(l)[key]);
    const netOf = (l) => Math.round((Number(valueOf(l, 'gross_weight')) - Number(valueOf(l, 'stone_weight'))) * 1000) / 1000;
    const NUMERIC = ['gross_weight', 'stone_weight', 'making_rate', 'gold_rate'];
    function setEdit(l, key, value) {
      const def = defaultsOf(l)[key];
      const same = NUMERIC.includes(key) ? Number(value) === Number(def) : String(value).trim() === String(def);
      if (same || value === '') delete l.edits[key]; else l.edits[key] = value;
    }

    const summaryOf = (l) => `${netOf(l).toFixed(3)} g net · ${inr(Number(valueOf(l, 'gold_rate')) || 0)}/g · making ${inr(Number(valueOf(l, 'making_rate')) || 0)}/g`;
    const linesBox = $('#lines-box', el);
    const lineField = (l, key, label) => html`<div class="field"><label>${label}</label>
      <input data-e="${key}" type="number" min="0" step="${key === 'gold_rate' || key === 'making_rate' ? 1 : 0.001}" value="${valueOf(l, key)}"></div>`;
    function renderLines() {
      mount(linesBox, html`${st.lines.map((l, i) => {
        const chosen = productOf(l);
        return html`<div class="line-card" data-i="${i}">
          <div class="line-row">
            <div class="field"><label>${st.lines.length > 1 ? `Item ${i + 1}` : 'Product'}</label>
              <button type="button" class="product-picker-btn" data-pick>
                ${chosen ? html`<img class="thumb" src="${chosen.image}" alt=""><span>${chosen.name}</span>` : html`<span class="muted">Select a product…</span>`}
              </button></div>
            <div class="field"><label>Qty</label><input data-f="quantity" type="number" min="1" max="20" value="${l.quantity}"></div>
            <button class="icon-btn" data-remove title="Remove item" ${st.lines.length === 1 ? 'disabled' : ''}>×</button>
          </div>
          ${chosen ? html`<details class="item-details" ${onPhone ? '' : 'open'}>
            <summary>Edit item details <span class="muted small" data-summary>${summaryOf(l)}</span></summary>
            <div class="item-fields">
              <div class="field span"><label>Item name (as on the bill)</label><input data-e="name" value="${valueOf(l, 'name')}"></div>
              <div class="field span"><label>Description</label><textarea data-e="description" rows="2" placeholder="Optional — design, size, remarks…">${valueOf(l, 'description')}</textarea></div>
              <div class="field"><label>Purity</label><select data-e="purity">${PURITIES.map((x) => html`<option ${x === valueOf(l, 'purity') ? 'selected' : ''}>${x}</option>`)}</select></div>
              ${lineField(l, 'gold_rate', 'Gold rate (₹/g)')}
              ${lineField(l, 'gross_weight', 'Gross weight (g)')}
              ${lineField(l, 'stone_weight', 'Stone weight (g)')}
              <div class="field"><label>Net gold weight (g)</label><input data-net readonly value="${netOf(l).toFixed(3)}"></div>
              ${lineField(l, 'making_rate', 'Making charge (₹/g)')}
            </div>
          </details>
          <div class="hint" data-hint></div>` : ''}
        </div>`;
      })}`);
      updateHints();
      $$('.line-card', linesBox).forEach((card) => {
        const i = Number(card.dataset.i);
        const l = st.lines[i];
        $('[data-pick]', card).addEventListener('click', () => {
          openProductPicker({
            selectedId: Number(l.product_id) || null,
            onPick: (id) => { l.product_id = id; l.edits = {}; renderLines(); recalc(); },
          });
        });
        $('[data-f=quantity]', card).addEventListener('input', (e) => { l.quantity = Math.max(1, Number(e.target.value) || 1); recalc(); });
        $('[data-remove]', card).addEventListener('click', () => { st.lines.splice(i, 1); renderLines(); recalc(); });
        $$('[data-e]', card).forEach((input) => {
          const onEdit = () => {
            setEdit(l, input.dataset.e, input.value);
            const net = $('[data-net]', card);
            if (net) net.value = netOf(l).toFixed(3);
            const sum = $('[data-summary]', card);
            if (sum) sum.textContent = summaryOf(l);
            if (input.dataset.e === 'purity' && l.edits.gold_rate === undefined) $('[data-e=gold_rate]', card).value = valueOf(l, 'gold_rate');
            recalcSoon();
          };
          input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', onEdit);
        });
      });
    }
    // Per-line hints (stock) are filled in place so typing is never interrupted.
    function updateHints() {
      let k = 0;
      $$('.line-card', linesBox).forEach((card) => {
        const l = st.lines[Number(card.dataset.i)];
        const pl = l.product_id ? st.preview?.lines?.[k++] : null;
        const hint = $('[data-hint]', card);
        if (hint) hint.textContent = pl ? `${pl.available} available in stock${pl.shortage ? ' — not enough stock for this order' : ''}${pl.edited ? ' · edited for this order' : ''}` : '';
      });
    }
    $('#add-line', el).onclick = () => {
      const i = st.lines.push({ product_id: '', quantity: 1, edits: {} }) - 1;
      renderLines();
      openProductPicker({ selectedId: null, onPick: (id) => { st.lines[i].product_id = id; renderLines(); recalc(); } });
    };
    renderLines();

    // ---- live pricing (always computed by the server, so it matches what will be saved)
    const figures = $('#summary-figures', el);
    const payload = () => ({
      items: st.lines.filter((l) => l.product_id).map((l) => {
        const item = { product_id: Number(l.product_id), quantity: Number(l.quantity) || 1 };
        for (const [key, value] of Object.entries(l.edits)) {
          if (NUMERIC.includes(key)) { if (value !== '' && Number.isFinite(Number(value))) item[key] = Number(value); }
          else item[key] = value;
        }
        return item;
      }),
      other_charges: $('#f-other', el).value === '' ? null : Number($('#f-other', el).value),
    });
    let seq = 0;
    async function recalc() {
      const body = payload();
      if (!body.items.length) { st.preview = null; mount(figures, html`<div class="muted">Choose a product to see the price.</div>`); updateBalance(); return; }
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
      $('#rate-note', el).textContent = `Today: ${[...new Set(p.lines.map((l) => `${l.purity} ${inr(l.gold_rate)}/g`))].join(' · ')}`;
      mount(figures, html`
        ${p.lines.map((l) => html`<div class="line-detail" style="margin-bottom:10px">
          <div class="prod-cell"><img class="thumb" src="${l.image}" alt=""><button type="button" class="link-btn cell-main" data-view-product="${l.product_id}">${l.name}</button>${l.quantity > 1 ? ` × ${l.quantity}` : ''}</div>
          <div class="kv sub"><span class="k">Gold: ${grams(l.net_weight_total)} × ${perGram(l.gold_rate)}</span><span class="v">${inr(l.gold_value)}</span></div>
          <div class="kv sub"><span class="k">Making: ${grams(l.net_weight_total)} × ${perGram(l.making_rate)}</span><span class="v">${inr(l.making_charge)}</span></div></div>`)}
        <div class="kv"><span class="k">Gold value</span><span class="v">${inr(t.gold_value)}</span></div>
        <div class="kv"><span class="k">Making charge</span><span class="v">${inr(t.making_charge)}</span></div>
        <div class="kv"><span class="k">GST @ ${p.gst_rate}%</span><span class="v">${inr(t.gst)}</span></div>
        ${t.other_charges ? html`<div class="kv"><span class="k">Other charges</span><span class="v">${inr(t.other_charges)}</span></div>` : ''}
        <div class="kv total"><span class="k">Total</span><span class="v">${inr(t.total)}</span></div>
        <div class="muted small" style="margin-top:8px">Total = gold + making + GST on both${t.other_charges ? ' + other charges' : ''}. ${isSale ? '' : 'The price is locked when the order is placed.'}</div>
        ${p.lines.some((l) => l.shortage) ? html`<div class="notice warn" style="margin-top:10px">Not enough stock for one of the items. Restock it in Inventory first.</div>` : ''}`);
      $$('[data-view-product]', figures).forEach((b) => b.addEventListener('click', () => openProductDetail(Number(b.dataset.viewProduct))));
      updateBalance();
    }
    const total = () => st.preview?.totals.total;
    function updateBalance() {
      const t = total();
      const adv = isSale ? t : Number($('#f-adv', el).value) || 0;
      $('#balance', el).textContent = t == null ? '—' : inr(isSale ? t : Math.max(t - adv, 0));
      $('#bar-total', el).textContent = t == null ? '—' : inr(t);
      $('#bar-sub', el).textContent = t == null ? '' : isSale ? 'Paid in full' : adv > 0 ? `Paying ${inr(adv)} now · balance ${inr(Math.max(t - adv, 0))}` : 'Nothing paid now';
    }
    if (!isSale) {
      $('#f-adv', el).addEventListener('input', updateBalance);
      $('#pay-full', el).onclick = (e) => { e.preventDefault(); if (total() != null) { $('#f-adv', el).value = total(); updateBalance(); } };
    }
    const recalcSoon = debounce(recalc, 300);
    $('#f-other', el).addEventListener('input', recalcSoon);
    if (st.lines[0].product_id) recalc();

    // ---- preview: a full-screen view of the bill / order slip exactly as it stands right now (nothing is saved)
    let shopCache = null;
    async function openPreview() {
      if (!st.preview) { toast('Add at least one product to preview the bill', 'error'); return; }
      try { shopCache ||= (await api.get('/api/settings')).values; } catch (e) { toast(e.message, 'error'); return; }
      const shop = shopCache;
      const p = st.preview;
      const t = p.totals;
      const c = st.customer || { name: $('#nc-name', el)?.value.trim() || '', phone: st.newCustomer?.phone || '', address: $('#nc-addr', el)?.value.trim() || '', city: $('#nc-city', el)?.value.trim() || '' };
      const delivery = isSale ? null : $('#f-delivery', el).value;
      const method = $('#f-method', el).value;
      const paidNow = isSale ? t.total : Math.min(Number($('#f-adv', el)?.value) || 0, t.total);
      const otherNote = $('#f-other-note', el).value.trim();
      const rates = [...new Set(p.lines.map((l) => `${l.purity} ${inr(l.gold_rate)}/g`))].join(' · ');
      const cgst = t.gst / 2;
      const view = { tab: 'bill' };

      const itemsTable = (slip) => html`<table class="inv-table">
        <thead><tr><th>Item</th><th>Purity</th><th class="num">Gross wt</th><th class="num">Stone wt</th><th class="num">Net gold wt</th><th class="num">Gold rate</th><th class="num">Gold value</th><th class="num">Making charge</th></tr></thead>
        <tbody>${p.lines.map((l) => html`<tr>
          <td><b>${l.name}</b>${l.quantity > 1 ? ` × ${l.quantity}` : ''}${l.description ? html`<div class="inv-small" style="margin:2px 0 0">${l.description}</div>` : ''}<div class="inv-small" style="margin:2px 0 0">SKU ${l.sku}</div></td>
          <td>${l.purity}</td><td class="num">${grams(l.gross_weight * l.quantity)}</td><td class="num">${grams(l.stone_weight * l.quantity)}</td>
          <td class="num"><b>${grams(l.net_weight_total)}</b></td><td class="num">${perGram(l.gold_rate)}</td><td class="num">${inr2(l.gold_value)}</td>
          <td class="num">${inr2(l.making_charge)}<div class="inv-small" style="margin:2px 0 0">${perGram(l.making_rate)}</div></td></tr>`)}</tbody></table>`;

      const payBox = html`<div class="inv-box">
        <h5>Payment${isSale ? '' : ' (planned)'}</h5>
        ${paidNow > 0 ? html`<div class="kv"><span class="k">${isSale ? 'Paid in full' : 'Paid now'} (${method})</span><span class="v">${inr2(paidNow)}</span></div>` : html`<div class="muted small">Nothing paid yet.</div>`}
        <div class="kv total" style="margin-top:8px"><span class="k">Balance due</span><span class="v">${inr2(Math.max(t.total - paidNow, 0))}</span></div>
      </div>`;

      const billView = () => html`<article class="invoice">
        <header class="inv-head">
          <div><div class="inv-shop">${shop.shop_name}</div><div class="inv-tag">${shop.shop_tagline}</div>
            <div class="inv-small" style="margin-top:8px">${shop.shop_address}<br>Phone: ${shop.shop_phone} · GSTIN: ${shop.shop_gstin}</div></div>
          <div class="inv-title"><h2>${isSale ? 'BILL — PREVIEW' : 'ORDER ESTIMATE'}</h2>
            <div style="margin-top:8px"><b>Not saved yet</b></div><div class="inv-small">Prepared ${fmtDate(todayIso())}</div></div>
        </header>
        <section class="inv-meta">
          <div><h5>Billed to</h5>${c.name || c.phone ? html`<div class="bold" style="font-size:15px">${c.name || '—'}</div><div>Phone: ${c.phone || '—'}</div>${c.address || c.city ? html`<div>${[c.address, c.city].filter(Boolean).join(', ')}</div>` : ''}` : html`<div class="muted">Customer not selected yet</div>`}</div>
          <div><h5>${isSale ? 'Sale details' : 'Order details'}</h5>
            <div>${isSale ? 'Sale date' : 'Order date'}: ${fmtDate(todayIso())}</div>${delivery ? html`<div>Delivery date: ${fmtDate(delivery)}</div>` : ''}
            <div>Gold rate today: ${rates}</div></div>
        </section>
        ${itemsTable(false)}
        <div class="inv-cols">
          ${payBox}
          <div class="inv-box">
            <h5>Amount</h5>
            <div class="kv"><span class="k">Gold value</span><span class="v">${inr2(t.gold_value)}</span></div>
            <div class="kv"><span class="k">Making charges</span><span class="v">${inr2(t.making_charge)}</span></div>
            ${t.other_charges ? html`<div class="kv"><span class="k">Other charges${otherNote ? ` (${otherNote})` : ''}</span><span class="v">${inr2(t.other_charges)}</span></div>` : ''}
            <div class="kv"><span class="k">CGST @ ${p.gst_rate / 2}%</span><span class="v">${inr2(cgst)}</span></div>
            <div class="kv"><span class="k">SGST @ ${p.gst_rate / 2}%</span><span class="v">${inr2(t.gst - cgst)}</span></div>
            <div class="inv-total"><span>Total amount</span><span>${inr2(t.total)}</span></div>
          </div>
        </div>
        <p class="inv-small"><b>How the total is worked out:</b> gold value (net weight × gold rate) + making charge (net weight × making rate) + GST @ ${p.gst_rate}% on both${t.other_charges ? ' + other charges' : ''}. ${isSale ? '' : 'The gold rate is fixed on the order date.'}</p>
      </article>`;

      const slipView = () => html`<article class="invoice">
        <header class="inv-head">
          <div><div class="inv-shop">Order Slip</div><div class="inv-tag">Internal use — workshop / delivery copy</div></div>
          <div class="inv-title"><h2>PREVIEW</h2><div class="inv-small" style="margin-top:6px">${isSale ? 'Sale date' : 'Order date'}: ${fmtDate(todayIso())}</div>
            ${delivery ? html`<div class="inv-small">Delivery date: ${fmtDate(delivery)}</div>` : ''}</div>
        </header>
        ${itemsTable(true)}
        <div class="inv-cols">
          ${payBox}
          <div class="inv-box"><h5>Amount</h5>
            <div class="kv"><span class="k">Gold value</span><span class="v">${inr2(t.gold_value)}</span></div>
            <div class="kv"><span class="k">Making charges</span><span class="v">${inr2(t.making_charge)}</span></div>
            <div class="kv"><span class="k">GST @ ${p.gst_rate}%</span><span class="v">${inr2(t.gst)}</span></div>
            ${t.other_charges ? html`<div class="kv"><span class="k">Other charges</span><span class="v">${inr2(t.other_charges)}</span></div>` : ''}
            <div class="inv-total"><span>Total</span><span>${inr2(t.total)}</span></div></div>
        </div>
        <div class="inv-foot"><div class="inv-small" style="margin:0;max-width:430px">Internal order slip for workshop and delivery use. Deliberately excludes customer name, address and phone number.</div></div>
      </article>`;

      openModal({
        title: 'Preview',
        size: 'full',
        content: html`<div class="preview-bar no-print">
            <div class="chips" id="pv-tabs"><button type="button" class="chip on" data-tab="bill">${isSale ? 'Bill' : 'Estimate'}</button><button type="button" class="chip" data-tab="slip">Order slip</button></div>
            <button type="button" class="btn btn-primary btn-sm" id="pv-print">${icon('print')} Print / Save as PDF</button>
          </div>
          <div class="notice warn no-print" style="margin-bottom:14px">Preview only — nothing is saved until you ${isSale ? 'create the bill' : 'place the order'}.</div>
          <div class="invoice-wrap" id="pv-body"></div>`,
        onOpen: (m) => {
          const draw = () => mount($('#pv-body', m), view.tab === 'bill' ? billView() : slipView());
          draw();
          $$('#pv-tabs .chip', m).forEach((b) => b.addEventListener('click', () => {
            view.tab = b.dataset.tab;
            $$('#pv-tabs .chip', m).forEach((x) => x.classList.toggle('on', x === b));
            draw();
          }));
          $('#pv-print', m).addEventListener('click', () => {
            document.body.classList.add('print-modal');
            window.addEventListener('afterprint', () => document.body.classList.remove('print-modal'), { once: true });
            window.print();
          });
        },
      });
    }
    $('#preview-btn', el).onclick = openPreview;

    // ---- submit
    const submit = async () => {
      const err = $('#order-error', el);
      err.textContent = '';
      const btns = $$('#submit-btn, #bar-submit', el);
      try {
        const body = payload();
        if (!body.items.length) throw new Error('Add at least one product');
        if (st.customer) body.customer_id = st.customer.id;
        else if (st.newCustomer) {
          const name = $('#nc-name', el)?.value.trim();
          if (!name) throw new Error('Enter the new customer\'s name');
          body.customer = { name, phone: st.newCustomer.phone, city: $('#nc-city', el).value.trim(), address: $('#nc-addr', el).value.trim(), is_premium: $('#nc-premium', el).checked };
        } else throw new Error('Find the customer by phone number first');
        body.other_charges_note = $('#f-other-note', el).value;
        const method = $('#f-method', el).value;
        const reference_number = $('#f-ref', el).value;
        btns.forEach((b) => { b.disabled = true; });
        if (isSale) {
          body.payment = { payment_method: method, reference_number };
          const res = await api.post('/api/sales', body);
          toast(`Bill ${res.bill.bill_number} created — ${inr(res.order.total_amount)} received`);
          navigate(`/bills/${res.bill.id}`);
        } else {
          body.expected_delivery_date = $('#f-delivery', el).value;
          body.notes = $('#f-notes', el).value;
          const adv = Number($('#f-adv', el).value) || 0;
          if (adv > 0) body.payment = { amount: adv, payment_method: method, reference_number };
          const res = await api.post('/api/orders', body);
          toast(`Order ${res.order.order_number} placed${adv ? ` — ${inr(adv)} received` : ''}`);
          navigate(`/orders/${res.order.id}`);
        }
      } catch (e) {
        err.textContent = e.message;
        if (onPhone) toast(e.message, 'error'); // the inline message can be off-screen behind the sticky bar
        btns.forEach((b) => { b.disabled = false; });
      }
    };
    $('#submit-btn', el).onclick = submit;
    $('#bar-submit', el).onclick = submit;
  };
}
export const orderNewPage = newTransactionPage('order');
export const saleNewPage = newTransactionPage('sale');

// ============================================================== order detail
function kv(k, v, cls = '') { return html`<div class="kv ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`; }

/** One plain-language sentence telling the shop owner what to do next with this order. */
function nextStepText(o) {
  const due = o.outstanding_amount;
  switch (o.status) {
    case 'PLACED': return 'Next: accept the order to confirm it with the customer.';
    case 'ACCEPTED': return due > 0
      ? `Payment pending — ${inr(due)} still due. Mark the order ready when the piece is prepared.`
      : 'Paid in full. Mark the order ready when the piece is prepared.';
    case 'READY': return due > 0
      ? `Ready — collect ${inr(due)} when the customer arrives, then deliver.`
      : 'Ready and paid in full — hand it over to deliver.';
    case 'DELIVERED': return 'Delivered — the final bill has been generated.';
    default: return '';
  }
}

export async function orderDetailPage({ el, params, isCurrent }) {
  const id = params[0];
  const data = await api.get(`/api/orders/${id}`);
  if (!isCurrent()) return;
  const { order: o, customer: c, items, payments, price, events, stock_movements: moves, bill, actions } = data;
  const has = (a) => actions.includes(a);
  const flowIdx = STATUS_FLOW.indexOf(o.status);
  const statusActions = ['accept', 'mark_ready', 'deliver', 'unmark_ready', 'cancel'].filter(has);

  mount(el, html`
    <div class="crumb"><a href="#/orders">Orders</a> / ${o.order_number}</div>
    <div class="order-head">
      <div>
        <div class="order-title"><h1>${o.order_number}</h1>${statusBadge(o.status)}${o.status === 'CANCELLED' ? '' : paymentBadge(o.payment_status)}${walkInTag(o)}</div>
        <div class="muted" style="margin-top:6px"><a href="#/customers/${c.id}" class="bold">${c.name}</a> · <a href="tel:${c.phone}">${c.phone}</a> · placed ${fmtDate(o.order_date)}</div>
      </div>
      <div class="page-actions">
        ${statusActions.length ? html`<div class="menu-wrap">
          <button type="button" class="btn ${o.status === 'READY' ? 'btn-gold' : 'btn-primary'}" id="status-menu-btn" aria-haspopup="menu" aria-expanded="false">Update status
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
          <div class="menu" id="status-menu" role="menu" hidden>
            ${has('accept') ? html`<button type="button" class="menu-item" role="menuitem" data-act="accept"><b>Accept order</b><small>Confirm it with the customer</small></button>` : ''}
            ${has('mark_ready') ? html`<button type="button" class="menu-item" role="menuitem" data-act="ready"><b>Mark ready for delivery</b><small>The piece is prepared</small></button>` : ''}
            ${has('deliver') ? html`<button type="button" class="menu-item" role="menuitem" data-act="deliver"><b>Deliver</b><small>${o.outstanding_amount > 0.005 ? `Collect ${inr(o.outstanding_amount)} first, then hand over` : 'Hand over and create the final bill'}</small></button>` : ''}
            ${has('unmark_ready') ? html`<button type="button" class="menu-item" role="menuitem" data-act="unready"><b>Undo ready</b><small>Move it back to Accepted</small></button>` : ''}
            ${has('cancel') ? html`<div class="menu-sep"></div><button type="button" class="menu-item danger" role="menuitem" data-act="cancel"><b>Cancel order</b><small>Release the reserved stock</small></button>` : ''}
          </div></div>` : ''}
        ${has('view_bill') && bill ? html`<a class="btn btn-primary" href="#/bills/${bill.id}">View Final Bill</a>` : ''}
        ${has('add_payment') ? html`<button class="btn" data-act="pay">Record Payment</button>` : ''}
        ${has('edit_delivery_date') ? html`<button class="btn" data-act="edit-delivery">Change Delivery Date</button>` : ''}
        <a class="btn" href="#/orders/${o.id}/slip">${icon('print')} Order Slip</a>
      </div>
    </div>

    ${o.status === 'CANCELLED' ? html`<div class="notice warn" style="margin-top:16px"><b>Cancelled</b> ${fmtDate(o.cancelled_at)}${o.cancel_reason ? ' — ' + o.cancel_reason : ''}. Reserved stock was released.${o.paid_amount > 0 ? ` ${inr(o.paid_amount)} received earlier remains in the payment history below and needs to be refunded or adjusted.` : ''}</div>` :
      html`<div class="notice next-step" style="margin-top:16px">${nextStepText(o)}</div>
      <div class="card card-body" style="margin-top:12px"><div class="flow">${STATUS_FLOW.map((k, i) => html`<div class="flow-step ${i < flowIdx || o.status === 'DELIVERED' ? 'done' : ''} ${i === flowIdx && o.status !== 'DELIVERED' ? 'now' : ''}" data-label="Step ${i + 1} of ${STATUS_FLOW.length} · ${statusLabel(k)}">${statusLabel(k)}</div>`)}</div></div>`}

    <div class="kpis order-kpis" style="margin-top:18px">
      <div class="kpi"><div class="kpi-label">Order total</div><div class="kpi-value">${inr(o.total_amount)}</div><div class="kpi-note">price locked at ${perGram(o.order_gold_rate)} on ${fmtDate(o.order_date, false)}</div></div>
      <div class="kpi"><div class="kpi-label">Paid so far</div><div class="kpi-value" style="color:var(--green)">${inr(o.paid_amount)}</div><div class="kpi-note">${payments.length} payment${payments.length === 1 ? '' : 's'}</div></div>
      <div class="kpi ${o.outstanding_amount > 0 ? 'hero' : ''}"><div class="kpi-label">Balance due</div><div class="kpi-value">${inr(o.outstanding_amount)}</div>
        <div class="kpi-note">${o.status === 'CANCELLED' ? 'cancelled' : o.outstanding_amount > 0 ? paymentBadge(o.payment_status) : 'Paid in full ✓'}</div></div>
      <div class="kpi"><div class="kpi-label">${o.actual_delivery_date ? 'Delivered on' : 'Delivery date'}</div><div class="kpi-value" style="font-size:19px">${fmtDate(o.actual_delivery_date || o.expected_delivery_date)}</div>
        <div class="kpi-note">${deliveryNote(o)}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Items</h2></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Product</th><th>SKU · Barcode</th><th>Purity</th><th class="num">Qty</th><th class="num">Gross</th><th class="num">Stone</th><th class="num">Net gold</th></tr></thead>
        <tbody>${items.map((i) => html`<tr>
          <td><div class="prod-cell"><img class="thumb" src="${i.image}" alt=""><div><button type="button" class="link-btn cell-main" data-view-product="${i.product_id}">${i.product_name}</button>${i.description ? html`<div class="cell-sub">${i.description}</div>` : ''}</div></div></td>
          <td><span class="mono">${i.sku}</span><div class="cell-sub mono">${i.barcode || ''}</div></td>
          <td>${i.purity} ${i.metal_type}</td><td class="num">${i.quantity}</td>
          <td class="num">${grams(i.gross_weight * i.quantity)}</td><td class="num">${grams(i.stone_weight * i.quantity)}</td>
          <td class="num bold">${grams(i.net_weight_total)}</td></tr>`)}</tbody></table></div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-head"><h2>Price</h2><span class="muted small">Locked on the order date — later gold-rate changes do not affect it</span></div>
      <div class="card-body">
        ${price.lines.map((l) => html`<div style="margin-bottom:12px">
          <div class="cell-main">${l.name}${l.quantity > 1 ? ` × ${l.quantity}` : ''}</div>
          ${kv(`Gold: ${grams(l.net_weight)} × ${perGram(l.gold_rate)}`, inr(l.gold_value), 'sub')}
          ${kv(`Making: ${grams(l.net_weight)} × ${perGram(l.making_rate)}`, inr(l.making_charge), 'sub')}
          ${kv(`GST @ ${price.gst_rate}%`, inr(l.gst), 'sub')}</div>`)}
        ${price.other_charges ? kv(`Other charges${price.other_charges_note ? ` (${price.other_charges_note})` : ''}`, inr(price.other_charges)) : ''}
        ${kv('Order total', inr(price.total), 'total')}
        ${kv('Paid', '− ' + inr(o.paid_amount), 'credit')}
        ${o.status === 'CANCELLED' ? '' : kv('Balance due', inr(o.outstanding_amount), `due ${o.outstanding_amount <= 0.005 ? 'zero' : ''}`)}
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-head"><h2>Payments</h2><span class="muted small">Records are never edited or removed.</span></div>
      ${payments.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>Payment</th><th>Date</th><th>Type</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th>Notes</th></tr></thead>
        <tbody>${payments.map((p) => html`<tr><td class="mono">PAY-${String(p.id).padStart(4, '0')}</td><td class="nowrap">${fmtDate(p.payment_date)}</td><td>${p.kind}</td><td>${p.payment_method}</td>
          <td class="mono">${p.reference_number || '—'}</td><td class="num bold">${inr(p.amount)}</td><td>${p.notes || ''}</td></tr>`)}</tbody>
        <tfoot><tr><td colspan="5">Total paid</td><td class="num">${inr(o.paid_amount)}</td><td></td></tr></tfoot></table></div>` : empty('No payments recorded yet')}
    </div>

    <div class="grid cols-2" style="margin-top:18px">
      <details class="card fold" ${window.matchMedia('(max-width: 767px)').matches ? '' : 'open'}><summary class="card-head"><h2>Activity</h2><span class="fold-chevron">›</span></summary><div class="card-body"><ul class="timeline">
        ${[...events].reverse().map((e) => html`<li class="${e.event_type}"><div>${e.message}</div><div class="when">${fmtDateTime(e.created_at)}</div></li>`)}</ul></div></details>
      <details class="card fold" ${window.matchMedia('(max-width: 767px)').matches ? '' : 'open'}><summary class="card-head"><h2>Stock impact</h2><span class="fold-chevron">›</span></summary>
        ${moves.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Product</th><th>Movement</th><th class="num">Change</th></tr></thead>
          <tbody>${moves.map((m) => html`<tr><td class="nowrap">${fmtDate(m.created_at, false)}</td><td>${m.product_name}</td><td>${moveBadge(m.movement_type)}</td>
            <td class="num">${m.counter === 'reserved' ? 'Reserved' : 'On hand'} ${m.previous_quantity} → ${m.new_quantity}</td></tr>`)}</tbody></table></div>` : empty('No stock movements', 'Stock is reserved when the order is placed.')}
        ${o.notes ? html`<div class="card-body" style="border-top:1px solid var(--line-2)"><div class="muted small">Order notes</div><div>${o.notes}</div></div>` : ''}
      </details>
    </div>`);

  // ---- actions
  const act = (name) => $(`[data-act=${name}]`, el);
  // The status dropdown: a small custom menu that closes on choosing, clicking elsewhere or Escape.
  const menuBtn = $('#status-menu-btn', el);
  const menu = $('#status-menu', el);
  if (menuBtn) {
    const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside); document.removeEventListener('keydown', onKey); };
    const outside = (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); } };
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!menu.hidden) return closeMenu();
      menu.hidden = false;
      menuBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', outside);
      document.addEventListener('keydown', onKey);
    });
    menu.addEventListener('click', () => closeMenu());
  }
  act('pay')?.addEventListener('click', () => openPaymentModal(data));
  act('deliver')?.addEventListener('click', () => openDeliverModal(data));
  act('accept')?.addEventListener('click', () => post(`/api/orders/${o.id}/accept`, {}, 'Order accepted'));
  act('ready')?.addEventListener('click', () => post(`/api/orders/${o.id}/ready`, { ready: true }, 'Marked ready for delivery'));
  act('unready')?.addEventListener('click', () => post(`/api/orders/${o.id}/ready`, { ready: false }, 'Ready mark removed'));
  act('edit-delivery')?.addEventListener('click', () => openEditDeliveryDateModal(data));
  act('cancel')?.addEventListener('click', () => openCancelModal(data));
  $$('[data-view-product]', el).forEach((b) => b.addEventListener('click', () => openProductDetail(Number(b.dataset.viewProduct), { onSaved: refresh })));
}

async function post(url, body, okMessage) {
  try { await api.post(url, body); toast(okMessage); refresh(); } catch (e) { toast(e.message, 'error'); }
}

function openPaymentModal(data) {
  const { order: o } = data;
  const due = o.outstanding_amount;
  openModal({
    title: `Record payment · ${o.order_number}`,
    content: html`<form class="form-grid">
      <div class="notice full" style="grid-column:1/-1">Balance due: <b>${inr(due)}</b> of ${inr(o.total_amount)}.</div>
      <div class="field full"><label for="p-amount">Amount received (₹)</label>
        <div class="input-group"><span>₹</span><input id="p-amount" name="amount" type="number" min="1" step="0.01" max="${due}" value="" required></div>
        <div class="hint"><a href="#" id="p-full">Pay the full balance (${inr(due)})</a></div></div>
      <div class="field"><label for="p-method">Payment method</label><select id="p-method" name="payment_method">${methodOptions('UPI')}</select></div>
      <div class="field"><label for="p-date">Payment date</label><input id="p-date" name="payment_date" type="date" value="${todayIso()}" min="${o.order_date}" max="${todayIso()}"></div>
      <div class="field full"><label for="p-ref">Reference number</label><input id="p-ref" name="reference_number" placeholder="UPI ref, card auth code, cheque no."></div>
      <div class="field full"><label for="p-notes">Notes</label><input id="p-notes" name="notes"></div>
      <div class="form-error full" style="grid-column:1/-1"></div>
      <div class="modal-actions full" style="grid-column:1/-1"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save payment</button></div>
    </form>`,
    onOpen: (m, close) => {
      $('#p-full', m).onclick = (e) => { e.preventDefault(); $('#p-amount', m).value = due; };
      onSubmit($('form', m), async (v) => {
        await api.post(`/api/orders/${o.id}/payments`, v);
        close();
        toast(`Payment of ${inr(Number(v.amount))} recorded`);
        refresh();
      });
    },
  });
}

function openDeliverModal(data) {
  const { order: o } = data;
  const due = o.outstanding_amount;
  openModal({
    title: `Deliver · ${o.order_number}`,
    content: html`<form>
      <div class="card" style="box-shadow:none"><div class="card-body">
        ${kv('Order total', inr(o.total_amount))}
        ${kv('Already paid', '− ' + inr(o.paid_amount), 'credit')}
        ${kv('Balance to collect now', inr(due), `due ${due <= 0.005 ? 'zero' : ''}`)}
      </div></div>
      ${due > 0.005 ? html`<div class="form-grid" style="margin-top:14px">
        <div class="field"><label for="d-amount">Amount received now (₹)</label><div class="input-group"><span>₹</span><input id="d-amount" name="amount" type="number" step="0.01" min="0" max="${due}" value="${due}"></div>
          <div class="hint">The piece is handed over only when the balance is paid in full.</div></div>
        <div class="field"><label for="d-method">Payment method</label><select id="d-method" name="payment_method">${methodOptions('UPI')}</select></div>
        <div class="field full"><label for="d-ref">Reference number</label><input id="d-ref" name="reference_number"></div>
      </div>` : html`<p class="muted" style="margin-top:12px">Nothing more to collect.</p>`}
      <p class="muted small" style="margin-top:12px">On confirmation the order becomes <b>Delivered</b>, stock is reduced and the final bill is generated automatically.</p>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-gold" type="submit">${due > 0.005 ? 'Take payment & deliver' : 'Confirm delivery'}</button></div>
    </form>`,
    onOpen: (m, close) => onSubmit($('form', m), async (v) => {
      const amount = Number(v.amount) || 0;
      const body = {};
      if (amount > 0) body.payment = { amount, payment_method: v.payment_method, reference_number: v.reference_number };
      const res = await api.post(`/api/orders/${o.id}/deliver`, body);
      close();
      toast(`${o.order_number} delivered — final bill ${res.bill.bill_number} generated`);
      refresh();
    }),
  });
}

function openEditDeliveryDateModal(data) {
  const { order: o } = data;
  openModal({
    title: `Change delivery date · ${o.order_number}`,
    content: html`<form>
      <div class="field"><label for="dd-date">Delivery date</label><input id="dd-date" name="expected_delivery_date" type="date" value="${o.expected_delivery_date}" min="${o.order_date}" required></div>
      <div class="form-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save date</button></div>
    </form>`,
    onOpen: (m, close) => onSubmit($('form', m), async (v) => {
      await api.put(`/api/orders/${o.id}/delivery-date`, { expected_delivery_date: v.expected_delivery_date });
      close(); toast('Delivery date updated'); refresh();
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
  const { order: o, items, payments, price } = data;

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
          <div class="inv-small">${o.actual_delivery_date ? `Delivered: ${fmtDate(o.actual_delivery_date)}` : `Delivery date: ${fmtDate(o.expected_delivery_date)}`}</div>
        </div>
      </header>

      <table class="inv-table">
        <thead><tr><th>Item</th><th>Purity</th><th class="num">Gross wt</th><th class="num">Stone wt</th><th class="num">Net gold wt</th><th class="num">Gold rate</th><th class="num">Gold value</th><th class="num">Making charge</th></tr></thead>
        <tbody>${items.map((i) => html`<tr>
          <td><b>${i.product_name}</b>${i.quantity > 1 ? ` × ${i.quantity}` : ''}${i.description ? html`<div class="inv-small" style="margin:2px 0 0">${i.description}</div>` : ''}<div class="inv-small" style="margin:2px 0 0">SKU ${i.sku} · Barcode ${i.barcode || '—'}</div></td>
          <td>${i.purity} ${i.metal_type}</td><td class="num">${grams(i.gross_weight * i.quantity)}</td><td class="num">${grams(i.stone_weight * i.quantity)}</td>
          <td class="num"><b>${grams(i.net_weight_total)}</b></td>
          <td class="num">${perGram(i.gold_rate)}</td><td class="num">${inr2(i.gold_value)}</td>
          <td class="num">${inr2(i.making_charge)}</td></tr>`)}</tbody>
      </table>

      <div class="inv-cols">
        <div class="inv-box">
          <h5>Payments</h5>
          ${payments.length ? html`<table class="inv-table"><thead><tr><th>Date</th><th>Type</th><th>Method</th><th class="num">Amount</th></tr></thead>
            <tbody>${payments.map((p) => html`<tr><td>${fmtDate(p.payment_date)}</td><td>${p.kind}</td><td>${p.payment_method}</td><td class="num">${inr2(p.amount)}</td></tr>`)}</tbody></table>`
            : html`<div class="muted">No payments yet.</div>`}
          <div class="kv total" style="margin-top:8px"><span class="k">Total paid</span><span class="v">${inr2(o.paid_amount)}</span></div>
          <div class="kv sub"><span class="k">Balance due</span><span class="v">${inr2(o.outstanding_amount)}</span></div>
        </div>
        <div class="inv-box">
          <h5>Amount</h5>
          <div class="kv"><span class="k">Gold value</span><span class="v">${inr2(price.gold_value)}</span></div>
          <div class="kv"><span class="k">Making charges</span><span class="v">${inr2(price.making_charge)}</span></div>
          <div class="kv"><span class="k">GST @ ${price.gst_rate}%</span><span class="v">${inr2(price.gst)}</span></div>
          ${price.other_charges ? html`<div class="kv"><span class="k">Other charges</span><span class="v">${inr2(price.other_charges)}</span></div>` : ''}
          <div class="inv-total"><span>Order total</span><span>${inr2(o.total_amount)}</span></div>
        </div>
      </div>

      <div class="inv-foot">
        <div class="inv-small" style="margin:0;max-width:430px">Internal order slip for workshop and delivery use. Deliberately excludes customer name, address and phone number.</div>
        <div class="sign">Prepared by<br><span class="muted">RA Jewellers</span></div>
      </div>
    </article></div>`);

  $('#print-slip', el).addEventListener('click', () => window.print());
}
