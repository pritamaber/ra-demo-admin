import { $, $$, api, html, mount, inr, fmtDate, relDays, statusBadge, dueBadge, empty, waLink, perGram, toast } from '../lib.js';

const state = { sort: 'overdue', filter: 'all' };
const creditState = { sort: 'credit_due' };

const SORTS = [
  ['overdue', 'Overdue first'], ['delivery', 'Delivery date'], ['outstanding', 'Highest outstanding'],
  ['customer', 'Customer'], ['order_date', 'Order date (newest)'],
];

const CREDIT_SORTS = [
  ['credit_due', 'Repayment date'], ['outstanding', 'Highest value'], ['order_date', 'Order date (newest)'], ['customer', 'Customer'],
];

function reminder(o) {
  if (o.is_credit) {
    return `Namaste ${o.customer_name}, this is RA Jewellers. Your order ${o.order_number} was delivered on credit with ${inr(o.outstanding_amount)} still due`
      + `${o.credit_due_date ? `, payable by ${fmtDate(o.credit_due_date)}` : ''}. Please arrange the payment at your earliest. Thank you!`;
  }
  return `Namaste ${o.customer_name}, this is RA Jewellers. Your order ${o.order_number} has ${inr(o.outstanding_amount)} pending. `
    + `Delivery date: ${fmtDate(o.expected_delivery_date)}. Please let us know when you can visit. Thank you!`;
}

function outstandingRows(rows) {
  if (!rows.length) return empty('Nothing pending here', 'Try a different filter.');
  return html`<div class="table-wrap"><table class="tbl">
    <thead><tr>
      <th>Customer</th><th>Order</th><th>Delivery</th><th class="num">Due</th><th>Status</th>
    </tr></thead>
    <tbody>${rows.map((o) => html`<tr>
      <td><a class="cell-main" href="#/customers/${o.customer_id}">${o.customer_name}</a>
        <div class="cell-sub"><a href="tel:${o.customer_phone}">${o.customer_phone}</a> · <a target="_blank" rel="noopener" title="Send a WhatsApp reminder" href="${waLink(o.customer_phone, reminder(o))}">WhatsApp</a></div></td>
      <td><a class="nowrap" href="#/orders/${o.id}">${o.order_number}</a><div class="cell-sub">${o.products}</div></td>
      <td class="nowrap">${fmtDate(o.expected_delivery_date)}<div class="cell-sub">${relDays(o.days_to_delivery)}</div></td>
      <td class="num"><div class="bold" style="color:var(--maroon)">${inr(o.outstanding_amount)}</div><div class="cell-sub">of ${inr(o.total_amount)}</div></td>
      <td><div class="row" style="gap:4px">${dueBadge(o.due_flag)}${statusBadge(o.status)}</div></td>
    </tr>`)}</tbody>
  </table></div>`;
}

function creditRows(rows) {
  if (!rows.length) return empty('No credit outstanding', 'Nothing has been delivered on credit right now.');
  return html`<div class="table-wrap"><table class="tbl">
    <thead><tr>
      <th>Customer</th><th>Order</th><th>Repayment due</th><th class="num">Credit owed</th><th>Status</th>
    </tr></thead>
    <tbody>${rows.map((o) => html`<tr>
      <td><a class="cell-main" href="#/customers/${o.customer_id}">${o.customer_name}</a>
        <div class="cell-sub"><a href="tel:${o.customer_phone}">${o.customer_phone}</a> · <a target="_blank" rel="noopener" title="Send a WhatsApp reminder" href="${waLink(o.customer_phone, reminder(o))}">WhatsApp</a></div></td>
      <td><a class="nowrap" href="#/orders/${o.id}">${o.order_number}</a><div class="cell-sub">${o.products}</div></td>
      <td class="nowrap">${o.credit_due_date ? html`${fmtDate(o.credit_due_date)}<div class="cell-sub">${relDays(o.days_to_credit_due)}</div>` : html`<span class="muted">not set</span>`}</td>
      <td class="num"><div class="bold" style="color:var(--maroon)">${inr(o.outstanding_amount)}</div><div class="cell-sub">of ${inr(o.total_amount)}</div></td>
      <td><div class="row" style="gap:4px">${dueBadge(o.due_flag)}${statusBadge(o.status)}</div></td>
    </tr>`)}</tbody>
  </table></div>`;
}

