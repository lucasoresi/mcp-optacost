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
        `Read-only PostgreSQL server for the Optacost lab cost & pricing database, ` +
        `anchored to the "${context.schema}" schema. Before writing any SQL, FIRST call ` +
        "list_database_domains to see the business domains, THEN call get_database_skill " +
        "for the relevant domain to load its tables, relationships, semantic rules and " +
        "validated example queries. Never guess table or column names — if unsure, use " +
        "describe_table or list_relationships. Then run one read-only statement with query, " +
        "or preview its plan with explain_query. Nothing here can modify data or structure.",
    },
  );

  registerTools(server, context);

  return server;
}
