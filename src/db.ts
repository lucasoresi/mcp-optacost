/**
 * Ejecución de queries de sólo lectura contra un pool ya existente.
 * No crea ni cierra pools (eso es responsabilidad de pool.ts) — sólo sabe
 * ejecutar dentro de una transacción READ ONLY, opcionalmente asumiendo un
 * rol (`SET LOCAL ROLE`) y un schema (`search_path`).
 *
 * Puerto de mcpYt (safe-postgres-mcp/src/db.ts), adaptado para recibir un
 * pool inyectado en vez de crear el suyo propio a partir de un DATABASE_URL,
 * y para soportar `SET LOCAL ROLE` — necesario para las sesiones OAuth de
 * mcp/, que corren físicamente como el rol bootstrap y asumen la identidad
 * real dentro de cada transacción.
 */

import type pg from "pg";
import type { PoolClient } from "pg";

export interface QueryOutcome {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/**
 * Fuerza el protocolo extendido, bajo el cual el backend rechaza parsear más
 * de un comando ("cannot insert multiple commands into a prepared
 * statement", SQLSTATE 42601). Es una defensa a nivel de protocolo que no
 * depende de que nuestro lexer sea correcto.
 *
 * Pasar `values: []` NO alcanza: `Query.requiresPreparation()` de `pg`
 * devuelve `values.length > 0`, así que un array vacío cae al protocolo
 * simple, que acepta `SELECT 1; SELECT 2`. `queryMode` es una opción real de
 * `pg` pero falta en `@types/pg`, de ahí el cast en cada call site.
 */
export const EXTENDED_PROTOCOL = { queryMode: "extended" } as const;

type ExtendedQueryConfig = pg.QueryConfig & { queryMode: "extended"; rowMode?: "array" };

export function extended(config: {
  text: string;
  values?: unknown[];
  rowMode?: "array";
}): ExtendedQueryConfig {
  return {
    text: config.text,
    values: config.values ?? [],
    ...(config.rowMode ? { rowMode: config.rowMode } : {}),
    ...EXTENDED_PROTOCOL,
  } as ExtendedQueryConfig;
}

/** Envuelve un identificador para interpolarlo de forma segura. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Statements válidos como subquery, así se les puede aplicar LIMIT envolviéndolos. */
const WRAPPABLE = /^(select|with|table|values)\b/i;

export interface DbOptions {
  /** Pool ya existente; esta clase no lo crea ni lo cierra. */
  pool: pg.Pool;
  statementTimeoutMs: number;
  /**
   * Si se define, cada transacción hace `SET LOCAL ROLE` a este rol antes de
   * correr nada más — usado por las sesiones OAuth ("assume"), donde la
   * conexión física corre como el rol bootstrap pero las queries y la
   * auditoría de privilegios deben reflejar al usuario real.
   */
  assumeRole: string | null;
}

/**
 * Todo lo que manda SQL a Postgres pasa por esta clase, y cada uno de esos
 * caminos corre dentro de una transacción READ ONLY que siempre se
 * rollbackea.
 */
export class Db {
  private readonly pool: pg.Pool;
  private readonly statementTimeoutMs: number;
  private readonly assumeRole: string | null;
  private schema: string | null = null;

  constructor(options: DbOptions) {
    this.pool = options.pool;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.assumeRole = options.assumeRole;
  }

  /** Se fija una vez que la auditoría resolvió a qué schema tenant está anclado este server. */
  setSchema(schema: string): void {
    this.schema = schema;
  }

  getSchema(): string | null {
    return this.schema;
  }

  /**
   * Abre la transacción READ ONLY y le aplica TODO el confinamiento de la
   * sesión: rol asumido, timeouts y schema. Está en un solo lugar a propósito
   * — `runUserQuery` tiene que reabrir la transacción en su camino de
   * fallback, y cualquier setting que se olvide ahí queda sin aplicar.
   */
  private async beginReadOnly(client: PoolClient): Promise<void> {
    await client.query("BEGIN TRANSACTION READ ONLY");
    if (this.assumeRole) {
      // SET ROLE no hereda el search_path del rol destino: se fija abajo.
      await client.query(`SET LOCAL ROLE ${quoteIdentifier(this.assumeRole)}`);
    }
    await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = ${this.statementTimeoutMs}`,
    );
    if (this.schema) {
      await client.query(`SET LOCAL search_path TO ${quoteIdentifier(this.schema)}`);
    }
  }

  /**
   * Corre `work` dentro de `BEGIN TRANSACTION READ ONLY` con los timeouts
   * configurados, el rol asumido (si aplica) y el schema tenant en el
   * search_path. La transacción siempre se rollbackea, incluso si tuvo
   * éxito: nada de lo que hace este servidor se commitea jamás.
   */
  async withReadOnly<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await this.beginReadOnly(client);
      return await work(client);
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Un rollback fallido significa que la transacción ya no existe;
        // liberar el cliente abajo es la única limpieza que queda por hacer.
      }
      client.release();
    }
  }

  /**
   * Corre SQL de confianza interno (introspección de catálogo). Siempre
   * parametrizado, así que viaja por el protocolo extendido, que rechaza
   * múltiples statements a nivel de protocolo.
   */
  async catalogQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.withReadOnly(async (client) => {
      const result = await client.query<T>(extended({ text, values: params }));
      return result.rows;
    });
  }

  /**
   * Corre un statement provisto por el caller que ya pasó el guard léxico.
   *
   * El límite de filas se aplica envolviendo el statement como subquery, así
   * lo aplica la base y no después de materializar todo. Si el statement no
   * se puede envolver, corre tal cual y se trunca en memoria — igual acotado
   * por el statement_timeout.
   */
  async runUserQuery(statement: string, limit: number): Promise<QueryOutcome> {
    return this.withReadOnly(async (client) => {
      if (WRAPPABLE.test(statement.trimStart())) {
        try {
          const wrapped = `SELECT * FROM (\n${statement}\n) AS _mcp_result LIMIT ${limit + 1}`;
          return toOutcome(
            await client.query(extended({ text: wrapped, rowMode: "array" })),
            limit,
          );
        } catch (error) {
          // Algunos statements válidos no sobreviven a volverse subquery.
          // Se sigue de largo, corre el original, y se trunca en memoria.
          if (!isSyntaxLikeError(error)) throw error;
          await client.query("ROLLBACK");
          await this.beginReadOnly(client);
        }
      }

      return toOutcome(await client.query(extended({ text: statement, rowMode: "array" })), limit);
    });
  }
}

/** Errores que sugieren que el problema fue envolver en subquery, no la query en sí. */
function isSyntaxLikeError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42601" || code === "42P10" || code === "0A000";
}

function toOutcome(result: pg.QueryResult, limit: number): QueryOutcome {
  const columns = result.fields.map((field) => field.name);
  const allRows = result.rows as unknown as unknown[][];
  const truncated = allRows.length > limit;
  return {
    columns,
    rows: truncated ? allRows.slice(0, limit) : allRows,
    truncated,
  };
}
