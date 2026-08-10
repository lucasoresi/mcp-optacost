import { z } from 'zod';

import { renderRecords } from "../format.js";
import {
  errorResult,
  guarded,
  resolveRelation,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

export const describeTableInputSchema = {
  table: z.string().describe('Name of a table or view in the anchored schema.'),
};

export function describeTableDescription(context: ToolContext): string {
  return `Show the full structure of one table or view in the "${context.schema}" schema: columns with types, nullability and defaults, primary key, outbound and inbound foreign keys, unique and check constraints, and indexes.`;
}

interface ColumnRow {
  column: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

interface ConstraintRow {
  conname: string;
  contype: string;
  definition: string;
}

interface InboundRow {
  from_table: string;
  conname: string;
  definition: string;
}

const CONSTRAINT_LABELS: Record<string, string> = {
  p: 'PRIMARY KEY',
  f: 'FOREIGN KEY',
  u: 'UNIQUE',
  c: 'CHECK',
  x: 'EXCLUDE',
};

export async function describeTable(
  context: ToolContext,
  args: { table: string },
): Promise<ToolResult> {
  return guarded(async () => {
    const relation = await resolveRelation(context, args.table);
    if (!relation) {
      return errorResult(
        `"${args.table}" was not found in the "${context.schema}" schema. Use list_tables to see what is available.`,
      );
    }

    const [columns, constraints, inbound, indexes, comment] = await Promise.all([
      context.db.catalogQuery<ColumnRow>(
        `SELECT a.attname AS column,
                format_type(a.atttypid, a.atttypmod) AS type,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default,
                col_description(a.attrelid, a.attnum) AS comment
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1
            AND a.attnum > 0
            AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [relation.oid],
      ),
      context.db.catalogQuery<ConstraintRow>(
        `SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = $1
          ORDER BY contype, conname`,
        [relation.oid],
      ),
      context.db.catalogQuery<InboundRow>(
        `SELECT c.relname AS from_table,
                con.conname,
                pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE con.confrelid = $1
            AND con.contype = 'f'
            AND n.nspname = $2
          ORDER BY c.relname, con.conname`,
        [relation.oid, context.schema],
      ),
      context.db.catalogQuery<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
           FROM pg_indexes
          WHERE schemaname = $1 AND tablename = $2
          ORDER BY indexname`,
        [context.schema, relation.relname],
      ),
      context.db.catalogQuery<{ comment: string | null }>(
        `SELECT obj_description($1, 'pg_class') AS comment`,
        [relation.oid],
      ),
    ]);

    const sections: string[] = [
      `${relation.kind} "${context.schema}"."${relation.relname}"`,
    ];

    const tableComment = comment[0]?.comment;
    if (tableComment) sections.push('', tableComment);

    sections.push(
      '',
      '## Columns',
      '',
      renderRecords(
        ['column', 'type', 'nullable', 'default', 'comment'],
        columns.map((row) => ({
          column: row.column,
          type: row.type,
          nullable: row.nullable ? 'yes' : 'NOT NULL',
          default: row.default ?? '',
          comment: row.comment ?? '',
        })),
      ),
    );

    if (constraints.length > 0) {
      sections.push(
        '',
        '## Constraints',
        '',
        renderRecords(
          ['name', 'type', 'definition'],
          constraints.map((row) => ({
            name: row.conname,
            type: CONSTRAINT_LABELS[row.contype] ?? row.contype,
            definition: row.definition,
          })),
        ),
      );
    }

    if (inbound.length > 0) {
      sections.push(
        '',
        '## Referenced by',
        '',
        renderRecords(
          ['from_table', 'constraint', 'definition'],
          inbound.map((row) => ({
            from_table: row.from_table,
            constraint: row.conname,
            definition: row.definition,
          })),
        ),
      );
    }

    if (indexes.length > 0) {
      sections.push(
        '',
        '## Indexes',
        '',
        renderRecords(
          ['name', 'definition'],
          indexes.map((row) => ({ name: row.indexname, definition: row.indexdef })),
        ),
      );
    }

    return textResult(sections.join('\n'));
  });
}
