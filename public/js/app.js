import { $, $$, api, html, raw, mount, icon, inr, debounce, navigate, toast } from './lib.js';
import { dashboardPage } from './pages/dashboard.js';
import { ordersListPage, orderNewPage, orderDetailPage, orderSlipPage } from './pages/orders.js';
import { billingPage, billViewPage } from './pages/billing.js';
import { customersPage, customerProfilePage, openCustomerForm } from './pages/customers.js';
import { catalogPage } from './pages/catalog.js';
import { inventoryPage } from './pages/inventory.js';
import { goldRatePage } from './pages/goldrate.js';
import { settingsPage } from './pages/settings.js';

const NAV = [
  ['dashboard', 'Dashboard', '/dashboard'],
  ['orders', 'Orders', '/orders'],
  ['billing', 'Billing', '/billing'],
  ['customers', 'Customers', '/customers'],
  ['catalog', 'Master Catalog', '/catalog'],
  ['inventory', 'Inventory', '/inventory'],
  ['gold', 'Gold Rate', '/gold-rate'],
  ['settings', 'Settings', '/settings'],
];

const ROUTES = [
  [/^\/dashboard$/, dashboardPage, 'Dashboard', '/dashboard'],
  [/^\/orders$/, ordersListPage, 'Orders', '/orders'],
  [/^\/orders\/new$/, orderNewPage, 'New Order', '/orders'],
  [/^\/orders\/(\d+)$/, orderDetailPage, 'Order', '/orders'],
  [/^\/orders\/(\d+)\/slip$/, orderSlipPage, 'Order Slip', '/orders'],
  [/^\/billing$/, billingPage, 'Billing', '/billing'],
  [/^\/bills\/(\d+)$/, billViewPage, 'Final Bill', '/billing'],
  [/^\/customers$/, customersPage, 'Customers', '/customers'],
  [/^\/customers\/(\d+)$/, customerProfilePage, 'Customer', '/customers'],
  [/^\/catalog$/, catalogPage, 'Master Catalog', '/catalog'],
  [/^\/inventory(?:\/(\w+))?$/, inventoryPage, 'Inventory', '/inventory'],
  [/^\/gold-rate$/, goldRatePage, 'Gold Rate', '/gold-rate'],
  [/^\/settings$/, settingsPage, 'Settings', '/settings'],
];

const view = $('#view');
let renderToken = 0;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, query = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

async function renderRoute() {
  const { path, query } = parseHash();
  const token = ++renderToken;
  const match = ROUTES.map(([re, page, title, nav]) => ({ m: path.match(re), page, title, nav })).find((r) => r.m);
  if (!match) { navigate('/dashboard'); return; }
  $$('#nav a, #bottom-nav a').forEach((a) => a.classList.toggle('active', a.dataset.path === match.nav));
  document.title = `${match.title} · RA Jewellers`;
  mount(view, html`<div class="card card-body"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div>`);
  try {
    await match.page({ el: view, params: match.m.slice(1), query, isCurrent: () => token === renderToken });
    if (token === renderToken) window.scrollTo(0, 0);
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    mount(view, html`<div class="card card-body"><h2>Something went wrong</h2><p class="muted" style="margin:6px 0 14px">${err.message}</p>
      <button class="btn" id="retry">Try again</button></div>`);
    $('#retry')?.addEventListener('click', renderRoute);
  }
}

// ----------------------------------------------------------------- sidebar
mount($('#nav'), html`${NAV.map(([ic, label, path]) => html`<a href="#${path}" data-path="${path}">${icon(ic)}<span>${label}</span></a>`)}`);

// ------------------------------------------------------- responsive shell
const bodyEl = document.body;
const menuBtn = $('#menu-btn');
const setDrawer = (open) => { bodyEl.classList.toggle('drawer-open', open); menuBtn.setAttribute('aria-expanded', String(open)); };
menuBtn.addEventListener('click', () => setDrawer(!bodyEl.classList.contains('drawer-open')));
$('#scrim').addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
window.addEventListener('hashchange', () => setDrawer(false));

