import { $, api, html, mount, inr, inr2, grams, perGram, fmtDate, roundOffText, statusBadge, icon } from '../lib.js';

/**
 * Gold payment statement: how every payment was applied. Each payment buys gold at that day's rate
 * (₹ ÷ rate = grams); what is left is the gold still owed, valued at the day's rate, plus making charge and GST.
 * Built from either a live order (getOrder) or an issued bill, so the slip, the bill and the stand-alone page agree.
 */
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export function statementFromOrder(data, { withCustomer = false } = {}) {
  const { order: o, customer: c, payments, settlement: s, price } = data;
  return {
    order_number: o.order_number, kind: o.kind, status: o.status,
    order_date: o.order_date, delivery_date: o.actual_delivery_date || o.expected_delivery_date, delivered: !!o.actual_delivery_date,
    customer: withCustomer ? { name: c.name, phone: c.phone } : null,
    net_weight: s.net_weight,
    booked: { date: s.booked.date, rate: s.booked.gold_rate, gold_value: s.booked.gold_value, total: s.booked.total },
    rows: payments.map((p) => ({
      date: p.payment_date, method: p.payment_method, kind: p.kind, amount: p.amount,
      gold_rate: p.gold_rate, gold_grams: p.gold_grams, gold_amount: p.gold_amount, other: r2(p.amount - p.gold_amount),
    })),
    now: {
      final: s.is_final, rate: s.gold_rate_today, gold_paid_grams: s.gold_paid_grams, gold_paid_amount: s.gold_paid_amount,
      remaining: s.remaining, gold_value: s.gold_value, making_charge: s.making_charge, making_quoted: s.booked.making_charge,
      gst: s.gst, gst_rate: price.gst_rate, other_charges: s.other_charges, round_off: s.round_off, total: s.total, paid: s.paid, outstanding: s.outstanding,
    },
  };
}

export function statementFromBill(rec) {
  const b = rec.bill;
  const t = b.totals;
  const w = b.gold.net_weight;
  return {
    order_number: b.order_number, kind: b.order_kind, status: 'DELIVERED',
    order_date: b.order_date, delivery_date: b.delivery_date, delivered: true,
    customer: { name: b.customer.name, phone: b.customer.phone },
    net_weight: w,
    booked: { date: b.order_date, rate: b.gold.booked_rate, gold_value: b.gold.booked_gold_value ?? r2(b.gold.booked_rate * w), total: b.gold.booked_total },
    rows: b.payments.map((p) => {
      const goldAmount = p.gold_amount ?? Math.min(p.amount, r2(p.gold_grams * p.gold_rate)); // bills issued before the field existed
      return { date: p.date, method: p.method, kind: p.kind, amount: p.amount, gold_rate: p.gold_rate, gold_grams: p.gold_grams, gold_amount: goldAmount, other: r2(p.amount - goldAmount) };
    }),
    now: {
      final: true, rate: b.gold.average_rate, gold_paid_grams: w, gold_paid_amount: t.gold_value,
      remaining: { gold_grams: 0, gold_value: 0, making_charge: 0, other_charges: 0, gst: 0, round_off: t.round_off },
      gold_value: t.gold_value, making_charge: t.making_charge, making_quoted: t.making_quoted ?? t.making_charge,
      gst: t.gst, gst_rate: t.gst_rate, other_charges: t.other_charges, round_off: t.round_off, total: t.total, paid: b.total_paid, outstanding: 0,
    },
  };
}

