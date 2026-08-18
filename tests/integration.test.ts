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

    // Fragmentos en español: audit.ts (Task 6) traduce los nombres de los checks.
    assert.equal(byName("superusuario")?.passed, true);
    assert.equal(byName("rol predefinido")?.passed, true);
    assert.equal(byName("escapar")?.passed, true);
    assert.equal(
      byName("privilegios de escritura")?.passed,
      true,
      "a SELECT-only role must pass the write-grant check",
    );
  });

  test("picks the tenant schema by readability, ignoring schemas it can only reach", async () => {
    // Con schemaOverride en null, resolveSchema tiene que elegir mcp_test por
    // sí solo. En Supabase el rol también ve public y pgsodium (USAGE otorgado
    // a PUBLIC) sin poder leer nada ahí: readableSchemas es lo que desempata.
    const pool = new pg.Pool({ connectionString: connectionFor(READER) });
    openPools.push(pool);
    const db = new Db({ pool, statementTimeoutMs: 10_000, assumeRole: null });
    const auditConfig: AuditConfig = { allowWritableRole: false, schemaOverride: null };

    const report = await runAudit(db, auditConfig);
    assert.deepEqual(
      report.readableSchemas,
      [SCHEMA],
      `only ${SCHEMA} should be readable, got ${report.readableSchemas.join(", ")} out of reachable ${report.schemas.join(", ")}`,
    );
    assert.equal(resolveSchema(report, auditConfig), SCHEMA);
  });

  test("refuses a role that holds write grants", async () => {
    await assert.rejects(
      () => contextFor(WRITER, openPools),
      (error: unknown) => {
        assert.ok(error instanceof AuditFailure, `expected AuditFailure, got ${String(error)}`);
        const names = error.failures.map((failure) => failure.name).join(", ");
        assert.match(names, /privilegios de escritura/);
        return true;
      },
    );
  });

  test("ALLOW_WRITABLE_ROLE downgrades the write-grant failure to a warning", async () => {
    const context = await contextFor(WRITER, openPools, { allowWritableRole: true });

    const writeCheck = context.report.checks.find((check) => check.name.includes("privilegios de escritura"));
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
