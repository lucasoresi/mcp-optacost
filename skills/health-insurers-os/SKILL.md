---
name: health-insurers-os
description: >-
  Health insurers (obras sociales / OS) and the reimbursement value each insurer
  pays per practice, the history of those values, unit-value (UB) references,
  and OS groupings. Use for questions about which insurer pays what for a
  practice and how those values changed. Headline tables: os, client_os,
  historical_os.
---

# Health Insurers (OS) & Coverage Values

## Overview
An **OS** (obra social) is a health insurer/payer. This domain stores the
catalog of insurers, the **value** each insurer reimburses for each practice
(`client_os`), the full history of those values (`historical_os`), unit-value
(UB) references, and user-defined OS groupings. These reimbursement values are
the revenue side that, together with cost composition and billing, drives
per-insurer profitability.

## Tables
- **`<schema>.os`** — insurer catalog. PK: `id` (uuid). Columns: `code`
  (varchar) — insurer code (join key); `os` (text) — insurer name; `active`
  (boolean, not null); `general_os_id` (bigint) — grouping/parent id;
  `created_at`, `created_by`. Scale: a handful to a few hundred per tenant.
- **`<schema>.client_os`** — the reimbursement value each insurer pays per
  practice (live). PK: `id`. Scale: thousands–hundreds of thousands. Key
  columns: `practice_code` (integer, joins `pricing.code`); `practice_name`
  (text); `os_code` (varchar, joins `os.code`); `value` (real) — reimbursed
  amount; `created_at`, `updated_at`, `created_by`, `updated_by`.
- **`<schema>.historical_os`** — append-only history of insurer×practice values.
  PK: `id`. Columns mirror `client_os`: `practice_code`, `practice_name`,
  `os_code`, `value`, `created_at`, `created_by`. Scale: large (hundreds of
  thousands+).
- **`<schema>.historical_ub`** — unit-value (UB) reference history per insurer.
  PK: `id`. Columns: `os_code` (text), `os` (text), `price` (real),
  `created_at`, `created_by`.
- **`<schema>.user_os_groups`** — user-defined groupings of insurers. PK: `id`.
  Columns: `label` (text), `os_list` (jsonb array of OS codes), `type` (text),
  `default_enabled` (boolean), `selected_by` (array), audit columns.

## Relationships (validated)
Implicit joins; cast keys to `text` when types differ (mixes of
`varchar`/`integer`/`text` occur across tenants).
- `client_os.os_code → os.code` (verified join).
- `client_os.practice_code → pricing.code` (verified join).
- `historical_os.os_code → os.code` (verified join).
- `historical_os.practice_code → pricing.code` (same key as `client_os`).

## Key concepts & terminology
- **OS / obra social** = health insurer/payer.
- **`value`** in `client_os` / `historical_os` = the amount the insurer
  reimburses for that practice.
- **UB (unidad bioquímica / unit value)** in `historical_ub` = a per-insurer
  unit reference price used to derive practice values.
- **`general_os_id`** groups related OS records (e.g. plans of the same insurer).
- **`os.active`** flags whether the insurer is currently in use (observed all
  `true` in the checked tenant).

## Metrics & calculations
- **Average reimbursed value per insurer**: `avg(value)` in `client_os` grouped
  by `os_code`.
- **Latest value per insurer×practice**: latest `created_at` per
  (`os_code`, `practice_code`) in `historical_os`.
- **Value volatility**: `count(*)` of `historical_os` rows per (`os_code`,
  `practice_code`) or per `os_code`.

## Semantic rules
- `client_os` is the current value; `historical_os` is the append-only trail —
  use the latest snapshot per key for "current from history".
- One insurer covers many practices and one practice is covered by many
  insurers; always specify both `os_code` and `practice_code` for a single
  value.
- `os_list` in `user_os_groups` is a jsonb array of OS codes — expand it to join
  back to `os`.

## Ambiguities & gotchas
- **`reportings.os_id` / `reportings.os` did not join to `os`** in the data
  checked (neither `os_id → os.general_os_id` nor `os → os.code` matched); do
  not assume a clean link from billing rows to the OS catalog. Reporting rows
  carry insurer as free text/id that may not reconcile to `os` — verify per
  tenant.
- Key column types differ (`client_os.os_code` varchar vs `os.code` that can be
  varchar or bigint across tenants) — cast to `text`.
- Read-model views: `full_os_data` (practice×OS with unit cost, total and
  margin), and the Spanish-named `v_os_detallada`,
  `v_os_estadisticas_mensuales`, `v_os_practicas_precios`.

## Example queries (validated)
`<schema>` is swappable per tenant.

```sql
-- Q: For each insurer, how many practices are covered and the average value?
select o.code, o.os, count(*) as practices, round(avg(c.value)::numeric, 2) as avg_value
from <schema>.client_os c
join <schema>.os o on c.os_code::text = o.code::text
group by o.code, o.os
order by practices desc
limit 10;
```

```sql
-- Q: Which insurer/practice pairs changed value most often?
select os_code, count(*) as changes
from <schema>.historical_os
group by os_code
order by changes desc
limit 10;
```

```sql
-- Q: Latest unit-value (UB) reference per insurer.
select os_code, os, price, created_at
from <schema>.historical_ub
order by created_at desc
limit 10;
```

```sql
-- Q: User-defined OS groups and how many insurers each contains.
select label, type, jsonb_array_length(os_list) as n_os
from <schema>.user_os_groups
where jsonb_typeof(os_list) = 'array'
limit 10;
```

```sql
-- Q: Practice profitability by insurer via the read-model view.
select laboratory, practice_name, unit_cost, total, margin_percentage
from <schema>.full_os_data
order by total desc nulls last
limit 10;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas. All
tables, relationships and queries were validated against the live database. Last
validated: 2026-08-12.
