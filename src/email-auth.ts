/**
 * Login por email de la aplicación: valida la contraseña contra Supabase Auth
 * (GoTrue) y resuelve el email al rol de Postgres del tenant. Es la única
 * pieza que conoce a Supabase Auth; el resto del flujo OAuth reusa el modo
 * `assume` existente.
 */

/** ¿El input del formulario es un email (login por app) o un rol de Postgres? */
export function looksLikeEmail(input: string): boolean {
  return input.includes("@");
}

/** Falla de resolución email → tenant, con la causa para elegir el mensaje. */
export class EmailLoginError extends Error {
  constructor(public readonly reason: "no_user" | "no_tenant_role" | "inactive" | "ambiguous") {
    super(`email login failed: ${reason}`);
    this.name = "EmailLoginError";
  }
}

/** Mensaje para la pantalla de login. No filtra si el email existe o su estado. */
export function emailLoginErrorMessage(reason: EmailLoginError["reason"]): string {
  switch (reason) {
    case "no_tenant_role":
      return "Tu organización todavía no tiene acceso al MCP.";
    case "no_user":
    case "inactive":
    case "ambiguous":
      return "Usuario o contraseña incorrectos.";
  }
}

/**
 * Valida email/password contra GoTrue. No devuelve ni guarda el token de
 * Supabase — solo confirma que la credencial es válida. Un 400/401 es
 * "credenciales incorrectas"; una red caída o un status inesperado se propagan
 * como error para no confundir un problema de infra con una contraseña mala.
 */
export async function verifyPassword(opts: {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { apikey: opts.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: opts.email, password: opts.password }),
    });
  } catch (e) {
    throw new Error(
      `No se pudo contactar a Supabase Auth: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (res.status === 200) return true;
  if (res.status === 400 || res.status === 401) return false;
  throw new Error(`Supabase Auth respondió con status ${res.status}`);
}

export type TenantLookupRow = {
  subdomain: string;
  user_status: string;
  client_status: string;
  deleted_at: string | null;
  role_exists: boolean;
};

/**
 * Todas las filas (idealmente una sola, o ninguna) con el subdomain del
 * cliente del usuario, su estado, y si existe un rol de Postgres homónimo.
 * Sin `LIMIT`: `public.users.email` no tiene constraint UNIQUE, así que
 * `tenantRoleFromRows` es quien decide qué hacer si hay más de una fila.
 * `lower(u.email)` hace el match case-insensitive. Nombres calificados a
 * `public` porque corre como bootstrap sin search_path de tenant.
 */
export const TENANT_LOOKUP_SQL = `
  SELECT c.subdomain,
         u.status AS user_status,
         c.status::text AS client_status,
         c.deleted_at,
         EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = c.subdomain) AS role_exists
  FROM public.users u
  JOIN public.clients c ON c.id = u.client_id
  WHERE lower(u.email) = lower($1)
`;

/**
 * Traduce el resultado del lookup a un nombre de rol, o lanza EmailLoginError.
 * `public.users.email` no tiene constraint UNIQUE (solo PK en `id`), así que
 * más de una fila para el mismo email es posible aunque no debería pasar hoy.
 * Ante esa ambigüedad, falla cerrado en vez de tomar `rows[0]` al azar.
 */
export function tenantRoleFromRows(rows: TenantLookupRow[]): string {
  if (rows.length === 0) throw new EmailLoginError("no_user");
  if (rows.length > 1) throw new EmailLoginError("ambiguous");
  const row = rows[0];
  if (row.deleted_at !== null || row.user_status !== "active" || row.client_status !== "active") {
    throw new EmailLoginError("inactive");
  }
  if (!row.role_exists) throw new EmailLoginError("no_tenant_role");
  return row.subdomain;
}

/** Corre el lookup con el runner inyectado (bootstrap pool) y resuelve el rol. */
export async function resolveTenantRole(
  email: string,
  runCatalog: (sql: string, params: unknown[]) => Promise<TenantLookupRow[]>,
): Promise<string> {
  const rows = await runCatalog(TENANT_LOOKUP_SQL, [email]);
  return tenantRoleFromRows(rows);
}
