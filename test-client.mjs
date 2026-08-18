// Cliente de prueba para el MCP local usando Basic Auth.
//
// Las credenciales salen del entorno, NUNCA de este archivo: es un archivo
// versionado y el repo es público. Poné MCP_TEST_USER y MCP_TEST_PASSWORD en
// tu .env (que está en .gitignore) o pasalas en la línea de comandos.
//
// Uso:
//   node test-client.mjs
//   MCP_TEST_USER=mi_rol MCP_TEST_PASSWORD=... node test-client.mjs
//   MCP_URL=http://localhost:3000/mcp node test-client.mjs

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_MCP = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const USER = process.env.MCP_TEST_USER;
const PASS = process.env.MCP_TEST_PASSWORD;

if (!USER || !PASS) {
  console.error(
    "Faltan credenciales. Definí MCP_TEST_USER y MCP_TEST_PASSWORD en tu .env\n" +
      "o pasalas en la línea de comandos:\n\n" +
      "  MCP_TEST_USER=tu_rol MCP_TEST_PASSWORD=tu_clave node test-client.mjs\n",
  );
  process.exit(1);
}

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
