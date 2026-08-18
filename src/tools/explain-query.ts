import { z } from 'zod';

import { extended } from "../db.js";
import { inspectSql } from "../guard.js";
import { errorResult, guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const explainQueryInputSchema = {
  sql: z.string().describe('The query to plan. EXPLAIN is added automatically if absent.'),
};

export function explainQueryDescription(context: ToolContext): string {
  return `Show the PostgreSQL execution plan for a query against the "${context.schema}" schema without running it. Use this when a query times out, or before running something over a large table. ANALYZE is never used, so the statement is not executed.`;
}

export async function explainQuery(
  context: ToolContext,
  args: { sql: string },
): Promise<ToolResult> {
  return guarded(async () => {
    const inspection = inspectSql(args.sql);
    if (!inspection.ok) {
      return errorResult(`Query rejected (${inspection.rule}): ${inspection.reason}`);
    }

    const statement = /^explain\b/i.test(inspection.statement)
      ? inspection.statement
      : `EXPLAIN ${inspection.statement}`;

    const rows = await context.db.withReadOnly(async (client) => {
      const result = await client.query(extended({ text: statement, rowMode: 'array' }));
      return result.rows as unknown as unknown[][];
    });

    const plan = rows.map((row) => String(row[0] ?? '')).join('\n');
    return textResult(plan || '(the planner returned no output)');
  });
}
