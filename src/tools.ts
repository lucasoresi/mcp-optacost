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
        `Read-only PostgreSQL server, anchored to the "${context.schema}" schema. ` +
        "Start with list_tables to see what's available, then describe_table or " +
        "list_relationships before writing joins. query runs a single read-only " +
        "statement; explain_query shows its plan without running it. Nothing here " +
        "can modify data or structure.",
    },
  );

  registerTools(server, context);

  return server;
}