const svg = (d) => raw(`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`);
const BOTTOM = [['dashboard', 'Home', '/dashboard'], ['orders', 'Orders', '/orders'], ['new', 'New', '/orders/new'], ['customers', 'Customers', '/customers']];
mount($('#bottom-nav'), html`${BOTTOM.map(([ic, label, path]) => html`<a href="#${path}" data-path="${path}" class="${ic === 'new' ? 'bn-new' : ''}">${ic === 'new' ? svg('M12 5v14M5 12h14') : icon(ic, 22)}<span>${label}</span></a>`)}
  <button type="button" id="bn-more">${svg('M5 12h.01M12 12h.01M19 12h.01')}<span>More</span></button>`);
$('#bn-more').addEventListener('click', () => setDrawer(true));

// Tables collapse into stacked cards on phones (CSS); label each cell from its column header.
function labelCells(root) {
  root.querySelectorAll('table.tbl').forEach((t) => {
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (!heads.length) return;
    t.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => {
      if (heads[i] && td.dataset.label !== heads[i]) td.dataset.label = heads[i];
    }));
  });
}
let labelQueued = false;
new MutationObserver(() => {
  if (labelQueued) return;
  labelQueued = true;
  requestAnimationFrame(() => { labelQueued = false; labelCells(document); });
}).observe(document.body, { childList: true, subtree: true });

// ------------------------------------------------------------- gold rate chips
async function loadRateChips() {
  try {
    const { items } = await api.get('/api/gold-rates/current');
    mount($('#rate-chips'), html`${items.filter((r) => r.purity !== '18K').map((r) => html`
      <a class="rate-chip" href="#/gold-rate" title="Updated ${r.effective_date}">
        <span>${r.purity}</span><b>${inr(r.rate_per_gram)}/g</b>
        ${r.change ? html`<span class="${r.change > 0 ? 'up' : 'down'}">${r.change > 0 ? '▲' : '▼'}</span>` : ''}
      </a>`)}`);
  } catch { /* the chips are decorative; the pages report real errors */ }
}

// ---------------------------------------------------------------- global search
const searchInput = $('#global-search');
const results = $('#search-results');
const hideResults = () => { results.hidden = true; };

async function runSearch() {
  const text = searchInput.value.trim();
  if (!text) return hideResults();
  const digits = text.replace(/\D/g, '');
  const isPhone = digits.length >= 10 && /^[\d\s+-]+$/.test(text);
  try {
    if (isPhone) {
      const c = await api.get('/api/customers/lookup', { phone: digits }).catch(() => null);
      if (c) { navigate(`/customers/${c.id}`); searchInput.value = ''; return hideResults(); }
      mount(results, html`<div class="item" id="add-from-search"><span>No customer with <b>${digits.slice(-10)}</b></span><span class="bold" style="color:var(--maroon)">+ Add customer</span></div>`);
      results.hidden = false;
      $('#add-from-search').onclick = () => { hideResults(); openCustomerForm({ phone: digits.slice(-10) }); };
      return;
    }
    const { items } = await api.get('/api/customers', { q: text, limit: 6 });
    mount(results, items.length
      ? html`${items.map((c) => html`<a href="#/customers/${c.id}"><span>${c.name}<br><span class="muted small">${c.city || ''}</span></span><span class="muted">${c.phone}</span></a>`)}`
      : html`<div class="item muted">No matching customers</div>`);
    results.hidden = false;
  } catch (err) { toast(err.message, 'error'); }
}
searchInput.addEventListener('input', debounce(runSearch, 220));
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); if (e.key === 'Escape') hideResults(); });
results.addEventListener('click', () => setTimeout(() => { hideResults(); searchInput.value = ''; }, 0));
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) hideResults(); });

// ------------------------------------------------------------------- go
window.addEventListener('hashchange', renderRoute);
window.addEventListener('app:refresh', renderRoute);
window.addEventListener('app:rates-changed', loadRateChips);
loadRateChips();
renderRoute();
