# Integración de mcpYt en mcp/ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `safe-postgres-mcp`'s (mcpYt) domain logic — startup privilege audit, lexical guard, read-only transaction wrapper, formatting, and its 6 tools — into `mcp/`, keeping mcpYt's tool behavior byte-for-byte, but serving it through `mcp/`'s existing multi-tenant Streamable HTTP + OAuth 2.1 + Basic Auth transport instead of mcpYt's single-tenant stdio transport.

**Architecture:** `mcp/`'s transport/auth files (`index.ts`, `oauth.ts`) stay structurally the same; `tools.ts` and `db.ts` are replaced. A new `IdentityContextCache` builds mcpYt's `{ db, config, report, schema }` context once per authenticated username (running the privilege audit exactly once), caches it in memory for the life of the process, and hands it to mcpYt's unmodified `registerTools()`. Two existing identity modes (`direct` = Basic Auth, own pool; `assume` = OAuth, shared bootstrap pool + `SET LOCAL ROLE`) are preserved, with the new `Db` class supporting both via an injected pool and an optional `assumeRole`.

**Tech Stack:** TypeScript (NodeNext), Express, `pg`, `@modelcontextprotocol/sdk` (`McpServer`, `StreamableHTTPServerTransport`), Zod, `node:test` + `tsx` for tests.

## Global Constraints

