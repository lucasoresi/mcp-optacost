---
name: billing-reporting
description: >-
  What was actually performed and billed per practice, insurer, headquarters and
  period, including derivations. Use for revenue/volume questions by month,
  practice or branch, and for profitability when combined with cost composition.
  Headline tables: reportings, headquarters.
---

# Billing & Reporting

## Overview
This domain records **actual activity and billing**: how many of each practice
were performed and how much was billed, broken down by period, practice,
insurer and headquarters (branch), including whether the work was a
**derivation** (referred out/in). It is the revenue/volume fact table; join it
to Cost Composition and Pricing to compute realized margins.

## Tables
- **`<schema>.reportings`** — billing/activity fact rows. PK: `id` (uuid).
  Scale: very large (hundreds of thousands to millions; ≈1.77M in reference
  schema). Key columns: `period` (date) — reporting month; `practice_id`
  (bigint, joins `pricing.code`); `practice_name` (text); `quantity` (bigint) —
  units performed; `billed_amount` (double) — amount billed;
  `counter_amount` (double) — a paired/counter amount; `is_derivation`
  (boolean) — whether the row is a derivation; `headquarter` (varchar) — branch
  name/label; `os` (varchar) / `os_id` (bigint) — insurer reference (free text /
  id; see gotchas); `job_id` (uuid, joins `jobs.id`); `created_at`,
  `created_by`.
- **`<schema>.headquarters`** — catalog of physical branches/sites. PK: `id`
  (uuid). Columns: `name`, `code`, `description`, `address`, `city`, `locality`,
  `district`, `province`, `type`, `url`, `map_url`, `created_at`, `updated_at`.
  Config table; empty in the reference schema.

## Relationships (validated)
Implicit joins; cast keys to `text` when types differ.
- `reportings.practice_id → pricing.code` (verified join).
- `reportings.job_id → jobs.id` (verified: full match).
- `reportings.practice_id` also joins `relation.practice_id` (Cost Composition)
  to combine billed volume with unit cost.

## Key concepts & terminology
- **`period`** = the month the activity belongs to (a date, typically the first
  of the month).
- **`quantity`** = number of practices performed; **`billed_amount`** = revenue
  billed; **`counter_amount`** = a paired amount (e.g. counter-value / expected).
- **`is_derivation`** = the row is a derivation (referral). Split reporting by
  this flag when derivations must be treated separately.
- **`headquarter`** = the branch/site, stored as a label on the row.

## Metrics & calculations
- **Billed revenue by period**: `sum(billed_amount)` grouped by `period`.
- **Volume by practice**: `sum(quantity)` grouped by `practice_id`.
- **Derivation share**: `sum(billed_amount)` / counts grouped by
  `is_derivation`.
- **Realized margin** (combine with cost): billed revenue minus
  `quantity * unit_cost`, where `unit_cost` comes from `relation`
  (`sum(cost*incidence)` per practice).

## Semantic rules
- `reportings` is an activity fact table — aggregate; do not treat individual
  rows as unique billing documents unless grouping by the natural keys
  (`period`, `practice_id`, `headquarter`, `os`).
- Always scope by `period` for time series; a practice appears in many periods.
- `headquarter` and `os` are stored as labels/ids on the row and may not
  reconcile to the `headquarters` / `os` catalogs (see gotchas).

## Ambiguities & gotchas
- **`reportings.os_id` / `reportings.os` did not join to the `os` catalog** in
  the data checked (neither `os_id → os.general_os_id` nor `os → os.code`
  matched). Treat the insurer on a reporting row as an unreconciled
  label/id unless verified for the specific tenant.
- `reportings.headquarter` is a `varchar` label, not a foreign key to
  `headquarters.id`; `headquarters` is empty in the reference schema.
- `quantity` is `bigint` in the base table but views may expose it as `numeric`.
- Read-model views: `reportings_full_view_os` (enriched with laboratory, unit
  cost, total, margin and margin %) and `practices_reportings_by_period`
  (per-practice totals and share by period). These are schema-scoped views;
  confirm existence in the target schema.

## Example queries (validated)
`<schema>` is swappable per tenant.

```sql
-- Q: Billed revenue and volume by period (last 12 periods).
select period, count(*) as rows, sum(quantity) as qty,
       round(sum(billed_amount)::numeric, 2) as billed
from <schema>.reportings
group by period
order by period desc
limit 12;
```

```sql
-- Q: Top practices by total billed amount.
select practice_id, practice_name,
       round(sum(billed_amount)::numeric, 2) as billed,
       sum(quantity) as qty
from <schema>.reportings
group by practice_id, practice_name
order by billed desc
limit 10;
```

```sql
-- Q: How much of billing is derivations vs own work?
select is_derivation, count(*) as rows,
       round(sum(billed_amount)::numeric, 2) as billed
from <schema>.reportings
group by is_derivation;
```

```sql
-- Q: Practice profitability (billed vs cost & margin) via the read-model view.
select practice_name,
       round(sum(total_amount)::numeric, 2) as amount,
       round(avg(margin_percentage)::numeric, 3) as avg_margin_pct
from <schema>.reportings_full_view_os
group by practice_name
order by amount desc nulls last
limit 10;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas. All
tables, relationships and queries were validated against the live database. Last
validated: 2026-08-12.
