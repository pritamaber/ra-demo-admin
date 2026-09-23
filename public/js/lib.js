// Shared helpers: safe HTML templating, API client, formatting, badges, modal, toast.

// ---------------------------------------------------------------- templating
// html`...` escapes every interpolated value unless it is itself html`...` output (or raw()).
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
const toHtml = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(toHtml).join('') : v == null || v === false ? '' : esc(v));
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += toHtml(v) + strings[i + 1]; });
  return new Raw(out);
}
export const mount = (el, tpl) => { el.innerHTML = tpl instanceof Raw ? tpl.s : String(tpl); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------- API
export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data.details;
    throw err;
  }
  return data;
}
const qs = (params) => {
  const p = Object.entries(params || {}).filter(([, v]) => v !== '' && v != null);
  return p.length ? '?' + new URLSearchParams(p).toString() : '';
};
api.get = (url, params) => api('GET', url + qs(params));
api.post = (url, body) => api('POST', url, body || {});
api.put = (url, body) => api('PUT', url, body || {});
api.del = (url) => api('DELETE', url);

// ------------------------------------------------------------ formatting
const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const inrFmt2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export const inr = (n) => (n == null || Number.isNaN(n) ? '—' : (n < 0 ? '-₹' : '₹') + inrFmt.format(Math.abs(n)));
export const inr2 = (n) => (n == null ? '—' : (n < 0 ? '-₹' : '₹') + inrFmt2.format(Math.abs(n)));
export const grams = (n, dp = 3) => (n == null ? '—' : Number(n).toFixed(dp) + ' g');
export const perGram = (n) => (n == null ? '—' : inr(n) + '/g');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso, withYear = true) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ' ' + y : ''}`;
}
export function fmtDateTime(ts) {
  if (!ts) return '—';
  return `${fmtDate(ts)} · ${ts.slice(11, 16)}`;
}
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
export function relDays(n) {
  if (n == null) return '';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
export const makingUnit = (method) => ({ per_gram: '₹ per gram', fixed_per_piece: '₹ per piece', percent_of_gold: '% of gold value' }[method] || '');
export const makingText = (method, rate) => (method === 'fixed_per_piece' ? `${inr(rate)}/piece` : method === 'percent_of_gold' ? `${rate}%` : `${inr(rate)}/g`);
export const initials = (name) => name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

// ---------------------------------------------------------------- badges
const STATUS = {
  DRAFT: ['Draft', 'gray'], CONFIRMED: ['Confirmed', 'blue'], ADVANCE_RECEIVED: ['Advance Received', 'amber'],
  PARTIALLY_PAID: ['Partially Paid', 'orange'], READY_FOR_DELIVERY: ['Ready for Delivery', 'teal'], FULLY_PAID: ['Fully Paid', 'green'],
  DELIVERED: ['Delivered', 'green'], BILLED: ['Final Bill Generated', 'purple'], CANCELLED: ['Cancelled', 'red'],
};
export const STATUS_FLOW = ['DRAFT', 'CONFIRMED', 'ADVANCE_RECEIVED', 'PARTIALLY_PAID', 'READY_FOR_DELIVERY', 'FULLY_PAID', 'DELIVERED', 'BILLED'];
export const statusLabel = (s) => STATUS[s]?.[0] || s;
export const statusBadge = (s) => html`<span class="badge ${STATUS[s]?.[1] || 'gray'}">${STATUS[s]?.[0] || s}</span>`;
export const dueBadge = (flag) => ({
  OVERDUE: html`<span class="badge red">Overdue</span>`,
  DUE_TODAY: html`<span class="badge amber">Due Today</span>`,
  DUE_SOON: html`<span class="badge yellow">Due Soon</span>`,
}[flag] || '');
export const stockBadge = (s) => ({
  OUT_OF_STOCK: html`<span class="badge red">Out of Stock</span>`,
  LOW_STOCK: html`<span class="badge amber">Low Stock</span>`,
  IN_STOCK: html`<span class="badge green">In Stock</span>`,
}[s] || '');
export const paymentBadge = (s) => ({
  UNPAID: html`<span class="badge gray">Unpaid</span>`,
  PARTIALLY_PAID: html`<span class="badge orange">Partially Paid</span>`,
  FULLY_PAID: html`<span class="badge green">Fully Paid</span>`,
}[s] || '');
export const moveBadge = (t) => {
  const color = { OPENING: 'gray', RESTOCK: 'green', ADJUSTMENT: 'blue', RESERVE: 'amber', RELEASE: 'teal', SALE: 'purple' }[t] || 'gray';
  return html`<span class="badge ${color}">${t.charAt(0) + t.slice(1).toLowerCase()}</span>`;
};

// ------------------------------------------------------------ toast/modal
export function toast(message, kind = 'ok') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 6000 : 3500);
  setTimeout(() => el.remove(), kind === 'error' ? 6400 : 3900);
}

/** Opens a modal and returns { el, close }. `content` is html`` for the body; pass `onOpen(el, close)` to bind events. */
export function openModal({ title, content, size = '', onOpen }) {
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = html`
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-head"><h3>${title}</h3><button class="icon-btn" data-close aria-label="Close">×</button></div>
      <div class="modal-body">${content}</div>
    </div>`.s;
  root.appendChild(wrap);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  $$('[data-close]', wrap).forEach((b) => b.addEventListener('click', close));
  document.addEventListener('keydown', onKey);
  onOpen?.(wrap, close);
  const first = $('input:not([type=hidden]):not([readonly]), select, textarea', wrap);
  first?.focus();
  return { el: wrap, close };
}

/** Fullscreen image viewer: scroll/swipe horizontally through `images`, starting at `index`. */
export function openLightbox(images, index = 0, alt = '') {
  if (!images?.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'lightbox';
  mount(wrap, html`
    <button type="button" class="lightbox-close" aria-label="Close" data-close>×</button>
    ${images.length > 1 ? html`<div class="lightbox-count">${index + 1} / ${images.length}</div>` : ''}
    ${images.length > 1 ? html`<button type="button" class="lightbox-nav prev" aria-label="Previous image" data-prev>‹</button>` : ''}
    <div class="lightbox-track">${images.map((src) => html`<div class="lightbox-slide"><img src="${src}" alt="${alt}"></div>`)}</div>
    ${images.length > 1 ? html`<button type="button" class="lightbox-nav next" aria-label="Next image" data-next>›</button>` : ''}
  `);
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  const track = $('.lightbox-track', wrap);
  const countEl = $('.lightbox-count', wrap);
  let current = index;
  const slideTo = (i, smooth = true) => {
    current = Math.max(0, Math.min(images.length - 1, i));
    track.scrollTo({ left: current * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    if (countEl) countEl.textContent = `${current + 1} / ${images.length}`;
  };
  slideTo(index, false);
  // A plain vertical mouse wheel has no deltaX, so redirect it to horizontal scroll;
  // trackpad/touch swipes already produce deltaX and pass through untouched.
  track.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      track.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  let scrollTimer;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      current = Math.round(track.scrollLeft / track.clientWidth);
      if (countEl) countEl.textContent = `${current + 1} / ${images.length}`;
    }, 80);
  });
  const close = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    document.body.style.overflow = '';
    wrap.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') slideTo(current + 1);
    else if (e.key === 'ArrowLeft') slideTo(current - 1);
  };
  const onResize = () => slideTo(current, false);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  $$('[data-close]', wrap).forEach((b) => b.addEventListener('click', close));
  $('[data-prev]', wrap)?.addEventListener('click', () => slideTo(current - 1));
  $('[data-next]', wrap)?.addEventListener('click', () => slideTo(current + 1));
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v, close) => { if (!settled) { settled = true; resolve(v); } close?.(); };
    const { el, close } = openModal({
      title,
      content: html`<p class="modal-text">${message}</p>
        <div class="modal-actions"><button class="btn" data-no>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${confirmLabel}</button></div>`,
    });
    $('[data-yes]', el).addEventListener('click', () => done(true, close));
    $('[data-no]', el).addEventListener('click', () => done(false, close));
    new MutationObserver(() => { if (!document.body.contains(el)) done(false); }).observe($('#modal-root'), { childList: true });
  });
}

// ------------------------------------------------------------------ forms
/** Reads a form into an object; blank fields become null. */
export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v;
  return out;
}

/** Wires a form: disables the submit button while `handler` runs and shows server errors inline. */
export function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    const errBox = $('.form-error', form);
    if (errBox) errBox.textContent = '';
    if (btn) btn.disabled = true;
    try {
      await handler(formData(form), e);
    } catch (err) {
      if (errBox) errBox.textContent = err.message;
      else toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

export const debounce = (fn, ms = 250) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

export const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');

/** Reads an image file from the user's device, downscales it and returns a JPEG data URL — small enough to store inline. */
export function readImageAsDataUrl(file, { maxDim = 720, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a valid image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale) || 1;
        const h = Math.round(img.height * scale) || 1;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------- navigation
export const navigate = (path) => { location.hash = '#' + path; };
export const refresh = () => window.dispatchEvent(new Event('app:refresh'));
export const ratesChanged = () => window.dispatchEvent(new Event('app:rates-changed'));

export const empty = (title, hint = '') => html`<div class="empty"><div class="empty-title">${title}</div>${hint ? html`<div class="empty-hint">${hint}</div>` : ''}</div>`;

export const waLink = (phone, text) => `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
export const link = (href, text, cls = '') => html`<a href="#${href}" class="${cls}">${text}</a>`;

export const ICONS = {
  dashboard: 'M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10',
  orders: 'M9 4h6a1 1 0 011 1v1H8V5a1 1 0 011-1zM6 6h12v15H6zM9 11h6M9 15h6',
  billing: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  customers: 'M16 19v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 19v-1a4 4 0 00-3-3.9M15.5 4.2a3.5 3.5 0 010 6.6',
  catalog: 'M6 3h12l3 6-9 12L3 9zM3 9h18M9 3l3 18M15 3l-3 18',
  inventory: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  gold: 'M4 18h16M6 18l2-6h8l2 6M9 12l1.5-5h3L15 12',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.5-4.5',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z',
  plus: 'M12 5v14M5 12h14',
  print: 'M7 9V3h10v6M6 18H4v-7h16v7h-2M7 14h10v7H7z',
  whatsapp: 'M4 20l1.3-4.1A8 8 0 1112 20a8 8 0 01-3.8-1zM9 9c0 3 3 6 6 6l1-1.5-2-1-1 .8c-1-.4-2-1.4-2.4-2.4l.8-1-1-2z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z M12 15a3 3 0 100-6 3 3 0 000 6z',
};
export const icon = (name, size = 18) => raw(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`);