- Both source projects already agree on `@modelcontextprotocol/sdk ^1.12.0` and `zod ^3.23.8` (verified in both `package.json`s) — **no dependency version bumps are needed anywhere in this plan.**
- Every file ported from mcpYt uses **`.js` import extensions**, never `.ts` — `mcp/`'s `tsconfig.json` is `module: NodeNext` / `moduleResolution: NodeNext` and compiles via `tsc` to `dist/`, unlike mcpYt's `bundler`/`tsx`-only setup. This is the one mechanical change applied to every ported file.
- **Do not add** the `-c default_transaction_read_only=on` Postgres startup option to any pool. `mcp/`'s existing pool config deliberately avoids the `options` startup parameter because Supabase's connection pooler (Supavisor, in use per `PGHOST=aws-0-us-west-1.pooler.supabase.com`) can reject or ignore it. The explicit `BEGIN TRANSACTION READ ONLY` per query is the real, already-proven enforcement (mcpYt's own integration test exists specifically to confirm this layer works alone).
- **No `PG_SCHEMA`-style global override.** Schema is always auto-detected per user from their Postgres `GRANT`s (`resolveSchema()`). If a role can see zero or more than one non-system schema, `resolveSchema()` throws — surfaced as an audit failure (401 for Basic Auth, re-shown login form for OAuth). This is intentional per the approved design spec, not a gap to fill in.
- **Tool-facing text is never translated.** Every string mcpYt sends to the model (tool titles, descriptions, guard rejection reasons, audit check names/details) stays in English, exactly as written in `mcpYt/src/**`. This was an explicit requirement during design ("mismos nombres, descriptions, lógica").
- **New glue code follows `mcp/`'s existing Spanish convention** for operator/developer-facing strings (matches `CLAUDE.md`: "Comments and identifiers in `db.ts`/`oauth.ts`/`config.ts` are in Spanish") — this applies to the new `pool.ts`, `identity.ts`, `identity-context.ts`, and the modified sections of `index.ts`/`oauth.ts`/`config.ts`.
- **Only successful audits are cached.** A failed audit is never cached — the next connection attempt from that username re-runs it. This lets a user who just fixed a Postgres `GRANT` succeed on their very next try, without a server restart. Successful audits are cached forever (until process restart) — this is an accepted, documented limitation from the design spec, not something to add a TTL for.
- Source references used throughout this plan: `/mnt/c/Users/lucas/Desktop/mcpYt/src/**` (source of the ported logic) and `/mnt/c/Users/lucas/Desktop/mcp/src/**` (integration target, branch `feat/mcpyt-integration`).
- Design spec: `docs/superpowers/specs/2026-08-10-mcpyt-integration-design.md`.

---

### Task 1: `allowWritableRole` config field, remove `userSchemaTemplate`

Per the approved design spec ("No se conserva ... `USER_SCHEMA_TEMPLATE`"): schema resolution moves entirely to mcpYt's auto-detection (Task 6/8), so the old template-substitution field becomes dead code and is removed in the same step that adds its replacement.

**Files:**
- Modify: `src/config.ts`

**Interfaces:**
- Produces: `AppConfig.allowWritableRole: boolean` — read by `audit.ts`'s `AuditConfig` (Task 6) and by the `get_database_info` tool (Task 7).
- Removes: `AppConfig.userSchemaTemplate` — no longer read anywhere after Task 4 (the new `Db` takes its schema from `resolveSchema()`, not from a template string).

- [ ] **Step 1: Add `allowWritableRole` to `AppConfig` and `loadConfig()`**

In `src/config.ts`, add to the `AppConfig` interface (after `maxRows: number;`):

```ts
  // Auditoría de privilegios (mcpYt): baja de fatal a warning el chequeo de
  // permisos de escritura del rol. El resto de los chequeos (superuser,
  // BYPASSRLS, extensiones de escape) nunca se pueden anular.
  allowWritableRole: boolean;
```

And in `loadConfig()`'s returned object (after `maxRows: int("MAX_ROWS", 1000),`):

```ts
    allowWritableRole: bool("ALLOW_WRITABLE_ROLE", false),
```

- [ ] **Step 2: Remove `userSchemaTemplate`**

In `src/config.ts`, delete the field from the `AppConfig` interface:

```ts
// delete this block
  // search_path para sesiones OAuth (SET ROLE no aplica el search_path del
  // rol destino). {user} se reemplaza por el nombre del usuario.
  userSchemaTemplate: string;
```

and delete its line from `loadConfig()`'s returned object:

```ts
// delete this line
    userSchemaTemplate: process.env.USER_SCHEMA_TEMPLATE?.trim() || "{user}",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors from `src/config.ts` itself. `src/db.ts` (old file, still present until Task 4) still reads `cfg.userSchemaTemplate` — this **will** error now; that's expected and gets resolved by Task 4, which replaces `db.ts` entirely. Confirm the only error is that one line in the old `src/db.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "config: add ALLOW_WRITABLE_ROLE, remove the now-unused USER_SCHEMA_TEMPLATE"
```

---

### Task 2: Test infra + pure ported files (`guard.ts`, `format.ts`, `errors.ts`)

**Files:**
- Create: `src/guard.ts` (verbatim copy, zero imports to fix)
- Create: `src/format.ts` (verbatim copy, zero imports to fix)
- Create: `src/errors.ts` (verbatim copy, zero imports to fix)
- Create: `tests/guard.test.ts` (ported, one import to fix)
- Modify: `package.json` (add test scripts)

**Interfaces:**
- Produces: `inspectSql(sql: string): GuardResult` from `guard.ts` — consumed by `tools/query.ts` and `tools/explain-query.ts` (Task 7).
- Produces: `renderTable`, `renderRecords`, `renderValue` from `format.ts` — consumed by all 6 tool files (Task 7).
- Produces: `describeError`, `redact`, `registerSecret` from `errors.ts` — consumed by `tools/shared.ts` (Task 7) and `identity-context.ts` (Task 8).

- [ ] **Step 1: Copy the three pure files unchanged**

```bash
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/guard.ts /mnt/c/Users/lucas/Desktop/mcp/src/guard.ts
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/format.ts /mnt/c/Users/lucas/Desktop/mcp/src/format.ts
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/errors.ts /mnt/c/Users/lucas/Desktop/mcp/src/errors.ts
```

None of these three files import anything (verified by reading them during design) — no edits needed.

- [ ] **Step 2: Add test scripts to `package.json`**

In `package.json`, add to `"scripts"` (after `"typecheck": "tsc --noEmit"`):

```json
    "test": "tsx --test tests/*.test.ts",
    "test:unit": "tsx --test tests/guard.test.ts",
    "test:integration": "tsx --test tests/integration.test.ts"
```

- [ ] **Step 3: Port the guard unit tests**

```bash
mkdir -p /mnt/c/Users/lucas/Desktop/mcp/tests
cp /mnt/c/Users/lucas/Desktop/mcpYt/tests/guard.test.ts /mnt/c/Users/lucas/Desktop/mcp/tests/guard.test.ts
```

Edit `tests/guard.test.ts`, change the only import:

```ts
// old
import { inspectSql } from '../src/guard.ts';
// new
import { inspectSql } from '../src/guard.js';
```

- [ ] **Step 4: Run the unit tests**

Run: `npm run test:unit`
Expected: all ~40 tests pass (pure function, no DB needed).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/guard.ts src/format.ts src/errors.ts tests/guard.test.ts package.json
git commit -m "Port guard, format and errors modules from mcpYt, add test:unit script"
```

---

### Task 3: `identity.ts` (Identity type) and `pool.ts` (pool lifecycle)

Extracts the two responsibilities that today live tangled together in `src/db.ts` (the old, soon-to-be-replaced file): who the caller is, and how connections/pools are created and closed. Neither depends on mcpYt code — this is prep work so Task 5's new `db.ts` can be pool-agnostic.

**Files:**
- Create: `src/identity.ts`
- Create: `src/pool.ts`

**Interfaces:**
- Produces: `Identity` type from `identity.ts` — consumed by `index.ts` (Task 10), `oauth.ts` (Task 11), `identity-context.ts` (Task 8).
- Produces: `PoolRegistry` class from `pool.ts` (`getUserPool`, `getBootstrapPool`, `validateCredentials`, `pingBootstrap`, `closeAll`) and `AuthError` — consumed by `identity-context.ts` (Task 8), `index.ts` (Task 10), `oauth.ts` (Task 11).

- [ ] **Step 1: Create `src/identity.ts`**

```ts
/** Identidad resuelta de quien hace la consulta. */
export type Identity =
  | { mode: "direct"; username: string; password: string } // Basic Auth
  | { mode: "assume"; username: string }; // OAuth (SET ROLE)
```

- [ ] **Step 2: Create `src/pool.ts`**

```ts
/**
 * Ciclo de vida de las conexiones a PostgreSQL: SSL, pools por usuario
 * (Basic Auth) y el pool bootstrap compartido (OAuth). No ejecuta queries;
 * eso es responsabilidad de db.ts.
 */

import pg from "pg";
import type { AppConfig } from "./config.js";

export class AuthError extends Error {}

export class PoolRegistry {
  private userPools = new Map<string, pg.Pool>();
  private bootstrapPool: pg.Pool | null = null;

  constructor(private cfg: AppConfig) {}

  private ssl() {
    return this.cfg.sslMode === "disable"
      ? false
      : this.cfg.sslMode === "no-verify"
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true };
  }

  private basePoolConfig(user: string, password: string): pg.PoolConfig {
    return {
      host: this.cfg.pgHost,
      port: this.cfg.pgPort,
      database: this.cfg.pgDatabase,
      user,
      password,
      ssl: this.ssl(),
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // El modo read-only lo garantiza `BEGIN TRANSACTION READ ONLY` en
      // db.ts, no el parámetro de arranque `options`: el pooler de Supabase
      // (Supavisor) puede rechazarlo.
    };
  }

  /** Pool directo para un usuario (Basic Auth). Cacheado por usuario+password. */
  getUserPool(user: string, password: string): pg.Pool {
    const key = `${user} ${password}`;
    let pool = this.userPools.get(key);
    if (!pool) {
      pool = new pg.Pool(this.basePoolConfig(user, password));
      this.userPools.set(key, pool);
    }
    return pool;
  }

  getBootstrapPool(): pg.Pool {
    if (!this.cfg.bootstrapUser || !this.cfg.bootstrapPassword) {
      throw new AuthError(
        "Sesión OAuth pero no hay BOOTSTRAP_DB_USER/PASSWORD configurados.",
      );
    }
    if (!this.bootstrapPool) {
      this.bootstrapPool = new pg.Pool(
        this.basePoolConfig(this.cfg.bootstrapUser, this.cfg.bootstrapPassword),
      );
    }
    return this.bootstrapPool;
  }

  /**
   * Valida usuario/contraseña abriendo una conexión real. No deja pool
   * abierto. Devuelve null si conecta OK, o el mensaje de error real si
   * falla (útil para distinguir credenciales incorrectas de problemas de
   * red/SSL).
   */
  async validateCredentials(user: string, password: string): Promise<string | null> {
    const pool = new pg.Pool({ ...this.basePoolConfig(user, password), max: 1 });
    try {
      const c = await pool.connect();
      c.release();
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[pool] Falló la conexión como "${user}":`, msg);
      return msg;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  /** Chequeo de conectividad del rol bootstrap al arrancar (si aplica). */
  async pingBootstrap(): Promise<void> {
    if (!this.cfg.bootstrapUser) return;
    const c = await this.getBootstrapPool().connect();
    try {
      await c.query("SELECT 1");
    } finally {
      c.release();
    }
  }

  async closeAll(): Promise<void> {
    for (const p of this.userPools.values()) await p.end().catch(() => {});
    if (this.bootstrapPool) await this.bootstrapPool.end().catch(() => {});
  }
}
```

This is the old `Database` class from `src/db.ts` with `assertReadOnly`/`runReadOnly`/query execution removed — pool lifecycle only.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (nothing imports these two files yet).

- [ ] **Step 4: Commit**

```bash
git add src/identity.ts src/pool.ts
git commit -m "Extract Identity type and pool lifecycle out of db.ts"
```

---

### Task 4: New `src/db.ts` (query execution, decoupled from pool ownership)

Replaces the current `src/db.ts` content entirely. This is mcpYt's `Db` class merged with `mcp/`'s `SET ROLE` requirement: the pool is now *injected* (mcpYt's original builds its own pool from a single `DATABASE_URL`, which doesn't fit one process serving many tenants), and an optional `assumeRole` makes every transaction run `SET LOCAL ROLE` first when serving an OAuth ("assume") identity.

**Files:**
- Modify: `src/db.ts` (full rewrite)

**Interfaces:**
- Consumes: nothing from earlier tasks (only `pg` types).
- Produces: `Db` class (`constructor(options: DbOptions)`, `setSchema`, `getSchema`, `withReadOnly`, `catalogQuery`, `runUserQuery`), `extended()`, `quoteIdentifier()`, `EXTENDED_PROTOCOL`, `QueryOutcome` type — consumed by `audit.ts` (Task 6), all tool files (Task 7), `identity-context.ts` (Task 8), `tests/integration.test.ts` (Task 12).

- [ ] **Step 1: Replace `src/db.ts`**

```ts
/**
 * Ejecución de queries de sólo lectura contra un pool ya existente.
 * No crea ni cierra pools (eso es responsabilidad de pool.ts) — sólo sabe
 * ejecutar dentro de una transacción READ ONLY, opcionalmente asumiendo un
 * rol (`SET LOCAL ROLE`) y un schema (`search_path`).
 *
 * Puerto de mcpYt (safe-postgres-mcp/src/db.ts), adaptado para recibir un
 * pool inyectado en vez de crear el suyo propio a partir de un DATABASE_URL,
 * y para soportar `SET LOCAL ROLE` — necesario para las sesiones OAuth de
 * mcp/, que corren físicamente como el rol bootstrap y asumen la identidad
 * real dentro de cada transacción.
 */

import type pg from "pg";
import type { PoolClient } from "pg";

