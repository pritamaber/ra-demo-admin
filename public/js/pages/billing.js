import {
  $, api, html, mount, inr, inr2, grams, perGram, fmtDate, roundOffText, empty, toast, debounce, icon,
} from '../lib.js';

// ================================================================== billing home
export async function billingPage({ el, isCurrent }) {
  const [ov, bills] = await Promise.all([
    api.get('/api/billing/overview'),
    api.get('/api/bills', { limit: 100 }),
  ]);
  if (!isCurrent()) return;

  mount(el, html`
    <div class="page-head dash-head">
      <div><h1>Billing</h1><div class="sub">Walk-in customers are billed on the spot. Booked orders are billed automatically when they are delivered.</div></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/billing/new">+ New Bill</a></div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Bills today</div><div class="kpi-value">${ov.today.bills}</div><div class="kpi-note">${inr(ov.today.billed_value)}</div></div>
      <div class="kpi"><div class="kpi-label">Bills this month</div><div class="kpi-value">${ov.this_month.bills}</div><div class="kpi-note">${inr(ov.this_month.billed_value)}</div></div>
      <div class="kpi"><div class="kpi-label">Bills issued in total</div><div class="kpi-value">${ov.totals.bills}</div><div class="kpi-note">${inr(ov.totals.billed_value)}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Bill history</h2><input id="bill-search" placeholder="Search bill no., order, customer or phone…" style="max-width:340px"></div>
      <div id="bill-table"></div>
    </div>`);

  const renderBills = (items) => mount($('#bill-table', el), items.length ? html`<div class="table-wrap"><table class="tbl">
    <thead><tr><th>Bill no.</th><th>Date</th><th>Order</th><th>Customer</th><th>Product</th><th class="num">Amount</th><th></th></tr></thead>
    <tbody>${items.map((b) => html`<tr>
      <td><a class="cell-main" href="#/bills/${b.id}">${b.bill_number}</a>${b.kind === 'SALE' ? html`<div class="cell-sub">Walk-in bill</div>` : ''}</td><td class="nowrap">${fmtDate(b.bill_date)}</td>
      <td><a href="#/orders/${b.order_id}">${b.order_number}</a></td>
      <td><a href="#/customers/${b.customer_id}">${b.customer_name}</a><div class="cell-sub">${b.customer_phone}</div></td>
      <td>${b.products}</td><td class="num bold">${inr(b.total_amount)}</td>
      <td class="right nowrap"><a class="btn btn-sm" href="#/bills/${b.id}">View / Print</a></td></tr>`)}</tbody></table></div>` : empty('No bills found', 'Bills appear here as soon as an order is delivered, or when you create a walk-in bill.'));
  renderBills(bills.items);

  $('#bill-search', el).addEventListener('input', debounce(async (e) => {
    try { renderBills((await api.get('/api/bills', { q: e.target.value.trim(), limit: 100 })).items); } catch (err) { toast(err.message, 'error'); }
  }, 250));
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
          <div>${b.order_kind === 'SALE' ? 'Walk-in bill' : 'Order no.'}: <b>${b.order_number}</b></div><div>${b.order_kind === 'SALE' ? 'Sale date' : 'Order date'}: ${fmtDate(b.order_date)}</div>${b.order_kind === 'SALE' ? '' : html`<div>Delivery date: ${fmtDate(b.delivery_date)}</div>`}
          <div>Gold rate: ${perGram(b.gold_rate)} on ${fmtDate(b.order_date, false)}</div></div>
      </section>

      <table class="inv-table">
        <thead><tr><th>Item</th><th>Purity</th><th class="num">Gross wt</th><th class="num">Stone wt</th><th class="num">Net gold wt</th><th class="num">Gold rate</th><th class="num">Gold value</th><th class="num">Making charge</th></tr></thead>
        <tbody>${b.items.map((i) => html`<tr>
          <td><b>${i.name}</b>${i.quantity > 1 ? ` × ${i.quantity}` : ''}${i.description ? html`<div class="inv-small" style="margin:2px 0 0">${i.description}</div>` : ''}<div class="inv-small" style="margin:2px 0 0">SKU ${i.sku} · Barcode ${i.barcode || '—'}</div></td>
          <td>${i.purity} ${i.metal_type}</td><td class="num">${grams(i.gross_weight)}</td><td class="num">${grams(i.stone_weight)}</td><td class="num"><b>${grams(i.net_gold_weight)}</b></td>
          <td class="num">${perGram(i.gold_rate)}</td><td class="num">${inr2(i.gold_value)}</td>
          <td class="num">${inr2(i.making_charge)}<div class="inv-small" style="margin:2px 0 0">${i.making_description}</div></td></tr>`)}</tbody>
      </table>

      <div class="inv-cols">
        <div class="inv-box">
          <h5>Payments</h5>
          <table class="inv-table"><thead><tr><th>Date</th><th>Type</th><th>Method</th><th class="num">Amount</th></tr></thead>
            <tbody>${b.payments.map((p) => html`<tr><td>${fmtDate(p.date)}</td><td>${p.kind}</td><td>${p.method}${p.reference ? html`<div class="inv-small" style="margin:1px 0 0">${p.reference}</div>` : ''}</td><td class="num">${inr2(p.amount)}</td></tr>`)}</tbody></table>
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
          ${t.round_off ? html`<div class="kv"><span class="k">Round off</span><span class="v">${roundOffText(t.round_off)}</span></div>` : ''}
                    <div class="inv-total"><span>Total amount</span><span>${inr2(t.total)}</span></div>
          <div class="inv-words">${t.amount_in_words}</div>
        </div>
      </div>

      <p class="inv-small"><b>How the total is worked out:</b> gold value (net weight × gold rate) + making charge (net weight × making rate) + GST @ ${t.gst_rate}% on both${t.other_charges ? ' + other charges' : ''}, rounded to the nearest rupee. The gold rate is fixed on the order date.</p>
      <div class="inv-foot">
        <div class="inv-small" style="margin:0;max-width:430px">Goods once sold are subject to the shop's exchange policy. Please retain this bill and the hallmark certificate. This is a computer-generated final bill for order ${b.order_number}.</div>
        <div class="sign">Authorised signatory<br><span class="muted">${b.shop.name}</span></div>
      </div>
    </article></div>`);

  $('#print-bill', el).addEventListener('click', () => window.print());
}
