---
name: database-domains-index
description: >-
  Map of all business domains in the Optacost laboratory cost-and-pricing
  database and when to use each. Load this first to route a question to the
  right domain Skill. Covers supplies/procurement, practice pricing, price
  benchmarking, cost composition, health insurers (OS), billing/reporting,
  indirect costs, clients/tenancy, and platform/system.
---

# Database Domains — Index

This database powers a multi-tenant SaaS for clinical-laboratory cost analysis,
pricing and profitability. A **practice** is a lab test/service (identified by a
numeric practice code); a **supply** is a consumable/reagent; an **OS** (obra
social) is a health insurer/payer. The core value chain is:
supplies → cost composition (which supplies a practice consumes) → practice
pricing & margins → billing/reporting of what was actually performed and billed
→ indirect-cost allocation.

## Schema architecture
- One PostgreSQL schema per tenant. `public` is the reference schema and is fully
  populated. Tenant schemas `tenant_demo`, `tenant_iaca`, `tenant_labmedicina`,
  `tenant_nanni`, `tenant_staging` mirror the same architecture.
- **Substitute the target schema** in every query below (shown as `<schema>`).
- **No foreign keys are declared** anywhere. All relationships are implicit
  (join on matching business keys). Primary keys exist (`id` on almost every
  table; `pricing.code`; `kickoff_checklist_state.client_id`).
- **Cross-schema drift to remember**:
  - `pricing` price tiers are named `consumer`, `distribuitor`, `special` in
    `public`; some tenant schemas expose configurable tiers as
    `price1 … price10` instead. Map: `price1 ≈ consumer`, `price2 ≈ distribuitor`,
    `price3 ≈ special` (inferred from the parallel pricing views — verify per
    tenant).
  - A few tables are not present in every tenant schema (e.g.
    `purchase_requirements`, `refresh_jobs` exist in `public` but not in every
    tenant). Verify table existence per tenant before querying.
- Common join keys: practice code (`pricing.code` ↔ `relation.practice_id` ↔
  `reportings.practice_id` ↔ `client_os.practice_code` ↔
  `practices_in_practice.practice_id`); supply code (`supplies.code` ↔
  `relation.supplie_id` ↔ `historical_stocks.supply_id`); OS code
  (`os.code` ↔ `client_os.os_code` ↔ `historical_os.os_code`). Cast to `text`
  when joining, because key column types differ across tables/tenants
  (`bigint`/`integer`/`text`/`varchar`).

## Domains
- **Inventory, Supplies & Procurement** (`inventory-supplies`) — the supply
  catalog, prices, stock levels over time, provider supply prices, and purchase
  requirements/orders. Tables: `supplies`, `historical_supplies`,
  `historical_stocks`, `supply_configurations`, `external_cost`,
  `providers_supplies_mapping`, `historical_providers_pricings`,
  `purchase_requirements`.
- **Practice Pricing & Conventions** (`practice-pricing`) — sell prices per
  practice across price tiers, price history, per-practice pricing rules
  (minimum prices, profit margins), derivation conventions, and laboratories.
  Tables: `pricing`, `historical_pricing`, `practice_configurations`,
  `conventions`, `laboratories`, `featured_practices`.
- **Price Benchmarking & External Sources** (`price-benchmarking`) — mapping of
  the client's practice/supply codes to external provider and market-source
  codes, and the historical benchmark prices used to compare against the
  client's own prices. Tables: `providers_practices_mapping`,
  `historical_practice_providers_pricings`, `sources_codes_mapping`,
  `historical_external_sources_pricings`, `providers_supplies_mapping`,
  `historical_providers_pricings`.
- **Cost Composition (Supply–Practice Relations)** (`cost-composition`) — which
  supplies go into each practice and in what proportion (incidence), giving each
  practice its unit cost; plus practice-in-practice composition. Tables:
  `relation`, `historical_relations`, `practices_in_practice`.
- **Health Insurers (OS) & Coverage Values** (`health-insurers-os`) — insurers
  (obras sociales), the reimbursement value each insurer pays per practice, the
  history of those values, unit-value (UB) references and OS groupings. Tables:
  `os`, `client_os`, `historical_os`, `historical_ub`, `user_os_groups`.
- **Billing & Reporting** (`billing-reporting`) — what was actually performed
  and billed per practice, insurer, headquarters and period, including
  derivations. Tables: `reportings`, `headquarters`.
- **Indirect Costs** (`indirect-costs`) — overhead/indirect costs, how they are
  distributed to cost centers (laboratories) and practices, and their history.
  Tables: `indirect_costs`, `indirect_cost_configurations`,
  `historical_indirect_cost_configurations`, `historical_costs`.
- **Clients, Plans, Users & Tenancy** (`clients-tenancy`) — the client
  (tenant) records, subscription plans, users and roles, per-client/per-user
  settings, tenant membership, onboarding checklist, and data integrations.
  Tables: `clients`, `plans`, `users`, `settings`, `local_settings`,
  `user_tenants`, `kickoff_checklist_state`, `integrations`,
  `clients_integrations`.
- **Platform & System** (`platform-system`) — asynchronous import jobs,
  materialized-view refresh orchestration, backups, comments/notifications, AI
  assistant chat history and vector embeddings. Tables: `jobs`, `refresh_jobs`,
  `backups`, `comments`, `n8n_chat_histories`, `embeddings`.

## Cross-domain notes
- **Practice code** is the backbone identifier linking Pricing, Cost
  Composition, Health Insurers (OS), Billing and Benchmarking.
- **`historical_*` tables** are append-only snapshots of the live counterpart
  in the same domain; most carry a `job_id` linking them to the import `jobs`
  run that produced them, and a `created_at`/`period` timestamp. Use the latest
  row per key for "current" values and the full series for trends. Never sum
  across historical snapshots as if they were distinct events.
- **`*_mapping` tables** connect the client's own codes to provider/market codes
  and bridge the Benchmarking domain to Pricing.
- **Laboratories double as cost centers**: `indirect_cost_configurations.cost_center_id`
  → `laboratories.id`.
- **`job_id`** on many tables → `jobs.id` (the import that created the rows).
- **Currency**: monetary amounts are unitless numeric values in the tenant's
  local currency (Argentine peso in observed tenants); no currency column
  exists. `supplies.with_iva` flags whether a supply price includes VAT (IVA).
- **Row Level Security is disabled** on several tables — see each Skill's
  gotchas; this is an operational security concern, not a query concern.

## Provenance
Reference schema analyzed: `public`. Architecture shared by all `tenant_*`
schemas (with the drift noted above). All tables, relationships, coded values
and example queries in these Skills were validated against the live database.
Last validated: 2026-08-12.
