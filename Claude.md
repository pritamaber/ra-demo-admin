# Jewellery Store Management Software — Working Demo

Build a **real, end-to-end working demo** of a custom jewellery-store management software.

This is a **demo/MVP**, not the complete production system. However, it must have a proper backend, relational database, CRUD operations, realistic sample data, and connected workflows so the client can actually use and test the software.

The application should feel like software designed specifically for an Indian jewellery store rather than a generic inventory application.

---

# Core Business Architecture

The **Order is the central transaction** of the system.

Do NOT treat Billing, Order and Payments as three independent transactions.

The primary business flow should be:

**Product → Customer → Order → Payments → Delivery → Final Settlement → Final Bill**

For example:

1. Customer selects a jewellery product.
2. A new Order is created.
3. Customer pays an advance.
4. The Order remains open/partially paid.
5. The system tracks the outstanding amount.
6. Gold rate may change before delivery.
7. On delivery, the system calculates the final settlement according to the configured pricing rules.
8. Customer pays the remaining amount.
9. Order becomes completed/delivered.
10. The system generates the Final Bill.
11. The final bill becomes part of the customer's purchase history.

This architecture should be used throughout the application.

---

# Main Modules

Create these modules:

1. **Dashboard**
2. **Orders**
3. **Billing**
4. **Customers**
5. **Master Catalog**
6. **Inventory**
7. **Gold Rate**

Billing should primarily represent the **final billing/documentation stage of an Order**, rather than being an unrelated transaction.

---

# 1. MASTER CATALOG / INVENTORY

Create a jewellery product catalogue with a hierarchical structure.

## Customer/Gender Categories

- Men
- Women
- Kids
- Unisex

## Jewellery Categories

- Ring
- Necklace
- Bangle
- Churi
- Pendant
- Earrings
- Chain
- Bracelet
- Mangalsutra
- Nose Pin

The catalogue structure can be inspired by the provided reference image.

For the demo, do NOT create hundreds of products.

Create approximately **20–30 realistic jewellery products** across the categories.

The architecture should nevertheless support thousands of products later.

---

## Product Fields

Each product should contain:

- Product ID
- SKU
- Barcode
- Product Name
- Gender
- Category
- Subcategory
- Product Image
- Metal Type
- Purity
- Gross Weight
- Stone Weight
- Net Gold Weight
- Making Charge
- Stock Quantity
- Available Quantity
- Status
- Created Date
- Updated Date

### Weight Calculation

Example:

Gross Weight:

`10.250 g`

Stone Weight:

`0.250 g`

Net Gold Weight:

`10.000 g`

The system should calculate:

**Net Gold Weight = Gross Weight − Stone Weight**

Do not manually duplicate this value if it can be calculated from the underlying weights.

---

# Stock Management

Each product must have stock tracking.

Example:

**22K Classic Gold Chain**

Available Stock:

`3`

When an order is created, the system should track the product's stock appropriately.

The demo should distinguish between:

- Available
- Reserved
- Sold
- Low Stock
- Out of Stock

Create a separate **Out of Stock** view.

The owner should be able to restock a product.

Example:

Current Stock:

`0`

Restock:

`5`

New Stock:

`5`

Maintain stock movement history:

- Product
- Previous Quantity
- Quantity Added/Removed
- Movement Type
- Reason
- Related Order
- Date

---

# 2. CUSTOMER MODULE

Create a customer profile system.

Fields:

- Customer ID
- Full Name
- Phone Number
- Alternate Phone
- Address
- City
- Date of Birth
- Anniversary
- Notes
- Created Date

## Customer Search

The **primary unique search field should be phone number**.

Example:

`9876543210`

Searching the number should open the customer's profile.

The profile should display:

### Customer Summary

- Name
- Phone
- Address
- Total Orders
- Total Purchases
- Total Paid
- Total Outstanding

### Order History

Show:

- Order Number
- Order Date
- Product
- Gold Weight
- Order Amount
- Amount Paid
- Outstanding
- Delivery Date
- Status

### Final Bill History

Show completed bills generated from the customer's completed orders.

---

# 3. ORDER MODULE

This is the **central module of the application**.

