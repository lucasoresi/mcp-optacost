# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote MCP server (Streamable HTTP) that exposes a **read-only, multi-tenant** view of a single PostgreSQL database. Each person authenticates with their own Postgres user/password and only ever sees their own schema — enforced by Postgres itself, not by application logic. Consumed by Claude Desktop/claude.ai, ChatGPT, Cursor, VS Code, and Claude Code.

The README.md (in Spanish) is the primary source of truth for setup, environment variables, and the two auth flows — read it before making auth or db changes.

## Commands

```bash
npm run dev        # tsx watch src/index.ts — local dev server with reload
npm run build       # tsc -> dist/
npm start           # node dist/index.js (requires build first)
npm run typecheck   # tsc --noEmit

npm run test:unit        # tsx --test tests/guard.test.ts — pure, no database
npm run test:integration # needs TEST_ADMIN_URL, skips entirely without it
npm test                 # both
```

`tests/integration.test.ts` needs `TEST_ADMIN_URL` — a connection string for a role that can create schemas and roles. It creates and drops the `mcp_test` schema plus the `mcp_test_reader`/`mcp_test_writer`/`mcp_test_bootstrap` roles, so point it at a disposable or dev database, never production.

`test-client.mjs` is a manual smoke-test script (Basic Auth against a local server) — edit the `USER`/`PASS` constants at the top before running with `node test-client.mjs`.

Requires a `.env` file (copy from `.env.example`) with at minimum `PUBLIC_URL`, `PGHOST`, `PGDATABASE`. See README.md's "Variables de entorno" table for the full list and defaults.

## Architecture

The transport/auth half is this project's own; the domain half (audit, guard, the 6 tools, formatting) was ported from `safe-postgres-mcp` (referred to as mcpYt, at `../mcpYt`), a single-tenant stdio server. See `docs/superpowers/specs/2026-08-10-mcpyt-integration-design.md` for why the split landed this way.

