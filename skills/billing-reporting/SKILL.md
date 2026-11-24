---
name: billing-reporting
description: >-
  What was actually performed and billed per practice, insurer, headquarters and
  period, including derivations. Use for revenue/volume questions by month,
  practice or branch, and for profitability when combined with cost composition.
  Headline tables: reportings, headquarters. This Skill answers billing
  QUESTIONS; to PRODUCE an informe/reporte document, load `billing-report` too.
---

# Billing & Reporting

> **Asked for an *informe* / *reporte* / *report* (a document), not a number?**
> This Skill gives you the data semantics; the deliverable's structure lives in
> the **`billing-report`** output Skill — a frozen HTML template so every report
> comes out identical across tenants. Load both: `billing-reporting` for what
> the columns mean, `billing-report` for what to build. Never improvise the
> report layout from this Skill alone.

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
  units performed; `billed_amount` (double) — amount billed to the insurer;
  `counter_amount` (double, nullable) — amount collected at the counter
  (ventanilla); `is_derivation`
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
- **`quantity`** = number of practices performed; **`billed_amount`** = amount
  billed to the insurer; **`counter_amount`** = amount collected at the counter
  (ventanilla, copays/particulares); may be NULL.
- **Facturación (billing / revenue / "cuánto se facturó") — MANDATORY rule:**
  always `billed_amount + COALESCE(counter_amount, 0)`. Never `billed_amount`
  alone: that leaves out the counter and does not match the platform's
  informes.
- **Derivation — MANDATORY rule (same as the platform's Derivaciones section):**
  a row is a derivation when
  `COALESCE(is_derivation, false) OR headquarter = 'Derivantes'`. Do not use
  `is_derivation` alone.
- **Default presentation:** billing totals INCLUDE derivations; when it helps,
  show own work and derivations as a separate breakdown (propio / derivado).
- **Insurers (obras sociales) ranking:** read from the materialized view
  `report_os` (only insurers loaded in the `os` catalog, official name, amount
  `total_amount` = billed + counter). Group by `os_code`. Its total does NOT
  add up to the total billing (derivantes, particulares and unloaded insurers
  are left out); compute shares over the insurers' total.
- **`headquarter`** = the branch/site, stored as a label on the row.

## Metrics & calculations
- **Billed revenue by period**: `sum(billed_amount + coalesce(counter_amount, 0))`
  grouped by `period`.
- **Volume by practice**: `sum(quantity)` grouped by `practice_id`.
- **Derivation share**: billing (formula above) / counts grouped by the
  derivation rule above.
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
- **`reportings.os` is free text** (mixes insurers with derivantes, external
  labs and particulares). Do not rank or count insurers from it: use
  `report_os` (see the insurers rule above).
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
       round(sum(billed_amount + coalesce(counter_amount, 0))::numeric, 2) as billed
from <schema>.reportings
group by period
order by period desc
limit 12;
```

```sql
-- Q: Top practices by total billed amount.
select practice_id, practice_name,
       round(sum(billed_amount + coalesce(counter_amount, 0))::numeric, 2) as billed,
       sum(quantity) as qty
from <schema>.reportings
group by practice_id, practice_name
order by billed desc
limit 10;
```

```sql
-- Q: How much of billing is derivations vs own work?
select (coalesce(is_derivation, false) or headquarter = 'Derivantes') as derivado,
       count(*) as rows,
       round(sum(billed_amount + coalesce(counter_amount, 0))::numeric, 2) as billed
from <schema>.reportings
group by 1;
```

```sql
-- Q: Top insurers (obras sociales) by billing in a period.
select max(os) as obra_social, sum(quantity) as qty,
       round(sum(total_amount)::numeric, 2) as billed
from <schema>.report_os
where period >= DATE '2026-09-01' and period < DATE '2026-10-01'
group by os_code
order by billed desc
limit 10;
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
