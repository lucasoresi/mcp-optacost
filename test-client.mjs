// Cliente de prueba para el MCP local usando Basic Auth.
// Uso:  node test-client.mjs
// Cambiá USER y PASS por tu rol de Postgres.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_MCP = "http://localhost:3000/mcp";
const USER = "user_cliente_a.nfjjlfovpznoipgkugdf";
const PASS = "1234";

const authHeader = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
  requestInit: { headers: { Authorization: authHeader } },
});

const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  console.log("✅ Conectado al MCP\n");

  const tools = await client.listTools();
  console.log("Tools disponibles:", tools.tools.map((t) => t.name).join(", "), "\n");

  console.log("── list_schemas ──");
  const schemas = await client.callTool({ name: "list_schemas", arguments: {} });
  console.log(schemas.content?.[0]?.text ?? JSON.stringify(schemas), "\n");

  console.log("── list_tables ──");
  const tablesRes = await client.callTool({ name: "list_tables", arguments: {} });
  console.log(tablesRes.content?.[0]?.text ?? JSON.stringify(tablesRes), "\n");

  console.log("── execute_sql: SELECT count(*) FROM jobs ──");
  const q = await client.callTool({
    name: "execute_sql",
    arguments: { sql: "SELECT count(*) AS total FROM jobs" },
  });
  console.log(q.content?.[0]?.text ?? JSON.stringify(q));
} catch (e) {
  console.error("❌ Error:", e.message ?? e);
} finally {
  await client.close().catch(() => {});
  process.exit(0);
}