**Transport and auth (this project's own):**

- **`config.ts`** — reads and validates all env vars once at startup (`loadConfig()`), fails fast if required vars are missing. Everything else takes `AppConfig` as a dependency rather than reading `process.env` directly.
- **`identity.ts`** — the `Identity` union: `{mode: "direct", username, password}` for Basic Auth vs `{mode: "assume", username}` for OAuth.
- **`pool.ts`** — `PoolRegistry`: connection lifecycle only, no queries. Pools are cached per Basic-Auth user (keyed by user+password); OAuth sessions all share one bootstrap pool. Also holds `validateCredentials()` and the startup `pingBootstrap()`. Deliberately does **not** pass the `options` startup parameter (`default_transaction_read_only`) — Supabase's pooler can reject it, and the explicit `BEGIN TRANSACTION READ ONLY` is the real enforcement.
- **`oauth.ts`** — a minimal embedded OAuth 2.1 Authorization Server (metadata endpoints, Dynamic Client Registration, `/authorize` login form + PKCE S256, `/token` with refresh support). Exists solely so that OAuth-only clients (ChatGPT, Claude web/desktop) can "log in" with a Postgres username/password: `/authorize` shows a form, validates the credentials via `pools.validateCredentials()`, **then runs the privilege audit** so a bad role fails on the login screen instead of cryptically inside the client, and issues a token — the password itself is never stored, only the resulting `username` is (queries later run via `SET ROLE`). State (clients, tokens, refresh tokens) is in-memory but persisted to a JSON file (`OAUTH_STATE_FILE`, default `./oauth-state.json`) on every mutation so it survives restarts. **Not safe for multiple replicas** — see "Notas de producción" in the README if scaling out.
- **`index.ts`** — wires everything together: Express app, CORS, the `/mcp` route (`resolveAuth()` picks Bearer-token-via-OAuth vs Basic-Auth-direct, then either reuses an existing `StreamableHTTPServerTransport` by `Mcp-Session-Id` or creates a new one on an MCP `initialize` request), and process lifecycle (bootstrap connectivity check on startup, graceful shutdown closing transports/pools on SIGINT/SIGTERM).

**The glue between the two halves:**

- **`identity-context.ts`** — `IdentityContextCache` builds mcpYt's `ToolContext` (`{db, config, report, schema}`) for an `Identity`: picks the pool, runs the privilege audit, resolves the tenant schema, and caches the result in memory for the life of the process so a returning user isn't re-audited. **The cache key is `direct:<user>:<password>` or `assume:<user>`, and the password part is load-bearing** — session init consults nothing else, so a username-only key would let a wrong password cache-hit into the legitimate user's context. Only *successful* audits are cached, so someone who fixes their `GRANT`s can retry without a restart. Known accepted limitation: privilege changes in Postgres after a successful audit aren't noticed until restart.
- **`tools.ts`** — `createMcpServer(context)`: builds one `McpServer` per session from an already-resolved `ToolContext` and calls mcpYt's `registerTools()`. Every tool call is implicitly scoped to that user; no per-call auth check is needed inside the handlers.

**Ported from mcpYt (`db.ts`, `audit.ts`, `guard.ts`, `format.ts`, `errors.ts`, `tools/`):**

- **`db.ts`** — the only file that runs SQL. `Db` takes an *injected* pool (mcpYt's original built its own from a single `DATABASE_URL`, which doesn't fit one process serving many tenants) plus an optional `assumeRole`. Everything goes through `withReadOnly()`: `BEGIN TRANSACTION READ ONLY`, then `SET LOCAL ROLE` when a role is assumed, `statement_timeout`, `idle_in_transaction_session_timeout`, `SET LOCAL search_path` to the tenant schema, and always `ROLLBACK` — nothing this server does is ever committed. `catalogQuery()` is for internal introspection; `runUserQuery()` runs caller SQL that already passed the guard, applying `MAX_ROWS` by wrapping the statement as a subquery so the limit happens in the database. Both force `pg`'s **extended protocol** (`extended()`), under which the backend refuses to parse more than one command — a protocol-level defense that doesn't depend on the lexer being right.
- **`audit.ts`** — the privilege audit (`runAudit`) and tenant-schema detection (`resolveSchema`, from the role's real `GRANT`s — there is no schema template or env override; see the read-in-exactly-one-schema rule below). Fatal checks that can never be overridden: `SUPERUSER`, `BYPASSRLS`, `REPLICATION`, privileged predefined roles, and reachable escape hatches (`dblink`, FDWs, untrusted procedural languages). Checks that `ALLOW_WRITABLE_ROLE=true` downgrades to warnings: write grants, `CREATE` on a schema, `CREATEDB`, `CREATEROLE`. **Its check text is in Spanish while the rest of the ported code is English** — a deliberate choice, since those strings are operator-facing (they surface in the 401 body and the OAuth login form via `formatAuditFailure`/`summarizeAuditFailure`). This does make `get_database_info` mixed-language; that's accepted, not a bug to fix.
- **`guard.ts`** — the lexical guard (`inspectSql`): one statement only, allow-listed leading keyword, comment/string-aware.
- **`tools/`** — the 6 tools (`query`, `list_tables`, `describe_table`, `list_relationships`, `explain_query`, `get_database_info`), `shared.ts` (`ToolContext`, `guarded()`, `resolveRelation()`), and `index.ts` (`registerTools`).
- **`format.ts`** / **`errors.ts`** — text-table rendering, and error sanitization that keeps passwords out of anything returned to a client.

### Request flow for `/mcp`

1. `resolveAuth()` inspects the `Authorization` header: `Bearer <token>` → looks up the OAuth token (issued by `oauth.ts`) to get a username → `Identity{mode:"assume"}`. `Basic <base64>` → decodes straight to `Identity{mode:"direct", username, password}`.
2. On session init (no `Mcp-Session-Id` yet + `initialize` request), `identityContexts.get(identity)` connects, audits privileges and resolves the tenant schema — for **both** auth modes. An `AuditFailure` comes back as a 401 carrying the full failure detail plus a copy-pasteable remediation script.
3. A new `McpServer` (from `tools.ts`) is created bound to that one `ToolContext` and connected to a new `StreamableHTTPServerTransport`, tracked in the in-memory `transports` map keyed by session id.
4. Every tool call thereafter goes through that context's `Db` — read-only enforcement and per-user scoping both live there (Postgres permissions are the actual security boundary).

### Defense in depth (read-only guarantee)

Layered checks, all must hold — don't weaken any one of them without understanding the others (see README's "Seguridad de solo lectura" section):
1. Postgres role permissions (each user's role is already restricted to their schema).
2. The privilege audit in `audit.ts` — runs once per user before any tool is registered, and refuses roles that could escape the layers below.
3. `SET LOCAL ROLE` for OAuth sessions — runs with that person's actual privileges, not the bootstrap role's. The audit itself runs *after* it, so `has_*_privilege()` reflects the real user.
4. `BEGIN TRANSACTION READ ONLY` + `ROLLBACK` around every query.
5. `inspectSql()` in `guard.ts` — single-statement, allow-listed leading keyword — plus the extended protocol, which rejects multi-statement text at the wire level.
6. `statement_timeout` and `MAX_ROWS` row-count cap (truncation flagged in the response, not silently dropped).

## Working in this codebase

- **Language convention:** operator/developer-facing text is Spanish in the files this project owns (`config.ts`, `identity.ts`, `pool.ts`, `db.ts`, `identity-context.ts`, `oauth.ts`, `index.ts`, `tools.ts`) plus `audit.ts`. Everything the model reads — tool titles, descriptions, guard rejection reasons, `tools/**`, `guard.ts`, `format.ts`, `errors.ts` — stays in English, byte-for-byte as ported from mcpYt. Don't translate either direction.
- Ported files use `.js` import extensions (this project is `module: NodeNext` compiled with `tsc`, unlike mcpYt's `tsx`-only setup). Apply that when porting anything else across.
- The bootstrap Postgres role must be `NOINHERIT` and only usable via granted `SET ROLE` — this is a deliberate security property, not an oversight.
- When touching `inspectSql()`, remember it's the last line of defense against write statements reaching Postgres for OAuth (bootstrap-role) sessions; keep the keyword lists and single-statement check conservative.
- A tenant role must be able to **read** in exactly one non-system schema — that's how `resolveSchema()` picks the tenant. `USAGE` alone can't decide it: on Supabase, `public` and `pgsodium` grant `USAGE` to `PUBLIC`, so every role reaches three schemas and only one of them holds anything it can `SELECT` (hence `AuditReport.readableSchemas`). Reading in zero or several makes `resolveSchema()` throw, which surfaces as a login failure — that's intentional, not a gap to paper over with a config override. The one exception: a role reaching exactly one schema gets it even if empty, so a freshly created tenant with no tables yet still works.
