# RA Jewellers — Store Management (working demo)

An end-to-end demo of a jewellery-store management system built around one idea: **the Order is the transaction.**
Products, customers, payments, delivery, stock and the final bill all hang off it.

```
Product → Customer → Order → Payments → Delivery → Final Bill
```

## Run it

Requires **Node.js 22.13 or newer**. There is nothing to install — no `npm install`, no database server.

```bash
npm start
```

Open **http://localhost:3000**. The first start creates `data/jewellery.db` and loads the sample data.

| Command | What it does |
| --- | --- |
| `npm start` | Start the app on port 3000 (`PORT=4000 npm start` to change it) |
| `npm test` | Run the lifecycle tests (in-memory database, ~0.2 s) |
| `npm run reset` | Wipe the database and reload the sample data (also available in **Settings**) |

> The sample data is dated relative to the day it is created, so "due today" and "overdue" always make sense.
> If the project lives in a cloud-synced folder (OneDrive etc.), point the database somewhere local with `DB_PATH=C:\data\jewellery.db npm start`.

## How it works

There are two ways a customer buys, and both end in the same **final bill**.

**Order** — the customer books ahead, pays in instalments (or all at once) to secure the pieces, and collects on the delivery date.

```
Order Placed → Accepted → Ready for Delivery → Delivered  (final bill created automatically)
```

- **Payment is tracked separately** from the order status: *Unpaid → Partly paid → Paid*. Take any number of payments, in any amounts, before or after the order is accepted.
- The **delivery date can be changed** any time before delivery.
- **Deliver** needs the balance to be zero — the last payment can be taken in the same step. Delivery reduces stock and generates the final bill automatically.
- An open order can be **cancelled**; reserved stock is released and payments already taken stay in the history.

**Walk-in bill** (Billing → *New Bill*) — the customer is in the shop: pick the customer and items, take the full payment, done. The sale is placed, paid, delivered and billed in one step.

### The price formula

One formula for every order and bill, **fixed on the day the order is placed** — later gold-rate changes never touch a placed order.

```
gold value = net weight (g) × gold rate of that day (₹/g)
making     = net weight (g) × the product's making rate (₹/g)
GST        = GST% × (gold value + making)                  → 3% by default
total      = gold value + making + GST + other charges     (other charges: optional, no GST)
```

Every amount is rounded to the rupee. The only pricing setting is the GST rate (Settings); a new rate applies to orders placed from then on.
Example: 10 g at ₹14,720/g with ₹850/g making → ₹1,47,200 + ₹8,500 + ₹4,671 GST = **₹1,60,371**.

- Payments are stored as the **rupee amount received** (with method, date and reference) and are **append-only**: the database rejects edits and deletes.
- Gold rates are **dated and never overwritten** — an order is priced with the rate effective on its order date.
- A bill is created only from a delivered, fully paid order and cannot be edited afterwards.

**Stock** is tracked as *on hand*, *reserved* (held for open orders), *available* (= on hand − reserved) and *sold*. Placing an order reserves stock; cancelling releases it; delivery consumes it.
Every change is written to the stock-movement ledger with the previous quantity, change, type, reason and related order.

## Try it (2 minutes)

The dashboard has this as a guided card. The scenario is Rahul Das — 22K Classic Gold Chain, 10 g, ordered at ₹14,720/g with a ₹50,000 UPI payment.

1. **Orders → ORD-…-0007 (Rahul Das)**: total ₹1,60,371, paid ₹50,000, balance ₹1,10,371 — the price stays as booked whatever the gold rate does.
2. **Mark Ready**, then **Deliver** → take the balance. The order becomes *Delivered*, stock drops by one and the **final bill is generated automatically**.
3. Check **Customers → Rahul Das → Final bills**, the **Dashboard** (outstanding has fallen by ₹1,10,371) and **Inventory → Stock movements** (`Reserve` then `Sale`).
4. **Billing → New Bill** for a walk-in customer, **+ New Order** to book one (new customers are added on the spot), **Inventory → Out of stock → Restock**.

> Upgrading from an older version? The first start after this change saves your previous database next to it
> (`data/jewellery.db-backup-pre-v2-…`) and loads the demo data again, because the order model changed shape.

## Data model

SQLite (`src/schema.sql`): `customers`, `categories` (category → subcategory), `products`, `gold_rates`, `pricing_settings`, `orders`, `order_items`, `payments`, `bills`, `stock_movements`, `order_events` (the order timeline).

- `products.net_gold_weight` and `available_quantity` are **generated columns** — derived from gross − stone and on-hand − reserved, never stored by hand.
- Order items and bills store a **snapshot** of the product, so later catalogue edits cannot rewrite history.

## Code map

```
server.js              HTTP server (no framework), static files, JSON errors
src/schema.sql         relational schema
src/services/          pricing · orders · sales (walk-in bills) · products (catalogue + stock) · customers · bills · goldrates · settings · dashboard · market
src/routes.js          REST API (see below)
src/seed.js            sample data, replayed through the real services with a back-dated clock
public/                single-page app in plain ES modules (no build step)
test/lifecycle.test.js end-to-end tests of the rules above
```

