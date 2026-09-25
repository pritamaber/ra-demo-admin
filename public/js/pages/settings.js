import { $, api, html, mount, onSubmit, toast, confirmDialog, navigate, ratesChanged } from '../lib.js';

function field(def, value) {
  if (def.type === 'select') {
    return html`<div class="field full"><div class="lbl">${def.label}</div><div class="hint" style="margin-bottom:4px">${def.description}</div>
      <div class="stack" style="display:grid;gap:8px">${def.options.map((o) => html`<label class="radio-card"><input type="radio" name="${def.key}" value="${o.value}" ${o.value === value ? 'checked' : ''}>
        <div><div class="t">${o.label}</div>${o.hint ? html`<div class="h">${o.hint}</div>` : ''}</div></label>`)}</div></div>`;
  }
  if (def.type === 'number') {
    return html`<div class="field"><label for="s-${def.key}">${def.label}</label>
      <div class="input-group">${def.prefix ? html`<span>${def.prefix}</span>` : ''}<input id="s-${def.key}" name="${def.key}" type="number" min="${def.min ?? ''}" max="${def.max ?? ''}" step="${def.step ?? 1}" value="${value}">${def.suffix ? html`<span>${def.suffix}</span>` : ''}</div>
      <div class="hint">${def.description}</div></div>`;
  }
  return html`<div class="field"><label for="s-${def.key}">${def.label}</label><input id="s-${def.key}" name="${def.key}" value="${value}">${def.description ? html`<div class="hint">${def.description}</div>` : ''}</div>`;
}

export async function settingsPage({ el, isCurrent }) {
  const { values, definitions } = await api.get('/api/settings');
  if (!isCurrent()) return;
  const group = (g) => definitions.filter((d) => d.group === g);

  mount(el, html`
    <div class="page-head">
      <div><h1>Settings</h1><div class="sub">GST, business rules and the shop details printed on bills.</div></div>
    </div>
    <form id="settings-form" class="stack">
      <div class="card"><div class="card-head"><h2>How prices are worked out</h2></div><div class="card-body">
        <div class="notice" style="margin-bottom:16px">One simple formula for every order and bill. The gold rate is fixed on the day the order is placed — later rate changes never affect a placed order.</div>
        <div class="stack" style="margin-bottom:16px">
          <div class="kv"><span class="k">Gold value</span><span class="v">net weight (g) × gold rate of the day (₹/g)</span></div>
          <div class="kv"><span class="k">Making charge</span><span class="v">net weight (g) × the product's making rate (₹/g)</span></div>
          <div class="kv"><span class="k">GST</span><span class="v">GST % × (gold value + making charge)</span></div>
          <div class="kv"><span class="k">Other charges</span><span class="v">optional flat amount per order (no GST)</span></div>
          <div class="kv"><span class="k">Round off</span><span class="v">the total is rounded to the nearest rupee; the difference is shown as its own line</span></div>
          <div class="kv total"><span class="k">Total</span><span class="v">gold + making + GST + other charges ± round off</span></div>
        </div>
        <div class="form-grid">${group('pricing').map((d) => field(d, values[d.key]))}</div>
        <div class="hint" style="margin-top:8px">A new GST rate applies to orders placed from now on.</div>
      </div></div>

      <div class="card"><div class="card-head"><h2>Business rules</h2></div><div class="card-body form-grid three">${group('business').map((d) => field(d, values[d.key]))}</div></div>
      <div class="card"><div class="card-head"><h2>Shop details (printed on bills)</h2></div><div class="card-body form-grid">${group('shop').map((d) => field(d, values[d.key]))}</div></div>

      <div class="row"><button class="btn btn-primary" type="submit">Save settings</button><span class="form-error"></span></div>
    </form>

    <div class="card" style="margin-top:22px;border-color:#e5b9b4">
      <div class="card-head"><h2>Demo data</h2></div>
      <div class="card-body row spread"><div><div class="bold">Reset to the original demo data</div>
        <div class="muted small">Deletes everything you have entered and reloads the sample customers, catalogue, orders and gold-rate history. Dates are re-based to today.</div></div>
        <button class="btn btn-danger" id="reset-demo">Reset demo data</button></div>
      <div class="card-body row spread" style="border-top:1px solid var(--line-2)"><div><div class="bold">Clear all data — start blank</div>
        <div class="muted small">Deletes every customer, product, order, payment, bill, stock movement and gold-rate entry. Categories and pricing settings are kept, so the app is ready for you to add your real catalogue and start testing.</div></div>
        <button class="btn btn-danger" id="clear-all">Clear all data</button></div>
    </div>`);

  onSubmit($('#settings-form', el), async (v) => {
    await api.put('/api/settings', v);
    toast('Settings saved');
  });

  $('#reset-demo', el).addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Reset demo data', message: 'This deletes all current data and reloads the sample data. Continue?', confirmLabel: 'Reset everything', danger: true }))) return;
    try {
      await api.post('/api/admin/reset');
      toast('Demo data reloaded');
      ratesChanged();
      navigate('/dashboard');
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#clear-all', el).addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Clear all data', message: 'This permanently deletes every customer, product, order, payment, bill and gold-rate entry. Categories and pricing settings are kept. This cannot be undone. Continue?', confirmLabel: 'Delete everything', danger: true }))) return;
    try {
      await api.post('/api/admin/clear');
      toast('All data cleared — ready for a fresh start');
      ratesChanged();
      navigate('/dashboard');
    } catch (e) { toast(e.message, 'error'); }
  });
}
