---
name: practice-pricing
description: >-
  Sell prices per practice (lab test/service) across price tiers, their history,
  per-practice pricing rules (minimum prices, profit margins), derivation
  conventions, and laboratories. Use for questions about how much a practice is
  sold for, price changes over time, margins vs cost, and lab/section grouping.
  Headline tables: pricing, historical_pricing, conventions, laboratories.
---

# Practice Pricing & Conventions

## Overview
A **practice** is a laboratory test or service, identified by a numeric practice
**code**. This domain holds the price at which each practice is sold, across
several price tiers (e.g. consumer, distributor, special), the full price
history, per-practice pricing rules, the laboratories that own practices, and
"conventions" that describe derivation pricing. Combine with the Cost
Composition domain to compute margins.

## Tables
- **`<schema>.pricing`** — current sell price per practice. **PK: `code`**
  (bigint) — the practice code (the join key used across domains). Scale:
  thousands (≈3,236). Key columns: `description` (practice name);
  **price tiers** `consumer`, `distribuitor`, `special` (double) in the
  reference schema; `laboratory` (text) — owning lab/section name;
  `laboratory_id` (uuid) → `laboratories.id`; `provider_id` (text);
  `updated_at`, `updated_by`.
  **Cross-schema drift**: some tenant schemas replace the three named tiers with
  configurable columns `price1 … price10` (`price1 ≈ consumer`,
  `price2 ≈ distribuitor`, `price3 ≈ special`, inferred from the pricing views).
- **`<schema>.historical_pricing`** — append-only price history. PK: `id`.
  Columns: `practice_id` (text, joins `pricing.code`), `practice_name`,
  `consumer`, `distribuitor`, `special`, `created_at`, `created_by`, `job_id`.
  Scale: tens of thousands (≈19,402).
- **`<schema>.practice_configurations`** — per-practice pricing rules. PK: `id`.
  Columns: `practice_id` (text, joins `pricing.code`), `minimum_prices` (jsonb),
  `profit_margins` (jsonb), `created_at`, `updated_at`. The jsonb columns hold
  tier-keyed floor prices and target margins.
- **`<schema>.conventions`** — derivation/agreement pricing definitions. PK:
  `id`. Columns: `code` (bigint), `description`, `original_pricing_type` (text),
  `pricing_type` (text), `factor` (double), `region` (text), `updated_by`.
  Scale: hundreds–thousands. RLS disabled.
- **`<schema>.laboratories`** — labs/sections that own practices and act as cost
  centers. PK: `id` (uuid). Columns: `laboratory` (text), `created_at`. Scale:
  ~dozens.
- **`<schema>.featured_practices`** — practices flagged/pinned for the UI. PK:
  `id`. Columns: `practice_id` (bigint, joins `pricing.code`), `created_at`.

## Relationships (validated)
Implicit joins; cast keys to `text` when types differ.
- `pricing.laboratory_id → laboratories.id` (verified: full match).
- `historical_pricing.practice_id → pricing.code` (verified join).
- `practice_configurations.practice_id → pricing.code` (verified join).
- `featured_practices.practice_id → pricing.code` (verified join).
- `pricing.code` is also the join target for `relation.practice_id`
  (Cost Composition), `reportings.practice_id` (Billing),
  `client_os.practice_code` (Health Insurers), and the benchmarking mappings.
- `historical_pricing.job_id → jobs.id`.

## Key concepts & terminology
- **Practice code** = `pricing.code`: the universal practice identifier.
- **Price tiers**: `consumer` (retail/patient), `distribuitor` (distributor),
  `special` (special/agreement) in `public`; `price1…priceN` in some tenants.
- **Convention `pricing_type`**: observed value `derivation` (derivations).
  `original_pricing_type` carries the raw source label (e.g. `Derivación`,
  `DERIVACIONES`). `factor` is a multiplier applied in derivation pricing.
- **`laboratory`** identifies the lab/section; also used as a cost center in the
  Indirect Costs domain.

## Metrics & calculations
- **Current sell price** of a practice: the tier column on `pricing`
  (`special` is the typical "our price" tier).
- **Practice unit cost**: `sum(cost * incidence)` over `relation` for that
  practice (see Cost Composition domain).
- **Gross margin** (per practice) = `pricing.special - unit_cost`; margin % =
  `(special - unit_cost) / special`.
- **Number of price changes**: `count(*)` in `historical_pricing` grouped by
  `practice_id`.

## Semantic rules
- `historical_pricing` is append-only; the latest row per `practice_id` is the
  historical "current". The live `pricing` row is authoritative for current
  price.
- When writing tenant-portable queries, select the correct tier column for the
  target schema (`special` vs `price3`).
- `conventions` describe derivation pricing rules; they are not a per-practice
  price row and do not necessarily map 1:1 to `pricing.code` (see gotchas).

## Ambiguities & gotchas
- **`conventions.code` did not match `pricing.code`** (0 rows) nor
  `client_os.practice_code` in the data checked — the linkage of a convention to
  a specific practice could not be confirmed; treat `conventions` as a
  standalone catalog of derivation rules keyed by its own `code`.
- The `price1…priceN` vs `consumer/distribuitor/special` drift is the single
  biggest portability hazard — confirm column names per tenant. The mapping
  `price1≈consumer, price2≈distribuitor, price3≈special` is inferred from the
  parallel `lab_pricing_view` / `availables_pricing` views, not guaranteed.
- In `public`, `pricing.laboratory_id` may be null even when the `laboratory`
  text is set; join on `laboratory_id` where populated, else group by the
  `laboratory` text.
- RLS is disabled on `conventions`.
- Helpful read-model views: `lab_pricing_view` (practice price + computed
  margins per tier), `availables_pricing` / `full_availables_pricing`,
  `active_pricing`.

## Example queries (validated)
`<schema>` is swappable per tenant; tier column names may differ per tenant.

```sql
-- Q: Current prices of the highest-priced practices (special tier).
select code, description, consumer, distribuitor, special
from <schema>.pricing
order by special desc nulls last
limit 10;
```

```sql
-- Q: How many practices and average special price per laboratory/section?
select laboratory, count(*) as practices, round(avg(special)::numeric, 2) as avg_special
from <schema>.pricing
where laboratory is not null
group by laboratory
order by practices desc
limit 10;
```

```sql
-- Q: Gross margin per practice = sell price (special) minus unit cost from
--    its supply composition.
with cost as (
  select practice_id, sum(cost * incidence) as unit_cost
  from <schema>.relation
  group by practice_id
)
select p.code, p.description, p.special,
       round(c.unit_cost::numeric, 4) as unit_cost,
       round((p.special - c.unit_cost)::numeric, 2) as margin
from <schema>.pricing p
join cost c on p.code = c.practice_id
order by margin desc nulls last
limit 10;
```

```sql
-- Q: Which practices had the most price changes over time?
select practice_id, count(*) as versions
from <schema>.historical_pricing
group by practice_id
having count(*) > 1
order by versions desc
limit 20;
```

```sql
-- Q: Derivation conventions by pricing type, with the average factor.
select pricing_type, count(*) as n, round(avg(factor)::numeric, 3) as avg_factor
from <schema>.conventions
group by pricing_type;
```

```sql
-- Q: Practice prices with computed margins per tier (read-model view).
select laboratory, code, practice, price1, margin1_percentage
from <schema>.lab_pricing_view
limit 5;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas, with
the `pricing` tier-column drift noted above. All tables, relationships, coded
values and queries were validated against the live database. Last validated:
2026-08-12.