export interface QueryOutcome {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/**
 * Fuerza el protocolo extendido, bajo el cual el backend rechaza parsear más
 * de un comando ("cannot insert multiple commands into a prepared
 * statement", SQLSTATE 42601). Es una defensa a nivel de protocolo que no
 * depende de que nuestro lexer sea correcto.
 *
 * Pasar `values: []` NO alcanza: `Query.requiresPreparation()` de `pg`
 * devuelve `values.length > 0`, así que un array vacío cae al protocolo
 * simple, que acepta `SELECT 1; SELECT 2`. `queryMode` es una opción real de
 * `pg` pero falta en `@types/pg`, de ahí el cast en cada call site.
 */
export const EXTENDED_PROTOCOL = { queryMode: "extended" } as const;

type ExtendedQueryConfig = pg.QueryConfig & { queryMode: "extended"; rowMode?: "array" };

export function extended(config: {
  text: string;
  values?: unknown[];
  rowMode?: "array";
}): ExtendedQueryConfig {
  return {
    text: config.text,
    values: config.values ?? [],
    ...(config.rowMode ? { rowMode: config.rowMode } : {}),
    ...EXTENDED_PROTOCOL,
  } as ExtendedQueryConfig;
}

/** Envuelve un identificador para interpolarlo de forma segura. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Statements válidos como subquery, así se les puede aplicar LIMIT envolviéndolos. */
const WRAPPABLE = /^(select|with|table|values)\b/i;

export interface DbOptions {
  /** Pool ya existente; esta clase no lo crea ni lo cierra. */
  pool: pg.Pool;
  statementTimeoutMs: number;
  /**
   * Si se define, cada transacción hace `SET LOCAL ROLE` a este rol antes de
   * correr nada más — usado por las sesiones OAuth ("assume"), donde la
   * conexión física corre como el rol bootstrap pero las queries y la
   * auditoría de privilegios deben reflejar al usuario real.
   */
  assumeRole: string | null;
}

/**
 * Todo lo que manda SQL a Postgres pasa por esta clase, y cada uno de esos
 * caminos corre dentro de una transacción READ ONLY que siempre se
 * rollbackea.
 */
export class Db {
  private readonly pool: pg.Pool;
  private readonly statementTimeoutMs: number;
  private readonly assumeRole: string | null;
  private schema: string | null = null;

  constructor(options: DbOptions) {
    this.pool = options.pool;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.assumeRole = options.assumeRole;
  }

  /** Se fija una vez que la auditoría resolvió a qué schema tenant está anclado este server. */
  setSchema(schema: string): void {
    this.schema = schema;
  }

  getSchema(): string | null {
    return this.schema;
  }

