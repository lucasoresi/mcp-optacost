---
name: billing-report
description: >-
  Fixed-format billing report (informe de facturación) for a period: an
  HTML deliverable with a standard 6-section structure, 4 KPI tiles and 6
  charts, always identical in layout and wording skeleton — only the data
  changes. Load this whenever someone asks for an "informe", "reporte" or
  "report" of facturación / billing / revenue for a range of months. Tells you
  which queries to run and how to fill the data object for the
  `render_billing_report` tool, which builds the page server-side. Uses the
  Billing & Reporting domain (`reportings`).
---

# Informe de facturación — plantilla fija

## RULE 0 — DO NOT WRITE HTML

**You do not build this report. The server does.** Run the queries, assemble one
data object, and call the tool **`render_billing_report`**. It returns a link to
the finished page.

There is no HTML in this Skill and you must not write any. No `<div>`, no
`<style>`, no chart code, no "I'll just make a simple version". If you produce a
billing report as hand-written HTML, the output is wrong no matter how good the
numbers are.

This is not stylistic pedantry — it is the lesson from two real attempts at
authoring the page instead of calling the tool. The first shipped a stray
backtick that killed the whole `<script>`: every chart and every table rendered
empty while the prose above them looked perfect. The second silently dropped
four of the six charts and left a figure titled "Volumen mensual" that contained
billing amounts, not volume. Both got the numbers right. Both were unusable, and
neither looked broken at a glance.

The server-side template is validated, colour-blind-safe, dark-mode aware and
identical across tenants. Use it.

---

This Skill produces **one specific deliverable**: a self-contained HTML billing
report. Its structure is **frozen**. Across tenants and periods the sections,
their order, the chart types, the KPI tiles, the sentence skeletons and the
visual style are always the same; **only the numbers, labels and the narrative
sentences change**.

Do not invent extra sections, drop sections, swap chart types, restyle the page,
or "improve" the layout. If a request needs something outside this contract,
produce the report as specified and add the extra analysis as a separate answer
in chat — never inside the report.

## When to use

Any request of the form "informe / reporte de facturación", "report of billing
from X to Y", "informe de ingresos del semestre", "reporte mensual de
facturación". Also load `billing-reporting` (the domain Skill) if you need
column semantics beyond what is written here.

## Inputs to settle before querying

1. **Period.** A closed range of months `[desde, hasta)`. If the user gives
   months without a year, use the most recent year that has data. If they give
   nothing, use the last 6 complete months present in `reportings`.
2. **Comparison period.** Always the same months of the **previous year**. If
   that range has no rows, the report drops to single-series mode (see
   `prev: null` below) — never silently compare against a different range.
3. **Schema.** Already anchored: every query below runs against `<schema>`.

Confirm the resolved period back to the user in one line when you deliver, e.g.
"Tomé enero–junio de 2026 (la base tiene datos hasta julio 2026)".

## Step 1 — Run these queries, in this order, unchanged

Substitute only the dates. Each is a single read-only statement.

```sql
-- Q0. Coverage: which periods exist at all.
select min(period) as desde, max(period) as hasta, count(*) as filas
from <schema>.reportings;
```

```sql
-- Q1. Monthly billing and volume, current period and the same months of the
-- previous year, in one pass.
select extract(year from period)::int as anio,
       to_char(period, 'MM')          as mes,
       sum(quantity)                  as qty,
       round(sum(billed_amount)::numeric, 2) as billed
from <schema>.reportings
where (period >= DATE '2026-01-01' and period < DATE '2026-07-01')
   or (period >= DATE '2025-01-01' and period < DATE '2025-07-01')
group by 1, 2
order by 1, 2;
```

```sql
-- Q2. Own work vs derivations, by month (current period only).
select to_char(period, 'YYYY-MM') as mes,
       round(sum(billed_amount) filter (where not is_derivation)::numeric, 2) as propio,
       round(sum(billed_amount) filter (where is_derivation)::numeric, 2)     as derivado
from <schema>.reportings
where period >= DATE '2026-01-01' and period < DATE '2026-07-01'
group by 1
order by 1;
```

```sql
-- Q3. Top 15 practices by billed amount.
select practice_name,
       sum(quantity) as qty,
       round(sum(billed_amount)::numeric, 2) as billed
from <schema>.reportings
where period >= DATE '2026-01-01' and period < DATE '2026-07-01'
group by 1
order by billed desc
limit 15;
```