export async function dashboardPage({ el, isCurrent }) {
  const d = await api.get('/api/dashboard');
  if (!isCurrent()) return;
  const k = d.kpis;
  const all = d.outstanding;
  const counts = {
    all: all.length,
    overdue: all.filter((o) => o.due_flag === 'OVERDUE').length,
    due: all.filter((o) => o.due_flag === 'DUE_TODAY' || o.due_flag === 'DUE_SOON').length,
    ready: all.filter((o) => o.is_ready).length,
  };
  const rahul = all.find((o) => o.customer_phone === '9876543210');
  const rate22 = d.gold_rates.find((r) => r.purity === '22K');

  const today = new Date(d.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  mount(el, html`
    <div class="page-head">
      <div><h1>Dashboard</h1><div class="sub">${today} — who has money pending, how much, and whom to contact.</div></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/orders/new">+ New Order</a></div>
    </div>

    <div class="kpis">
      <a class="kpi hero" href="#/orders?view=outstanding"><div class="kpi-label">Outstanding amount</div><div class="kpi-value">${inr(k.outstanding_amount)}</div><div class="kpi-note">${k.customers_owing} customer${k.customers_owing === 1 ? '' : 's'} owe money</div></a>
      <a class="kpi ${k.overdue_orders ? 'danger' : ''}" href="#/orders?view=overdue"><div class="kpi-label">Overdue</div><div class="kpi-value">${k.overdue_orders}</div><div class="kpi-note">past the delivery date</div></a>
      <a class="kpi" href="#/orders?view=ready"><div class="kpi-label">Ready for delivery</div><div class="kpi-value">${k.ready_for_delivery}</div><div class="kpi-note">waiting for collection</div></a>
      <a class="kpi" href="#/orders?view=open"><div class="kpi-label">Pending orders</div><div class="kpi-value">${k.pending_orders}</div><div class="kpi-note">not yet delivered</div></a>
      <div class="kpi"><div class="kpi-label">Today's collections</div><div class="kpi-value">${inr(k.todays_collections)}</div><div class="kpi-note">${k.todays_payments} payment${k.todays_payments === 1 ? '' : 's'} received</div></div>
      <a class="kpi" href="#/orders?view=all&q="><div class="kpi-label">Today's orders</div><div class="kpi-value">${k.todays_orders}</div><div class="kpi-note">worth ${inr(k.todays_sales)}</div></a>
    </div>

    <div class="alert-strip">
      ${k.low_stock ? html`<a class="alert-chip warn" href="#/inventory/low">${k.low_stock} product${k.low_stock === 1 ? '' : 's'} low on stock</a>` : ''}
      ${k.out_of_stock ? html`<a class="alert-chip danger" href="#/inventory/out">${k.out_of_stock} out of stock</a>` : ''}
      ${k.awaiting_bill ? html`<a class="alert-chip warn" href="#/billing">${k.awaiting_bill} delivered — bill not generated</a>` : ''}
      ${k.credit_given_orders ? html`<span class="alert-chip warn" id="credit-kpi">${inr(k.credit_given_amount)} given on credit (${k.credit_given_orders})</span>` : ''}
    </div>

    <div>
      <div>
        <div class="card">
          <div class="card-head">
            <h2>Outstanding payments</h2>
            <div class="row">
              <div class="chips" id="out-filters">
                ${[['all', 'All'], ['overdue', 'Overdue'], ['due', 'Due soon'], ['ready', 'Ready for delivery']].map(([key, label]) => html`
                  <button class="chip ${state.filter === key ? 'on' : ''}" data-filter="${key}">${label}<span class="n">${counts[key]}</span></button>`)}
              </div>
              <select id="out-sort" style="width:auto" aria-label="Sort outstanding payments">
                ${SORTS.map(([v, l]) => html`<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`)}
              </select>
            </div>
          </div>
          <div id="out-table">${outstandingRows(filterRows(all))}</div>
        </div>
      </div>

      ${d.credit_given.length ? html`<div class="card" style="margin-top:18px" id="credit-given">
        <div class="card-head">
          <h2>Credit given</h2>
          <div class="row">
            <span class="muted small">Items delivered to customers before full payment</span>
            <select id="credit-sort" style="width:auto" aria-label="Sort credit given">
              ${CREDIT_SORTS.map(([v, l]) => html`<option value="${v}" ${creditState.sort === v ? 'selected' : ''}>${l}</option>`)}
            </select>
          </div>
        </div>
        <div id="credit-table">${creditRows(d.credit_given)}</div>
      </div>` : ''}

      <div class="grid cols-3" style="margin-top:18px">
        <div class="card">
          <div class="card-head"><h2>Who to call first</h2><span class="muted small">largest balances</span></div>
          ${d.debtors.length ? html`<div>${d.debtors.map((c) => html`
            <div class="card-body row spread" style="padding:11px 18px;border-bottom:1px solid var(--line-2)">
              <div><a class="cell-main" href="#/customers/${c.id}">${c.name}</a>
                <div class="cell-sub">${c.orders} order${c.orders > 1 ? 's' : ''} · next delivery ${fmtDate(c.next_delivery, false)}</div></div>
              <div class="right"><div class="bold" style="color:var(--maroon)">${inr(c.due)}</div><a class="small" href="tel:${c.phone}">${c.phone}</a></div>
            </div>`)}</div>` : empty('All clear', 'No customer owes anything.')}
        </div>

        <div class="card">
          <div class="card-head"><h2>Gold rate today</h2><a class="small" href="#/gold-rate">Update</a></div>
          <div class="card-body">${d.gold_rates.map((r) => html`<div class="kv"><span class="k">${r.purity} gold</span><span class="v">${perGram(r.rate_per_gram)}
            ${r.change ? html`<span class="small ${r.change > 0 ? 'up' : 'down'}">${r.change > 0 ? '▲' : '▼'} ${inr(Math.abs(r.change))}</span>` : ''}</span></div>`)}</div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Recent collections</h2></div>
          ${d.recent_payments.length ? html`<div>${d.recent_payments.map((p) => html`
            <div class="row spread" style="padding:10px 18px;border-bottom:1px solid var(--line-2)">
              <div><a href="#/customers/${p.customer_id}" class="cell-main">${p.customer_name}</a>
                <div class="cell-sub"><a href="#/orders/${p.order_id}">${p.order_number}</a> · ${p.payment_method} · ${fmtDate(p.payment_date, false)}</div></div>
              <span class="bold up">+${inr(p.amount)}</span>
            </div>`)}</div>` : empty('No payments yet')}
        </div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:18px">
      <div class="card">
        <div class="card-head"><h2>Low stock</h2><a class="small" href="#/inventory/low">View all</a></div>
        ${stockList(d.low_stock_items, 'Nothing is running low.')}
      </div>
      <div class="card">
        <div class="card-head"><h2>Out of stock</h2><a class="small" href="#/inventory/out">View all</a></div>
        ${stockList(d.out_of_stock_items, 'Everything is in stock.')}
      </div>
    </div>

    ${rahul && rate22 ? html`<div class="card" style="margin-top:18px;border-color:var(--gold-2)">
      <div class="card-head" style="background:var(--gold-soft)"><h2>Try the full lifecycle in two minutes</h2><span class="muted small">Rahul Das · 22K Classic Gold Chain · 10 g</span></div>
      <div class="card-body">
        <ol style="margin:0;padding-left:20px;line-height:1.9">
          <li>Open <a href="#/gold-rate">Gold Rate</a> and set 22K to <b>₹15,000</b> — Rahul's order was placed at ₹14,720/g with a ₹50,000 advance.</li>
          <li>Open <a href="#/orders/${rahul.id}">${rahul.order_number}</a> and read the <b>Delivery Settlement</b>: the new rate, the amount payable and what is still due.</li>
          <li>Click <b>Settle &amp; Deliver</b>, take the balance and confirm. Stock drops by one and the order is delivered.</li>
          <li>Click <b>Generate Final Bill</b>, then check the bill in Rahul's <a href="#/customers/${rahul.customer_id}">customer profile</a> and watch Outstanding fall on this dashboard.</li>
        </ol>
      </div>
    </div>` : ''}
  `);

  function filterRows(rows) {
    if (state.filter === 'overdue') return rows.filter((o) => o.due_flag === 'OVERDUE');
    if (state.filter === 'due') return rows.filter((o) => o.due_flag === 'DUE_TODAY' || o.due_flag === 'DUE_SOON');
    if (state.filter === 'ready') return rows.filter((o) => o.is_ready);
    return rows;
  }

  async function reloadTable() {
    try {
      const { items } = await api.get('/api/dashboard/outstanding', { sort: state.sort, filter: state.filter });
      mount($('#out-table', el), outstandingRows(items));
    } catch (err) { toast(err.message, 'error'); }
  }
  $$('#out-filters .chip', el).forEach((btn) => btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    $$('#out-filters .chip', el).forEach((b) => b.classList.toggle('on', b === btn));
    reloadTable();
  }));
  $('#out-sort', el).addEventListener('change', (e) => { state.sort = e.target.value; reloadTable(); });
  if (state.sort !== 'overdue' || state.filter !== 'all') reloadTable();
  $('#credit-kpi', el)?.addEventListener('click', () => $('#credit-given', el)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

  $('#credit-sort', el)?.addEventListener('change', async (e) => {
    creditState.sort = e.target.value;
    try {
      const { items } = await api.get('/api/dashboard/credit', { sort: creditState.sort });
      mount($('#credit-table', el), creditRows(items));
    } catch (err) { toast(err.message, 'error'); }
  });
}

function stockList(items, emptyText) {
  if (!items.length) return empty(emptyText);
  return html`<div>${items.map((p) => html`
    <div class="row spread" style="padding:10px 18px;border-bottom:1px solid var(--line-2)">
      <div class="prod-cell"><img class="thumb" src="${p.image}" alt=""><div><div class="cell-main">${p.name}</div>
        <div class="cell-sub">${p.sku} · ${p.reserved_quantity} reserved</div></div></div>
      <div class="right"><div class="bold">${p.available_quantity} available</div><a class="small" href="#/inventory/${p.available_quantity <= 0 ? 'out' : 'low'}">Restock</a></div>
    </div>`)}</div>`;
}
