/**
 * Render del informe de facturación del lado del servidor.
 *
 * La plantilla HTML vive en `skills/billing-report/template.html` y NUNCA sale
 * del servidor: el modelo manda datos, no marcado. Eso es todo el punto de este
 * módulo — un informe generado por un LLM que reescribe el HTML sale distinto
 * cada vez y con bugs distintos cada vez; acá la plantilla es fija por
 * construcción y lo único variable son los números, validados con Zod.
 *
 * El HTML renderizado se guarda en memoria con un TTL corto y se sirve por
 * `GET /report/:id`. No se persiste en disco ni en la base.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { skillsDir } from "./skills.js";

// ── Plantilla ───────────────────────────────────────────────────────────────

const TEMPLATE_FILE = join(skillsDir, "billing-report", "template.html");
const PLACEHOLDER = "__DATA__";

let templateCache: string | null = null;

export function loadTemplate(): string {
  if (templateCache) return templateCache;
  if (!existsSync(TEMPLATE_FILE)) {
    throw new Error(
      `No se encontró la plantilla del informe en ${TEMPLATE_FILE}. ` +
        `¿Falta la carpeta skills/billing-report en el deploy?`,
    );
  }
  const html = readFileSync(TEMPLATE_FILE, "utf8");
  if (!html.includes(PLACEHOLDER)) {
    throw new Error(`La plantilla del informe no contiene el placeholder ${PLACEHOLDER}.`);
  }
  templateCache = html;
  return html;
}

// ── Saneado de texto ────────────────────────────────────────────────────────

/** Escapa todo. Para nombres de prácticas, obras sociales y sedes. */
function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Para los párrafos del informe: escapa todo y después vuelve a permitir un
 * puñado de etiquetas de énfasis. Así el modelo puede resaltar una cifra sin
 * poder inyectar marcado arbitrario en la página.
 */
const ALLOWED = ["strong", "b", "em", "i", "code", "br"];
function sanitizeRich(s: string): string {
  let out = escapeText(s);
  for (const tag of ALLOWED) {
    out = out
      .split(`&lt;${tag}&gt;`).join(`<${tag}>`)
      .split(`&lt;/${tag}&gt;`).join(`</${tag}>`)
      .split(`&lt;${tag}/&gt;`).join(`<${tag}>`);
  }
  return out;
}

// ── Esquema de los datos ────────────────────────────────────────────────────

const money = z.number().finite().nonnegative();
const serie = z.array(money).min(1).max(24);
const label = z.string().trim().min(1).max(120);
const prose = z.string().trim().min(1).max(1200);

/**
 * Forma base, sin las validaciones cruzadas. Es la que se publica como
 * `inputSchema` de la tool: el SDK la convierte a JSON Schema, y un ZodEffects
 * (lo que devuelve `.superRefine`) no sobrevive esa conversión. Las reglas
 * cruzadas se aplican adentro del handler con `billingReportSchema`.
 */
export const billingReportBase = z
  .object({
    tenant: label.describe("Nombre visible del laboratorio, ej. \"IACA\"."),
    periodLabel: label.describe("Etiqueta del período, ej. \"Enero a Junio 2026\"."),
    currLabel: z.string().trim().max(40).describe("Etiqueta corta del período actual, ej. \"H1 2026\"."),
    prevLabel: z.string().trim().max(40).describe("Etiqueta corta del comparativo, ej. \"H1 2025\"."),
    yearCurr: z.string().trim().max(10),
    yearPrev: z.string().trim().max(10),
    generated: z.string().trim().max(20).describe("Fecha de elaboración, dd/mm/aaaa."),
    rangeNote: z.string().trim().max(300).describe("Detalle de períodos para el pie."),

    months: z.array(z.string().trim().min(1).max(12)).min(1).max(24),
    billed: serie,
    qty: serie,
    billedPrev: serie.nullable().describe("null si el año previo no tiene datos."),
    qtyPrev: serie.nullable(),
    own: serie,
    derived: serie,

    practices: z.array(z.tuple([label, money, money])).length(10)
      .describe("[nombre, cantidad, facturado] — top 10."),
    insurers: z.array(z.tuple([label, money])).length(10)
      .describe("[nombre, facturado] — top 10."),
    sites: z.array(z.tuple([label, money, money])).min(1).max(30)
      .describe("[nombre, cantidad, facturado] — deben sumar el total del período."),

    counts: z.object({
      filas: z.number().int().nonnegative(),
      practicas: z.number().int().nonnegative(),
      obrasSociales: z.number().int().nonnegative(),
      sedes: z.number().int().nonnegative(),
    }),

    narrative: z.object({
      s1: prose, s1b: prose, s2: prose, s3: prose, s3b: prose,
      s4head: prose, s4: prose, s5: prose,
      conclusions: z.array(z.object({ t: label, b: prose })).length(5),
    }),
  });