An Order represents the customer's complete purchase journey.

An order may be:

- Unpaid
- Partially Paid
- Fully Paid
- Ready for Delivery
- Delivered
- Cancelled

---

## Creating an Order

Example customer:

**Rahul Das**

Phone:

`9876543210`

Product:

**22K Gold Chain**

Net Gold Weight:

`10.000g`

Gold Rate on Order Date:

`₹14,720/g`

### Gold Value

`10 × ₹14,720 = ₹147,200`

### Making Charge

For example:

`₹850/g`

Making Charge:

`10 × ₹850 = ₹8,500`

### GST

For the demo:

`3%`

The system should calculate GST according to the configured GST rule.

### Initial Estimated Total

The system displays:

- Gold Value
- Making Charge
- GST
- Other Charges
- Estimated Total

The exact pricing calculation should remain configurable rather than hard-coded.

---

# Advance Payment

Suppose the customer pays:

**₹50,000**

The system records an actual payment against the Order.

Payment record:

- Payment ID
- Order ID
- Amount
- Payment Method
- Payment Date
- Reference Number
- Notes

Example:

`₹50,000 — UPI — 21 Sep 2026`

The Order now becomes:

**PARTIALLY PAID**

The system should NOT create the final bill yet.

It should show:

**Total Estimated Amount**

**Paid: ₹50,000**

**Outstanding: ₹X**

---

# Gold Rate and Advance Calculation

The system must support changes in gold prices between Order Date and Delivery Date.

Important:

**Do NOT hard-code the example `₹50,000 ÷ ₹14,720 = 3.39g` as the business rule.**

The database should store the actual payment amount and the gold rate applicable when the payment was made.

The system may calculate and display:

**Gold-equivalent value of payment**

using:

`Payment Amount ÷ Applicable Gold Rate`

This should be calculated using full internal precision and only rounded for display.

For example:

`₹50,000 ÷ ₹14,720`

The UI can display the resulting gold-equivalent weight, but the underlying payment must remain:

**₹50,000**

Do not replace the payment with a rounded gold-weight value.

---

# Delivery Date Settlement

Suppose the customer returns on the delivery date.

The current gold rate is:

**₹15,000/g**

The system should retrieve the delivery-date rate.

The Order should show a clear settlement calculation:

### Original Order

- Product
- Net Gold Weight
- Order-date Gold Rate
- Original Gold Value
- Making Charge
- GST
- Estimated Total

### Payments Already Received

- Payment 1
- Payment 2
- Total Advance/Paid

### Delivery Settlement

- Delivery-date Gold Rate
- Applicable Gold Value
- Making Charge
- GST
- Other Charges
- Previous Payments
- Final Amount Payable
- Final Outstanding

---

# Configurable Pricing Rules

Because the exact accounting rules of the jewellery shop may differ, do NOT permanently hard-code assumptions into the application.

Create a simple pricing configuration structure.

The system should be designed so the shop can later configure rules such as:

- Whether gold value is recalculated using the delivery-date rate
- Whether the advance is treated purely as monetary credit
- Whether the advance gets converted into gold-equivalent credit
- Whether making charge is fixed from the order date
- Whether making charge is recalculated at delivery
- GST calculation basis
- Other charges
- Rounding rules

For the demo, use one clearly defined default configuration.

The UI should make it obvious which rules were used to calculate the final amount.

This allows the real client's accounting rules to be incorporated later without redesigning the Order system.

---

# Payment System

Payments belong to an **Order**.

An Order can have multiple payments.

Example:

### Payment 1

₹50,000 — UPI

### Payment 2

₹40,000 — Cash

### Payment 3

₹30,116 — Card

The system should calculate:

**Total Paid**

**Total Outstanding**

automatically.

Supported payment methods:

- Cash
- UPI
- Card
- Bank Transfer
- Other

Never overwrite previous payment records.

Every payment should remain in the payment history.

---

# Order Status Flow

Implement a clear state flow:

**Draft**

↓

**Confirmed**

↓

**Advance Received**

↓

**Partially Paid**

↓

**Ready for Delivery**

↓

**Fully Paid**

↓

**Delivered**

↓

**Final Bill Generated**

