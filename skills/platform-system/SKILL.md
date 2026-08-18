---
name: platform-system
description: >-
  Operational plumbing: asynchronous import jobs, materialized-view refresh
  orchestration, backups, in-app comments/notifications, AI assistant chat
  history and vector embeddings. Use for questions about data-import runs, their
  status, view refreshes, and system/audit activity. Headline tables: jobs,
  refresh_jobs, comments.
---

# Platform & System

## Overview
This domain is the technical backbone that keeps the operational data fresh and
supports the app: **jobs** run the data imports that populate the business
domains, **refresh_jobs** rebuild the read-model views afterward, **backups**
track database snapshots, **comments** are in-app notes/notifications, and
**n8n_chat_histories** + **embeddings** support an AI assistant. Most
`historical_*` and `reportings` rows across the database carry a `job_id`
pointing back into `jobs`.

## Tables
- **`<schema>.jobs`** — asynchronous import/processing runs. PK: `id` (uuid).
  Scale: thousands. Columns: `type` (text) — what the job does; `status`
  (smallint — coded, see below); `payload` (json) — input; `result` (json) —
  output; `user_id` (uuid); `created_at`, `updated_at`.
- **`<schema>.refresh_jobs`** — read-model/view refresh orchestration. PK: `id`
  (bigint). Columns: `schema_name` (text) — target tenant schema; `view_names`
  (array) — views refreshed; `status` (text); `message` (text);
  `associated_job_id` (uuid, links to the `jobs` run that triggered it);
  `created_at`, `updated_at`. Not present in every tenant schema (exists in
  `public`).
- **`<schema>.backups`** — database backup records. PK: `id` (uuid). Columns:
  `file_name`, `file_path`, `file_size` (double), `restores` (integer),
  `created_at`, `last_restored_at`, `last_restored_by`.
- **`<schema>.comments`** — in-app comments/notifications. PK: `id` (uuid).
  Columns: `user_id` (uuid); `content` (text); `type` (varchar); `reply_to`
  (uuid, self-reference); `entity` (varchar) / `entity_id` (varchar) — what the
  comment is attached to; `roles` (smallint) / `only_for` (json) — visibility;
  `read_at`; `created_at`, `updated_at`. Scale: small.
- **`<schema>.n8n_chat_histories`** — AI assistant chat message log. PK: `id`
  (integer). Columns: `session_id` (varchar), `message` (jsonb). RLS disabled.
- **`<schema>.embeddings`** — vector store for semantic search / RAG. PK: `id`
  (varchar). Columns: `resource_id` (varchar), `content` (text), `embedding`
  (vector column, pgvector). RLS disabled.

## Relationships (validated)
Implicit joins.
- `reportings.job_id → jobs.id` (verified, full match), and
  `historical_costs.job_id → jobs.id` (verified). By the same convention,
  `historical_supplies.job_id`, `historical_stocks.job_id`,
  `historical_pricing.job_id`, `historical_os` producers and the benchmarking
  feeds carry `job_id → jobs.id`.
- `refresh_jobs.associated_job_id → jobs.id` (the import that triggered the
  refresh).
- `comments.reply_to → comments.id` (self-referencing thread).
- `comments.entity` / `entity_id` are a polymorphic reference to a business row
  (the target table depends on `entity`).

## Key concepts & terminology
- **`jobs.type`** — the importer that ran. Validated values: `update-supplies`
  (dominant), `update-prices`, `update-purchase-requirements`,
  `update-reportings`, `update-os-prices`, `update-ub-prices`,
  `update-external-sources-pricings`. These correspond to the
  `integrations.code` importers (Clients & Tenancy domain).
- **`jobs.status`** — a smallint code; observed values `1`, `2`, `3` with `2`
  dominant. Inferred mapping (from the parallel `request_status` enum
  PENDING/SUCCESS/ERROR and the distribution): `1` = pending/processing,
  `2` = success, `3` = error. **Inferred, not guaranteed** — confirm with the
  application.
- **`refresh_jobs.status`** — text; validated values `done`, `error`.
- **`embedding`** — a pgvector vector column enabling similarity search.

## Metrics & calculations
- **Import throughput / failures**: `count(*)` in `jobs` grouped by `type`,
  `status`.
- **View-refresh health**: `count(*)` and latest `created_at` in `refresh_jobs`
  grouped by `status`.
- **Job provenance of a fact row**: join any `*.job_id` back to `jobs` to see
  when/how the data was loaded.

## Semantic rules
- `jobs` is the audit/provenance backbone: nearly every `historical_*` and the
  `reportings` fact table reference the job that produced them.
- `refresh_jobs` are downstream of `jobs`; a successful import is typically
  followed by view refreshes for the same `schema_name`.
- `comments.entity`/`entity_id` is polymorphic — resolve the target table from
  the `entity` value before joining.

## Ambiguities & gotchas
- `jobs.status` code meaning is **inferred** (see above); do not hard-code a
  status label without confirmation.
- `refresh_jobs` (and `purchase_requirements` in the Inventory domain) exist in
  `public` but may be absent in some tenant schemas — verify existence.
- `comments.roles` is a numeric visibility code with no in-database lookup.
- RLS is disabled on `n8n_chat_histories` and `embeddings`.

## Example queries (validated)
`<schema>` is swappable per tenant.

```sql
-- Q: Import jobs by type and status (coded status; 2 = success observed).
select type, status, count(*) as n
from <schema>.jobs
group by type, status
order by n desc
limit 15;
```

```sql
-- Q: View-refresh health: counts and most recent run per status.
select status, count(*) as n, max(created_at) as last_run
from <schema>.refresh_jobs
group by status;
```

```sql
-- Q: Comments/notifications by type.
select type, count(*) as n
from <schema>.comments
group by type;
```

## Provenance
Schema analyzed: `public`. Architecture shared by all `tenant_*` schemas
(`refresh_jobs` may be absent in a given tenant). All tables, relationships,
coded values and queries were validated against the live database. `jobs.status`
code meaning is inferred and flagged. Last validated: 2026-08-12.
