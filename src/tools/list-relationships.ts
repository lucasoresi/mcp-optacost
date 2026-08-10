import { renderRecords } from "../format.js";
import { guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";

interface RelationshipRow {
  from_table: string;
  from_columns: string;
  to_schema: string;
  to_table: string;
  to_columns: string;
  constraint_name: string;
}

export function listRelationshipsDescription(context: ToolContext): string {
  return `Show every foreign-key relationship in the "${context.schema}" schema as a single graph. Use this before writing a JOIN, instead of calling describe_table on each table to guess how they connect.`;
}

export async function listRelationships(context: ToolContext): Promise<ToolResult> {
  return guarded(async () => {
    const rows = await context.db.catalogQuery<RelationshipRow>(
      `SELECT src.relname AS from_table,
              (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a
                   ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS from_columns,
              tn.nspname AS to_schema,
              tgt.relname AS to_table,
              (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a
                   ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS to_columns,
              con.conname AS constraint_name
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_class tgt ON tgt.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = src.relnamespace
         JOIN pg_namespace tn ON tn.oid = tgt.relnamespace
        WHERE con.contype = 'f'
          AND n.nspname = $1
        ORDER BY src.relname, con.conname`,
      [context.schema],
    );

    if (rows.length === 0) {
      return textResult(
        `No foreign keys are defined in the "${context.schema}" schema. Tables may still be related by convention — inspect column names with describe_table.`,
      );
    }

    // A foreign key may point at a table in another schema. Qualifying those
    // keeps the model from writing an unqualified name that will not resolve.
    const qualify = (row: RelationshipRow) =>
      row.to_schema === context.schema ? row.to_table : `${row.to_schema}.${row.to_table}`;

    const records = rows.map((row) => ({
      join: `${row.from_table}.${row.from_columns} → ${qualify(row)}.${row.to_columns}`,
      from_table: row.from_table,
      to_table: qualify(row),
      constraint: row.constraint_name,
    }));

    const external = rows.filter((row) => row.to_schema !== context.schema);

    const lines = [
      `Foreign keys in "${context.schema}" — ${rows.length} relationship(s).`,
      '',
      renderRecords(['join', 'from_table', 'to_table', 'constraint'], records),
    ];

    if (external.length > 0) {
      const schemas = [...new Set(external.map((row) => row.to_schema))].join(', ');
      lines.push(
        '',
        `${external.length} of these point outside the anchored schema (${schemas}). Those targets need to be written schema-qualified, and are only readable if this role has been granted access to them.`,
      );
    }

    return textResult(lines.join('\n'));
  });
}