  /**
   * Corre `work` dentro de `BEGIN TRANSACTION READ ONLY` con los timeouts
   * configurados, el rol asumido (si aplica) y el schema tenant en el
   * search_path. La transacción siempre se rollbackea, incluso si tuvo
   * éxito: nada de lo que hace este servidor se commitea jamás.
   */
  async withReadOnly<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      if (this.assumeRole) {
        // SET ROLE no hereda el search_path del rol destino: se fija abajo.
        await client.query(`SET LOCAL ROLE ${quoteIdentifier(this.assumeRole)}`);
      }
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = ${this.statementTimeoutMs}`,
      );
      if (this.schema) {
        await client.query(`SET LOCAL search_path TO ${quoteIdentifier(this.schema)}`);
      }
      return await work(client);
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Un rollback fallido significa que la transacción ya no existe;
        // liberar el cliente abajo es la única limpieza que queda por hacer.
      }
      client.release();
    }
  }

  /**
   * Corre SQL de confianza interno (introspección de catálogo). Siempre
   * parametrizado, así que viaja por el protocolo extendido, que rechaza
   * múltiples statements a nivel de protocolo.
   */
  async catalogQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.withReadOnly(async (client) => {
      const result = await client.query<T>(extended({ text, values: params }));
      return result.rows;
    });
  }

  /**
   * Corre un statement provisto por el caller que ya pasó el guard léxico.
   *
   * El límite de filas se aplica envolviendo el statement como subquery, así
   * lo aplica la base y no después de materializar todo. Si el statement no
   * se puede envolver, corre tal cual y se trunca en memoria — igual acotado
   * por el statement_timeout.
   */
  async runUserQuery(statement: string, limit: number): Promise<QueryOutcome> {
    return this.withReadOnly(async (client) => {
      if (WRAPPABLE.test(statement.trimStart())) {
        try {
          const wrapped = `SELECT * FROM (\n${statement}\n) AS _mcp_result LIMIT ${limit + 1}`;
          return toOutcome(
            await client.query(extended({ text: wrapped, rowMode: "array" })),
            limit,
          );
        } catch (error) {
          // Algunos statements válidos no sobreviven a volverse subquery.
          // Se sigue de largo, corre el original, y se trunca en memoria.
          if (!isSyntaxLikeError(error)) throw error;
          await client.query("ROLLBACK");
          await client.query("BEGIN TRANSACTION READ ONLY");
          if (this.assumeRole) {
            await client.query(`SET LOCAL ROLE ${quoteIdentifier(this.assumeRole)}`);
          }
          await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
          if (this.schema) {
            await client.query(`SET LOCAL search_path TO ${quoteIdentifier(this.schema)}`);
          }
        }
      }

      return toOutcome(await client.query(extended({ text: statement, rowMode: "array" })), limit);
    });
  }
}

/** Errores que sugieren que el problema fue envolver en subquery, no la query en sí. */
function isSyntaxLikeError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42601" || code === "42P10" || code === "0A000";
}

function toOutcome(result: pg.QueryResult, limit: number): QueryOutcome {
  const columns = result.fields.map((field) => field.name);
  const allRows = result.rows as unknown as unknown[][];
  const truncated = allRows.length > limit;
  return {
    columns,
    rows: truncated ? allRows.slice(0, limit) : allRows,
    truncated,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: errors in `src/tools.ts` and `src/index.ts` (they still reference the old `Database`/`Identity`/`ReadOnlyViolationError` exports) — **expected at this point in the plan**, resolved by Tasks 9–11. Confirm the *only* errors are in those two files, nothing new in `src/db.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "Replace db.ts with mcpYt's pool-agnostic Db (extended protocol, SET LOCAL ROLE support)"
```

---

### Task 5: `.env.example` — document `ALLOW_WRITABLE_ROLE`, remove `USER_SCHEMA_TEMPLATE`

Small, standalone doc task placed here so it isn't forgotten later.

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the new variable**

In `.env.example`, after the `STATEMENT_TIMEOUT_MS`/`MAX_ROWS` block, add:

```bash
# Auditoría de privilegios (mcpYt): baja de fatal a warning el chequeo de
# permisos de escritura del rol conectado. Los chequeos de superuser,
# BYPASSRLS y extensiones de escape (dblink, etc.) nunca se pueden anular.
# ALLOW_WRITABLE_ROLE=false
```

- [ ] **Step 2: Remove the now-unused `USER_SCHEMA_TEMPLATE`**

Delete its block (schema is auto-detected now, per Task 1):

```bash
# delete this block
# Plantilla del schema por usuario (SET ROLE no fija el search_path).
# {user} se reemplaza por el nombre del usuario. Si el schema de cada
# persona se llama igual que su usuario, dejá el default.
USER_SCHEMA_TEMPLATE={user}
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: document ALLOW_WRITABLE_ROLE, drop USER_SCHEMA_TEMPLATE from .env.example"
```

---

### Task 6: Port `audit.ts`

**Files:**
- Create: `src/audit.ts`

**Interfaces:**
- Consumes: `Db` (`db.catalogQuery`) from Task 4.
- Produces: `runAudit(db, config): Promise<AuditReport>`, `resolveSchema(report, config): string`, `remediationScript(schema): string`, `AuditFailure` class, `AuditReport`/`AuditCheck`/`Severity` types, `AuditConfig` type, `formatAuditFailure(error): string`, `summarizeAuditFailure(error): string` — consumed by `identity-context.ts` (Task 8), `tools/database-info.ts` (Task 7), `index.ts` (Task 10), `oauth.ts` (Task 11).

- [ ] **Step 1: Copy the file**

```bash
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/audit.ts /mnt/c/Users/lucas/Desktop/mcp/src/audit.ts
```

- [ ] **Step 2: Replace the `Config` import with a local, minimal `AuditConfig`**

Edit `src/audit.ts`. Change:

```ts
// old
import type { Config } from './config.ts';
import type { Db } from './db.ts';
```

to:

```ts
// new
import type { Db } from "./db.js";

/**
 * Único subconjunto de AppConfig que necesita la auditoría — se define acá
 * en vez de importar AppConfig completo para no atar audit.ts a mcp/'s
 * config shape entero (útil también para tests: ver tests/integration.test.ts).
 */
export interface AuditConfig {
  allowWritableRole: boolean;
  /** Ya no es una variable de entorno global multi-tenant: siempre null en producción. */
  schemaOverride: string | null;
}
```

Then replace every remaining `config: Config` parameter type in the file with `config: AuditConfig` — there are two: `runAudit(db: Db, config: Config)` and `resolveSchema(report: AuditReport, config: Config)`. Every other line (the checks themselves, `AuditFailure`, `remediationScript`, all the SQL) stays exactly as copied.

- [ ] **Step 3: Add the failure-formatting helpers**

mcpYt keeps this formatting in its single-tenant `index.ts`; `mcp/` needs it from two call sites (`index.ts` for Basic Auth 401s, `oauth.ts` for the OAuth login form), so it belongs in `audit.ts` itself. Append to the end of `src/audit.ts`:

```ts
/** Detalle completo de una falla de auditoría, para el 401 de Basic Auth (uso de operador/editor). */
export function formatAuditFailure(error: AuditFailure): string {
  const lines = [error.message];
  if (error.failures.length > 0) {
    lines.push("", "Chequeos que fallaron:");
    for (const failure of error.failures) {
      lines.push(`  - ${failure.name}: ${failure.detail}`);
    }
  }

  const schema = error.report?.schemas[0] ?? "tu_schema";
  const onlyOverridable = error.failures.every(
    (failure) =>
      failure.name.includes("write privileges") ||
      failure.name.includes("create objects") ||
      failure.name.includes("create databases"),
  );

  if (error.failures.length > 0 && onlyOverridable) {
    lines.push("", "Creá un rol de sólo lectura dedicado:", "", remediationScript(schema));
  } else if (error.failures.length > 0) {
    lines.push(
      "",
      "Estos chequeos no se pueden anular: los privilegios de arriba permiten que una consulta escape de la transacción read-only. Usá un rol dedicado y sin privilegios:",
      "",
      remediationScript(schema),
    );
  }

  return lines.join("\n");
}

/** Resumen de una línea, para mostrar en el formulario de login OAuth. */
export function summarizeAuditFailure(error: AuditFailure): string {
  const first = error.failures[0];
  return first ? `${error.message} (${first.name}: ${first.detail})` : error.message;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no new errors from `src/audit.ts` (the pre-existing `tools.ts`/`index.ts` errors from Task 4 are still there — unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts
git commit -m "Port audit.ts from mcpYt with a local AuditConfig and failure-formatting helpers"
```

---

### Task 7: Port the 6 tools + `tools/shared.ts` + `tools/index.ts`

**Files:**
- Create: `src/tools/shared.ts`
- Create: `src/tools/query.ts`
- Create: `src/tools/list-tables.ts`
- Create: `src/tools/describe-table.ts`
- Create: `src/tools/explain-query.ts`
- Create: `src/tools/list-relationships.ts`
- Create: `src/tools/database-info.ts`
- Create: `src/tools/index.ts`

**Interfaces:**
- Consumes: `Db` (Task 4), `AppConfig` (existing `config.ts` + Task 1), `AuditReport` (Task 6), `describeError` (Task 2), `renderTable`/`renderRecords` (Task 2), `inspectSql` (Task 2), `extended` (Task 4).
- Produces: `ToolContext` type, `registerTools(server, context)` — consumed by `src/tools.ts` (Task 9).

- [ ] **Step 1: Copy all 7 files into a new `src/tools/` directory**

```bash
mkdir -p /mnt/c/Users/lucas/Desktop/mcp/src/tools
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/tools/shared.ts /mnt/c/Users/lucas/Desktop/mcp/src/tools/shared.ts
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/tools/query.ts /mnt/c/Users/lucas/Desktop/mcp/src/tools/query.ts
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/tools/list-tables.ts /mnt/c/Users/lucas/Desktop/mcp/src/tools/list-tables.ts
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/tools/describe-table.ts /mnt/c/Users/lucas/Desktop/mcp/src/tools/describe-table.ts
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/tools/explain-query.ts /mnt/c/Users/lucas/Desktop/mcp/src/tools/explain-query.ts
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/tools/list-relationships.ts /mnt/c/Users/lucas/Desktop/mcp/src/tools/list-relationships.ts
cp /mnt/c/Users/lucas/Desktop/mcpYt/src/tools/database-info.ts /mnt/c/Users/lucas/Desktop/mcp/src/tools/database-info.ts
```

Note: `mcp/`'s old `src/tools.ts` (the flat file) is left untouched for now — it's rewritten in Task 9. There is no naming clash: `src/tools.ts` and `src/tools/` coexist as distinct paths.

- [ ] **Step 2: Fix `src/tools/shared.ts`'s imports and `ToolContext.config` type**

Replace the whole import block and the `ToolContext` interface at the top of the file:

```ts
// old
import type { AuditReport } from '../audit.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { describeError } from '../errors.ts';

export interface ToolContext {
  db: Db;
  config: Config;
  report: AuditReport;
  /** The tenant schema this server is anchored to. */
  schema: string;
}
```

```ts
// new
import type { AuditReport } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { describeError } from "../errors.js";

export interface ToolContext {
  db: Db;
  config: AppConfig;
  report: AuditReport;
  /** The tenant schema this server is anchored to. */
  schema: string;
}
```

Nothing else in the file changes — `AppConfig` already has `maxRows`/`statementTimeoutMs`/`allowWritableRole` (Task 1), the only fields any tool actually reads off `context.config`.

- [ ] **Step 3: Fix the remaining import lines (`.ts` → `.js`)**

In `src/tools/query.ts`:

```ts
// old
import { renderTable } from '../format.ts';
import { inspectSql } from '../guard.ts';
import { errorResult, guarded, textResult, type ToolContext, type ToolResult } from './shared.ts';
// new
import { renderTable } from "../format.js";
import { inspectSql } from "../guard.js";
import { errorResult, guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";
```

In `src/tools/list-tables.ts`:

```ts
// old
import { renderRecords } from '../format.ts';
import { describeRelkind, guarded, textResult, type ToolContext, type ToolResult } from './shared.ts';
// new
import { renderRecords } from "../format.js";
import { describeRelkind, guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";
```

In `src/tools/describe-table.ts`:

```ts
// old
import { renderRecords } from '../format.ts';
import {
  errorResult,
  guarded,
  resolveRelation,
  textResult,
  type ToolContext,
  type ToolResult,
} from './shared.ts';
// new
import { renderRecords } from "../format.js";
import {
  errorResult,
  guarded,
  resolveRelation,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";
```

In `src/tools/explain-query.ts`:

```ts
// old
import { extended } from '../db.ts';
import { inspectSql } from '../guard.ts';
import { errorResult, guarded, textResult, type ToolContext, type ToolResult } from './shared.ts';
// new
import { extended } from "../db.js";
import { inspectSql } from "../guard.js";
import { errorResult, guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";
```

In `src/tools/list-relationships.ts`:

```ts
// old
import { renderRecords } from '../format.ts';
import { guarded, textResult, type ToolContext, type ToolResult } from './shared.ts';
// new
import { renderRecords } from "../format.js";
import { guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";
```

In `src/tools/database-info.ts`:

```ts
// old
import { renderRecords } from '../format.ts';
import { guarded, textResult, type ToolContext, type ToolResult } from './shared.ts';
// new
import { renderRecords } from "../format.js";
import { guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";
```

- [ ] **Step 4: Create `src/tools/index.ts` (`registerTools`)**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { databaseInfo, databaseInfoDescription } from "./database-info.js";
import { describeTable, describeTableDescription, describeTableInputSchema } from "./describe-table.js";
import { explainQuery, explainQueryDescription, explainQueryInputSchema } from "./explain-query.js";
import { listRelationships, listRelationshipsDescription } from "./list-relationships.js";
import { listTables, listTablesDescription } from "./list-tables.js";
import { queryDescription, queryInputSchema, runQuery } from "./query.js";
import type { ToolContext } from "./shared.js";

/** Every tool here is read-only, which the annotations advertise to the client. */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "query",
    {
      title: "Run a read-only SQL query",
      description: queryDescription(context),
      inputSchema: queryInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => runQuery(context, args),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables and views",
      description: listTablesDescription(context),
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => listTables(context),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe a table",
      description: describeTableDescription(context),
      inputSchema: describeTableInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => describeTable(context, args),
  );

  server.registerTool(
    "list_relationships",
    {
      title: "List foreign-key relationships",
      description: listRelationshipsDescription(context),
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => listRelationships(context),
  );

  server.registerTool(
    "explain_query",
    {
      title: "Explain a query plan",
      description: explainQueryDescription(context),
      inputSchema: explainQueryInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => explainQuery(context, args),
  );

  server.registerTool(
    "get_database_info",
    {
      title: "Show connection and safety status",
      description: databaseInfoDescription(),
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => databaseInfo(context),
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors from anything under `src/tools/` (the pre-existing errors in the old flat `src/tools.ts` and `src/index.ts` remain, unaffected until Tasks 9–11).

- [ ] **Step 6: Commit**

```bash
git add src/tools/
git commit -m "Port mcpYt's 6 tools and registerTools() into src/tools/"
```

---

### Task 8: `identity-context.ts` (the per-user cache)

**Files:**
- Create: `src/identity-context.ts`

**Interfaces:**
- Consumes: `runAudit`, `resolveSchema`, `AuditConfig` (Task 6); `Db` (Task 4); `Identity` (Task 3); `PoolRegistry` (Task 3); `ToolContext` (Task 7); `AppConfig` (existing).
- Produces: `IdentityContextCache` class (`constructor(pools, cfg)`, `get(identity): Promise<ToolContext>`) — consumed by `index.ts` (Task 10) and `oauth.ts` (Task 11).

- [ ] **Step 1: Create the file**

```ts
/**
 * Cachea, por usuario, el contexto que necesitan las tools de mcpYt: el
 * `Db` ya apuntando al pool correcto, el schema del tenant (auto-detectado
 * por sus GRANTs) y el reporte de la auditoría de privilegios.
 *
 * Se arma una única vez por usuario (la primera vez que se conecta) y se
 * cachea en memoria por el resto de la vida del proceso — evita volver a
 * auditar en cada sesión nueva de la misma persona. Sólo se cachean
 * auditorías EXITOSAS: si falla, no se guarda nada, así alguien que corrige
 * sus permisos en Postgres puede reintentar sin esperar un reinicio del
 * servidor.
 */

import { resolveSchema, runAudit, type AuditConfig } from "./audit.js";
import type { AppConfig } from "./config.js";
import { Db } from "./db.js";
import type { Identity } from "./identity.js";
import { PoolRegistry } from "./pool.js";
import type { ToolContext } from "./tools/shared.js";

export class IdentityContextCache {
  private cache = new Map<string, Promise<ToolContext>>();

  constructor(
    private pools: PoolRegistry,
    private cfg: AppConfig,
  ) {}

  /** Devuelve (armando y cacheando si hace falta) el ToolContext de un usuario. */
  async get(identity: Identity): Promise<ToolContext> {
    const cached = this.cache.get(identity.username);
    if (cached) return cached;

    const built = this.build(identity);
    this.cache.set(identity.username, built);
    // Si falla, no dejamos la promesa rechazada cacheada: el próximo intento
    // debe volver a auditar, no repetir el mismo error para siempre.
    built.catch(() => this.cache.delete(identity.username));
    return built;
  }

  private async build(identity: Identity): Promise<ToolContext> {
    const pool =
      identity.mode === "direct"
        ? this.pools.getUserPool(identity.username, identity.password)
        : this.pools.getBootstrapPool();

    // El sufijo de Supabase (ej: ".nfjjlfovpznoipgkugdf") es sólo para el
    // pooler; el rol real de Postgres es la parte antes del primer punto.
    const pgRole = identity.username.split(".")[0]!;

    const db = new Db({
      pool,
      statementTimeoutMs: this.cfg.statementTimeoutMs,
      assumeRole: identity.mode === "assume" ? pgRole : null,
    });

    const auditConfig: AuditConfig = {
      allowWritableRole: this.cfg.allowWritableRole,
      schemaOverride: null,
    };

    const report = await runAudit(db, auditConfig);
    const schema = resolveSchema(report, auditConfig);
    db.setSchema(schema);

    return { db, config: this.cfg, report, schema };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors from `src/identity-context.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/identity-context.ts
git commit -m "Add IdentityContextCache: builds and caches mcpYt's ToolContext per user"
```

---

### Task 9: Rewrite `src/tools.ts`

**Files:**
- Modify: `src/tools.ts` (full rewrite — the old 4-tool definitions are deleted)

**Interfaces:**
- Consumes: `registerTools` (Task 7), `ToolContext` (Task 7).
- Produces: `createMcpServer(context: ToolContext): McpServer` — consumed by `index.ts` (Task 10).

- [ ] **Step 1: Replace the file**

```ts
/**
 * Construye el McpServer para una identidad ya resuelta (ver
 * identity-context.ts): registra las tools de mcpYt tal cual, sin
 * adaptarlas — el schema/rol/permisos ya están resueltos en el ToolContext.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/index.js";
import type { ToolContext } from "./tools/shared.js";

export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: "postgres-readonly", version: "2.0.0" },
    {
      instructions:
        `Read-only PostgreSQL server, anchored to the "${context.schema}" schema. ` +
        "Start with list_tables to see what's available, then describe_table or " +
        "list_relationships before writing joins. query runs a single read-only " +
        "statement; explain_query shows its plan without running it. Nothing here " +
        "can modify data or structure.",
    },
  );

  registerTools(server, context);

  return server;
}
```

(`instructions` is in English, matching mcpYt's own tool text, per the Global Constraints — this field isn't listed among `CLAUDE.md`'s Spanish-convention files.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: `src/tools.ts` itself is now clean; remaining errors are only in `src/index.ts` and `src/oauth.ts` (resolved next).

- [ ] **Step 3: Commit**

```bash
git add src/tools.ts
git commit -m "Rewrite createMcpServer to register mcpYt's tools from a pre-built ToolContext"
```

---

### Task 10: Wire `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `PoolRegistry` (Task 3), `IdentityContextCache` (Task 8), `AuditFailure`/`formatAuditFailure` (Task 6), `Identity` (Task 3), `createMcpServer(context)` (Task 9), `mountOAuth` (Task 11 — signature changes there).

- [ ] **Step 1: Update imports**

```ts
// old
import { loadConfig } from "./config.js";
import { Database, type Identity } from "./db.js";
import { createMcpServer } from "./tools.js";
import { mountOAuth } from "./oauth.js";
```

```ts
// new
import { AuditFailure, formatAuditFailure } from "./audit.js";
import { loadConfig } from "./config.js";
import type { Identity } from "./identity.js";
import { IdentityContextCache } from "./identity-context.js";
import { mountOAuth } from "./oauth.js";
import { PoolRegistry } from "./pool.js";
import { createMcpServer } from "./tools.js";
```

- [ ] **Step 2: Replace the `Database` construction**

```ts
// old
const cfg = loadConfig();
const db = new Database(cfg);
```

```ts
// new
const cfg = loadConfig();
const pools = new PoolRegistry(cfg);
const identityContexts = new IdentityContextCache(pools, cfg);
```

- [ ] **Step 3: Update `mountOAuth` call**

```ts
// old
const oauth = mountOAuth(app, db, cfg);
```

```ts
// new
const oauth = mountOAuth(app, pools, identityContexts, cfg);
```

- [ ] **Step 4: Replace the session-init block inside `app.post("/mcp", ...)`**

```ts
// old
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Para Basic Auth validamos las credenciales al iniciar la sesión.
      if (auth.identity.mode === "direct") {
        const err = await db.validateCredentials(auth.identity.username, auth.identity.password);
        if (err) {
          return send401(res, { ok: false, status: 401, message: `No se pudo conectar a la base como "${auth.identity.username}": ${err}` });
        }
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const server = createMcpServer(db, cfg, auth.identity);
      await server.connect(transport);
    } else {
```

```ts
// new
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Arma (o reutiliza del cache) el contexto de esta identidad: conecta,
      // audita sus privilegios y resuelve su schema. Reemplaza el chequeo
      // de credenciales que hacía antes sólo para Basic Auth — ahora corre
      // para las dos modalidades, porque la auditoría también aplica a OAuth.
      let context: Awaited<ReturnType<typeof identityContexts.get>>;
      try {
        context = await identityContexts.get(auth.identity);
      } catch (err) {
        if (err instanceof AuditFailure) {
          return send401(res, { ok: false, status: 401, message: formatAuditFailure(err) });
        }
        const detail = err instanceof Error ? err.message : String(err);
        return send401(res, {
          ok: false,
          status: 401,
          message: `No se pudo conectar a la base como "${auth.identity.username}": ${detail}`,
        });
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const server = createMcpServer(context);
      await server.connect(transport);
    } else {
```

- [ ] **Step 5: Update startup and shutdown**

```ts
// old (inside main())
  if (cfg.bootstrapUser) {
    try {
      await db.pingBootstrap();
      console.log("[db] Rol bootstrap verificado (para sesiones OAuth).");
```

```ts
// new
  if (cfg.bootstrapUser) {
    try {
      await pools.pingBootstrap();
      console.log("[db] Rol bootstrap verificado (para sesiones OAuth).");
```

```ts
// old (inside shutdown())
    for (const t of transports.values()) await t.close().catch(() => {});
    await db.close().catch(() => {});
```

```ts
// new
    for (const t of transports.values()) await t.close().catch(() => {});
    await pools.closeAll().catch(() => {});
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: only remaining errors are inside `src/oauth.ts` (Task 11).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "Wire index.ts to IdentityContextCache: audit runs on every session init, not just Basic Auth"
```

---

### Task 11: Wire `src/oauth.ts`

**Files:**
- Modify: `src/oauth.ts`

**Interfaces:**
- Consumes: `PoolRegistry` (Task 3), `IdentityContextCache` (Task 8), `AuditFailure`/`summarizeAuditFailure` (Task 6).

- [ ] **Step 1: Update imports**

```ts
// old
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Express, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { Database } from "./db.js";
```

```ts
// new
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Express, Request, Response } from "express";
import { AuditFailure, summarizeAuditFailure } from "./audit.js";
import type { AppConfig } from "./config.js";
import type { IdentityContextCache } from "./identity-context.js";
import type { PoolRegistry } from "./pool.js";
```

- [ ] **Step 2: Update `mountOAuth`'s signature**

```ts
// old
export function mountOAuth(app: Express, db: Database, cfg: AppConfig): OAuthLayer {
```

```ts
// new
export function mountOAuth(
  app: Express,
  pools: PoolRegistry,
  identityContexts: IdentityContextCache,
  cfg: AppConfig,
): OAuthLayer {
```

- [ ] **Step 3: Update the `POST /authorize` handler**

```ts
// old
  app.post("/authorize", async (req: Request, res: Response) => {
    const { client_id, redirect_uri, code_challenge, state, username, password } =
      req.body as Record<string, string>;

    const client = client_id ? clients.get(client_id) : undefined;
    if (!client || !redirect_uri || !client.redirectUris.includes(redirect_uri) || !code_challenge) {
      res.status(400).send("Petición de autorización inválida.");
      return;
    }

    const err = username && password ? await db.validateCredentials(username, password) : "faltan credenciales";
    if (err) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        loginPage({ client_id, redirect_uri, code_challenge, state: state ?? "", error: "Usuario o contraseña incorrectos." }),
      );
      return;
    }

    const code = rand(24);
```

```ts
// new
  app.post("/authorize", async (req: Request, res: Response) => {
    const { client_id, redirect_uri, code_challenge, state, username, password } =
      req.body as Record<string, string>;

    const client = client_id ? clients.get(client_id) : undefined;
    if (!client || !redirect_uri || !client.redirectUris.includes(redirect_uri) || !code_challenge) {
      res.status(400).send("Petición de autorización inválida.");
      return;
    }

    const err = username && password ? await pools.validateCredentials(username, password) : "faltan credenciales";
    if (err) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        loginPage({ client_id, redirect_uri, code_challenge, state: state ?? "", error: "Usuario o contraseña incorrectos." }),
      );
      return;
    }

    // Auditar acá, no sólo al primer /mcp: así la falla se ve en la pantalla
    // de login, no como un error críptico ya "dentro" de ChatGPT.
    try {
      await identityContexts.get({ mode: "assume", username });
    } catch (auditError) {
      const message =
        auditError instanceof AuditFailure
          ? summarizeAuditFailure(auditError)
          : "No se pudo verificar los permisos de este usuario.";
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        loginPage({ client_id, redirect_uri, code_challenge, state: state ?? "", error: message }),
      );
      return;
    }

    const code = rand(24);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: **zero errors** across the whole project.

- [ ] **Step 5: Commit**

```bash
git add src/oauth.ts
git commit -m "oauth: run the privilege audit at /authorize, fail the login form instead of the first tool call"
```

---

### Task 12: Port and adapt the integration tests + the new assume-mode audit test

**Files:**
- Create: `tests/integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4, 6, 7 (`Db`, `audit.ts`, tool functions).

- [ ] **Step 1: Create the file**

This is a rewrite of mcpYt's `tests/integration.test.ts`, not a mechanical port: mcpYt's `contextFor()` calls its own `loadConfig(env)` (which accepts an injectable env object) to build a `Db` that creates its own pool from `config.databaseUrl`. `mcp/`'s `Db` no longer builds its own pool (Task 4) and its `loadConfig()` doesn't accept injected env (it reads `process.env` directly, and requires unrelated vars like `PUBLIC_URL`) — so the test harness builds a `pg.Pool` and a fake `AppConfig` object directly instead.

```ts
/**
 * Integration tests against a real PostgreSQL server.
 *
 * Requires TEST_ADMIN_URL: a connection string for a role that can create a
 * schema and roles. Everything is created under the schema "mcp_test" and
 * dropped again afterwards. Without it the whole suite is skipped.
 *
 *   TEST_ADMIN_URL=postgres://owner:pw@host:5432/db npm run test:integration
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import pg from "pg";

import { AuditFailure, resolveSchema, runAudit, type AuditConfig } from "../src/audit.js";
import type { AppConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { describeTable } from "../src/tools/describe-table.js";
import { explainQuery } from "../src/tools/explain-query.js";
import { listRelationships } from "../src/tools/list-relationships.js";
import { listTables } from "../src/tools/list-tables.js";
import { runQuery } from "../src/tools/query.js";
import type { ToolContext } from "../src/tools/shared.js";

const ADMIN_URL = process.env.TEST_ADMIN_URL;
const SCHEMA = "mcp_test";
const READER = { user: "mcp_test_reader", password: "mcp_test_reader_pw" };
const WRITER = { user: "mcp_test_writer", password: "mcp_test_writer_pw" };

function connectionFor(role: { user: string; password: string }): string {
  const url = new URL(ADMIN_URL!);
  url.username = role.user;
  url.password = role.password;
  return url.toString();
}

/** Minimal AppConfig for tests — only the fields the audit/tools actually read matter. */
function fakeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    pgHost: "localhost",
    pgPort: 5432,
    pgDatabase: "test",
    sslMode: "disable",
    bootstrapUser: null,
    bootstrapPassword: null,
    statementTimeoutMs: 10_000,
    maxRows: 200,
    publicUrl: "http://localhost",
    port: 3000,
    allowedOrigins: [],
    enableBasicAuth: true,
    tokenTtlSeconds: 3600,
    allowWritableRole: false,
    ...overrides,
  };
}

/** Builds a Db + ToolContext for a given role, running the audit exactly as the server does. */
async function contextFor(
  role: { user: string; password: string },
  openPools: pg.Pool[],
  overrides: Partial<AppConfig> = {},
): Promise<ToolContext> {
  const pool = new pg.Pool({ connectionString: connectionFor(role) });
  openPools.push(pool);

  const config = fakeConfig(overrides);
  const db = new Db({ pool, statementTimeoutMs: config.statementTimeoutMs, assumeRole: null });
  const auditConfig: AuditConfig = { allowWritableRole: config.allowWritableRole, schemaOverride: SCHEMA };
  const report = await runAudit(db, auditConfig);
  const schema = resolveSchema(report, auditConfig);
  db.setSchema(schema);
  return { db, config, report, schema };
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("mcp/ against a real database (mcpYt tools ported in)", { skip: !ADMIN_URL }, () => {
  let admin: pg.Client;
  const openPools: pg.Pool[] = [];

  before(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);

    await admin.query(`
      CREATE TABLE ${SCHEMA}.clientes (
        id     serial PRIMARY KEY,
        nombre text NOT NULL,
        email  text UNIQUE
      )`);
    await admin.query(`COMMENT ON TABLE ${SCHEMA}.clientes IS 'Clientes del tenant de prueba'`);
    await admin.query(`COMMENT ON COLUMN ${SCHEMA}.clientes.email IS 'Correo de contacto'`);

    await admin.query(`
      CREATE TABLE ${SCHEMA}.pedidos (
        id         serial PRIMARY KEY,
        cliente_id integer NOT NULL REFERENCES ${SCHEMA}.clientes(id),
        total      numeric(10,2) NOT NULL CHECK (total >= 0),
        creado_en  timestamptz NOT NULL DEFAULT now()
      )`);
    await admin.query(`CREATE INDEX pedidos_cliente_idx ON ${SCHEMA}.pedidos (cliente_id)`);

    await admin.query(`
      CREATE VIEW ${SCHEMA}.pedidos_por_cliente AS
        SELECT c.nombre, count(p.id) AS pedidos
          FROM ${SCHEMA}.clientes c
          LEFT JOIN ${SCHEMA}.pedidos p ON p.cliente_id = c.id
         GROUP BY c.nombre`);

    await admin.query(`
      INSERT INTO ${SCHEMA}.clientes (nombre, email)
      VALUES ('Ana', 'ana@example.com'), ('Beto', 'beto@example.com'), ('Cata', 'cata@example.com')`);
    await admin.query(`
      INSERT INTO ${SCHEMA}.pedidos (cliente_id, total)
      VALUES (1, 100.50), (1, 20.00), (2, 300.00)`);
    await admin.query(`ANALYZE ${SCHEMA}.clientes`);
    await admin.query(`ANALYZE ${SCHEMA}.pedidos`);

    for (const role of [READER, WRITER]) {
      await admin.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.user}') THEN
            EXECUTE 'DROP OWNED BY ${role.user}';
            EXECUTE 'DROP ROLE ${role.user}';
          END IF;
        END $$`);
      await admin.query(`CREATE ROLE ${role.user} LOGIN PASSWORD '${role.password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role.user}`);
    }

    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${READER.user}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${WRITER.user}`,
    );
  });

  after(async () => {
    for (const pool of openPools) await pool.end().catch(() => {});
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    for (const role of [READER, WRITER]) {
      await admin.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.user}') THEN
            EXECUTE 'DROP OWNED BY ${role.user}';
            EXECUTE 'DROP ROLE ${role.user}';
          END IF;
        END $$`);
    }
    await admin.end();
  });

  // --- Layer 1: the startup audit ------------------------------------------

  test("accepts a read-only role and anchors the tenant schema", async () => {
    const context = await contextFor(READER, openPools);

    assert.equal(context.schema, SCHEMA);
    assert.equal(context.report.role, READER.user);

    const byName = (fragment: string) =>
      context.report.checks.find((check) => check.name.includes(fragment));

    assert.equal(byName("superuser")?.passed, true);
    assert.equal(byName("predefined role")?.passed, true);
    assert.equal(byName("escape")?.passed, true);
    assert.equal(
      byName("write privileges")?.passed,
      true,
      "a SELECT-only role must pass the write-grant check",
    );
  });

  test("refuses a role that holds write grants", async () => {
    await assert.rejects(
      () => contextFor(WRITER, openPools),
      (error: unknown) => {
        assert.ok(error instanceof AuditFailure, `expected AuditFailure, got ${String(error)}`);
        const names = error.failures.map((failure) => failure.name).join(", ");
        assert.match(names, /write privileges/);
        return true;
      },
    );
  });

  test("ALLOW_WRITABLE_ROLE downgrades the write-grant failure to a warning", async () => {
    const context = await contextFor(WRITER, openPools, { allowWritableRole: true });

    const writeCheck = context.report.checks.find((check) => check.name.includes("write privileges"));
    assert.equal(writeCheck?.passed, false);
    assert.equal(writeCheck?.severity, "warning");
  });

  // --- Layer 3: Postgres itself refuses the write --------------------------

  test("an INSERT by a role that CAN write is still blocked with SQLSTATE 25006", async () => {
    // Load-bearing test: the guard is bypassed entirely, and the role
    // genuinely holds INSERT. Only the READ ONLY transaction can stop it.
    const context = await contextFor(WRITER, openPools, { allowWritableRole: true });

    await assert.rejects(
      () =>
        context.db.withReadOnly(async (client) => {
          await client.query({
            text: `INSERT INTO ${SCHEMA}.clientes (nombre) VALUES ($1)`,
            values: ["deberia fallar"],
          });
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "25006");
        return true;
      },
    );

    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.clientes`);
    assert.equal(rows[0].n, 3, "the row must not exist after the rejected INSERT");
  });

  // --- Tools ------------------------------------------------------------

  describe("tools", () => {
    let context: ToolContext;

    before(async () => {
      context = await contextFor(READER, openPools);
    });

    test("list_tables finds the seeded tables and the view", async () => {
      const output = textOf(await listTables(context));
      assert.match(output, /clientes/);
      assert.match(output, /pedidos/);
      assert.match(output, /pedidos_por_cliente/);
    });

    test("describe_table reports columns, keys and indexes", async () => {
      const output = textOf(await describeTable(context, { table: "pedidos" }));
      assert.match(output, /cliente_id/);
      assert.match(output, /PRIMARY KEY/);
      assert.match(output, /FOREIGN KEY/);
    });

    test("list_relationships shows the pedidos to clientes edge", async () => {
      const output = textOf(await listRelationships(context));
      assert.match(output, /pedidos\.cliente_id → clientes\.id/);
    });

    test("query returns rows from the tenant schema without qualification", async () => {
      const output = textOf(await runQuery(context, { sql: "SELECT nombre FROM clientes ORDER BY nombre" }));
      assert.match(output, /Ana/);
      assert.match(output, /3 row\(s\)/);
    });

    test("query refuses an INSERT before it reaches the database", async () => {
      const result = await runQuery(context, { sql: `INSERT INTO clientes (nombre) VALUES ('x')` });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /forbidden-statement/);
    });

    test("explain_query returns a plan without executing", async () => {
      const output = textOf(await explainQuery(context, { sql: "SELECT * FROM pedidos" }));
      assert.match(output, /Scan/);
    });
  });

  // --- assume mode: SET LOCAL ROLE must reflect the assumed role's privileges, not the bootstrap's ---

  describe("assume mode (OAuth): SET LOCAL ROLE inside withReadOnly", () => {
    const ASSUMED_BOOTSTRAP = { user: "mcp_test_bootstrap", password: "mcp_test_bootstrap_pw" };

    before(async () => {
      await admin.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ASSUMED_BOOTSTRAP.user}') THEN
            EXECUTE 'DROP OWNED BY ${ASSUMED_BOOTSTRAP.user}';
            EXECUTE 'DROP ROLE ${ASSUMED_BOOTSTRAP.user}';
          END IF;
        END $$`);
      // NOINHERIT mirrors mcp/'s real bootstrap role: it must hold no
      // privileges of its own, only what it reaches via SET ROLE.
      await admin.query(
        `CREATE ROLE ${ASSUMED_BOOTSTRAP.user} LOGIN PASSWORD '${ASSUMED_BOOTSTRAP.password}' NOINHERIT`,
      );
      await admin.query(`GRANT ${READER.user} TO ${ASSUMED_BOOTSTRAP.user}`);
    });

    after(async () => {
      await admin.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ASSUMED_BOOTSTRAP.user}') THEN
            EXECUTE 'DROP OWNED BY ${ASSUMED_BOOTSTRAP.user}';
            EXECUTE 'DROP ROLE ${ASSUMED_BOOTSTRAP.user}';
          END IF;
        END $$`);
    });

    test("auditing the bootstrap connection directly sees no reachable schema (NOINHERIT, no grants of its own)", async () => {
      const pool = new pg.Pool({ connectionString: connectionFor(ASSUMED_BOOTSTRAP) });
      openPools.push(pool);
      const db = new Db({ pool, statementTimeoutMs: 10_000, assumeRole: null });
      const auditConfig: AuditConfig = { allowWritableRole: false, schemaOverride: null };

      const report = await runAudit(db, auditConfig);
      assert.equal(report.role, ASSUMED_BOOTSTRAP.user);
      assert.equal(report.schemas.length, 0, "NOINHERIT with no direct grants must reach no schema");
    });

    test("auditing with assumeRole set to the reader reflects the reader's privileges, not the bootstrap's", async () => {
      const pool = new pg.Pool({ connectionString: connectionFor(ASSUMED_BOOTSTRAP) });
      openPools.push(pool);
      const db = new Db({ pool, statementTimeoutMs: 10_000, assumeRole: READER.user });
      const auditConfig: AuditConfig = { allowWritableRole: false, schemaOverride: SCHEMA };

      const report = await runAudit(db, auditConfig);
      assert.equal(report.role, READER.user, "current_user inside the transaction must be the assumed role");
      assert.ok(report.schemas.includes(SCHEMA), "the assumed role's schema grant must be visible");

      const schema = resolveSchema(report, auditConfig);
      db.setSchema(schema);
      const output = textOf(await listTables({ db, config: fakeConfig(), report, schema }));
      assert.match(output, /clientes/);
    });
  });
});
```

- [ ] **Step 2: Run the integration tests**

Run: `TEST_ADMIN_URL=postgres://<owner>:<pw>@<host>:5432/<db> npm run test:integration`

(Use an admin/owner connection string against a disposable or dev database — the suite creates and drops `mcp_test`, `mcp_test_reader`, `mcp_test_writer` and `mcp_test_bootstrap`.)

Expected: all tests pass, including the two new `assume mode` tests.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (test files aren't in the root `tsconfig.json`'s `include`, so this just re-confirms `src/` is still clean).

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "Port mcpYt's integration tests, adapted to injected pools, plus a new assume-mode audit test"
```

---

### Task 13: Update `test-client.mjs`

**Files:**
- Modify: `test-client.mjs`

- [ ] **Step 1: Replace the tool calls**

```js
// old
  console.log("── list_schemas ──");
  const schemas = await client.callTool({ name: "list_schemas", arguments: {} });
  console.log(schemas.content?.[0]?.text ?? JSON.stringify(schemas), "\n");

  console.log("── list_tables ──");
  const tablesRes = await client.callTool({ name: "list_tables", arguments: {} });
  console.log(tablesRes.content?.[0]?.text ?? JSON.stringify(tablesRes), "\n");

  console.log("── execute_sql: SELECT count(*) FROM jobs ──");
  const q = await client.callTool({
    name: "execute_sql",
    arguments: { sql: "SELECT count(*) AS total FROM jobs" },
  });
  console.log(q.content?.[0]?.text ?? JSON.stringify(q));
```

```js
// new
  console.log("── list_tables ──");
  const tablesRes = await client.callTool({ name: "list_tables", arguments: {} });
  console.log(tablesRes.content?.[0]?.text ?? JSON.stringify(tablesRes), "\n");

  console.log("── list_relationships ──");
  const rels = await client.callTool({ name: "list_relationships", arguments: {} });
  console.log(rels.content?.[0]?.text ?? JSON.stringify(rels), "\n");

  console.log("── get_database_info ──");
  const info = await client.callTool({ name: "get_database_info", arguments: {} });
  console.log(info.content?.[0]?.text ?? JSON.stringify(info), "\n");

  console.log("── query: SELECT count(*) FROM jobs ──");
  const q = await client.callTool({
    name: "query",
    arguments: { sql: "SELECT count(*) AS total FROM jobs" },
  });
  console.log(q.content?.[0]?.text ?? JSON.stringify(q));
```

(`describe_table` and `explain_query` are left out of the smoke test since they need a real table name — same reasoning the original script used by only exercising `execute_sql` against a table it assumed existed.)

- [ ] **Step 2: Commit**

```bash
git add test-client.mjs
git commit -m "test-client: exercise the 6 ported tools instead of the old 4"
```

---

### Task 14: Update `README.md` and `CLAUDE.md`

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `README.md`'s tools table**

Replace:

```markdown
## Tools que expone

| Tool             | Qué hace                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `list_schemas`   | Schemas visibles para tu usuario.                                  |
| `list_tables`    | Tablas y vistas sobre las que tenés `SELECT`.                      |
| `describe_table` | Columnas, tipos, PK y FKs de una tabla.                            |
| `execute_sql`    | Una consulta de lectura con parámetros (`$1, $2, ...`).            |
```

with:

```markdown
## Tools que expone

Portadas de `safe-postgres-mcp` (mcpYt), con el mismo comportamiento y las mismas descriptions — sólo cambia cómo se resuelve la identidad (auth de este server) en vez de un único `DATABASE_URL`.

| Tool                 | Qué hace                                                                          |
| -------------------- | ---------------------------------------------------------------------------------- |
| `query`              | Una consulta de sólo lectura (`SELECT/WITH/EXPLAIN/TABLE/VALUES/SHOW`).            |
| `list_tables`        | Tablas, vistas y vistas materializadas del schema, con tamaño y comentario.        |
| `describe_table`     | Columnas, PK, FKs entrantes/salientes, constraints e índices de una tabla.         |
| `list_relationships` | Todo el grafo de foreign keys del schema, para escribir JOINs correctos.           |
| `explain_query`      | Plan de ejecución de una query, sin correrla (nunca usa `ANALYZE`).                |
| `get_database_info`  | A qué está conectado el server y qué chequeos de seguridad pasaron.                |

Además de la auditoría de privilegios al primer login de cada usuario (rechaza roles con `SUPERUSER`, `BYPASSRLS`, o acceso a `dblink`/extensiones de escape — ver "Seguridad de solo lectura" abajo).
```

- [ ] **Step 2: Add `ALLOW_WRITABLE_ROLE` to the env vars section, remove `USER_SCHEMA_TEMPLATE`**

Find README's environment variables table/section (adjacent to `MAX_ROWS`/`STATEMENT_TIMEOUT_MS`) and add a row/line documenting `ALLOW_WRITABLE_ROLE` (default `false`) with the same wording as `.env.example` (Task 5).

Also remove the `USER_SCHEMA_TEMPLATE` guidance in the "Paso 1 — Preparar Postgres" section:

```markdown
// delete this line
> Si tu convención es "cada usuario tiene un schema con su mismo nombre", no toques `USER_SCHEMA_TEMPLATE`. Si el schema se llama distinto, ajustá la plantilla (ej. `data_{user}`).
```

(schema resolution is now automatic — a role must have `USAGE` on exactly one non-system schema, or the login fails with an actionable error, per Task 1/6/8).

- [ ] **Step 3: Update `CLAUDE.md`'s Architecture section**

Update the per-file descriptions to reflect the new files (`pool.ts`, `identity.ts`, `identity-context.ts`, `audit.ts`, `guard.ts`, `format.ts`, `errors.ts`, `tools/`) and retire the description of the old `db.ts`/`tools.ts` responsibilities, matching what Tasks 1–11 actually built. Keep the "Defense in depth" section but add the startup privilege audit as an explicit new layer (it runs once per user, before layer 2 in the existing list).

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: reflect the mcpYt tool integration in README and CLAUDE.md"
```

---

## Final verification (after Task 14)

- [ ] `npm run typecheck` — zero errors.
- [ ] `npm run test:unit` — all guard tests pass.
- [ ] `npm run build` — `tsc` succeeds, `dist/` is produced.
- [ ] `TEST_ADMIN_URL=... npm run test:integration` — all integration tests pass, including the two `assume mode` tests.
- [ ] Manual smoke test: `npm run dev`, then `node test-client.mjs` (Basic Auth) against a real tenant role — confirm all called tools return real data.
- [ ] Manual smoke test over OAuth: repeat the ngrok + ChatGPT connector flow already validated for the old 4-tool version, confirm the 6 new tools appear and `query`/`list_tables` work end-to-end.