```sql
-- Q4. Top 15 insurers (obras sociales) by billed amount.
select coalesce(nullif(os, ''), '(sin dato)') as obra_social,
       sum(quantity) as qty,
       round(sum(billed_amount)::numeric, 2) as billed
from <schema>.reportings
where period >= DATE '2026-01-01' and period < DATE '2026-07-01'
group by 1
order by billed desc
limit 15;
```

```sql
-- Q5. All sites (headquarters).
select coalesce(nullif(headquarter, ''), '(sin dato)') as sede,
       sum(quantity) as qty,
       round(sum(billed_amount)::numeric, 2) as billed
from <schema>.reportings
where period >= DATE '2026-01-01' and period < DATE '2026-07-01'
group by 1
order by billed desc;
```

```sql
-- Q6a. Row count of the period.
select count(*) as filas
from <schema>.reportings
where period >= DATE '2026-01-01' and period < DATE '2026-07-01';
```

```sql
-- Q6b. Distinct practices. Run the same shape again for `os`
-- (obras_sociales). The site count comes free from Q5's row count.
select count(*) as practicas
from (select distinct practice_id
      from <schema>.reportings
      where period >= DATE '2026-01-01' and period < DATE '2026-07-01') t;
```

**Never merge Q6a/Q6b into one statement with several `count(distinct …)`.**
On a large tenant (≈1.8 M rows) that plan blows the 8 s `STATEMENT_TIMEOUT_MS`;
one distinct per statement returns in about a second. Wrapping the period rows
in a CTE and counting three distincts off it times out too — each distinct needs
its own statement.

```sql
-- Q7. How much of the period's billing has a loaded cost composition
-- (decides the wording of conclusion 5 — never omit this check).
select round((100.0 * sum(r.billed_amount) filter (where c.practice_id is not null)
              / nullif(sum(r.billed_amount), 0))::numeric, 1) as pct_con_costo
from <schema>.reportings r
left join (select distinct practice_id from <schema>.relation) c
       on c.practice_id = r.practice_id::text
where r.period >= DATE '2026-01-01' and r.period < DATE '2026-07-01';
```

Notes that decide correctness:

- `reportings.os` and `headquarter` are **unreconciled labels**, not foreign
  keys — never join them to the `os` / `headquarters` catalogs.
- Do not compute realized margin from `relation` unless Q7 returns **≥ 60 %**.
  Below that the cross is not representative; the report says so in conclusion 5
  instead of showing a margin number.
- Amounts are **pesos corrientes**; the base stores no currency or index. The
  inflation caveat in section 1 is fixed content and is never removed.

## Step 2 — Build the data object

This object is the whole payload of `render_billing_report`. Fill it with raw
query output only: **do not pre-compute totals, percentages or deltas** — the
template computes them, which is what keeps two reports comparable, and the tool
rejects data that contradicts itself.

Shape (abbreviated; the tool's schema is the authority):

```json
{
  "tenant": "IACA",
  "periodLabel": "Enero a Junio 2026",
  "currLabel": "H1 2026",
  "prevLabel": "H1 2025",
  "yearCurr": "2026",
  "yearPrev": "2025",
  "generated": "25/08/2026",
  "rangeNote": "períodos 2026-01 a 2026-06; comparativo 2025-01 a 2025-06",
  "months":     ["Ene","Feb","Mar","Abr","May","Jun"],
  "billed":     [2272657765, 2361565418, "…"],
  "qty":        [225231, 244886, "…"],
  "billedPrev": [1988014505, 2135205207, "…"],
  "qtyPrev":    [213402, 240855, "…"],
  "own":        [500936369, 566389120, "…"],
  "derived":    [1771721396, 1795176298, "…"],
  "practices":  [["Vitamina D 25-OH", 51211, 697712247], "… 10 en total"],
  "insurers":   [["QUALIUM", 585117406], "… 10 en total"],
  "sites":      [["Derivantes", 1157037, 12377382462], "…"],
  "counts":     { "filas": 256347, "practicas": 1935, "obrasSociales": 1504, "sedes": 11 },
  "narrative":  { "s1": "…", "s1b": "…", "s2": "…", "s3": "…", "s3b": "…",
                  "s4head": "…", "s4": "…", "s5": "…",
                  "conclusions": [{ "t": "…", "b": "…" }, "… 5 en total"] }
}
```

- `months` — short Spanish labels in order (`Ene`, `Feb`, …).
- `billed`, `qty` — current-period arrays, one entry per month, same order.
- `billedPrev`, `qtyPrev` — previous-year arrays, **or `null`** for both if that
  range has no rows (the template then renders single-series charts and shows
  `s/d` in the comparison line of each tile).
- `own`, `derived` — from Q2.
- `practices` — top 10 from Q3 as `[nombre, cantidad, facturado]`. Shorten names
  for readability (`VITAMINA D 25-HIDROXI` → `Vitamina D 25-OH`); keep the
  original in the table if it differs materially.
- `insurers` — top 10 from Q4 as `[nombre, facturado]`.
- `sites` — from Q5: the top 9 as `[nombre, cantidad, facturado]`, then a final
  row `['Otras (N sedes)', resto_cantidad, resto_facturado]` **only if 3 or more
  remain**; with 1 or 2 left over, list them by name instead — an "Otras (2
  sedes)" row hides as much as it saves. The rows must add up to the period
  total.
