import { $, $$, api, html, raw, mount, inr, fmtDate, fmtDateTime, empty, onSubmit, toast, refresh, ratesChanged, todayIso } from '../lib.js';

/** Small dependency-free line chart of rate history (oldest → newest). */
function chart(points) {
  if (points.length < 2) return html`<div class="muted" style="padding:30px;text-align:center">Not enough history to draw a chart.</div>`;
  const W = 720, H = 190, padL = 58, padR = 16, padT = 14, padB = 26;
  const vals = points.map((p) => p.rate_per_gram);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, 1);
  lo -= span * 0.15; hi += span * 0.15;
  const x = (i) => padL + (i * (W - padL - padR)) / (points.length - 1);
  const y = (v) => padT + ((hi - v) * (H - padT - padB)) / (hi - lo);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.rate_per_gram).toFixed(1)}`).join(' ');
  const ticks = [0, 0.5, 1].map((t) => lo + (hi - lo) * t);
  const label = (iso) => fmtDate(iso, false);
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gold rate history">
    ${ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="#e7dfd0" stroke-dasharray="3 4"/><text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="#857a6d">${inr(Math.round(t))}</text>`).join('')}
    <polyline points="${line}" fill="none" stroke="#7a1f2b" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.rate_per_gram)}" r="${i === points.length - 1 ? 5 : 3}" fill="${i === points.length - 1 ? '#b98a2e' : '#7a1f2b'}"><title>${label(p.effective_date)}: ${inr(p.rate_per_gram)}/g</title></circle>`).join('')}
    <text x="${padL}" y="${H - 6}" font-size="11" fill="#857a6d">${label(points[0].effective_date)}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="11" fill="#857a6d">${label(points[points.length - 1].effective_date)}</text></svg>`;
  return raw(svg);
}

export async function goldRatePage({ el, isCurrent }) {
  const state = { purity: '22K' };
  const { items: current } = await api.get('/api/gold-rates/current');
  if (!isCurrent()) return;

  mount(el, html`
    <div class="page-head">
      <div><h1>Gold Rate Master</h1><div class="sub">Set today's rate. Every earlier rate is kept. A payment buys gold at the rate of the day it is made, and the gold an open order has not been paid for yet is re-valued at today's rate.</div></div>
    </div>
    <div class="rate-tiles">
      ${current.map((r) => html`<div class="rate-tile ${r.purity === '22K' ? 'main' : ''}">
        <div class="p">${r.purity} Gold</div>
        <div class="r">${inr(r.rate_per_gram)} <small>/ gram</small></div>
        <div class="d">${r.change ? html`<b class="${r.change > 0 ? 'up' : 'down'}" style="${r.purity === '22K' ? 'color:#fff' : ''}">${r.change > 0 ? '▲' : '▼'} ${inr(Math.abs(r.change))} (${Math.abs(r.change_percent)}%)</b> vs previous · ` : ''}effective ${fmtDate(r.effective_date)}</div>
      </div>`)}
    </div>

    <div class="grid split">
      <div class="card">
        <div class="card-head"><h2>Rate history</h2><div class="chips" id="purity-chips">
          ${['22K', '24K', '18K', ''].map((p) => html`<button class="chip ${p === state.purity ? 'on' : ''}" data-purity="${p}">${p || 'All'}</button>`)}</div></div>
        <div class="card-body" id="chart-box"></div>
        <div id="history-table"></div>
      </div>
      <div class="card"><div class="card-head"><h2>Update rate</h2></div><div class="card-body">
        <form class="form-grid" id="rate-form" style="grid-template-columns:1fr">
          <div class="field"><label for="r-purity">Enter the rate you know</label><select id="r-purity" name="purity">${current.map((r) => html`<option ${r.purity === '22K' ? 'selected' : ''}>${r.purity}</option>`)}</select></div>
          <div class="field"><label for="r-rate">Rate per gram (₹)</label><div class="input-group"><span>₹</span><input id="r-rate" name="rate_per_gram" type="number" min="1" step="1" required placeholder="e.g. 15000"></div>
            <div class="hint" id="r-hint"></div></div>
          <div class="field"><label for="r-date">Effective date</label><input id="r-date" name="effective_date" type="date" value="${todayIso()}"></div>
          <div class="field"><label for="r-note">Note</label><input id="r-note" name="note" placeholder="Optional"></div>
          <div class="form-error"></div>
          <button class="btn btn-primary" type="submit" style="justify-content:center">Save new rate</button>
        </form>
        <div class="notice" style="margin-top:14px">The other two purities are calculated automatically from this one (24K 99.99% · 22K 91.6% · 18K 75% fineness) — you only ever need to enter whichever rate you're given. Saving adds new dated entries — nothing is overwritten. Open orders are re-valued straight away for the gold still unpaid; gold already paid for and delivered orders never change.</div>
      </div></div>
    </div>`);

  const hint = () => {
    const purity = $('#r-purity', el).value;
    const cur = current.find((r) => r.purity === purity);
    $('#r-hint', el).textContent = cur ? `Current ${purity}: ${inr(cur.rate_per_gram)}/g` : '';
  };
  $('#r-purity', el).addEventListener('change', hint);
  hint();

  async function loadHistory() {
    const { items } = await api.get('/api/gold-rates', { purity: state.purity, limit: 120 });
    if (!isCurrent()) return;
    mount($('#chart-box', el), state.purity ? chart([...items].reverse()) : html`<div class="muted small">Select a purity to see its chart.</div>`);
    mount($('#history-table', el), items.length ? html`<div class="table-wrap" style="max-height:420px;overflow-y:auto"><table class="tbl">
      <thead><tr><th>Effective date</th><th>Purity</th><th class="num">Rate / g</th><th>Note</th><th>Recorded</th></tr></thead>
      <tbody>${items.map((r) => html`<tr><td class="nowrap">${fmtDate(r.effective_date)}</td><td>${r.purity}</td><td class="num bold">${inr(r.rate_per_gram)}</td><td>${r.note || ''}</td><td class="muted nowrap">${fmtDateTime(r.created_at)}</td></tr>`)}</tbody></table></div>` : empty('No rates recorded'));
  }
  $$('#purity-chips .chip', el).forEach((chip) => chip.addEventListener('click', () => {
    state.purity = chip.dataset.purity;
    $$('#purity-chips .chip', el).forEach((c) => c.classList.toggle('on', c === chip));
    loadHistory();
  }));

  onSubmit($('#rate-form', el), async (v) => {
    const res = await api.post('/api/gold-rates', { ...v, rate_per_gram: Number(v.rate_per_gram) });
    const others = res.derived.map((r) => `${r.purity} ${inr(r.rate_per_gram)}/g`).join(', ');
    toast(`${res.rate.purity} set to ${inr(res.rate.rate_per_gram)}/g — ${others} auto-updated${res.repriced_orders ? ` — ${res.repriced_orders} open order${res.repriced_orders === 1 ? '' : 's'} re-valued` : ''}`);
    ratesChanged();
    refresh();
  });
  await loadHistory();
}
