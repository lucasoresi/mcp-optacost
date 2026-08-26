import { z } from "zod";

import {
  billingReportSchema,
  REPORT_TTL_MS,
  renderBillingReport,
  storeReport,
  type BillingReportData,
} from "../report.js";
import { errorResult, guarded, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const renderBillingReportInputSchema = {
  // Se anuncia como objeto libre a propósito: el schema rico (con tuplas y los
  // $ref que zod-to-json-schema genera al deduplicar) es válido para Claude pero
  // el validador de function-calling de ChatGPT lo rechaza y aborta el connect.
  // La forma exacta se valida igual en el handler con `billingReportSchema`, y la
  // Skill billing-report documenta el objeto campo por campo para el modelo.
  data: z.record(z.string(), z.unknown()).describe(
    "Los datos del informe, tal como los define la Skill billing-report. Salida cruda de las consultas: nada de totales, porcentajes ni variaciones — los calcula la plantilla. Cargá antes la Skill (get_database_skill) para saber la forma exacta del objeto; el servidor la valida al recibirla.",
  ),
  format: z
    .enum(["url", "html"])
    .default("url")
    .describe(
      'Cómo devolver el informe. "url" (por defecto) guarda el HTML en el servidor y devuelve un link temporal para abrirlo o descargarlo — es lo recomendado. "html" devuelve el documento entero como texto; usalo sólo si necesitás guardarlo vos mismo en un archivo.',
    ),
};

export function renderBillingReportDescription(context: ToolContext): string {
  return (
    `Genera el informe de facturación de "${context.schema}" en HTML, con su plantilla fija: 4 KPIs, ` +
    `6 gráficos y 6 secciones. Pasás sólo los datos; el HTML lo arma el servidor, así que el informe ` +
    `sale idéntico siempre. NO escribas vos el HTML de un informe de facturación: usá esta tool. ` +
    `Cargá antes la Skill "billing-report" (get_database_skill) para saber qué consultas correr y ` +
    `cómo se arma el objeto de datos. Valida coherencia: si las sedes no suman el total del período, ` +
    `o propio + derivado no da el facturado, rechaza con el detalle.`
  );
}

export async function renderBillingReportTool(
  context: ToolContext,
  args: { data: unknown; format?: "url" | "html" },
): Promise<ToolResult> {
  return guarded(async () => {
    const parsed = billingReportSchema.safeParse(args.data);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 12)
        .map((i) => `  · ${i.path.join(".") || "(raíz)"}: ${i.message}`)
        .join("\n");
      return errorResult(
        `Los datos del informe no pasaron la validación:\n${issues}\n\n` +
          `Corregí los datos y volvé a llamar. No generes el HTML por tu cuenta.`,
      );
    }

    const data = parsed.data as BillingReportData;
    const html = renderBillingReport(data, context.schema);

    if (args.format === "html") return textResult(html);

    const slug = `${context.schema}_${data.periodLabel}`
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const filename = `informe_facturacion_${slug}.html`;

    const { id, expiresAt } = storeReport(html, filename);
    const url = `${context.config.publicUrl}/report/${id}`;
    const minutos = Math.round(REPORT_TTL_MS / 60000);

    return textResult(
      [
        `Informe generado: ${url}`,
        ``,
        `Archivo sugerido: ${filename}`,
        `El link vence en ${minutos} minutos y no queda guardado en ninguna base.`,
        `Pasale el link al usuario para que lo abra o lo descargue.`,
      ].join("\n"),
    );
  });
}
