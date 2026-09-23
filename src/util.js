'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const bad = (msg, details) => new HttpError(400, msg, details);
const notFound = (what) => new HttpError(404, `${what} not found`);
const conflict = (msg, details) => new HttpError(409, msg, details);

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const pad = (n, w) => String(n).padStart(w, '0');

// ---- Clock -----------------------------------------------------------------
// All "now"/"today" reads go through here so the seed script can back-date history.
const clock = (() => {
  let override = null;
  const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  return {
    now: () => (override ? new Date(override) : new Date()),
    today() { return localDate(this.now()); },
    timestamp() {
      const d = this.now();
      return `${localDate(d)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
    },
    /** iso: 'YYYY-MM-DDTHH:MM:SS' in local time */
    setNow(iso) { override = new Date(iso); },
    reset() { override = null; },
  };
})();

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1, 2)}-${pad(dt.getDate(), 2)}`;
}

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + 'T00:00:00');
  const b = new Date(toIso + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// ---- Formatting (server-side, for event messages and bill text) ------------
const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const inr = (n) => '₹' + inrFmt.format(n);

// ---- Amount in words, Indian numbering (lakh / crore) ---------------------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}
function integerInWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const units = [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']];
  for (const [size, label] of units) {
    const q = Math.floor(n / size);
    if (q) { parts.push(below1000(q) + ' ' + label); n %= size; }
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
function amountInWords(amount) {
  const rupees = Math.floor(amount + 1e-9);
  const paise = Math.round((amount - rupees) * 100);
  let out = 'Rupees ' + integerInWords(rupees);
  if (paise) out += ' and ' + below100(paise) + ' Paise';
  return out + ' Only';
}

// ---- EAN-13 barcode --------------------------------------------------------
function ean13(base12) {
  const digits = String(base12).padStart(12, '0').slice(-12).split('').map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return digits.join('') + ((10 - (sum % 10)) % 10);
}

// ---- Input helpers ---------------------------------------------------------
const str = (v) => (v == null ? null : String(v).trim() || null);
function num(v, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`${label} must be a number`);
  if (integer && !Number.isInteger(n)) throw bad(`${label} must be a whole number`);
  if (n < min) throw bad(`${label} must be at least ${min}`);
  if (n > max) throw bad(`${label} must be at most ${max}`);
  return n;
}
function normalizePhone(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
}

module.exports = {
  HttpError, bad, notFound, conflict, round2, round3, pad, clock, addDays, daysBetween, isIsoDate,
  inr, amountInWords, ean13, str, num, normalizePhone,
};
