import {
  $, $$, api, html, mount, inr, grams, fmtDate, statusBadge, empty, openModal, confirmDialog, onSubmit, toast, navigate, refresh, debounce,
  initials, waLink, icon,
} from '../lib.js';

// ---------------------------------------------------------------- add / edit
export function openCustomerForm({ customer = null, phone = '', onSaved } = {}) {
  const c = customer || { phone };
  openModal({
    title: customer ? 'Edit customer' : 'Add customer',
    size: 'wide',
    content: html`<form class="form-grid">
      <div class="field"><label for="c-name">Full name *</label><input id="c-name" name="name" value="${c.name || ''}" required></div>
      <div class="field"><label for="c-phone">Phone number *</label><input id="c-phone" name="phone" inputmode="numeric" value="${c.phone || ''}" required placeholder="10-digit mobile"></div>
      <div class="field"><label for="c-alt">Alternate phone</label><input id="c-alt" name="alternate_phone" inputmode="numeric" value="${c.alternate_phone || ''}"></div>
      <div class="field"><label for="c-city">City</label><input id="c-city" name="city" value="${c.city || ''}"></div>
      <div class="field full"><label for="c-addr">Address</label><input id="c-addr" name="address" value="${c.address || ''}"></div>
      <div class="field"><label for="c-dob">Date of birth</label><input id="c-dob" name="dob" type="date" value="${c.dob || ''}"></div>
      <div class="field"><label for="c-ann">Anniversary</label><input id="c-ann" name="anniversary" type="date" value="${c.anniversary || ''}"></div>
      <div class="field full"><label class="checkbox-label"><input id="c-premium" name="is_premium" type="checkbox" ${c.is_premium ? 'checked' : ''}> Premium customer</label></div>
      <div class="field full"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes">${c.notes || ''}</textarea></div>
      <div class="form-error full"></div>
      <div class="modal-actions full">
        ${customer ? html`<button type="button" class="btn btn-danger" id="c-delete" style="margin-right:auto">Delete</button>` : ''}
        <button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" type="submit">${customer ? 'Save changes' : 'Add customer'}</button>
      </div>
    </form>`,
    onOpen: (m, close) => {
      onSubmit($('form', m), async (v) => {
        const saved = customer ? await api.put(`/api/customers/${customer.id}`, v) : await api.post('/api/customers', v);
        close();
        toast(customer ? 'Customer updated' : `${saved.name} added`);
        if (onSaved) onSaved(saved); else navigate(`/customers/${saved.id}`);
        if (customer) refresh();
      });
      $('#c-delete', m)?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete customer', message: `Delete ${customer.name}? This only works for customers with no orders.`, confirmLabel: 'Delete', danger: true }))) return;
        try { await api.del(`/api/customers/${customer.id}`); close(); toast('Customer deleted'); navigate('/customers'); } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

// ------------------------------------------------------------------- list
export async function customersPage({ el, isCurrent }) {
  let owing = false;
  let text = '';
  mount(el, html`
    <div class="page-head dash-head">
      <div><h1>Customers</h1><div class="sub">Search by mobile number to open a profile with orders, bills and balance.</div></div>
      <div class="page-actions"><button class="btn btn-primary" id="add-customer">+ Add customer</button></div>
    </div>
    <div class="card">
      <div class="card-head">
        <div class="row" style="flex:1">
          <div class="field" style="flex:1;max-width:420px"><input id="cust-search" inputmode="search" placeholder="Enter phone number (e.g. 9876543210) or name" aria-label="Search customers" autofocus></div>
          <div class="chips"><button class="chip" id="owing-chip">Owes money</button></div>
        </div>
        <span class="muted small" id="cust-count"></span>
      </div>
      <div id="cust-table"></div>
    </div>`);

  async function load() {
    const { items } = await api.get('/api/customers', { q: text, has_outstanding: owing ? 1 : '', limit: 200 });
    if (!isCurrent()) return;
    $('#cust-count', el).textContent = `${items.length} customer${items.length === 1 ? '' : 's'}`;
    mount($('#cust-table', el), items.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>ID</th><th>Customer</th><th>Phone</th><th>City</th><th class="num">Orders</th><th class="num">Purchases</th><th class="num">Paid</th><th class="num">Outstanding</th></tr></thead>
      <tbody>${items.map((c) => html`<tr class="clickable" data-href="#/customers/${c.id}">
        <td class="mono">${c.display_id}</td>
        <td><a class="cell-main" href="#/customers/${c.id}">${c.name}</a>${c.is_premium ? html` <span class="badge yellow">Premium</span>` : ''}</td>
        <td>${c.phone}</td><td>${c.city || '—'}</td><td class="num">${c.total_orders}</td>
        <td class="num">${inr(c.total_purchases)}</td><td class="num">${inr(c.total_paid)}</td>
        <td class="num ${c.total_outstanding > 0 ? 'bold' : 'muted'}" style="${c.total_outstanding > 0 ? 'color:var(--maroon)' : ''}">${inr(c.total_outstanding)}</td>
      </tr>`)}</tbody></table></div>` : empty('No customers found', text ? 'Press Enter with a full 10-digit number to add them.' : ''));
    $$('tr[data-href]', el).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; }));
  }
  $('#cust-search', el).addEventListener('input', debounce((e) => { text = e.target.value.trim(); load(); }, 220));
  $('#cust-search', el).addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const digits = e.target.value.replace(/\D/g, '');
    if (digits.length < 10) return;
    try { const c = await api.get('/api/customers/lookup', { phone: digits }); navigate(`/customers/${c.id}`); }
    catch { openCustomerForm({ phone: digits.slice(-10) }); }
  });
  $('#owing-chip', el).addEventListener('click', (e) => { owing = !owing; e.target.classList.toggle('on', owing); load(); });
  $('#add-customer', el).addEventListener('click', () => openCustomerForm());
  await load();
}

// ---------------------------------------------------------------- profile
export async function customerProfilePage({ el, params, isCurrent }) {
  const { customer: c, orders, bills, payments } = await api.get(`/api/customers/${params[0]}`);
  if (!isCurrent()) return;
  const reminder = `Namaste ${c.name}, this is RA Jewellers. `
    + (c.total_outstanding > 0 ? `A balance of ${inr(c.total_outstanding)} is pending on your order. Please let us know when you can visit. Thank you!` : 'Thank you for shopping with us!');

  mount(el, html`
    <div class="crumb"><a href="#/customers">Customers</a> / ${c.name}</div>
    <div class="card"><div class="card-body row spread" style="align-items:flex-start;gap:24px">
      <div class="row" style="align-items:flex-start;gap:16px"><div class="avatar lg">${initials(c.name)}</div>
        <div><h1>${c.name}${c.is_premium ? html` <span class="badge yellow">Premium</span>` : ''}</h1>
          <div class="muted" style="margin-top:4px">${c.display_id} · customer since ${fmtDate(c.created_at)}</div>
          <div style="margin-top:8px">${icon('phone', 15)} <a href="tel:${c.phone}" class="bold">${c.phone}</a>${c.alternate_phone ? html` · <a href="tel:${c.alternate_phone}">${c.alternate_phone}</a>` : ''}</div>
          <div class="muted" style="margin-top:2px">${[c.address, c.city].filter(Boolean).join(', ') || 'No address on file'}</div></div></div>
      <div class="page-actions">
        <a class="btn btn-primary" href="#/orders/new?customer=${c.id}">+ New Order</a>
        <a class="btn" href="#/billing/new?customer=${c.id}">+ New Bill</a>
        <a class="btn" target="_blank" rel="noopener" href="${waLink(c.phone, reminder)}">WhatsApp</a>
        <button class="btn" id="edit-customer">Edit</button>
      </div>
    </div></div>

    <div class="kpis" style="margin-top:18px">
      <div class="kpi"><div class="kpi-label">Total orders</div><div class="kpi-value">${c.total_orders}</div><div class="kpi-note">${c.open_orders} open</div></div>
      <div class="kpi"><div class="kpi-label">Total purchases</div><div class="kpi-value">${inr(c.total_purchases)}</div><div class="kpi-note">value of all orders</div></div>
      <div class="kpi"><div class="kpi-label">Total paid</div><div class="kpi-value" style="color:var(--green)">${inr(c.total_paid)}</div><div class="kpi-note">${payments.length} payment${payments.length === 1 ? '' : 's'}</div></div>
      <div class="kpi ${c.total_outstanding > 0 ? 'hero' : ''}"><div class="kpi-label">Total outstanding</div><div class="kpi-value">${inr(c.total_outstanding)}</div><div class="kpi-note">${c.total_outstanding > 0 ? 'to be collected' : 'nothing due'}</div></div>
    </div>

    <div class="tabs" id="cust-tabs">
      <button class="tab on" data-tab="orders">Order history<span class="n">${orders.length}</span></button>
      <button class="tab" data-tab="bills">Final bills<span class="n">${bills.length}</span></button>
      <button class="tab" data-tab="payments">Payments<span class="n">${payments.length}</span></button>
      <button class="tab" data-tab="details">Details</button>
    </div>

    <div data-panel="orders" class="card">${orders.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Order</th><th>Order date</th><th>Product</th><th class="num">Gold weight</th><th class="num">Order amount</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Delivery date</th><th>Status</th></tr></thead>
      <tbody>${orders.map((o) => html`<tr>
        <td><a class="cell-main" href="#/orders/${o.id}">${o.order_number}</a></td><td class="nowrap">${fmtDate(o.order_date)}</td><td>${o.products}</td>
        <td class="num nowrap">${grams(o.gold_weight)}</td><td class="num">${inr(o.total_amount)}</td><td class="num">${inr(o.paid_amount)}</td>
        <td class="num ${o.outstanding_amount > 0 ? 'bold' : 'muted'}">${inr(o.outstanding_amount)}</td>
        <td class="nowrap">${o.actual_delivery_date ? html`${fmtDate(o.actual_delivery_date)}<div class="cell-sub">delivered</div>` : o.expected_delivery_date ? html`${fmtDate(o.expected_delivery_date)}<div class="cell-sub">expected</div>` : '—'}</td>
        <td>${statusBadge(o.status)}</td></tr>`)}</tbody></table></div>` : empty('No orders yet', 'Start one with the button above.')}</div>

    <div data-panel="bills" class="card" hidden>${bills.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Bill no.</th><th>Bill date</th><th>Order</th><th>Product</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${bills.map((b) => html`<tr><td><a class="cell-main" href="#/bills/${b.id}">${b.bill_number}</a></td><td>${fmtDate(b.bill_date)}</td>
        <td><a href="#/orders/${b.order_id}">${b.order_number}</a></td><td>${b.products}</td><td class="num bold">${inr(b.total_amount)}</td>
        <td class="right"><a class="btn btn-sm" href="#/bills/${b.id}">View / Print</a></td></tr>`)}</tbody></table></div>`
      : empty('No final bills yet', 'A bill appears here as soon as an order is delivered or a walk-in bill is created.')}</div>

    <div data-panel="payments" class="card" hidden>${payments.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Date</th><th>Order</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead>
      <tbody>${payments.map((p) => html`<tr><td>${fmtDate(p.payment_date)}</td><td><a href="#/orders/${p.order_id}">${p.order_number}</a></td><td>${p.payment_method}</td>
        <td class="mono">${p.reference_number || '—'}</td><td class="num bold">${inr(p.amount)}</td></tr>`)}</tbody></table></div>` : empty('No payments yet')}</div>

    <div data-panel="details" class="card" hidden><div class="card-body meta-grid">
      ${[['Premium customer', c.is_premium ? 'Yes' : 'No'], ['Date of birth', c.dob ? fmtDate(c.dob) : '—'], ['Anniversary', c.anniversary ? fmtDate(c.anniversary) : '—'], ['Alternate phone', c.alternate_phone || '—'], ['City', c.city || '—'], ['Address', c.address || '—'], ['Notes', c.notes || '—']]
        .map(([k, v]) => html`<div class="meta"><div class="k">${k}</div><div class="v">${v}</div></div>`)}</div></div>`);

  $$('#cust-tabs .tab', el).forEach((tab) => tab.addEventListener('click', () => {
    $$('#cust-tabs .tab', el).forEach((t) => t.classList.toggle('on', t === tab));
    $$('[data-panel]', el).forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  }));
  $('#edit-customer', el).addEventListener('click', () => openCustomerForm({ customer: c }));
}
