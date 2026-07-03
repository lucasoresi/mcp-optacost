/**
 * Definición del servidor MCP y sus tools de sólo lectura sobre PostgreSQL.
 * Cada instancia se crea para UNA identidad (el usuario autenticado), así que
 * todas las consultas quedan scopeadas al schema de esa persona.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { Database, ReadOnlyViolationError, type Identity } from "./db.js";

// Schemas internos de Postgres que nunca queremos listar.
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

function jsonText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function errorText(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createMcpServer(db: Database, cfg: AppConfig, identity: Identity): McpServer {
  const server = new McpServer(
    { name: "postgres-readonly", version: "2.0.0" },
    {
      instructions:
        `Servidor de SOLO LECTURA sobre PostgreSQL, autenticado como el usuario "${identity.username}". ` +
        "Sólo ves los schemas/tablas a los que ese usuario tiene permiso. Explorá con " +
        "list_schemas / list_tables / describe_table y consultá con execute_sql (SELECT). " +
        "No es posible modificar datos ni estructura.",
    },
  );

  const notSystem = `n.nspname <> ALL($1::text[])`;

  // ── list_schemas ────────────────────────────────────────────────
  server.registerTool(
    "list_schemas",
    {
      title: "Listar schemas",
      description: "Devuelve los schemas a los que tu usuario tiene acceso.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await db.runReadOnly(
          identity,
          `SELECT n.nspname AS schema
             FROM pg_namespace n
            WHERE has_schema_privilege(n.oid, 'USAGE')
              AND n.nspname <> ALL($1::text[])
            ORDER BY n.nspname`,
          [SYSTEM_SCHEMAS],
        );
        return jsonText(res.rows);
      } catch (e) {
        return errorText(describeError(e));
      }
    },
  );

  // ── list_tables ─────────────────────────────────────────────────
  server.registerTool(
    "list_tables",
    {
      title: "Listar tablas y vistas",
      description:
        "Lista tablas y vistas visibles para tu usuario, con tipo, comentario y " +
        "estimación de filas. Podés filtrar por un schema.",
      inputSchema: {
        schema: z.string().optional().describe("Schema a filtrar (opcional)."),
      },
    },
    async ({ schema }) => {
      try {
        const params: unknown[] = [SYSTEM_SCHEMAS];
        let schemaFilter = notSystem;
        if (schema) {
          params.push(schema);
          schemaFilter = `n.nspname = $2`;
        }
        const res = await db.runReadOnly(
          identity,
          `SELECT n.nspname AS schema,
                  c.relname AS name,
                  CASE c.relkind
                       WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table'
                       WHEN 'v' THEN 'view'  WHEN 'm' THEN 'materialized_view'
                       WHEN 'f' THEN 'foreign_table' ELSE c.relkind::text END AS type,
                  obj_description(c.oid) AS comment,
                  c.reltuples::bigint AS approx_rows
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p','v','m','f')
              AND has_schema_privilege(n.oid, 'USAGE')
              AND has_table_privilege(c.oid, 'SELECT')
              AND ${schemaFilter}
            ORDER BY n.nspname, c.relname`,
          params,
        );
        return jsonText(res.rows);
      } catch (e) {
        return errorText(describeError(e));
      }
    },
  );

  // ── describe_table ──────────────────────────────────────────────
  server.registerTool(
    "describe_table",
    {
      title: "Describir tabla",
      description:
        "Columnas (nombre, tipo, nullabilidad, default), clave primaria y claves " +
        "foráneas de una tabla o vista visible para tu usuario.",
      inputSchema: {
        table: z.string().describe("Nombre de la tabla o vista."),
        schema: z.string().optional().describe("Schema (opcional)."),
      },
    },
    async ({ table, schema }) => {
      try {
        const schemaCond = schema ? `table_schema = $2` : `table_schema NOT IN ('pg_catalog','information_schema')`;
        const colParams: unknown[] = schema ? [table, schema] : [table];

        const columns = await db.runReadOnly(
          identity,
          `SELECT table_schema, column_name, data_type, udt_name, is_nullable,
                  column_default, character_maximum_length, numeric_precision,
                  numeric_scale, ordinal_position
             FROM information_schema.columns
            WHERE table_name = $1 AND ${schemaCond}
            ORDER BY table_schema, ordinal_position`,
          colParams,
        );
        if (columns.rows.length === 0) {
          return errorText(`No se encontró "${schema ? schema + "." : ""}${table}" o no tenés acceso.`);
        }
        const targetSchema = (columns.rows[0] as { table_schema: string }).table_schema;

        const primaryKey = await db.runReadOnly(
          identity,
          `SELECT kcu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = $1 AND tc.table_name = $2
            ORDER BY kcu.ordinal_position`,
          [targetSchema, table],
        );
        const foreignKeys = await db.runReadOnly(
          identity,
          `SELECT kcu.column_name, ccu.table_schema AS foreign_schema,
                  ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = $1 AND tc.table_name = $2`,
          [targetSchema, table],
        );

        return jsonText({
          schema: targetSchema,
          table,
          columns: columns.rows,
          primary_key: primaryKey.rows.map((r) => (r as { column_name: string }).column_name),
          foreign_keys: foreignKeys.rows,
        });
      } catch (e) {
        return errorText(describeError(e));
      }
    },
  );

  // ── execute_sql ─────────────────────────────────────────────────
  server.registerTool(
    "execute_sql",
    {
      title: "Ejecutar SQL (solo lectura)",
      description:
        "Ejecuta UNA consulta de sólo lectura (SELECT / WITH / EXPLAIN / SHOW) con tus " +
        "permisos. Usá parámetros ($1, $2, ...) para valores dinámicos. Máximo " +
        `${cfg.maxRows} filas.`,
      inputSchema: {
        sql: z.string().describe("Consulta SQL de lectura. Ej: SELECT * FROM pedidos LIMIT 20"),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe("Parámetros posicionales para $1, $2, ... (evita inyección)."),
      },
    },
    async ({ sql, params }) => {
      try {
        const res = await db.runReadOnly(identity, sql, params ?? []);
        return jsonText({
          row_count: res.rowCount,
          truncated: res.truncated,
          columns: res.fields.map((f) => f.name),
          rows: res.rows,
          ...(res.truncated ? { note: `Recortado a ${cfg.maxRows} filas.` } : {}),
        });
      } catch (e) {
        if (e instanceof ReadOnlyViolationError) {
          return errorText(`Consulta rechazada (solo lectura): ${e.message}`);
        }
        return errorText(describeError(e));
      }
    },
  );

  return server;
}
