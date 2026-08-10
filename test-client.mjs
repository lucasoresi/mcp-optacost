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

  console.log("── list_tables ──");
  const tablesRes = await client.callTool({ name: "list_tables", arguments: {} });
  console.log(tablesRes.content?.[0]?.text ?? JSON.stringify(tablesRes), "\n");

  console.log("── list_relationships ──");
  const rels = await client.callTool({ name: "list_relationships", arguments: {} });
  console.log(rels.content?.[0]?.text ?? JSON.stringify(rels), "\n");

  console.log("── get_database_info ──");
  const info = await client.callTool({ name: "get_database_info", arguments: {} });
  console.log(info.content?.[0]?.text ?? JSON.stringify(info), "\n");

  console.log("── query: SELECT count(*) FROM jobs ──");
  const q = await client.callTool({
    name: "query",
    arguments: { sql: "SELECT count(*) AS total FROM jobs" },
  });
  console.log(q.content?.[0]?.text ?? JSON.stringify(q));
} catch (e) {
  console.error("❌ Error:", e.message ?? e);
} finally {
  await client.close().catch(() => {});
  process.exit(0);
}
