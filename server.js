'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Optional local .env (Supabase credentials etc.) — never committed (see .env.example). Existing
// process env vars always win, so `SUPABASE_URL=... npm start` still overrides it as usual. This runs
// before any of this project's own modules are required, since some read process.env at load time.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = (m[2] || '').trim().replace(/^["']|["']$/g, '');
  }
}

const { HttpError } = require('./src/util');
const { categorySvg } = require('./src/images');
const { seed, hasData } = require('./src/seed');
const routes = require('./src/routes');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!hasData()) {
  console.log('Empty database — loading demo data…');
  seed();
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
};

// Compile "/api/orders/:id/payments" into a matcher once.
const table = routes.map(([method, pattern, handler]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { method, re, keys, handler };
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'Request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

// The storefront (a separate site/host, e.g. on Vercel) reads the catalogue cross-origin — only these
// read-only routes need it, everything else in the admin API stays same-origin.
const PUBLIC_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' };

/** Turn database errors into messages a shop owner can act on. */
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  const msg = String(err.message || '');
  if (/UNIQUE constraint failed/.test(msg)) {
    const field = msg.split('.').pop();
    return new HttpError(409, `That ${field.replace(/_/g, ' ')} is already in use`);
  }
  if (/immutable|cannot be deleted/.test(msg)) return new HttpError(409, msg.replace(/^.*?:\s*/, ''));
  if (/CHECK constraint failed|NOT NULL constraint failed|FOREIGN KEY constraint failed/.test(msg)) return new HttpError(400, `Invalid data (${msg})`);
  return null;
}

async function handleApi(req, res, url) {
  const isPublic = url.pathname.startsWith('/api/public/');
  const cors = isPublic ? PUBLIC_CORS : {};
  if (isPublic && req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const route = table.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route) {
    const otherMethod = table.some((r) => r.re.test(url.pathname));
    return send(res, otherMethod ? 405 : 404, { error: otherMethod ? 'Method not allowed' : 'Unknown API route' }, cors);
  }
  const match = url.pathname.match(route.re);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    const query = Object.fromEntries(url.searchParams);
    send(res, 200, route.handler({ params, query, body }), cors);
  } catch (err) {
    const http = toHttpError(err);
    if (http) return send(res, http.status, { error: http.message, details: http.details }, cors);
    console.error(`${req.method} ${url.pathname} failed:`, err);
    send(res, 500, { error: 'Something went wrong on the server' }, cors);
  }
}

function serveStatic(req, res, url) {
  const svg = url.pathname.match(/^\/img\/category\/([a-z0-9-]+)\.svg$/);
  if (svg) {
    res.writeHead(200, { 'Content-Type': MIME['.svg'], 'Cache-Control': 'no-cache' });
    return res.end(categorySvg(svg[1]));
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  serveStatic(req, res, url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — the demo may already be running at http://localhost:${PORT}.`);
    console.error(`  Open that address, or start a second copy on another port:  PORT=${PORT + 1} npm start`);
    console.error(`  (PowerShell:  $env:PORT=${PORT + 1}; npm start)\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  RA Jewellers demo running at  http://localhost:${PORT}\n`);
});
