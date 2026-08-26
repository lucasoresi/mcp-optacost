// Smoke test de la Skill de salida `billing-report`.
//
// Verifica, contra el server local, que:
//   1. el router (_index) la anuncia en la sección de Output Skills,
//   2. get_database_skill la devuelve entera y anclada al schema del usuario,
//   3. la skill NO lleva HTML: deriva el armado a `render_billing_report`,
//   4. la tool renderiza, publica el link, sirve la página y rechaza datos
//      incoherentes con un mensaje que dice qué no cierra.
//
// Las credenciales salen del entorno, NUNCA de este archivo.
//
// Uso:
//   node test-skill.mjs
//   MCP_TEST_USER=otro_rol MCP_TEST_PASSWORD=... node test-skill.mjs

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_MCP = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const USER = process.env.MCP_TEST_USER;
const PASS = process.env.MCP_TEST_PASSWORD;
const SLUG = process.argv[2] ?? "billing-report";

if (!USER || !PASS) {
  console.error(
    "Faltan credenciales. Definí MCP_TEST_USER y MCP_TEST_PASSWORD en tu .env\n" +
      "o pasalas en la línea de comandos:\n\n" +
      "  MCP_TEST_USER=tu_rol MCP_TEST_PASSWORD=tu_clave node test-skill.mjs\n",
  );
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
  requestInit: {
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") },
  },
});
const client = new Client({ name: "test-skill", version: "1.0.0" }, { capabilities: {} });