Cancellation should be handled separately.

The exact status can depend on whether the customer has paid the required amount and whether the product has been delivered.

---

# Final Bill

The final bill is generated **from a completed Order**.

Do not create an unrelated bill transaction.

When:

- Product is delivered
- Final settlement is completed
- Outstanding amount becomes zero

the system should allow:

**Generate Final Bill**

The final bill should contain:

- Bill Number
- Order Number
- Customer
- Customer Phone
- Product
- SKU
- Barcode
- Gross Weight
- Stone Weight
- Net Gold Weight
- Purity
- Gold Rate
- Gold Value
- Making Charge
- GST
- Other Charges
- Total Amount
- Previous Payments
- Final Payment
- Total Paid
- Payment Method
- Order Date
- Delivery Date
- Bill Date

The bill should have a clean printable/PDF format.

---

# 4. BILLING MODULE

The Billing module should focus on:

**Final bill creation, bill viewing, bill history and printing/PDF.**

It should also provide a quick way to start a new Order.

Suggested workflow:

**New Sale / Order**

→ Select Customer

→ Select Product

→ Calculate Order

→ Receive Advance

→ Save Order

→ Later Receive Payments

→ Delivery

→ Final Settlement

→ Generate Bill

The Billing module should therefore work with the Order module instead of maintaining duplicate sales data.

---

# 5. OUTSTANDING / CREDIT DASHBOARD

Create a dashboard specifically for the shop owner.

The main purpose is:

**"Who has money pending, how much is pending, and whom should I contact?"**

Display:

### Today's Overview

- Today's Orders
- Today's Sales
- Today's Collections
- Pending Orders
- Outstanding Amount
- Orders Ready for Delivery
- Overdue Orders
- Low Stock
- Out of Stock

---

## Outstanding Payments Table

| Customer | Phone | Order | Order Date | Delivery Date | Total | Paid | Due | Status |
| -------- | ----- | ----- | ---------- | ------------- | ----: | ---: | --: | ------ |

Sort/filter by:

- Overdue
- Delivery Date
- Highest Outstanding
- Customer
- Order Date

Status examples:

- Due Today
- Due Soon
- Overdue
- Partially Paid
- Ready for Delivery

Clicking a customer should open their profile and payment/order history.

---

# 6. GOLD RATE MASTER

Create a simple Gold Rate Master.

Example:

**22K Gold**

`₹14,720 / gram`

The shop owner can update the rate.

The system must preserve historical rates.

For example:

| Date        | Purity |  Rate/g |
| ----------- | ------ | ------: |
| 20 Sep 2026 | 22K    | ₹14,650 |
| 21 Sep 2026 | 22K    | ₹14,720 |
| 25 Sep 2026 | 22K    | ₹15,000 |

An existing Order must retain the rates that were applicable to its transactions.

Do not simply replace old rates with the latest rate.

---

# DATABASE STRUCTURE

Use a proper relational database.

Suggested tables:

### customers

- id
- name
- phone
- alternate_phone
- address
- city
- dob
- anniversary
- notes
- created_at
- updated_at

### categories

- id
- name
- parent_category_id
- gender
- status

### products

- id
- sku
- barcode
- name
- gender
- category_id
- subcategory_id
- image_url
- metal_type
- purity
- gross_weight
- stone_weight
- net_gold_weight
- making_charge
- stock_quantity
- reserved_quantity
- status
- created_at
- updated_at

### orders

- id
- order_number
- customer_id
- status
- order_date
- expected_delivery_date
- actual_delivery_date
- order_gold_rate
- delivery_gold_rate
- subtotal
- making_charge
- gst
- other_charges
- total_amount
- paid_amount
- outstanding_amount
- created_at
- updated_at

### order_items

- id
- order_id
- product_id
- quantity
- gross_weight
- stone_weight
- net_gold_weight
- gold_rate
- gold_value
- making_charge
- gst
- total

### payments

- id
- order_id
- amount
- payment_method
- payment_date
- gold_rate_at_payment
- gold_equivalent
- reference_number
- notes
- created_at

The `gold_equivalent` field is informational/calculated data. The **actual payment amount remains the authoritative financial value**.