<details><summary>REST API</summary>

`GET /api/dashboard` · `GET /api/dashboard/outstanding?sort=&filter=`
`GET|POST /api/customers` · `GET /api/customers/lookup?phone=` · `GET|PUT|DELETE /api/customers/:id`
`GET|POST /api/categories` · `PUT /api/categories/:id`
`GET|POST /api/products` · `GET|PUT|DELETE /api/products/:id` · `POST /api/products/:id/stock`
`GET /api/inventory/summary` · `GET /api/inventory/movements`
`GET|POST /api/orders` · `POST /api/orders/preview` · `GET /api/orders/:id` · `PUT /api/orders/:id/delivery-date`
`POST /api/orders/:id/{accept|payments|ready|deliver|cancel}`
`POST /api/sales` (walk-in bill) · `GET /api/billing/overview` · `GET /api/bills` · `GET /api/bills/:id`
`GET /api/gold-rates` · `GET /api/gold-rates/current` · `POST /api/gold-rates`
`GET|PUT /api/settings` · `POST /api/admin/reset`
`GET /api/public/categories` · `GET /api/public/products` (CORS-enabled, read-only — see "Public website")

</details>

## Sample data

8 customers · 28 products in 10 categories (22 subcategories) · 10 orders in different states (placed, accepted and part-paid, overdue, due today, ready for delivery, delivered ×3, cancelled) plus a walk-in bill · payments by cash, UPI, card and bank transfer · a month of 24K/22K/18K rate history · 2 low-stock and 2 out-of-stock products.
Shop name, address and GSTIN on bills are placeholders (editable in Settings).

## Public website (Supabase sync)

Every product supports **multiple photos** — a gallery, reorderable in the catalogue form, with the first photo used as the thumbnail everywhere.

The separate storefront (a different codebase, e.g. on Vercel) does **not** talk to this admin server directly — it reads from **Supabase** instead, so this admin app never needs to be a public, always-on host. Whenever a product is created, edited, restocked or its status changes, this app pushes a copy to Supabase in the background. Nothing here breaks if Supabase isn't configured — the sync is a no-op until you set the environment variables below.

**One-time Supabase setup** (free tier is enough):

1. Create a project at [supabase.com](https://supabase.com).
2. **Storage** → create a bucket named `product-images`, set it **Public**.
3. **SQL editor** → run:
   ```sql
   create table products_public (
     id integer primary key,
     name text, slug text, sku text, gender text,
     category text, subcategory text, metal_type text, purity text,
     net_gold_weight numeric, making_charge numeric, description text,
     images jsonb, in_stock boolean, is_active boolean,
     updated_at timestamptz
   );
   alter table products_public enable row level security;
   create policy "public read" on products_public for select using (true);

   create table gold_rates_public (
     purity text primary key,
     rate_per_gram numeric not null,
     effective_date date,
     updated_at timestamptz
   );
   alter table gold_rates_public enable row level security;
   create policy "public read" on gold_rates_public for select using (true);
   ```
   Already have `products_public` from an earlier setup and just need the new columns? Run instead:
   ```sql
   alter table products_public add column if not exists description text;
   -- then the two gold_rates_public statements above
   ```
4. **Project Settings → API** → copy the Project URL and the `service_role` key (server-side only — never expose it in the Vercel site's frontend code).
5. Start this app with those values set:
   ```bash
   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... npm start
   ```
   (PowerShell: `$env:SUPABASE_URL="https://xxxx.supabase.co"; $env:SUPABASE_SERVICE_KEY="eyJ..."; npm start`)

Save or edit any product afterwards and it appears in the `products_public` Supabase table, with images uploaded to the `product-images` bucket. Saving a gold rate in the Gold Rate master similarly mirrors the 24K/22K/18K rates into `gold_rates_public`. The Vercel site then queries Supabase directly with its own **anon** key (Project Settings → API → "anon public" — safe to expose client-side, RLS above only allows reads):

```js
const { data } = await supabase.from('products_public').select('*').eq('is_active', true).eq('in_stock', true);
```

The `ra-jewellery-demo` storefront reads `description` for its product page's copy and `gold_rates_public` for a live price break-up, in place of `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` demo fallback values — set those two env vars there (locally in `.env.local`, and in that project's Vercel settings) once this table exists.

If you'd rather have the storefront hit this server directly (e.g. it's deployed somewhere with a persistent disk, like Fly.io), it can instead call this app's own CORS-enabled, read-only endpoints — no Supabase needed:

`GET /api/public/categories` · `GET /api/public/products?gender=&category_id=`

## Deliberately out of scope for the demo

Login and roles · refunds for cancelled orders (the advance stays in the history and is flagged) · multi-store · old-gold exchange and karigar/job-work · server-side PDF files (the bill prints from the browser) · barcode-scanner input · GST e-invoicing/HSN detail · pagination beyond a few hundred rows.
Money is stored as rupees rounded to paise in SQLite `REAL`; a production system would move to integer paise or `NUMERIC` on PostgreSQL. The service layer is where those changes would live — the UI and API would not need to change.
