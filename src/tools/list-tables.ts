import { renderRecords } from "../format.js";
import { describeRelkind, guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";

interface TableRow {
  name: string;
  relkind: string;
  estimated_rows: string | null;
  size: string | null;
  comment: string | null;
}

export function listTablesDescription(context: ToolContext): string {
  return `List every table, view and materialized view in the "${context.schema}" schema, with an estimated row count, on-disk size and comment. Start here to discover what can be queried.`;
}

export async function listTables(context: ToolContext): Promise<ToolResult> {
  return guarded(async () => {
    const rows = await context.db.catalogQuery<TableRow>(
      `SELECT c.relname AS name,
              c.relkind,
              CASE
                WHEN c.relkind IN ('r', 'p', 'm') AND c.reltuples >= 0
                THEN c.reltuples::bigint::text
              END AS estimated_rows,
              CASE
                WHEN c.relkind IN ('r', 'p', 'm')
                THEN pg_size_pretty(pg_total_relation_size(c.oid))
              END AS size,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY c.relname`,
      [context.schema],
    );

    if (rows.length === 0) {
      return textResult(`The "${context.schema}" schema contains no tables or views visible to this role.`);
    }

    const records = rows.map((row) => ({
      name: row.name,
      kind: describeRelkind(row.relkind),
      estimated_rows: row.estimated_rows ?? '-',
      size: row.size ?? '-',
      comment: row.comment ?? '',
    }));

    return textResult(
      [
        `Schema "${context.schema}" — ${rows.length} object(s).`,
        '',
        renderRecords(['name', 'kind', 'estimated_rows', 'size', 'comment'], records),
        '',
        'Row counts are planner estimates from the last ANALYZE, not exact counts.',
      ].join('\n'),
    );
  });
}
