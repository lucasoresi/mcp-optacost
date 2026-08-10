import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
    'query',
    {
      title: 'Run a read-only SQL query',
      description: queryDescription(context),
      inputSchema: queryInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => runQuery(context, args),
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List tables and views',
      description: listTablesDescription(context),
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => listTables(context),
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description: describeTableDescription(context),
      inputSchema: describeTableInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => describeTable(context, args),
  );

  server.registerTool(
    'list_relationships',
    {
      title: 'List foreign-key relationships',
      description: listRelationshipsDescription(context),
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => listRelationships(context),
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain a query plan',
      description: explainQueryDescription(context),
      inputSchema: explainQueryInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => explainQuery(context, args),
  );

  server.registerTool(
    'get_database_info',
    {
      title: 'Show connection and safety status',
      description: databaseInfoDescription(),
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => databaseInfo(context),
  );
}
