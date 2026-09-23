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
  constructor(public readonly reason: "no_user" | "no_tenant_role" | "inactive") {
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
      return "Usuario o contraseña incorrectos.";
  }
}
