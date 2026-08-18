---
name: cost-composition
description: >-
  How each practice is built from supplies: the bill-of-materials linking
  supplies to practices with an incidence (proportion) that yields each
  practice's unit cost, plus practice-in-practice composition. Use for questions
  about what a test costs, which supplies drive its cost, and composite
  practices. Headline tables: relation, historical_relations,
  practices_in_practice.
---

# Cost Composition (Supply–Practice Relations)

## Overview
This is the costing backbone: the **`relation`** table is the bill of materials
that ties each **supply** to each **practice** with a **cost** and an
**incidence** (how much of the supply a single practice consumes). Summing
`cost * incidence` across a practice's supplies gives its **unit cost**, which
feeds margins (Practice Pricing) and profitability (Billing). Practices can also
be composed of other practices via `practices_in_practice`.

## Tables
- **`<schema>.relation`** — supply-to-practice bill of materials (the live cost
  composition). PK: `id` (uuid). Scale: thousands–tens of thousands (≈15,405 in
  reference schema). Key columns: `practice_id` (bigint, joins `pricing.code`);
  `practice_name` (text); `supplie_id` (text, joins `supplies.code`);
  `supplie_name` (text); `cost` (double) — supply cost used in this composition;
  `incidence` (numeric) — proportion/quantity of the supply consumed by the
  practice; `unit_cost` (double) — stored per-row cost contribution;
  `last_purchase` (text); `external_supplie_id` (uuid); `created_at`,
  `updated_at`, `updated_by`.
- **`<schema>.historical_relations`** — append-only history of the composition,
  with validity windows. PK: `id` (bigint). Columns: `supply_id` (text, joins
  `supplies.code`), `practice_id` (text, joins `pricing.code`), `incidence`
  (double), `valid_from`, `valid_to`, `external_supply_id`, `created_at`.
- **`<schema>.practices_in_practice`** — composite practices: a parent practice
  made up of child practices. PK: `id`. Columns: `practice_id` (bigint, parent,
  joins `pricing.code`), `child_practice_id` (bigint, child, joins
  `pricing.code`), `created_at`, `created_by`. Scale: hundreds.

## Relationships (validated)
Implicit joins; cast keys to `text` when types differ.
- `relation.supplie_id → supplies.code` (verified join).
- `relation.practice_id → pricing.code` (verified join).
- `historical_relations.supply_id → supplies.code` (verified join).
- `practices_in_practice.practice_id → pricing.code` (verified) and
  `practices_in_practice.child_practice_id → pricing.code` (verified).

## Key concepts & terminology
- **Incidence** = the amount/proportion of a supply consumed per unit of the
  practice. A practice's cost contribution from one supply = `cost * incidence`.
- **Unit cost** of a practice = `sum(cost * incidence)` across its `relation`
  rows. Each row also stores a `unit_cost` value; prefer recomputing from
  `cost * incidence` for consistency, and reconcile against the stored value.
- **Composite practice**: a parent practice whose cost/definition includes one
  or more child practices (`practices_in_practice`).

## Metrics & calculations
- **Practice unit cost**: `sum(cost * incidence)` grouped by `practice_id`.
- **Supply usage breadth**: `count(distinct practice_id)` per `supplie_id` —
  how many practices use a given supply.
- **Number of children** of a composite practice: `count(*)` in
  `practices_in_practice` grouped by `practice_id`.

## Semantic rules
- One practice has many `relation` rows (one per supply); always aggregate to
  `practice_id` for a practice-level cost.
- `historical_relations.valid_from`/`valid_to` define when a composition was in
  effect; the live `relation` reflects the current composition.
- To avoid double counting composite practices, decide whether to cost the
  parent from its own `relation` rows or by expanding `practices_in_practice`
  into child costs — they are two different modeling choices; do not mix.

## Ambiguities & gotchas
- `relation.external_supplie_id → supplies.id` did **not** match any rows in the
  data checked; join supplies via `supplie_id → supplies.code` instead.
- The stored `relation.unit_cost` and the recomputed `cost * incidence` may
  differ per row (rounding / staleness); recompute when precision matters.
- `historical_relations.practice_id` is `text` while `relation.practice_id` is
  `bigint` — cast when joining.
- Read-model views: `relations_with_practices` (relation enriched with practice
  name + laboratory), `full_practices_in_practice` (composite practices with
  computed margins), `supplies_with_practices` (supplies with a `practice_count`).

## Example queries (validated)
`<schema>` is swappable per tenant.

```sql
-- Q: Unit cost of each practice, computed from its supply composition.
select r.practice_id, r.practice_name,
       count(*) as n_supplies,
       round(sum(r.cost * r.incidence)::numeric, 4) as unit_cost
from <schema>.relation r
group by r.practice_id, r.practice_name
order by unit_cost desc
limit 10;
```

```sql
-- Q: Compare recomputed unit cost vs the stored per-row unit_cost.
select practice_id,
       round(sum(cost * incidence)::numeric, 4) as computed,
       round(max(unit_cost)::numeric, 4)        as stored_row
from <schema>.relation
group by practice_id
limit 20;
```

```sql
-- Q: Which supplies are used across the most practices?
select supplie_id, supplie_name, count(distinct practice_id) as practices
from <schema>.relation
group by supplie_id, supplie_name
order by practices desc
limit 10;
```

```sql
-- Q: Which composite practices have the most child practices?
select practice_id, count(*) as children
from <schema>.practices_in_practice
group by practice_id
order by children desc
limit 10;
```

```sql
-- Q: Supplies enriched with the number of practices they belong to (view).
select code, name, practice_count
from <schema>.supplies_with_practices
order by practice_count desc
limit 5;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas. All
tables, relationships and queries were validated against the live database. Last
validated: 2026-08-12.
