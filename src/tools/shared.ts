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

export interface ToolResult {
  // The SDK's result type carries an index signature for protocol extensions.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Ensures no tool ever throws a raw driver error at the caller: everything comes
 * back as a readable, credential-free message.
 */
export async function guarded(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    return errorResult(describeError(error));
  }
}

/** Resolves a table or view name inside the tenant schema to its OID. */
export async function resolveRelation(
  context: ToolContext,
  name: string,
): Promise<{ oid: number; kind: string; relname: string } | null> {
  // Accept either "table" or "schema.table", but only inside the anchored schema.
  const parts = name.split('.');
  const bare = parts.length === 2 ? parts[1]! : name;
  if (parts.length === 2 && parts[0] !== context.schema) {
    return null;
  }

  const rows = await context.db.catalogQuery<{ oid: number; relkind: string; relname: string }>(
    `SELECT c.oid, c.relkind, c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    [context.schema, bare],
  );

  const row = rows[0];
  return row ? { oid: row.oid, kind: describeRelkind(row.relkind), relname: row.relname } : null;
}

export function describeRelkind(relkind: string): string {
  switch (relkind) {
    case 'r':
      return 'table';
    case 'p':
      return 'partitioned table';
    case 'v':
      return 'view';
    case 'm':
      return 'materialized view';
    case 'f':
      return 'foreign table';
    default:
      return relkind;
  }
}
