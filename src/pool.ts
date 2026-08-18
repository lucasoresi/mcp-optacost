/**
 * Ciclo de vida de las conexiones a PostgreSQL: SSL, pools por usuario
 * (Basic Auth) y el pool bootstrap compartido (OAuth). No ejecuta queries;
 * eso es responsabilidad de db.ts.
 */

import pg from "pg";
import type { AppConfig } from "./config.js";

export class AuthError extends Error {}

export class PoolRegistry {
  private userPools = new Map<string, pg.Pool>();
  private bootstrapPool: pg.Pool | null = null;

  constructor(private cfg: AppConfig) {}

  private ssl() {
    return this.cfg.sslMode === "disable"
      ? false
      : this.cfg.sslMode === "no-verify"
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true };
  }

  private basePoolConfig(user: string, password: string): pg.PoolConfig {
    return {
      host: this.cfg.pgHost,
      port: this.cfg.pgPort,
      database: this.cfg.pgDatabase,
      user,
      password,
      ssl: this.ssl(),
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // El modo read-only lo garantiza `BEGIN TRANSACTION READ ONLY` en
      // db.ts, no el parámetro de arranque `options`: el pooler de Supabase
      // (Supavisor) puede rechazarlo.
    };
  }

  /** Pool directo para un usuario (Basic Auth). Cacheado por usuario+password. */
  getUserPool(user: string, password: string): pg.Pool {
    // JSON en vez de concatenar: con un separador suelto, dos pares distintos
    // de usuario/contraseña pueden producir la misma clave.
    const key = JSON.stringify([user, password]);
    let pool = this.userPools.get(key);
    if (!pool) {
      pool = new pg.Pool(this.basePoolConfig(user, password));
      this.userPools.set(key, pool);
    }
    return pool;
  }

  getBootstrapPool(): pg.Pool {
    if (!this.cfg.bootstrapUser || !this.cfg.bootstrapPassword) {
      throw new AuthError(
        "Sesión OAuth pero no hay BOOTSTRAP_DB_USER/PASSWORD configurados.",
      );
    }
    if (!this.bootstrapPool) {
      this.bootstrapPool = new pg.Pool(
        this.basePoolConfig(this.cfg.bootstrapUser, this.cfg.bootstrapPassword),
      );
    }
    return this.bootstrapPool;
  }

  /**
   * Valida usuario/contraseña abriendo una conexión real. No deja pool
   * abierto. Devuelve null si conecta OK, o el mensaje de error real si
   * falla (útil para distinguir credenciales incorrectas de problemas de
   * red/SSL).
   */
  async validateCredentials(user: string, password: string): Promise<string | null> {
    const pool = new pg.Pool({ ...this.basePoolConfig(user, password), max: 1 });
    try {
      const c = await pool.connect();
      c.release();
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[pool] Falló la conexión como "${user}":`, msg);
      return msg;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  /** Chequeo de conectividad del rol bootstrap al arrancar (si aplica). */
  async pingBootstrap(): Promise<void> {
    if (!this.cfg.bootstrapUser) return;
    const c = await this.getBootstrapPool().connect();
    try {
      await c.query("SELECT 1");
    } finally {
      c.release();
    }
  }

  async closeAll(): Promise<void> {
    for (const p of this.userPools.values()) await p.end().catch(() => {});
    if (this.bootstrapPool) await this.bootstrapPool.end().catch(() => {});
  }
}
