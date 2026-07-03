/**
 * Configuración leída desde variables de entorno.
 * Se valida una sola vez al arrancar para fallar rápido si falta algo.
 *
 * Modelo multiusuario: el host y la base son fijos. Cada persona se
 * autentica con SU usuario y contraseña de Postgres, que ya limita su
 * schema. No hay un token compartido de servidor.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return v;
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`${name} debe ser un entero positivo`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function list(name: string, def: string[]): string[] {
  const v = process.env[name];
  if (!v) return def;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export interface AppConfig {
  // Conexión a Postgres (fija; solo cambian usuario/contraseña por persona)
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  sslMode: "require" | "no-verify" | "disable";

  // Rol "bootstrap": se usa SOLO para sesiones OAuth. Puede hacer SET ROLE
  // a los usuarios (GRANT <usuario> TO <bootstrap>), así ejecuta como cada
  // persona sin necesitar su contraseña guardada.
  bootstrapUser: string | null;
  bootstrapPassword: string | null;

  // search_path para sesiones OAuth (SET ROLE no aplica el search_path del
  // rol destino). {user} se reemplaza por el nombre del usuario.
  userSchemaTemplate: string;

  // Límites de seguridad
  statementTimeoutMs: number;
  maxRows: number;

  // Servidor / OAuth
  publicUrl: string; // URL pública base (issuer y resource). Ej: https://mcp.midominio.com
  port: number;
  allowedOrigins: string[];
  enableBasicAuth: boolean; // permitir Authorization: Basic en /mcp (editores)
  tokenTtlSeconds: number;
}

export function loadConfig(): AppConfig {
  const sslMode = (process.env.PGSSLMODE ?? "require") as AppConfig["sslMode"];
  if (!["require", "no-verify", "disable"].includes(sslMode)) {
    throw new Error("PGSSLMODE debe ser require | no-verify | disable");
  }

  const publicUrl = required("PUBLIC_URL").replace(/\/+$/, "");

  return {
    pgHost: required("PGHOST"),
    pgPort: int("PGPORT", 5432),
    pgDatabase: required("PGDATABASE"),
    sslMode,
    bootstrapUser: process.env.BOOTSTRAP_DB_USER?.trim() || null,
    bootstrapPassword: process.env.BOOTSTRAP_DB_PASSWORD?.trim() || null,
    userSchemaTemplate: process.env.USER_SCHEMA_TEMPLATE?.trim() || "{user}",
    statementTimeoutMs: int("STATEMENT_TIMEOUT_MS", 8000),
    maxRows: int("MAX_ROWS", 1000),
    publicUrl,
    port: int("PORT", 3000),
    allowedOrigins: list("ALLOWED_ORIGINS", ["https://claude.ai", "https://chatgpt.com"]),
    enableBasicAuth: bool("ENABLE_BASIC_AUTH", true),
    tokenTtlSeconds: int("TOKEN_TTL_SECONDS", 3600),
  };
}
