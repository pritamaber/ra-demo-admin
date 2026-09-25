-- RA Jewellers demo — relational schema (SQLite).
-- Money is stored in rupees (REAL, rounded to paise by the service layer).
-- Weights are grams. Dates are ISO 'YYYY-MM-DD'; timestamps are 'YYYY-MM-DD HH:MM:SS' local time.

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL UNIQUE,          -- primary search key (10-digit mobile)
  alternate_phone TEXT,
  address         TEXT,
  city            TEXT,
  dob             TEXT,
  anniversary     TEXT,
  is_premium      INTEGER NOT NULL DEFAULT 0,     -- flagged VIP / high-value customer
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Two-level hierarchy: jewellery category (parent NULL) -> subcategory.
-- `gender` on a subcategory marks its intended audience (NULL = all).
CREATE TABLE IF NOT EXISTS categories (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  parent_category_id INTEGER REFERENCES categories(id),
  gender             TEXT CHECK (gender IS NULL OR gender IN ('Men','Women','Kids','Unisex')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  sort_order         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique ON categories (COALESCE(parent_category_id, 0), name);

CREATE TABLE IF NOT EXISTS products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sku               TEXT NOT NULL UNIQUE,
  barcode           TEXT UNIQUE,
  name              TEXT NOT NULL,
  gender            TEXT NOT NULL CHECK (gender IN ('Men','Women','Kids','Unisex')),
  category_id       INTEGER NOT NULL REFERENCES categories(id),
  subcategory_id    INTEGER REFERENCES categories(id),
  image_url         TEXT,
  description       TEXT,  -- shown on the public website's product page
  metal_type        TEXT NOT NULL DEFAULT 'Gold',
  purity            TEXT NOT NULL DEFAULT '22K',
  gross_weight      REAL NOT NULL CHECK (gross_weight > 0),
  stone_weight      REAL NOT NULL DEFAULT 0 CHECK (stone_weight >= 0),
  -- Derived, never entered by hand: net gold = gross - stone
  net_gold_weight   REAL GENERATED ALWAYS AS (round(gross_weight - stone_weight, 3)) VIRTUAL,
  making_charge     REAL NOT NULL DEFAULT 0 CHECK (making_charge >= 0),  -- rupees per gram of net gold
  stock_quantity    INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),     -- physically in the shop (includes reserved)
  reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),  -- held for open orders
  available_quantity INTEGER GENERATED ALWAYS AS (stock_quantity - reserved_quantity) VIRTUAL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (stone_weight <= gross_weight),
  CHECK (reserved_quantity <= stock_quantity)
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id, subcategory_id);
CREATE INDEX IF NOT EXISTS idx_products_gender ON products (gender);

-- A product's photo gallery. products.image_url always mirrors sort_order = 0 here, kept for quick access.
CREATE TABLE IF NOT EXISTS product_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images (product_id, sort_order);

CREATE TABLE IF NOT EXISTS gold_rates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  purity         TEXT NOT NULL CHECK (purity IN ('24K','22K','18K')),
  rate_per_gram  REAL NOT NULL CHECK (rate_per_gram > 0),
  effective_date TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL
);
-- Append-only history: the applicable rate for a date is the latest row with effective_date <= that date.
CREATE INDEX IF NOT EXISTS idx_gold_rates_lookup ON gold_rates (purity, effective_date, id);