export const billingReportSchema = billingReportBase
  .superRefine((d, ctx) => {
    const n = d.months.length;
    const err = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    for (const [k, v] of Object.entries({ billed: d.billed, qty: d.qty, own: d.own, derived: d.derived })) {
      if (v.length !== n) err(`"${k}" tiene ${v.length} valores y "months" ${n}.`, [k]);
    }

    const prevA = Array.isArray(d.billedPrev);
    const prevB = Array.isArray(d.qtyPrev);
    if (prevA !== prevB) {
      err('"billedPrev" y "qtyPrev" tienen que ser ambos arrays o ambos null.', ["billedPrev"]);
    } else if (prevA) {
      if (d.billedPrev!.length !== n) err(`"billedPrev" tiene ${d.billedPrev!.length} valores y "months" ${n}.`, ["billedPrev"]);
      if (d.qtyPrev!.length !== n) err(`"qtyPrev" tiene ${d.qtyPrev!.length} valores y "months" ${n}.`, ["qtyPrev"]);
    }

    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 1e-9);

    const total = sum(d.billed);
    if (!near(sum(d.own) + sum(d.derived), total)) {
      err(`propio + derivado = ${sum(d.own) + sum(d.derived)} pero el facturado total es ${total}. Revisá Q2.`, ["derived"]);
    }
    if (!near(sum(d.sites.map((s) => s[2])), total)) {
      err(`Las sedes suman ${sum(d.sites.map((s) => s[2]))} y el facturado total es ${total}. Faltan sedes o sobra una fila.`, ["sites"]);
    }
    if (!near(sum(d.sites.map((s) => s[1])), sum(d.qty))) {
      err(`Las cantidades por sede suman ${sum(d.sites.map((s) => s[1]))} y el volumen del período es ${sum(d.qty)}.`, ["sites"]);
    }
    if (sum(d.practices.map((p) => p[2])) > total) {
      err("El top 10 de prácticas factura más que el total del período.", ["practices"]);
    }
    if (sum(d.insurers.map((o) => o[1])) > total) {
      err("El top 10 de obras sociales factura más que el total del período.", ["insurers"]);
    }
  });

export type BillingReportData = z.infer<typeof billingReportSchema>;

// ── Render ──────────────────────────────────────────────────────────────────

/** Sanea los textos y fuerza el schema real; el resto son números validados. */
function harden(data: BillingReportData, schema: string) {
  return {
    ...data,
    schema, // el tenant lo pone el servidor, no el modelo
    tenant: escapeText(data.tenant),
    periodLabel: escapeText(data.periodLabel),
    rangeNote: escapeText(data.rangeNote),
    practices: data.practices.map(([n, q, b]) => [escapeText(n), q, b]),
    insurers: data.insurers.map(([n, b]) => [escapeText(n), b]),
    sites: data.sites.map(([n, q, b]) => [escapeText(n), q, b]),
    narrative: {
      ...Object.fromEntries(
        Object.entries(data.narrative)
          .filter(([k]) => k !== "conclusions")
          .map(([k, v]) => [k, sanitizeRich(v as string)]),
      ),
      conclusions: data.narrative.conclusions.map((c) => ({
        t: sanitizeRich(c.t),
        b: sanitizeRich(c.b),
      })),
    },
  };
}

export function renderBillingReport(data: BillingReportData, schema: string): string {
  // `<` escapado: un JSON con "</script>" adentro cerraría el bloque.
  const json = JSON.stringify(harden(data, schema)).split("<").join("\\u003c");
  return loadTemplate()
    .split(PLACEHOLDER).join(json)
    .split("Informe de facturación · PERIODO · TENANT")
    .join(`Informe de facturación · ${escapeText(data.periodLabel)} · ${escapeText(data.tenant)}`);
}

// ── Almacén efímero ─────────────────────────────────────────────────────────

export const REPORT_TTL_MS = 60 * 60 * 1000; // 1 hora
const MAX_REPORTS = 50;

interface StoredReport {
  html: string;
  expiresAt: number;
  filename: string;
}

const store = new Map<string, StoredReport>();

function sweep(): void {
  const now = Date.now();
  for (const [id, r] of store) if (r.expiresAt <= now) store.delete(id);
  while (store.size > MAX_REPORTS) store.delete(store.keys().next().value as string);
}

/** Guarda el HTML y devuelve un id imposible de adivinar (256 bits). */
export function storeReport(html: string, filename: string): { id: string; expiresAt: number } {
  sweep();
  const id = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + REPORT_TTL_MS;
  store.set(id, { html, expiresAt, filename });
  return { id, expiresAt };
}

export function takeReport(id: string): StoredReport | null {
  sweep();
  const r = store.get(id);
  return r && r.expiresAt > Date.now() ? r : null;
}
