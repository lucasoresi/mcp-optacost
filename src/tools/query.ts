import { z } from 'zod';

import { renderTable } from "../format.js";
import { inspectSql } from "../guard.js";
import { errorResult, guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const queryInputSchema = {
  sql: z.string().describe('A single read-only SQL statement. Must start with SELECT, WITH, EXPLAIN, TABLE, VALUES or SHOW.'),
  limit: z.number().int().positive().optional().describe('Maximum rows to return. Defaults to the server MAX_ROWS setting.'),
};

export function queryDescription(context: ToolContext): string {
  return [
    `Run a read-only SQL query against the "${context.schema}" schema.`,
    '',
    'Only one statement per call. The connection runs inside a READ ONLY transaction that is always rolled back, so nothing can be modified.',
    `Unqualified table names resolve to the "${context.schema}" schema, so write "SELECT * FROM clientes", not "SELECT * FROM ${context.schema}.clientes".`,
    'Results are truncated; use an explicit LIMIT and ORDER BY for predictable output.',
  ].join('\n');
}

export async function runQuery(
  context: ToolContext,
  args: { sql: string; limit?: number },
): Promise<ToolResult> {
  return guarded(async () => {
    const inspection = inspectSql(args.sql);
    if (!inspection.ok) {
      return errorResult(`Query rejected (${inspection.rule}): ${inspection.reason}`);
    }

    const limit = args.limit ?? context.config.maxRows;
    const outcome = await context.db.runUserQuery(inspection.statement, limit);

    const parts = [renderTable(outcome.columns, outcome.rows)];
    if (outcome.truncated) {
      parts.push(
        '',
        `Truncated to ${limit} rows. There are more; add an ORDER BY and a LIMIT/OFFSET, or aggregate, to see the rest.`,
      );
    } else {
      parts.push('', `${outcome.rows.length} row(s).`);
    }

    return textResult(parts.join('\n'));
  });
}
