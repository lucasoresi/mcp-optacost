/**
 * Cachea, por usuario, el contexto que necesitan las tools de mcpYt: el
 * `Db` ya apuntando al pool correcto, el schema del tenant (auto-detectado
 * por sus GRANTs) y el reporte de la auditoría de privilegios.
 *
 * Se arma una única vez por usuario (la primera vez que se conecta) y se
 * cachea en memoria por el resto de la vida del proceso — evita volver a
 * auditar en cada sesión nueva de la misma persona. Sólo se cachean
 * auditorías EXITOSAS: si falla, no se guarda nada, así alguien que corrige
 * sus permisos en Postgres puede reintentar sin esperar un reinicio del
 * servidor.
 */

import { resolveSchema, runAudit, type AuditConfig } from "./audit.js";
import type { AppConfig } from "./config.js";
import { Db } from "./db.js";
import type { Identity } from "./identity.js";
import { PoolRegistry } from "./pool.js";
import type { ToolContext } from "./tools/shared.js";

export class IdentityContextCache {
  private cache = new Map<string, Promise<ToolContext>>();

  constructor(
    private pools: PoolRegistry,
    private cfg: AppConfig,
  ) {}

  /**
   * La contraseña forma parte de la clave en modo `direct`: el cache es lo
   * único que se consulta al iniciar una sesión, así que si la clave fuera
   * sólo el usuario, alguien con la contraseña equivocada haría cache hit
   * sobre el contexto de otra persona y entraría sin autenticarse. Con la
   * contraseña incluida, una credencial incorrecta es un cache miss y falla
   * al conectar dentro de `runAudit`.
   *
   * El modo se incluye también para que una sesión OAuth ("assume") nunca
   * reutilice el pool de una sesión Basic Auth del mismo usuario: el `Db` de
   * cada modo se arma distinto (pool propio vs bootstrap + SET LOCAL ROLE).
   */
  private keyFor(identity: Identity): string {
    return identity.mode === "direct"
      ? `direct:${identity.username}:${identity.password}`
      : `assume:${identity.username}`;
  }

  /** Devuelve (armando y cacheando si hace falta) el ToolContext de un usuario. */
  async get(identity: Identity): Promise<ToolContext> {
    const key = this.keyFor(identity);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const built = this.build(identity);
    this.cache.set(key, built);
    // Si falla, no dejamos la promesa rechazada cacheada: el próximo intento
    // debe volver a auditar, no repetir el mismo error para siempre.
    built.catch(() => this.cache.delete(key));
    return built;
  }

  private async build(identity: Identity): Promise<ToolContext> {
    const pool =
      identity.mode === "direct"
        ? this.pools.getUserPool(identity.username, identity.password)
        : this.pools.getBootstrapPool();

    // El sufijo de Supabase (ej: ".abcdefghijklmnopqrst", el project ref) es
    // sólo para el pooler; el rol real de Postgres es la parte antes del
    // primer punto.
    const pgRole = identity.username.split(".")[0]!;

    const db = new Db({
      pool,
      statementTimeoutMs: this.cfg.statementTimeoutMs,
      assumeRole: identity.mode === "assume" ? pgRole : null,
    });

    const auditConfig: AuditConfig = {
      allowWritableRole: this.cfg.allowWritableRole,
      schemaOverride: null,
    };

    const report = await runAudit(db, auditConfig);
    const schema = resolveSchema(report, auditConfig);
    db.setSchema(schema);

    return { db, config: this.cfg, report, schema };
  }
}
