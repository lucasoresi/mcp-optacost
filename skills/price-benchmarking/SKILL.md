---
name: price-benchmarking
description: >-
  Benchmark the client's own practice/supply prices against external provider
  quotes and market sources. Maps client codes to provider/source codes and
  stores historical benchmark prices. Use for questions like "how does our price
  compare to provider X / market source Y". Headline tables:
  sources_codes_mapping, historical_external_sources_pricings,
  providers_practices_mapping, historical_practice_providers_pricings.
---

# Price Benchmarking & External Sources

## Overview
This domain lets the client compare its own prices/costs against outside
references. It has two parts: **code mappings** that translate the client's
practice or supply codes into a provider's or a market source's codes, and
**historical price feeds** from those providers/sources. Joining a mapping to a
feed and then to the client's own `pricing` (Practice Pricing domain) produces a
price comparison.

## Tables
- **`<schema>.sources_codes_mapping`** — maps a client practice code to a market
  source's code. PK: `id`. Columns: `source_id` (text) — the external source;
  `client_code` (text, joins `pricing.code`); `code` (text) — the source's code
  for that practice; `created_at`. Scale: hundreds–thousands. RLS disabled.
- **`<schema>.historical_external_sources_pricings`** — price feed from external
  market sources over time. PK: `id`. Columns: `source_id` (text), `code`
  (text), `description`, `price` (double), `period` (date), `job_id`,
  `created_at`. Scale: thousands. RLS disabled.
- **`<schema>.providers_practices_mapping`** — maps a client practice code to a
  provider's practice code. PK: `id` (bigint). Columns: `provider_id` (text),
  `provider_code` (text), `client_code` (text, joins `pricing.code`),
  `created_at`. Populated in tenant schemas; empty in the reference schema.
- **`<schema>.historical_practice_providers_pricings`** — provider quotes for
  practices over time. PK: `id`. Columns: `provider_id`, `provider_description`,
  `practice_description`, `practice_code` (text, joins a provider code),
  `price` (double), `period` (date), `job_id`, `created_at`. Populated in tenant
  schemas; empty in the reference schema.
- **`<schema>.providers_supplies_mapping`** — supply-side analogue of the
  practices mapping (client supply code → provider supply code). PK: `id`.
  Columns: `provider_id`, `provider_code`, `client_code`, `created_at`.
- **`<schema>.historical_providers_pricings`** — provider quotes for supplies
  over time. PK: `id`. Columns: `provider_id`, `provider_description`,
  `supply_description`, `supply_code`, `price`, `period`, `job_id`,
  `created_at`.

## Relationships (validated)
Implicit joins; cast keys to `text` when types differ.
- **Practices, client side**: `providers_practices_mapping.client_code →
  pricing.code` (verified) and `sources_codes_mapping.client_code →
  pricing.code` (verified).
- **Practices, provider side**: `providers_practices_mapping.provider_code →
  historical_practice_providers_pricings.practice_code` (verified).
- **Practices, source side**: `sources_codes_mapping.code →
  historical_external_sources_pricings.code` (verified). Use the pair
  (`source_id`, `code`) as the key — joining on `source_id` alone is not
  selective (it fans out massively).
- **Supplies, client side**: `providers_supplies_mapping.client_code →
  supplies.code`; **supply feed**: `historical_providers_pricings.supply_code →
  a provider supply code` (bridge through `providers_supplies_mapping`).
- All feed tables carry `job_id → jobs.id`.

## Key concepts & terminology
- **Client code**: the client's own practice code (= `pricing.code`) or supply
  code (= `supplies.code`).
- **Provider code / source code**: the external party's code for the same item;
  you must translate through the mapping table.
- **Source vs provider**: a **source** is a market/reference price list
  (`sources_*`, `external_sources`); a **provider** is a specific vendor
  (`providers_*`).
- **`period`**: the effective month/date of the benchmark price. Use the latest
  `period` per code for "current" benchmark.

## Metrics & calculations
- **Latest benchmark price** per code: `row_number() over (partition by code
  order by period desc)` = 1 on the relevant historical feed.
- **Price gap vs client**: `client_price - benchmark_price` and the same over
  `client_price` for a percentage (mirrors the `external_prices_comparison_view`
  read model).
- **Mapping coverage**: `count(distinct client_code)` in a mapping vs total
  practices in `pricing`.

## Semantic rules
- The historical feeds are append-only; reduce to the latest `period` per code
  before comparing.
- Always go client_code → (mapping) → provider/source code → (feed) price. The
  client's own price still comes from `pricing` (Practice Pricing domain).
- Provider-side practice tables are empty in the reference schema but populated
  in tenant schemas; validate example output against a populated tenant.

## Ambiguities & gotchas
- Provider and source feed prices do **not** join directly to `pricing.code` or
  `supplies.code` — they use the provider's/source's own codes; the mapping
  table is mandatory.
- Joining source feeds on `source_id` alone produces a Cartesian blow-up; always
  include `code`.
- `providers_practices_mapping` and `historical_practice_providers_pricings` are
  empty in `public`; the external-source pair (`sources_codes_mapping` +
  `historical_external_sources_pricings`) is populated there.
- RLS is disabled on `sources_codes_mapping` and
  `historical_external_sources_pricings`.
- Read-model view `external_prices_comparison_view` precomputes client-vs-source
  differences; `providers_practices_matching_view`,
  `optacost_practices_matching_view` and `supplies_matching_view` list the
  mappings.

## Example queries (validated)
`<schema>` is swappable per tenant.

```sql
-- Q: Compare each client practice's special price to the latest external
--    market-source price for the same practice.
with ext as (
  select code, price, period,
         row_number() over (partition by code order by period desc nulls last) as rn
  from <schema>.historical_external_sources_pricings
)
select m.client_code,
       p.special       as client_special,
       e.price         as source_price,
       round((p.special - e.price)::numeric, 2) as diff
from <schema>.sources_codes_mapping m
join <schema>.pricing p on m.client_code::text = p.code::text
join ext e on e.code::text = m.code::text and e.rn = 1
limit 20;
```

```sql
-- Q: Latest provider quote per client practice (validated on a populated tenant).
with pv as (
  select practice_code, price, period,
         row_number() over (partition by practice_code order by period desc nulls last) as rn
  from <schema>.historical_practice_providers_pricings
)
select m.client_code, p.special as client_special, v.price as provider_price
from <schema>.providers_practices_mapping m
join <schema>.pricing p on m.client_code::text = p.code::text
join pv v on v.practice_code::text = m.provider_code::text and v.rn = 1
limit 20;
```

```sql
-- Q: How many of our practices are mapped to an external source?
select count(distinct m.client_code) as mapped_practices,
       (select count(*) from <schema>.pricing) as total_practices
from <schema>.sources_codes_mapping m
join <schema>.pricing p on m.client_code::text = p.code::text;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas; the
provider-side practice tables are populated only in tenant schemas. All tables,
relationships and queries were validated against the live database. Last
validated: 2026-08-12.