- A site that is the derivation channel rather than a physical branch (often
  literally named `Derivados` / `Derivantes`) stays in the table as queried, but
  `narrative.s5` must say what it is — otherwise the top site reads as a branch.
- `counts` — from Q6.
- `narrative` — the prose. Rules in step 3.

## Step 3 — Write the narrative (fixed skeletons)

Each field is one short paragraph in **Spanish, neutral, no adjectives of
enthusiasm**. Percentages are written like `51,2 %` (comma decimal, thin space
before `%`). Bold only the figure that carries the point.

| Field | Must state |
|---|---|
| `s1` | Whether billing grew month over month, the total swing first→last month, and whether volume followed or stayed flat. |
| `s1b` | The price-vs-volume decomposition: ticket at start vs end, the volume band, and how the interannual growth splits between price and volume. |
| `s2` | Derivation share of the period and its monthly band (min month, max month). |
| `s3` | Concentration of the top 10 practices (% of billing) against the total number of distinct practices. |
| `s3b` | The most extreme unit-price cases: the practice with the highest economic weight and its price per unit, and one high-volume/low-price counterexample. |
| `s4` | The leading insurer, its share, and — when plans of one group appear split — the consolidated ranking of those groups. |
| `s5` | How many sites have activity and the share of the top 5. |
| `conclusions` | Exactly **5** items, in this fixed order and titles: (1) *Precio vs. actividad*, (2) *Concentración*, (3) *Práctica a vigilar*, (4) *Estacionalidad*, (5) *Rentabilidad medible*. Each is `{t: 'título', b: 'cuerpo'}`. Item 5 always reports the Q7 coverage figure and what it enables or blocks. |

Never state real (inflation-adjusted) growth. Say nominal, and point at the
caveat box.

## Step 4 — Call the tool

```
render_billing_report({ data: <el objeto del paso 2> })
```

It returns a link to the finished page, valid for an hour, plus a suggested
filename. Hand the link to the user; that is the deliverable. Pass
`format: "html"` only if you need the document as text to save it yourself.

If the tool answers with a validation error, **fix the data and call again** —
do not fall back to writing the page by hand. The errors are specific on
purpose: *"Las sedes suman 16.543.078.801 y el facturado total es
16.548.991.406"* means Q5 lost a row, not that the tool is broken.

The palette, the layout, dark mode and colour-blind safety are the template's
problem, not yours.

## Self-check before delivering

- [ ] The deliverable is the link the tool returned — **not** HTML you wrote.
- [ ] Every narrative figure matches a queried number — no rounded-from-memory
      values, no numbers that appear nowhere in the query output. The tool checks
      arithmetic, not honesty: it cannot tell that "las 5 primeras sedes suman el
      98,1 %" is wrong when the real figure is 97,3 %.
- [ ] Conclusion 5 states the Q7 coverage percentage.
- [ ] The period you resolved is stated back to the user in one line.

The shape checks — 10 practices, 10 insurers, sites adding up to the period
total, series of equal length, `billedPrev`/`qtyPrev` both present or both null
— are enforced by the tool. You do not need to verify them; you need to not
argue with them.

## Provenance
The page is rendered by `render_billing_report` from
`skills/billing-report/template.html`; the model never handles the markup.
Template validated against two tenants over 2026-01 … 2026-06, deliberately
opposite in shape: `tenant_nanni` (80 k rows, 8 % derivations, growth driven by
price, cost coverage 1,2 %) and `tenant_iaca` (256 k rows of 1,77 M, 75 %
derivations, growth driven by volume, cost coverage 93,5 %). Both render with
the same structure; the single-series path (`billedPrev: null`) was exercised
too. Colour palette validated for CVD (light and dark).
Last validated: 2026-08-25.