const text = (res) => res?.content?.[0]?.text ?? "";
let fallas = 0;
const check = (ok, label, detalle = "") => {
  if (!ok) fallas++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detalle ? "  — " + detalle : ""}`);
};

try {
  await client.connect(transport);
  console.log(`Conectado a ${URL_MCP} como "${USER}"\n`);

  // ── Schema al que quedó anclada la sesión ────────────────────────────────
  const info = text(await client.callTool({ name: "get_database_info", arguments: {} }));
  const schema = (info.match(/tenant_[a-z0-9_]+|"?schema"?[:\s]+([a-z0-9_]+)/i) ?? [])[0] ?? "(?)";
  console.log(`Schema de la sesión: ${schema}\n`);

  // ── 1. El router la anuncia ──────────────────────────────────────────────
  console.log("── list_database_domains ──");
  const router = text(await client.callTool({ name: "list_database_domains", arguments: {} }));
  check(/Output Skills/i.test(router), "El índice tiene la sección 'Output Skills'");
  check(router.includes(SLUG), `El índice nombra el slug '${SLUG}'`);
  check(/informe|reporte/i.test(router), "El índice menciona las palabras gatillo (informe/reporte)");

  // ── 2..4. La skill se carga y viene completa ─────────────────────────────
  console.log(`\n── get_database_skill { domain: "${SLUG}" } ──`);
  const skill = text(await client.callTool({ name: "get_database_skill", arguments: { domain: SLUG } }));
  check(!/^Unknown domain/i.test(skill), `El server conoce el dominio '${SLUG}'`,
        /^Unknown domain/i.test(skill) ? skill.slice(0, 120) : `${skill.length} chars`);

  if (!/^Unknown domain/i.test(skill)) {
    check(!skill.includes("<schema>"), "No quedaron placeholders <schema> sin reemplazar");
    check(schema === "(?)" || skill.includes(schema), `Las queries quedaron ancladas a ${schema}`);
    check((skill.match(/```sql/g) ?? []).length >= 8, "Están las 8 consultas SQL (Q0–Q7)",
          `${(skill.match(/```sql/g) ?? []).length} bloques sql`);
    check(!skill.includes("```html"),
          "La skill ya no lleva HTML embebido (lo arma el servidor)");
    check(/RULE 0 — DO NOT WRITE HTML/.test(skill), "La skill arranca con la regla 0");
    check(skill.includes("render_billing_report"), "La skill deriva el render a la tool");
  }

  // ── La tool de render ────────────────────────────────────────────────────
  console.log("\n── render_billing_report ──");
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(tools.includes("render_billing_report"), "La tool está publicada",
        tools.includes("render_billing_report") ? "" : `tools: ${tools.join(", ")}`);

  if (tools.includes("render_billing_report")) {
    // Payload sintético mínimo, pero coherente: un mes, una sede, todo cuadrado.
    const narrativa = Object.fromEntries(
      ["s1", "s1b", "s2", "s3", "s3b", "s4head", "s4", "s5"].map((k) => [k, `Texto de prueba ${k}.`]),
    );
    const data = {
      tenant: "Prueba", periodLabel: "Enero 2026", currLabel: "Ene 2026", prevLabel: "Ene 2025",
      yearCurr: "2026", yearPrev: "2025", generated: "01/01/2026", rangeNote: "smoke test",
      months: ["Ene"], billed: [1000], qty: [10], billedPrev: null, qtyPrev: null,
      own: [400], derived: [600],
      practices: Array.from({ length: 10 }, (_, i) => [`Práctica ${i + 1}`, 1, 10]),
      insurers: Array.from({ length: 10 }, (_, i) => [`Obra social ${i + 1}`, 10]),
      sites: [["Sede única", 10, 1000]],
      counts: { filas: 10, practicas: 10, obrasSociales: 10, sedes: 1 },
      narrative: { ...narrativa, conclusions: Array.from({ length: 5 }, (_, i) => ({ t: `T${i + 1}`, b: `Cuerpo ${i + 1}.` })) },
    };

    const okRes = await client.callTool({ name: "render_billing_report", arguments: { data } });
    const okTxt = text(okRes);
    const url = (okTxt.match(/https?:\/\/\S+\/report\/[A-Za-z0-9_-]+/) ?? [])[0];
    check(!okRes.isError && !!url, "Datos válidos → devuelve un link", url ? "" : okTxt.slice(0, 200));

    if (url) {
      // El link sale con PUBLIC_URL (el túnel); para probar la ruta local,
      // pegamos el path contra el mismo origen del MCP.
      const local = new URL(new URL(url).pathname, new URL(URL_MCP).origin).href;
      try {
        const r = await fetch(local);
        const html = await r.text();
        check(r.ok, `GET ${new URL(local).pathname} responde 200`, `${r.status}`);
        check(html.includes("optacost-billing-report v1"), "La página servida es la plantilla");
        check(!html.includes("__DATA__"), "El placeholder quedó resuelto");
        check(html.includes("function vbars("), "Las funciones de render viajan intactas");
      } catch (e) {
        check(false, "Se pudo descargar el informe", e.message);
      }
      const r404 = await fetch(new URL("/report/inexistente", new URL(URL_MCP).origin).href);
      check(r404.status === 404, "Un id inexistente da 404", `${r404.status}`);
    }

    // Datos incoherentes: las sedes no suman el total. La diferencia tiene que
    // superar la tolerancia del validador (1 unidad, para absorber redondeo de
    // punto flotante) — con 999 contra 1000 el chequeo pasa, y con razón.
    const roto = structuredClone(data);
    roto.sites = [["Sede única", 10, 900]];
    const badRes = await client.callTool({ name: "render_billing_report", arguments: { data: roto } });
    const badTxt = text(badRes);
    check(badRes.isError === true, "Datos incoherentes → rechaza");
    check(/sedes suman/i.test(badTxt), "El rechazo explica qué no cierra", badTxt.split("\n")[1]?.trim());
  }

  console.log(`\n${fallas === 0 ? "✅ Todo OK" : `❌ ${fallas} chequeo(s) fallaron`}`);
} catch (e) {
  console.error("❌ Error:", e.message ?? e);
  fallas++;
} finally {
  // No usar process.exit() acá: en Windows cierra el proceso mientras libuv
  // todavía está desarmando los handles del transporte y tira
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)". Se marca el
  // código de salida y se deja que el loop se drene solo; el timer sin ref
  // es la red de contención si algún handle queda colgado.
  process.exitCode = fallas === 0 ? 0 : 1;
  await client.close().catch(() => {});
  setTimeout(() => process.exit(process.exitCode), 250).unref();
}