### bills

- id
- bill_number
- order_id
- customer_id
- bill_date
- total_amount
- generated_at

### stock_movements

- id
- product_id
- quantity
- movement_type
- reference_id
- reason
- created_at

### gold_rates

- id
- purity
- rate_per_gram
- effective_date
- created_at

### pricing_settings

Store configurable business rules such as:

- GST rate
- Making charge calculation method
- Advance treatment
- Gold-rate settlement method
- Rounding rules
- Other charges

---

# DEMO DATA

Keep the dataset small but realistic.

Create approximately:

- 5–8 realistic customers
- 20–30 jewellery products
- 8–10 categories/subcategories
- 5–10 sample orders
- Multiple payment records
- Several stock movements
- 2–3 outstanding orders
- 2–3 completed orders
- 1–2 out-of-stock products
- 1–2 low-stock products
- Historical gold rates

Use realistic Indian jewellery names and realistic weights.

Example products:

- 22K Classic Gold Chain
- 22K Floral Pendant
- 22K Women's Gold Ring
- 22K Men's Gold Ring
- 22K Daily Wear Bangle
- 22K Jhumka Earrings
- 22K Baby Bracelet
- 22K Traditional Mangalsutra
- 22K Gold Choker
- 22K Gold Nose Pin

Weights should look realistic:

`2.35g`

`4.80g`

`7.25g`

`10.00g`

`12.40g`

Avoid placeholder data such as:

`Product 001`

`Customer ABC`

---

# END-TO-END DEMO SCENARIO

The application must include at least one complete demo scenario showing the entire lifecycle.

Example:

### Day 1

Customer:

**Rahul Das**

Phone:

`9876543210`

Purchases:

**22K Gold Chain**

Net Gold Weight:

`10g`

Order-date Gold Rate:

`₹14,720/g`

Customer pays:

`₹50,000`

Order status:

**Partially Paid**

---

### Between Order and Delivery

Gold rate changes.

New rate:

`₹15,000/g`

The system preserves the original transaction information and applies the configured delivery settlement rules.

---

### Delivery Day

The shop opens the Order.

The system displays:

**Original Order**

**Payments Received**

**Current Gold Rate**

**Final Settlement Calculation**

**Outstanding Amount**

The customer pays the remaining amount.

Order status becomes:

**Fully Paid → Delivered**

---

### Final Step

The system generates:

**Final Bill**

The bill becomes visible in:

**Customer → Purchase History → Bills**

The product stock is updated.

The payment history is updated.

The dashboard outstanding amount is updated.

The Order is no longer shown as an outstanding payment.

This complete workflow must actually work in the demo.

---

# IMPORTANT IMPLEMENTATION PRINCIPLE

Do not build this as a collection of disconnected UI screens.

The demo must have real relationships:

**Customer**
↓
**Order**
↓
**Order Items**
↓
**Product / Inventory**
↓
**Payments**
↓
**Delivery / Settlement**
↓
**Final Bill**

A change in one module should affect the appropriate related modules.

For example:

If ₹20,000 payment is added to an Order:

- Order's Paid Amount increases
- Order's Outstanding Amount decreases
- Customer's outstanding balance updates
- Dashboard outstanding amount updates
- Payment history records the transaction

If an Order is delivered:

- Product stock is reduced appropriately
- Order status changes
- Final bill becomes available
- Customer purchase history updates

If a product is restocked:

- Inventory quantity increases
- Stock movement is recorded
- Out-of-stock status changes automatically.

---

# DEMO PRIORITY

Do not spend most of the development time creating a huge catalogue or unnecessary features.

The most important thing is to demonstrate this complete working flow:

**Catalog Product**

→ **Customer**

→ **Create Order**

→ **Calculate Gold + Making + GST**

→ **Receive Advance**

→ **Track Outstanding**

→ **Gold Rate Changes**

→ **Delivery-Date Settlement**

→ **Receive Remaining Payment**

→ **Update Inventory**

→ **Generate Final Bill**

→ **Customer Purchase History**

→ **Dashboard Outstanding Cleared**

The catalogue should remain intentionally small for the demo, but the underlying architecture should be production-expandable.
