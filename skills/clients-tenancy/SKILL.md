---
name: clients-tenancy
description: >-
  Client (tenant) records, subscription plans, users and roles, per-client and
  per-user settings, tenant membership, onboarding checklist, and data
  integrations. Use for questions about who the clients are, their plan, users,
  configuration, and which importers are enabled. Headline tables: clients,
  plans, users, integrations, clients_integrations.
---

# Clients, Plans, Users & Tenancy

## Overview
This domain holds the SaaS/tenancy layer: the **clients** (tenants) and their
subscription **plans**, the **users** and their roles, per-client and per-user
**settings**, tenant membership, the onboarding checklist, and the **data
integrations** (importers) that feed the operational domains.

## Tables
- **`<schema>.clients`** — client/tenant records. PK: `id` (uuid). Columns:
  `subdomain` (text, not null) — tenant subdomain; `plan_id` (uuid, joins
  `plans.id`); `status` (enum `client_status`, not null); `created_at`,
  `deleted_at` (soft delete). Scale: a handful.
- **`<schema>.plans`** — subscription plans. PK: `id` (uuid). Columns: `name`
  (text, not null), `description`, `status` (text), `price` (double),
  `created_at`, `updated_at`. Table comment: "Plans for clients".
- **`<schema>.users`** — application users. PK: `id` (uuid). Columns: `name`,
  `email`, `role` (smallint — coded, see below), `status` (text),
  `client_id` (uuid, joins `clients.id`), `created_at`, `updated_at`. Scale:
  dozens.
- **`<schema>.settings`** — per-client key/value settings. PK: `id` (bigint).
  Columns: `name` (text, not null), `variable_label` (text),
  `variable_value` (text, not null), `client_id` (uuid, not null, joins
  `clients.id`), `created_at`, `updated_at`. Table comment: "Client settings".
- **`<schema>.local_settings`** — per-user key/value settings. PK: `id`
  (bigint). Columns: `name`, `variable_label`, `variable_value` (jsonb, not
  null), `user_id` (uuid, joins `users.id`). RLS disabled.
- **`<schema>.user_tenants`** — user↔tenant membership. PK: `id` (integer).
  Columns: `user_id` (varchar), `email` (varchar), `tenant_schema` (varchar),
  `role` (varchar), `is_active` (boolean). RLS disabled.
- **`<schema>.kickoff_checklist_state`** — onboarding checklist per client. PK:
  `client_id` (uuid). Columns: `checked_items` (jsonb, not null), `created_at`,
  `updated_at`.
- **`<schema>.integrations`** — catalog of data importers. PK: `id` (uuid).
  Columns: `name`, `description`, `image`, `status` (text), `target_entity`
  (text) — what it feeds, `code` (enum `integration_code`), `column_schema`
  (jsonb), `config_schema` (jsonb), `eligible_plans` (array), `created_at`.
- **`<schema>.clients_integrations`** — which integrations a client has enabled
  and their config. PK: `id` (uuid). Columns: `client_id` (uuid, joins
  `clients.id`), `integration_id` (uuid, joins `integrations.id`), `status`
  (text), `column_mapping` (jsonb), `config` (jsonb), `created_at`.

## Relationships (validated)
Implicit joins.
- `clients.plan_id → plans.id` (verified).
- `users.client_id → clients.id` (verified).
- `clients_integrations.integration_id → integrations.id` (verified).
- `clients_integrations.client_id → clients.id`; `settings.client_id →
  clients.id`; `local_settings.user_id → users.id`;
  `kickoff_checklist_state.client_id → clients.id` (same-key joins).

## Key concepts & terminology
- **`clients.status`** — enum `client_status`: `active`, `maintenance`,
  `inactive` (validated; observed `active`).
- **`users.role`** — a smallint code; observed values `1`, `2`, `3`, `9`. The
  business meaning of each code is **not** derivable from the schema — treat as
  an opaque code and confirm with application config.
- **`users.status`** — validated values `active`, `pending`.
- **`integrations.code`** — enum `integration_code`, the importer type:
  `practices-csv`, `supplies-csv`, `supplies-bejerman`, `os-ub-csv`,
  `os-prices-csv`, `derivations-conventions-csv`, `reportings-csv`,
  `supplies-tango` (validated). `bejerman`/`tango` are ERP connectors.
- **`integrations.target_entity`** — what an importer feeds: `supplies`, `os`,
  `reportings`, `derivations`, `practices` (validated).
- **`clients_integrations.status`** — validated values `enabled`, `disabled`.
- **Settings** are generic name/value pairs: `settings` is per client (value is
  text), `local_settings` is per user (value is jsonb).

## Metrics & calculations
- **Clients by status/plan**: `count(*)` grouped by `clients.status` and plan
  name.
- **Users by role/status**: `count(*)` grouped by `role`, `status`.
- **Enabled integrations**: `count(*)` in `clients_integrations` where
  `status = 'enabled'`.

## Semantic rules
- `deleted_at` on `clients` is a soft delete — exclude non-null for active
  tenants.
- `eligible_plans` on `integrations` gates which plans may use an importer.
- Each `integrations.code` value corresponds to a `jobs.type` used when that
  importer runs (see Platform & System domain).

## Ambiguities & gotchas
- `users.role` and `comments.roles` (Platform domain) are numeric codes with no
  in-database lookup; the mapping to role names lives in the application.
- `plans.status` was null in the tenant checked — status may be unused for
  plans.
- `user_tenants` and `user_access` (a view combining user/tenant/role) support
  cross-tenant access control; `user_tenants` and `local_settings` have RLS
  disabled.

## Example queries (validated)
`<schema>` is swappable per tenant.

```sql
-- Q: Clients by status and plan.
select c.status, p.name as plan, count(*) as clients
from <schema>.clients c
left join <schema>.plans p on c.plan_id = p.id
group by c.status, p.name;
```

```sql
-- Q: Users by role code and status.
select role, status, count(*) as n
from <schema>.users
group by role, status
order by n desc;
```

```sql
-- Q: The integrations (importers) catalog by target entity.
select name, code, target_entity, status
from <schema>.integrations
order by target_entity;
```

```sql
-- Q: How many client integrations are enabled vs disabled?
select status, count(*) as n
from <schema>.clients_integrations
group by status;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas. All
tables, relationships, coded values and queries were validated against the live
database. Last validated: 2026-08-12.
