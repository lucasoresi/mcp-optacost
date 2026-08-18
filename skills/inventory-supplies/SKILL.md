---
name: inventory-supplies
description: >-
  Supply catalog and procurement: consumables/reagents with prices, VAT flags
  and classes; stock levels over time; provider supply prices; and purchase
  requirements/orders. Use for questions about supplies, their prices and
  stock, what was requested/purchased, and from which providers. Headline
  tables: supplies, historical_stocks, purchase_requirements.
---

# Inventory, Supplies & Procurement

## Overview
This domain is the master catalog of **supplies** (consumables, reagents,
cleaning items, stationery, etc.) that laboratories buy and consume, together
with their prices, stock evolution over time, and the procurement flow
(purchase requirements and purchase orders). Supply cost is the raw material
that flows into practice cost composition (see the Cost Composition domain).

## Tables
- **`<schema>.supplies`** — the live supply catalog. PK: `id` (uuid). Scale:
  thousands (≈8,264 in reference schema). Key columns: `code` (text) — business
  code used to join everywhere; `old_id` (bigint) — legacy numeric id;
  `name` (text); `class` (text) — category (see values below); `supplier`
  (text); `quantity` (real) — current stock on hand; `price` (double) — catalog
  purchase price; `overrided_price` (double) — manual price override when set;
  `with_iva` (boolean) — whether the price includes VAT; `last_purchase` (text)
  — last purchase reference; `active` (boolean), `deprecated` (boolean),
  `deleted_at` (timestamptz) — lifecycle/soft-delete flags; `updated_price`,
  `updated_overrided_price`, `updated_by` — audit.
- **`<schema>.historical_supplies`** — append-only price history for supplies.
  PK: `id`. Key columns: `supplie_id` (text, joins `supplies.code`),
  `supplie_name`, `price`, `created_at`, `job_id`. Scale: tens of thousands.
- **`<schema>.historical_stocks`** — append-only stock-level snapshots. PK: `id`.
  Key columns: `supply_id` (text, joins `supplies.code`), `quantity` (double),
  `created_at`, `update_method` (text; observed value `service`), `job_id`.
  Scale: tens of thousands.
- **`<schema>.supply_configurations`** — per-supply alert thresholds. No PK
  declared. Columns: `supply_id` (text), `months_of_stock_remaining_threshold`,
  `remaining_practices_threshold`. Config/empty in reference schema. RLS
  disabled.
- **`<schema>.external_cost`** — externally-sourced cost items (supplies not in
  the main flow). PK: `id`. Columns mirror supplies: `code`, `name`, `supplier`,
  `price`, `class`, `quantity`. Small/config in reference schema.
- **`<schema>.providers_supplies_mapping`** — maps the client's supply code to a
  provider's supply code. PK: `id`. Columns: `provider_id`, `provider_code`,
  `client_code`, `created_at`. Empty in reference schema (see the Benchmarking
  domain for the populated practice-side analogue).
- **`<schema>.historical_providers_pricings`** — provider quotes for supplies
  over time. PK: `id`. Columns: `provider_id`, `provider_description`,
  `supply_description`, `supply_code`, `price`, `period`, `job_id`. Empty in
  reference schema (populated equivalents live in the Benchmarking domain).
- **`<schema>.purchase_requirements`** — procurement line items: requirements
  and purchase orders. PK: `id` (bigint). Scale: tens of thousands (≈47,984).
  Key columns: `requirement_id` (text) — groups lines into one requisition/order;
  `supply_id` (text, joins `supplies.code`); `supply_description`; `status`
  (text); `is_purchase_order` (boolean) — true = purchase order, false =
  requirement; `requested_quantity` (double); `provider_id`/`provider_name`;
  `origin_id`/`origin_name` — requesting site; `requested_by`, `approved_by`
  (text); `emission_date`, `approval_date`. Not present in every tenant schema.

## Relationships (validated)
All are implicit joins (no declared FKs); cast keys to `text` when types differ.
- `historical_supplies.supplie_id → supplies.code` (verified join).
- `historical_stocks.supply_id → supplies.code` (verified join).
- `purchase_requirements.supply_id → supplies.code` (verified: 47,978 of 47,984
  lines match a catalog supply).
- `supplies.code → relation.supplie_id` — links a supply to the practices that
  consume it (see Cost Composition domain).