/** The printable statement. `break` starts it on a new printed page (used when it follows a slip or a bill). */
export function statementArticle(m, { pageBreak = false } = {}) {
  const w = m.net_weight;
  let cumulative = 0;
  const rows = m.rows.map((r) => {
    cumulative = r3(cumulative + r.gold_grams);
    return { ...r, owed: Math.max(r3(w - cumulative), 0) };
  });
  const n = m.now;
  const left = n.remaining;
  const noGold = rows.every((r) => !(r.gold_grams > 0));
  return html`<article class="invoice statement ${pageBreak ? 'page-break' : ''}">
    <header class="inv-head">
      <div><div class="inv-shop">Payment Statement</div><div class="inv-tag">Gold settlement — how each payment was applied</div></div>
      <div class="inv-title"><h2>${m.order_number}</h2>
        <div style="margin-top:8px">${statusBadge(m.status)}</div>
        <div class="inv-small" style="margin-top:6px">Order date: ${fmtDate(m.order_date)}</div>
        <div class="inv-small">${m.delivered ? `Delivered: ${fmtDate(m.delivery_date)}` : `Delivery date: ${fmtDate(m.delivery_date)}`}</div></div>
    </header>

    ${m.customer ? html`<section class="inv-meta">
      <div><h5>Customer</h5><div class="bold" style="font-size:15px">${m.customer.name}</div><div>Phone: ${m.customer.phone}</div></div>
      <div><h5>Gold booked</h5><div><b>${grams(w)}</b> at ${perGram(m.booked.rate)} on ${fmtDate(m.booked.date, false)}</div>
        <div>Gold value ${inr2(m.booked.gold_value)} · booked total ${inr2(m.booked.total)}</div></div>
    </section>` : html`<section class="inv-meta">
      <div><h5>Gold booked</h5><div><b>${grams(w)}</b> at ${perGram(m.booked.rate)} on ${fmtDate(m.booked.date, false)}</div></div>
      <div><h5>Booked amount</h5><div>Gold value ${inr2(m.booked.gold_value)} · total ${inr2(m.booked.total)}</div></div>
    </section>`}

    <h5 class="st-heading">How each payment was applied</h5>
    ${rows.length ? html`<table class="inv-table">
      <thead><tr><th>Date</th><th>Method</th><th class="num">Paid</th><th class="num">Gold rate</th><th class="num">Gold bought</th><th class="num">₹ to gold</th><th class="num">₹ to making / GST</th><th class="num">Gold still owed</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr>
        <td>${fmtDate(r.date)}<div class="inv-small" style="margin:1px 0 0">${r.kind}</div></td><td>${r.method}</td>
        <td class="num"><b>${inr2(r.amount)}</b></td>
        <td class="num">${r.gold_rate ? perGram(r.gold_rate) : '—'}</td>
        <td class="num">${r.gold_grams > 0 ? html`<b>${grams(r.gold_grams)}</b>` : '—'}</td>
        <td class="num">${inr2(r.gold_amount)}</td><td class="num">${r.other > 0.005 ? inr2(r.other) : '—'}</td>
        <td class="num">${grams(r.owed)}</td></tr>`)}</tbody>
      <tfoot><tr><td colspan="2"><b>Total</b></td><td class="num"><b>${inr2(n.paid)}</b></td><td></td><td class="num"><b>${grams(n.gold_paid_grams)}</b></td><td class="num">${inr2(n.gold_paid_amount)}</td><td class="num">${inr2(r2(n.paid - n.gold_paid_amount))}</td><td class="num">${grams(left.gold_grams)}</td></tr></tfoot>
    </table>` : html`<p class="muted">No payments yet.</p>`}
    ${noGold && rows.length ? html`<p class="inv-small">These payments went towards making charge and GST.</p>` : ''}

    <div class="inv-cols">
      <div class="inv-box">
        <h5>${n.final ? 'Gold — settled' : 'Gold — where it stands'}</h5>
        <div class="kv"><span class="k">Gold booked</span><span class="v">${grams(w)}</span></div>
        <div class="kv"><span class="k">Gold paid for</span><span class="v">${grams(n.gold_paid_grams)} · ${inr2(n.gold_paid_amount)}</span></div>
        ${left.gold_grams > 0.0005
          ? html`<div class="kv"><span class="k">Gold still owed</span><span class="v">${grams(left.gold_grams)}</span></div>
            <div class="kv"><span class="k">Valued at today's ${perGram(n.rate)}</span><span class="v">${inr2(left.gold_value)}</span></div>`
          : html`<div class="kv"><span class="k">Gold still owed</span><span class="v">nil — all paid for</span></div>`}
        ${n.final ? html`<div class="kv sub"><span class="k">Average rate paid</span><span class="v">${perGram(n.rate)}</span></div>` : ''}
      </div>
      <div class="inv-box">
        <h5>${n.final ? 'Final amount' : 'Amount now'}</h5>
        <div class="kv"><span class="k">Gold value</span><span class="v">${inr2(n.gold_value)}</span></div>
        <div class="kv"><span class="k">Making charge${n.making_quoted - n.making_charge > 0.005 ? ` (quoted ${inr2(n.making_quoted)})` : ''}</span><span class="v">${inr2(n.making_charge)}</span></div>
        <div class="kv"><span class="k">GST @ ${n.gst_rate}%</span><span class="v">${inr2(n.gst)}</span></div>
        ${n.other_charges ? html`<div class="kv"><span class="k">Other charges</span><span class="v">${inr2(n.other_charges)}</span></div>` : ''}
        ${n.round_off ? html`<div class="kv"><span class="k">Round off</span><span class="v">${roundOffText(n.round_off)}</span></div>` : ''}
        <div class="inv-total"><span>${n.final ? 'Final total' : 'Total now'}</span><span>${inr2(n.total)}</span></div>
        <div class="kv"><span class="k">Paid</span><span class="v">${inr2(n.paid)}</span></div>
        <div class="kv total"><span class="k">Balance due</span><span class="v">${inr2(n.outstanding)}</span></div>
        ${n.outstanding > 0.005 ? html`<div class="inv-small" style="margin-top:8px">Still owed: ${[
          left.gold_grams > 0.0005 ? `${grams(left.gold_grams)} gold (${inr2(left.gold_value)})` : '',
          left.making_charge > 0.005 ? `${inr2(left.making_charge)} making` : '',
          left.other_charges > 0.005 ? `${inr2(left.other_charges)} other` : '',
          left.gst > 0.005 ? `${inr2(left.gst)} GST` : '',
        ].filter(Boolean).join(' + ')}</div>` : ''}
      </div>
    </div>
  </article>`;
}

/** Stand-alone page: the statement on its own, ready to print or hand to the customer. */
export async function orderStatementPage({ el, params, isCurrent }) {
  const data = await api.get(`/api/orders/${params[0]}`);
  if (!isCurrent()) return;
  const o = data.order;
  mount(el, html`
    <div class="no-print">
      <div class="crumb"><a href="#/orders/${o.id}">${o.order_number}</a> / Payment statement</div>
      <div class="page-head">
        <div><h1>Payment Statement · ${o.order_number}</h1><div class="sub">How each payment was applied to the gold, making charge and GST</div></div>
        <div class="page-actions">
          <a class="btn" href="#/orders/${o.id}">Back to order</a>
          <button class="btn btn-primary" id="print-statement">${icon('print')} Print / Save as PDF</button>
        </div>
      </div>
    </div>
    <div class="invoice-wrap">${statementArticle(statementFromOrder(data, { withCustomer: true }))}</div>`);
  $('#print-statement', el).addEventListener('click', () => window.print());
}
