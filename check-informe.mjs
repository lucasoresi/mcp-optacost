// Valida un informe de facturación ya generado contra el contrato de la Skill
// `billing-report`. No necesita base de datos ni server: lee el archivo HTML.
//
// Uso:
//   node check-informe.mjs ruta/al/informe.html
//
// Detecta el fallo que importa: que el modelo haya reescrito el HTML en lugar
// de copiar la plantilla. Y las roturas de sintaxis que dejan la página con
// prosa perfecta y cero gráficos.

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Uso: node check-informe.mjs ruta/al/informe.html");
  process.exit(1);
}

const html = readFileSync(file, "utf8");
let fallas = 0;
const check = (ok, label, detalle = "") => {
  if (!ok) fallas++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detalle ? "  — " + detalle : ""}`);
};

console.log(`Revisando ${file}  (${html.length} chars)\n`);

// ── 1. ¿Se usó la plantilla, o se reescribió? ────────────────────────────────
console.log("── Plantilla ──");
const marcador = html.includes("optacost-billing-report v1");
check(marcador, "Lleva el marcador de versión de la plantilla",
      marcador ? "" : "SE REESCRIBIÓ EL HTML — rehacer copiando la plantilla");
for (const fn of ["function vbars(", "function line(", "function hbars("]) {
  check(html.includes(fn), `Función de render intacta: ${fn}…`);
}
check(/const DATA\s*=/.test(html), "Los datos viajan en un objeto DATA");

// ── 2. ¿El script está sano? ────────────────────────────────────────────────
console.log("\n── Sintaxis del script ──");
const script = (html.match(/<script>([\s\S]*?)<\/script>/) ?? [])[1] ?? "";
check(script.length > 0, "Hay un bloque <script>");
const backticks = (script.match(/`/g) ?? []).length;
check(backticks % 2 === 0, "Los backticks cierran (template literals balanceados)",
      backticks % 2 === 0 ? `${backticks}` : `${backticks} — impar: hay uno suelto`);
let sintaxisOk = true;
try {
  new Function(script);
} catch (e) {
  sintaxisOk = false;
  check(false, "El script parsea sin errores", e.message);
}
if (sintaxisOk) check(true, "El script parsea sin errores");

// ── 3. ¿Está la estructura fija? ────────────────────────────────────────────
console.log("\n── Estructura ──");
const secciones = [
  "1. Evolución mensual",
  "2. Composición: trabajo propio vs. derivaciones",
  "3. Prácticas que más facturan",
  "4. Obras sociales",
  "5. Sedes",
  "6. Conclusiones y puntos de atención",
];
secciones.forEach((s) => check(html.includes(s), `Sección "${s}"`));
for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
  check(html.includes(`id="${id}"`), `Contenedor del gráfico ${id}`);
}
check(/pesos corrientes sin ajustar por inflación/.test(html), "Caja de advertencia por inflación");

// ── 4. ¿Los datos cierran? ──────────────────────────────────────────────────
// El objeto DATA puede venir escrito a mano (multilínea, con comentarios) o
// inyectado por el servidor como una sola línea de JSON: se recorta contando
// llaves, sin depender del formato.
function extractData(src) {
  const at = src.search(/const\s+DATA\s*=\s*\{/);
  if (at < 0) return null;
  const start = src.indexOf("{", at);
  let depth = 0, quote = null, escaped = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

console.log("\n── Coherencia de los datos ──");
try {
  const literal = extractData(script);
  if (!literal) throw new Error("no se encontró la asignación de DATA");
  const DATA = new Function(`return (${literal});`)();
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  check(DATA.narrative?.conclusions?.length === 5, "Son exactamente 5 conclusiones",
        `${DATA.narrative?.conclusions?.length ?? 0}`);
  const total = sum(DATA.billed);
  const n = DATA.months.length;

  check(DATA.qty.length === n && DATA.own.length === n && DATA.derived.length === n,
        "Todas las series mensuales tienen el mismo largo", `${n} meses`);
  check(Math.abs(sum(DATA.own) + sum(DATA.derived) - total) < 1,
        "propio + derivado = facturado total");
  check(Math.abs(sum(DATA.sites.map((s) => s[2])) - total) < 1,
        "Las sedes suman el total del período");
  check(Math.abs(sum(DATA.sites.map((s) => s[1])) - sum(DATA.qty)) < 1,
        "Las cantidades por sede suman el volumen del período");
  check(DATA.practices.length === 10, "10 prácticas", `${DATA.practices.length}`);
  check(DATA.insurers.length === 10, "10 obras sociales", `${DATA.insurers.length}`);
  const prev = Array.isArray(DATA.billedPrev);
  check(!prev || DATA.billedPrev.length === n,
        prev ? "La serie del año previo tiene el mismo largo" : "Sin año previo (modo serie única)");
} catch (e) {
  check(false, "Se pudo leer el objeto DATA", e.message);
}

console.log(`\n${fallas === 0 ? "✅ El informe cumple el contrato" : `❌ ${fallas} chequeo(s) fallaron`}`);
process.exitCode = fallas === 0 ? 0 : 1;