CREATE TABLE IF NOT EXISTS pricing_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Gold-first settlement. At booking: gold = net weight x that day's gold rate, making = net weight x making rate,
-- gst = gst% x (gold + making), total = gold + making + gst + other, rounded to the rupee (round_off).
-- Every payment then buys gold at ITS day's rate (payments.gold_fraction / gold_amount); the gold still unpaid is
-- valued at today's rate, so the order's current figures move with the market until all the gold is paid for.
-- orders.total_amount / gst / subtotal / outstanding_amount are those CURRENT figures; booked_total is the original quote.
CREATE TABLE IF NOT EXISTS orders (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number           TEXT NOT NULL UNIQUE,
  customer_id            INTEGER NOT NULL REFERENCES customers(id),
  kind                   TEXT NOT NULL DEFAULT 'ORDER' CHECK (kind IN ('ORDER','SALE')),  -- SALE = walk-in bill, settled on the spot
  status                 TEXT NOT NULL CHECK (status IN ('PLACED','ACCEPTED','READY','DELIVERED','CANCELLED')),
  order_date             TEXT NOT NULL,
  expected_delivery_date TEXT,
  actual_delivery_date   TEXT,
  order_gold_rate        REAL,     -- rate locked when the order was placed (first item's purity)
  subtotal               REAL NOT NULL DEFAULT 0,      -- gold value
  making_charge          REAL NOT NULL DEFAULT 0,
  gst                    REAL NOT NULL DEFAULT 0,
  gst_rate               REAL NOT NULL DEFAULT 3,
  other_charges          REAL NOT NULL DEFAULT 0,
  other_charges_note     TEXT,
  round_off              REAL NOT NULL DEFAULT 0,      -- total rounded to the nearest rupee: total = gold + making + gst + other + round_off
  total_amount           REAL NOT NULL DEFAULT 0,      -- current total at today's gold rate for the unpaid gold
  booked_total           REAL NOT NULL DEFAULT 0,      -- the quote on the order date; never changes
  paid_amount            REAL NOT NULL DEFAULT 0,      -- actual money received
  outstanding_amount     REAL NOT NULL DEFAULT 0,
  notes                  TEXT,
  cancel_reason          TEXT,
  cancelled_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_delivery ON orders (expected_delivery_date);

CREATE TABLE IF NOT EXISTS order_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id              INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id            INTEGER NOT NULL REFERENCES products(id),
  -- Product snapshot: the bill must show the piece as it was sold even if the catalogue changes later.
  product_name          TEXT NOT NULL,                 -- as sold; the shopkeeper can edit it per order
  description           TEXT,
  sku                   TEXT NOT NULL,
  barcode               TEXT,
  metal_type            TEXT NOT NULL,
  purity                TEXT NOT NULL,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  gross_weight          REAL NOT NULL,                 -- per piece
  stone_weight          REAL NOT NULL,                 -- per piece
  net_gold_weight       REAL GENERATED ALWAYS AS (round(gross_weight - stone_weight, 3)) VIRTUAL,
  making_rate           REAL NOT NULL,                 -- rupees per gram of net gold
  gold_rate             REAL NOT NULL,                 -- rupees per gram on the order date
  gold_value            REAL NOT NULL,
  making_charge         REAL NOT NULL,
  gst                   REAL NOT NULL,
  total                 REAL NOT NULL,
  -- Final figures, filled in when the order is delivered (gold bought at each payment's rate)
  settled_gold_rate     REAL,
  settled_gold_value    REAL,
  settled_gst           REAL,
  settled_total         REAL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);

CREATE TABLE IF NOT EXISTS payments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id             INTEGER NOT NULL REFERENCES orders(id),
  amount               REAL NOT NULL CHECK (amount > 0),
  payment_method       TEXT NOT NULL CHECK (payment_method IN ('Cash','UPI','Card','Bank Transfer','Other')),
  payment_date         TEXT NOT NULL,
  gold_rate            REAL NOT NULL DEFAULT 0,        -- gold rate of the payment day (average ₹/g across the order's items)
  gold_fraction        REAL NOT NULL DEFAULT 0,        -- share of the order's gold this payment bought (amount ÷ value of the whole gold that day)
  gold_amount          REAL NOT NULL DEFAULT 0,        -- rupees of this payment that bought gold (the rest went to making / GST)
  reference_number     TEXT,
  notes                TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments (payment_date);

-- Payment history is append-only: records are never edited or removed.
CREATE TRIGGER IF NOT EXISTS payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'Payment records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'Payment records cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS bills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_number  TEXT NOT NULL UNIQUE,
  order_id     INTEGER NOT NULL UNIQUE REFERENCES orders(id),   -- a bill is created automatically when an order is delivered
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  bill_date    TEXT NOT NULL,
  total_amount REAL NOT NULL,
  generated_at TEXT NOT NULL,
  snapshot     TEXT NOT NULL                                    -- the document exactly as issued
);
CREATE INDEX IF NOT EXISTS idx_bills_customer ON bills (customer_id);

CREATE TRIGGER IF NOT EXISTS bills_no_update BEFORE UPDATE ON bills
BEGIN SELECT RAISE(ABORT, 'Issued bills are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bills_no_delete BEFORE DELETE ON bills
BEGIN SELECT RAISE(ABORT, 'Issued bills cannot be deleted'); END;

-- counter: which quantity the movement changed. 'stock' = on hand, 'reserved' = held for orders.
CREATE TABLE IF NOT EXISTS stock_movements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  counter           TEXT NOT NULL CHECK (counter IN ('stock','reserved')),
  movement_type     TEXT NOT NULL CHECK (movement_type IN ('OPENING','RESTOCK','ADJUSTMENT','RESERVE','RELEASE','SALE')),
  previous_quantity INTEGER NOT NULL,
  quantity          INTEGER NOT NULL,      -- signed change
  new_quantity      INTEGER NOT NULL,
  reference_id      INTEGER REFERENCES orders(id),
  reason            TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements (product_id, id);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events (order_id, id);
