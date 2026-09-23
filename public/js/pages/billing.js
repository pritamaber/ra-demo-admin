import {
  $, $$, api, html, mount, inr, inr2, grams, perGram, fmtDate, empty, confirmDialog, toast, navigate, debounce, icon,
} from '../lib.js';

async function generateBill(order) {
  if (!(await confirmDialog({
    title: 'Generate final bill',
    message: `Generate the final bill for ${order.order_number} (${inr(order.total_amount)})? Issued bills cannot be edited.`,
    confirmLabel: 'Generate bill',
  }))) return;
  try {
    const b = await api.post(`/api/orders/${order.id}/bill`);
    toast(`Bill ${b.bill_number} generated`);
    navigate(`/bills/${b.id}`);
  } catch (e) { toast(e.message, 'error'); }
}

// ================================================================== billing home
export async function billingPage({ el, isCurrent }) {
  const [ov, open, bills] = await Promise.all([
    api.get('/api/billing/overview'),
    api.get('/api/orders', { view: 'open', limit: 1 }),
    api.get('/api/bills', { limit: 100 }),
  ]);
  if (!isCurrent()) return;

  mount(el, html`
    <div class="page-head">
      <div><h1>Billing</h1><div class="sub">Final bills are generated from completed orders — nothing is billed on its own.</div></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="card-body row spread">
        <div><div class="bold">Quick start</div><div class="muted small">Select customer → select product → calculate → receive advance → save → later payments → delivery → settlement → bill</div></div>
        <form class="row" id="quick-start"><input name="phone" inputmode="numeric" placeholder="Customer phone number" style="width:220px" aria-label="Customer phone number"><button class="btn btn-primary" type="submit">Start order</button></form>
      </div>
    </div>

    <div class="stepper" style="margin-bottom:22px">
      <a class="stepper-item" href="#/orders?view=open"><div class="n">${open.total}</div><div class="l">Open orders in progress</div></a>
      <a class="stepper-item" href="#/orders?status=FULLY_PAID"><div class="n">${ov.ready_to_settle.length}</div><div class="l">Fully paid — ready to hand over</div></a>
      <div class="stepper-item ${ov.awaiting_bill.length ? 'alert' : ''}"><div class="n">${ov.awaiting_bill.length}</div><div class="l">Delivered — awaiting final bill</div></div>
      <div class="stepper-item"><div class="n">${ov.this_month.bills}</div><div class="l">Bills this month · ${inr(ov.this_month.billed_value)}</div></div>
      <div class="stepper-item"><div class="n">${ov.totals.bills}</div><div class="l">Bills issued in total · ${inr(ov.totals.billed_value)}</div></div>
    </div>

    ${ov.awaiting_bill.length ? html`<div class="card" style="margin-bottom:18px;border-color:var(--gold-2)">
      <div class="card-head" style="background:var(--gold-soft)"><h2>Ready to bill</h2><span class="muted small">Delivered and fully settled — generate the final bill</span></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Order</th><th>Customer</th><th>Product</th><th>Delivered</th><th class="num">Final amount</th><th></th></tr></thead>
        <tbody>${ov.awaiting_bill.map((o) => html`<tr>
          <td><a class="cell-main" href="#/orders/${o.id}">${o.order_number}</a></td>
          <td><a href="#/customers/${o.customer_id}">${o.customer_name}</a><div class="cell-sub">${o.customer_phone}</div></td>
          <td>${o.products}</td><td class="nowrap">${fmtDate(o.actual_delivery_date)}</td>
          <td class="num bold">${inr(o.total_amount)}</td>
          <td class="right"><button class="btn btn-gold btn-sm" data-bill="${o.id}">Generate Final Bill</button></td></tr>`)}</tbody></table></div></div>` : ''}

    ${ov.ready_to_settle.length ? html`<div class="card" style="margin-bottom:18px">
      <div class="card-head"><h2>Fully paid — waiting for delivery</h2><span class="muted small">Open the order to deliver it and lock the final settlement</span></div>
      <div class="table-wrap"><table class="tbl"><tbody>${ov.ready_to_settle.map((o) => html`<tr>
        <td><a class="cell-main" href="#/orders/${o.id}">${o.order_number}</a></td><td><a href="#/customers/${o.customer_id}">${o.customer_name}</a></td>
        <td>${o.products}</td><td class="nowrap">due ${fmtDate(o.expected_delivery_date)}</td><td class="num">${inr(o.total_amount)}</td>
        <td class="right"><a class="btn btn-sm" href="#/orders/${o.id}">Open order</a></td></tr>`)}</tbody></table></div></div>` : ''}

    <div class="card">
      <div class="card-head"><h2>Bill history</h2><input id="bill-search" placeholder="Search bill no., order, customer or phone…" style="max-width:340px"></div>
      <div id="bill-table"></div>
    </div>`);

  const renderBills = (items) => mount($('#bill-table', el), items.length ? html`<div class="table-wrap"><table class="tbl">
    <thead><tr><th>Bill no.</th><th>Date</th><th>Order</th><th>Customer</th><th>Product</th><th class="num">Amount</th><th></th></tr></thead>
    <tbody>${items.map((b) => html`<tr>
      <td><a class="cell-main" href="#/bills/${b.id}">${b.bill_number}</a></td><td class="nowrap">${fmtDate(b.bill_date)}</td>
      <td><a href="#/orders/${b.order_id}">${b.order_number}</a></td>
      <td><a href="#/customers/${b.customer_id}">${b.customer_name}</a><div class="cell-sub">${b.customer_phone}</div></td>
      <td>${b.products}</td><td class="num bold">${inr(b.total_amount)}</td>
      <td class="right nowrap"><a class="btn btn-sm" href="#/bills/${b.id}">View / Print</a></td></tr>`)}</tbody></table></div>` : empty('No bills found', 'Bills appear here once a delivered order is fully settled and billed.'));
  renderBills(bills.items);

  $('#bill-search', el).addEventListener('input', debounce(async (e) => {
    try { renderBills((await api.get('/api/bills', { q: e.target.value.trim(), limit: 100 })).items); } catch (err) { toast(err.message, 'error'); }
  }, 250));
  $$('[data-bill]', el).forEach((b) => b.addEventListener('click', () => generateBill(ov.awaiting_bill.find((o) => o.id === Number(b.dataset.bill)))));
  $('#quick-start', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const phone = new FormData(e.target).get('phone').replace(/\D/g, '');
    navigate(`/orders/new${phone ? '?phone=' + phone : ''}`);
  });
}

