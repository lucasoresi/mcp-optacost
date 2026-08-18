---
name: indirect-costs
description: >-
  Overhead / indirect costs and how they are distributed to cost centers
  (laboratories) and then to practices, plus the history of those
  configurations and posted costs. Use for questions about total overhead, its
  allocation method, and per-cost-center/per-practice indirect cost. Headline
  tables: indirect_costs, indirect_cost_configurations, historical_costs.
---

# Indirect Costs

## Overview
This domain models **overhead** that is not tied to a single supply or practice
(rent, utilities, administration, etc.) and the rules that spread it first to
**cost centers** (which are laboratories) and then to **practices**. It also
keeps a history of the allocation configurations and of the posted cost amounts
per period.

## Tables
- **`<schema>.indirect_costs`** — the overhead items. PK: `id` (uuid). Columns:
  `description` (text); `amount` (double) — total cost; `cc_distribution_method`
  (text) — how it is split across cost centers; `status` (text);
  `last_period` (date); `created_at`, `updated_at`. Scale: dozens.
- **`<schema>.indirect_cost_configurations`** — allocation rule per overhead ×
  cost center. PK: `id`. Columns: `indirect_cost_id` (uuid, joins
  `indirect_costs.id`); `cost_center_id` (uuid, joins `laboratories.id`);
  `distribution_percentage` (double) — share of the cost to this cost center;
  `fixed_amount` (double) — fixed portion; `practices_distribution_method`
  (text) — how the cost-center amount is then split across practices;
  `created_at`, `updated_at`. Scale: hundreds.
- **`<schema>.historical_indirect_cost_configurations`** — append-only history
  of the configurations. PK: `id`. Columns: `indirect_cost_configuration_id`
  (uuid, joins `indirect_cost_configurations.id`), `distribution_percentage`,
  `fixed_amount`, `practices_distribution_method`, `created_at`, `updated_at`.
- **`<schema>.historical_costs`** — append-only posted cost amounts over time
  (generic; used for indirect and other cost postings). PK: `id` (bigint).
  Columns: `entity_id` (text) — the costed entity; `type` (text) — cost type;
  `price` (double); `job_id` (uuid, joins `jobs.id`); `extra_data` (jsonb);
  `created_by`, `created_at`.

## Relationships (validated)
Implicit joins.
- `indirect_cost_configurations.indirect_cost_id → indirect_costs.id` (verified).
- `indirect_cost_configurations.cost_center_id → laboratories.id` (verified) —
  **cost centers are laboratories**.
- `historical_indirect_cost_configurations.indirect_cost_configuration_id →
  indirect_cost_configurations.id` (verified).
- `historical_costs.job_id → jobs.id` (verified).

## Key concepts & terminology
- **Cost center = laboratory** (`laboratories` table, also used in Practice
  Pricing).
- **`cc_distribution_method`** — how an overhead is split across cost centers.
  Validated values: `weighted_by_amount`, `asymmetric`.
- **`practices_distribution_method`** — how a cost center's share is split across
  its practices. Validated value: `weighted_by_quantity`.
- **`distribution_percentage`** vs **`fixed_amount`** — a configuration line can
  allocate a percentage of the overhead and/or a fixed amount to the cost
  center.
- **`status`** on `indirect_costs`: validated value `active`.

## Metrics & calculations
- **Total overhead**: `sum(amount)` in `indirect_costs` (optionally grouped by
  `cc_distribution_method` or `status`).
- **Amount allocated to a cost center**: `indirect_costs.amount *
  distribution_percentage` (+ `fixed_amount`) from the matching configuration
  line.
- **Per-practice allocation**: the cost-center amount split by the
  `practices_distribution_method` (e.g. weighted by billed quantity from
  `reportings`) — precomputed in the read-model views below.

## Semantic rules
- `historical_*` tables are append-only; use the latest per key for current
  configuration, the series for change history.
- A single overhead (`indirect_costs`) fans out to multiple
  `indirect_cost_configurations` rows (one per cost center); the
  `distribution_percentage` values for an overhead are meant to sum to 100%.
- `historical_costs` is generic — always filter by `type` to isolate indirect
  postings.

## Ambiguities & gotchas
- `indirect_costs`, `indirect_cost_configurations` and `historical_costs` are
  empty in the **reference** schema `public` but populated in tenant schemas;
  validate example output against a populated tenant.
- `historical_costs.entity_id` is a text reference whose meaning depends on
  `type`; its target table is not fixed — inspect per `type`.
- The exact per-practice split formulas are encapsulated in the read-model
  views: `cost_center_amount_by_period` (amount and % per cost center per
  period), `historical_indirect_cost_overview`, and
  `historical_indirect_cost_practice_distribution` (fully expanded per-practice
  allocation).

## Example queries (validated)
`<schema>` is swappable per tenant; validate against a populated tenant.

```sql
-- Q: Largest overhead items with their allocation method and status.
select description, amount, cc_distribution_method, status, last_period
from <schema>.indirect_costs
order by amount desc
limit 10;
```

```sql
-- Q: Allocation of overheads to cost centers (laboratories).
select i.description, l.laboratory as cost_center,
       ic.distribution_percentage, ic.practices_distribution_method
from <schema>.indirect_cost_configurations ic
join <schema>.indirect_costs i on ic.indirect_cost_id = i.id
join <schema>.laboratories l on ic.cost_center_id = l.id
limit 10;
```

```sql
-- Q: Posted historical costs by type.
select type, count(*) as n, round(sum(price)::numeric, 2) as total
from <schema>.historical_costs
group by type
order by n desc
limit 10;
```

```sql
-- Q: Indirect cost amount and share per cost center per period (view).
select period, cost_center, round(total_amount::numeric, 2) as amount
from <schema>.cost_center_amount_by_period
order by period desc
limit 10;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas; the
indirect-cost tables are populated only in tenant schemas. All tables,
relationships, coded values and queries were validated against the live
database. Last validated: 2026-08-12.