- `historical_supplies.job_id`, `historical_stocks.job_id` → `jobs.id` (the
  import run that produced the snapshot; see Platform & System domain).

## Key concepts & terminology
- **Supply code vs id**: join on `code` (text business key). `id` (uuid) and
  `old_id` (bigint) are surrogate keys.
- **`class`** — supply category. Reference-schema values (Spanish, top by count):
  `Reactivos` (reagents, dominant), `Limpieza` (cleaning), `Librería`,
  `Papelería` (stationery), `Reac UL`, `React.Inte`, `Desayunado`, `Varios`,
  `Computació`, `Ins.deriva`, and other reagent sub-classes. Values are free
  text and can be truncated; treat as tenant-defined.
- **Effective price** = `coalesce(overrided_price, price)`: use the manual
  override when present, otherwise the catalog price.
- **`with_iva`** indicates the price already includes VAT (IVA).
- **`status`** on `purchase_requirements`: `rejected`, `approved`, `pending`
  (validated distinct values).
- **`is_purchase_order`** splits the table roughly in half: order lines vs
  requirement lines.

## Metrics & calculations
- **Effective supply price**: `coalesce(overrided_price, price)`.
- **Current stock**: latest `historical_stocks.quantity` per `supply_id`
  (`distinct on (supply_id) ... order by supply_id, created_at desc`), or the
  live `supplies.quantity`.
- **Requested quantity by supply**: `sum(requested_quantity)` grouped by
  `supply_id` (optionally filtered by `status = 'approved'`).
- **Requisition/order count**: `count(distinct requirement_id)`.

## Semantic rules
- `historical_supplies` and `historical_stocks` are append-only snapshots: use
  the latest row per key for "current", the full series for trends. Do not sum
  across snapshots.
- Exclude retired items with `deleted_at is null` and/or `active = true` /
  `deprecated = false` depending on the question.
- A `requirement_id` groups multiple line items; aggregate to it for
  order/requisition-level metrics.
- `purchase_requirements` and provider/stock snapshots may be absent in some
  tenant schemas — verify existence.

## Ambiguities & gotchas
- `providers_supplies_mapping` and `historical_providers_pricings` are empty in
  the reference schema; the populated, practice-side benchmarking analogues live
  in the Price Benchmarking domain.
- `class` values are free text and frequently truncated; do not assume a fixed
  enumeration.
- `relation.external_supplie_id → supplies.id` did **not** match any rows in
  the data checked — do not rely on that link; join supplies via `code`.
- RLS is disabled on `historical_stocks` and `supply_configurations`.

## Example queries (validated)
`<schema>` is swappable per tenant.

```sql
-- Q: How many supplies and what is the average price per class?
select class, count(*) as n_supplies, round(avg(price)::numeric, 2) as avg_price
from <schema>.supplies
where deleted_at is null
group by class
order by n_supplies desc
limit 10;
```

```sql
-- Q: What is the current (effective) price of active supplies, highest first?
select code, name, coalesce(overrided_price, price) as effective_price
from <schema>.supplies
where active and deleted_at is null
order by effective_price desc nulls last
limit 10;
```

```sql
-- Q: What is the latest known stock quantity for each supply?
select distinct on (supply_id) supply_id, quantity, created_at
from <schema>.historical_stocks
order by supply_id, created_at desc;
```

```sql
-- Q: Price history of each supply, most recent first.
select h.supplie_id, s.name, h.price, h.created_at
from <schema>.historical_supplies h
join <schema>.supplies s on h.supplie_id::text = s.code::text
order by h.created_at desc
limit 20;
```

```sql
-- Q: Procurement volume by status and document type (requirement vs order).
select status, is_purchase_order, count(*) as lines
from <schema>.purchase_requirements
group by status, is_purchase_order
order by lines desc;
```

```sql
-- Q: Which approved supplies were requested in the largest quantities?
select supply_id, supply_description, sum(requested_quantity) as total_qty
from <schema>.purchase_requirements
where status = 'approved'
group by supply_id, supply_description
order by total_qty desc
limit 10;
```

```sql
-- Q: Requisition/order summary (one row per requirement, via the helper view).
select requirement_id, total_supplies, status
from <schema>.purchase_requirements_view
limit 10;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas
(`purchase_requirements` and some provider/config tables may be absent in a
given tenant). All tables, relationships and queries were validated against the
live database. Last validated: 2026-08-12.