// ===================================================================== bill view
export async function billViewPage({ el, params, isCurrent }) {
  const rec = await api.get(`/api/bills/${params[0]}`);
  if (!isCurrent()) return;
  const b = rec.bill;
  const t = b.totals;
  const fullyPaid = Math.abs(b.total_paid - t.total) < 0.01;

  mount(el, html`
    <div class="no-print">
      <div class="crumb"><a href="#/billing">Billing</a> / ${b.bill_number}</div>
      <div class="page-head">
        <div><h1>Final Bill ${b.bill_number}</h1><div class="sub">Issued ${fmtDate(b.bill_date)} for order <a href="#/orders/${rec.order_id}">${b.order_number}</a></div></div>
        <div class="page-actions">
          <a class="btn" href="#/orders/${rec.order_id}">View order</a>
          <a class="btn" href="#/customers/${b.customer.id}">Customer profile</a>
          <button class="btn btn-primary" id="print-bill">${icon('print')} Print / Save as PDF</button>
        </div>
      </div>
    </div>

    <div class="invoice-wrap"><article class="invoice">
      <header class="inv-head">
        <div><div class="inv-shop">${b.shop.name}</div><div class="inv-tag">${b.shop.tagline}</div>
          <div class="inv-small" style="margin-top:8px">${b.shop.address}<br>Phone: ${b.shop.phone} · GSTIN: ${b.shop.gstin}</div></div>
        <div class="inv-title"><h2>FINAL BILL</h2>
          <div style="margin-top:8px"><b>${b.bill_number}</b></div>
          <div class="inv-small">Bill date: ${fmtDate(b.bill_date)}</div></div>
      </header>

      <section class="inv-meta">
        <div><h5>Billed to</h5><div class="bold" style="font-size:15px">${b.customer.name}</div>
          <div>Phone: ${b.customer.phone}</div>${b.customer.address ? html`<div>${b.customer.address}${b.customer.city ? ', ' + b.customer.city : ''}</div>` : ''}</div>
        <div><h5>Order details</h5>
          <div>Order no.: <b>${b.order_number}</b></div><div>Order date: ${fmtDate(b.order_date)}</div><div>Delivery date: ${fmtDate(b.delivery_date)}</div>
          <div>Gold rate: ${perGram(b.order_gold_rate)} on order date · <b>${perGram(b.delivery_gold_rate)}</b> on delivery</div></div>
      </section>

      <table class="inv-table">
        <thead><tr><th>Item</th><th>Purity</th><th class="num">Gross wt</th><th class="num">Stone wt</th><th class="num">Net gold wt</th><th class="num">Gold rate</th><th class="num">Gold value</th><th class="num">Making charge</th></tr></thead>
        <tbody>${b.items.map((i) => html`<tr>
          <td><b>${i.name}</b>${i.quantity > 1 ? ` × ${i.quantity}` : ''}<div class="inv-small" style="margin:2px 0 0">SKU ${i.sku} · Barcode ${i.barcode || '—'}</div></td>
          <td>${i.purity} ${i.metal_type}</td><td class="num">${grams(i.gross_weight)}</td><td class="num">${grams(i.stone_weight)}</td><td class="num"><b>${grams(i.net_gold_weight)}</b></td>
          <td class="num">${perGram(i.gold_rate)}</td><td class="num">${inr2(i.gold_value)}</td>
          <td class="num">${inr2(i.making_charge)}<div class="inv-small" style="margin:2px 0 0">${i.making_description}</div></td></tr>`)}</tbody>
      </table>

      <div class="inv-cols">
        <div class="inv-box">
          <h5>Payments</h5>
          <table class="inv-table"><thead><tr><th>Date</th><th>Type</th><th>Method</th><th class="num">Amount</th></tr></thead>
            <tbody>${b.payments.map((p) => html`<tr><td>${fmtDate(p.date)}</td><td>${p.kind}</td><td>${p.method}${p.reference ? html`<div class="inv-small" style="margin:1px 0 0">${p.reference}</div>` : ''}</td><td class="num">${inr2(p.amount)}</td></tr>`)}</tbody></table>
          <div class="kv" style="margin-top:8px"><span class="k">Previous payments (${b.previous_payments.count})</span><span class="v">${inr2(b.previous_payments.total)}</span></div>
          ${b.final_payment ? html`<div class="kv"><span class="k">Final payment (${b.final_payment.method}, ${fmtDate(b.final_payment.date, false)})</span><span class="v">${inr2(b.final_payment.amount)}</span></div>` : ''}
          <div class="kv total"><span class="k">Total paid</span><span class="v">${inr2(b.total_paid)}</span></div>
          <div class="kv sub"><span class="k">Payment method${b.payment_methods.length > 1 ? 's' : ''}</span><span class="v">${b.payment_methods.join(', ')}</span></div>
          <div class="kv sub"><span class="k">Balance</span><span class="v">${fullyPaid ? 'Nil — paid in full' : inr2(t.total - b.total_paid)}</span></div>
        </div>
        <div class="inv-box">
          <h5>Amount</h5>
          <div class="kv"><span class="k">Gold value</span><span class="v">${inr2(t.gold_value)}</span></div>
          <div class="kv"><span class="k">Making charges</span><span class="v">${inr2(t.making_charge)}</span></div>
          <div class="kv"><span class="k">Other charges${t.other_charges_note ? ` (${t.other_charges_note})` : ''}</span><span class="v">${inr2(t.other_charges)}</span></div>
          <div class="kv"><span class="k">CGST @ ${t.gst_rate / 2}%</span><span class="v">${inr2(t.cgst)}</span></div>
          <div class="kv"><span class="k">SGST @ ${t.gst_rate / 2}%</span><span class="v">${inr2(t.sgst)}</span></div>
          ${t.round_off ? html`<div class="kv"><span class="k">Round off</span><span class="v">${inr2(t.round_off)}</span></div>` : ''}
          <div class="inv-total"><span>Total amount</span><span>${inr2(t.total)}</span></div>
          <div class="inv-words">${t.amount_in_words}</div>
        </div>
      </div>

      <p class="inv-small"><b>Pricing rules applied:</b> ${b.rules.map((r) => `${r.label}: ${r.text}`).join(' · ')}.</p>
      <div class="inv-foot">
        <div class="inv-small" style="margin:0;max-width:430px">Goods once sold are subject to the shop's exchange policy. Please retain this bill and the hallmark certificate. This is a computer-generated final bill for order ${b.order_number}.</div>
        <div class="sign">Authorised signatory<br><span class="muted">${b.shop.name}</span></div>
      </div>
    </article></div>`);

  $('#print-bill', el).addEventListener('click', () => window.print());
}
