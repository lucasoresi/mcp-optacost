# Login por email de la aplicación — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir loguear en el flujo OAuth con email/password de la app (validado contra Supabase Auth/GoTrue), mapeando el email al rol de Postgres del tenant y reutilizando el modo `assume` existente, sin romper el login por rol de Postgres ni el Basic Auth.

**Architecture:** Todo el cambio se concentra en el paso de login (`oauth.ts POST /authorize`). Un módulo nuevo aislado (`email-auth.ts`) valida la contraseña contra GoTrue y resuelve `email → public.users.client_id → clients.subdomain` (= nombre del rol). El resto de la cadena (`identityContexts.get({mode:"assume", username:<rol>})` → bootstrap pool → `SET ROLE` → auditoría → schema → tools) ya existe y no se toca.

**Tech Stack:** TypeScript (NodeNext), Express, `pg`, `fetch` nativo (GoTrue), `node:test` + `node:assert/strict` corridos con `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-23-email-login-design.md`

## Global Constraints

- **Idioma:** `email-auth.ts`, `config.ts`, `oauth.ts` son archivos propios del proyecto → texto operador-facing en **español**. No tocar el inglés de `tools/**`, `guard.ts`, `format.ts`, `errors.ts`.
- **Imports con extensión `.js`** (proyecto NodeNext compilado con `tsc`).
- **Env vars nuevas opcionales:** `SUPABASE_URL` y `SUPABASE_ANON_KEY`. Si falta cualquiera de las dos, el login por email queda deshabilitado y un input con `@` devuelve "Usuario o contraseña incorrectos." (nunca intenta conectar a Postgres con un email como usuario).
- **No romper** el flujo actual: input sin `@` sigue yendo por `pools.validateCredentials`; Basic Auth intacto.
- **El token OAuth guarda solo el rol resuelto** (ej. `iaca`), igual que hoy. El email va solo a un `console.log` de servidor.
- **Detección de rama:** por presencia de `@` en el input, previo `trim()`.
- **Tests:** `node:test` + `node:assert/strict`, imports `.js`, correr con `npx tsx --test tests/<archivo>.test.ts`.

## Review Focus

- **Input con `@` pero Supabase sin configurar** → "Usuario o contraseña incorrectos.", sin intentar conexión a Postgres. (Task 5)
- **GoTrue caído / responde 5xx / error de red** → "No se pudo verificar las credenciales. Intentá de nuevo.", nunca "credenciales incorrectas". (Task 3)
- **Email válido en GoTrue pero sin fila en `public.users`** → mensaje genérico, no filtra que el email no existe. (Task 4)
- **Email con mayúsculas / espacios** (`  Lucasoresi1@GMAIL.com `) → se normaliza (trim + `lower()` en SQL) y resuelve igual. (Task 4)
- **Cliente sin rol de tenant** (demo/maipu/staging) → "Tu organización todavía no tiene acceso al MCP." (Task 4)

---

## File Structure

- **Create `src/email-auth.ts`** — módulo aislado: `looksLikeEmail`, `EmailLoginError`, `emailLoginErrorMessage`, `verifyPassword` (GoTrue), `tenantRoleFromRows` (lógica pura), `resolveTenantRole` (query + lógica), `TENANT_LOOKUP_SQL`.
- **Create `tests/email-auth.test.ts`** — unit tests del módulo (fetch y query mockeados).
- **Create `tests/config.test.ts`** — unit test de las env vars nuevas.
- **Modify `src/config.ts`** — agregar `supabaseUrl`/`supabaseAnonKey` a `AppConfig` y `loadConfig`.
- **Modify `src/oauth.ts`** — label del form + ramificación por email en `POST /authorize`.
- **Modify `README.md`** y **`.env.example`** — documentar env vars + `GRANT` a `mcp_bootstrap`.
- **Modify `package.json`** — `test:unit` incluye los archivos nuevos.

---

## Task 1: Config — env vars de Supabase

**Files:**
- Modify: `src/config.ts` (interface `AppConfig` ~línea 60, `loadConfig` return ~línea 76)
- Create: `tests/config.test.ts`
- Modify: `package.json` (`test:unit`)

**Interfaces:**
- Produces: `AppConfig.supabaseUrl: string | null`, `AppConfig.supabaseAnonKey: string | null`.

- [ ] **Step 1: Escribir el test que falla**

`tests/config.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try { fn(); } finally { process.env = prev; }
}

const base = { PUBLIC_URL: 'https://x.test', PGHOST: 'h', PGDATABASE: 'd' };

test('supabase vars ausentes => null', () => {
  withEnv({ ...base, SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.supabaseUrl, null);
    assert.equal(cfg.supabaseAnonKey, null);
  });
});

test('supabase vars presentes => se leen y se recorta la barra final', () => {
  withEnv({ ...base, SUPABASE_URL: 'https://proj.supabase.co/', SUPABASE_ANON_KEY: 'anon123' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.supabaseUrl, 'https://proj.supabase.co');
    assert.equal(cfg.supabaseAnonKey, 'anon123');
  });
});
```

- [ ] **Step 2: Correr el test y ver que falla**

Run: `npx tsx --test tests/config.test.ts`
Expected: FAIL (`cfg.supabaseUrl` es `undefined`, no existe la propiedad).

- [ ] **Step 3: Implementar**

En `src/config.ts`, agregar a la interface `AppConfig` (junto a las otras de servidor/OAuth):
```ts
  // Supabase Auth (GoTrue) para login por email. Ausentes => login por email
  // deshabilitado (solo funciona el login por rol de Postgres).
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
```

En el `return` de `loadConfig()`, agregar:
```ts
    supabaseUrl: process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY?.trim() || null,
```

- [ ] **Step 4: Correr el test y ver que pasa**

Run: `npx tsx --test tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Actualizar `test:unit` y commitear**

En `package.json`, cambiar el script:
```json
"test:unit": "tsx --test tests/guard.test.ts tests/config.test.ts tests/email-auth.test.ts",
```
(el archivo `email-auth.test.ts` se crea en Task 2; hasta entonces `test:unit` no se corre — los TDD de este plan usan `npx tsx --test <archivo>` directo.)

```bash
git add src/config.ts tests/config.test.ts package.json
git commit -m "feat: env vars SUPABASE_URL/SUPABASE_ANON_KEY para login por email"
```

---

## Task 2: email-auth — helpers puros (`looksLikeEmail`, `EmailLoginError`, `emailLoginErrorMessage`)

**Files:**
- Create: `src/email-auth.ts`
- Create: `tests/email-auth.test.ts`

**Interfaces:**
- Produces:
  - `looksLikeEmail(input: string): boolean`
  - `class EmailLoginError extends Error { reason: "no_user" | "no_tenant_role" | "inactive" }`
  - `emailLoginErrorMessage(reason: EmailLoginError["reason"]): string`

- [ ] **Step 1: Escribir el test que falla**

`tests/email-auth.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeEmail, EmailLoginError, emailLoginErrorMessage } from '../src/email-auth.js';

test('looksLikeEmail detecta @', () => {
  assert.equal(looksLikeEmail('a@b.com'), true);
  assert.equal(looksLikeEmail('nanni.nfjjlfovpznoipgkugdf'), false);
  assert.equal(looksLikeEmail(''), false);
});

test('emailLoginErrorMessage: mensaje específico solo para no_tenant_role', () => {
  assert.equal(emailLoginErrorMessage('no_tenant_role'), 'Tu organización todavía no tiene acceso al MCP.');
  assert.equal(emailLoginErrorMessage('no_user'), 'Usuario o contraseña incorrectos.');
  assert.equal(emailLoginErrorMessage('inactive'), 'Usuario o contraseña incorrectos.');
});

test('EmailLoginError guarda el reason', () => {
  const e = new EmailLoginError('no_tenant_role');
  assert.equal(e.reason, 'no_tenant_role');
  assert.equal(e.name, 'EmailLoginError');
});
```

- [ ] **Step 2: Correr el test y ver que falla**

Run: `npx tsx --test tests/email-auth.test.ts`
Expected: FAIL (no existe `../src/email-auth.js`).

- [ ] **Step 3: Implementar**

`src/email-auth.ts`:
```ts
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
```

- [ ] **Step 4: Correr el test y ver que pasa**

Run: `npx tsx --test tests/email-auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commitear**

```bash
git add src/email-auth.ts tests/email-auth.test.ts
git commit -m "feat: email-auth helpers (looksLikeEmail, EmailLoginError, mensajes)"
```

---

## Task 3: email-auth — `verifyPassword` (GoTrue)

**Files:**
- Modify: `src/email-auth.ts`
- Modify: `tests/email-auth.test.ts`

**Interfaces:**
- Produces:
  - `verifyPassword(opts: { supabaseUrl: string; anonKey: string; email: string; password: string; fetchImpl?: typeof fetch }): Promise<boolean>`
  - Devuelve `true` si GoTrue responde 200, `false` si 400/401. Lanza `Error` en red caída o status inesperado (5xx, etc.).

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/email-auth.test.ts`:
```ts
import { verifyPassword } from '../src/email-auth.js';

function fakeFetch(status: number): typeof fetch {
  return (async () => ({ status } as Response)) as unknown as typeof fetch;
}

const creds = { supabaseUrl: 'https://p.supabase.co', anonKey: 'anon', email: 'a@b.com', password: 'x' };

test('verifyPassword: 200 => true', async () => {
  assert.equal(await verifyPassword({ ...creds, fetchImpl: fakeFetch(200) }), true);
});

test('verifyPassword: 400 => false', async () => {
  assert.equal(await verifyPassword({ ...creds, fetchImpl: fakeFetch(400) }), false);
});

test('verifyPassword: 401 => false', async () => {
  assert.equal(await verifyPassword({ ...creds, fetchImpl: fakeFetch(401) }), false);
});

test('verifyPassword: 500 => lanza', async () => {
  await assert.rejects(verifyPassword({ ...creds, fetchImpl: fakeFetch(500) }));
});

test('verifyPassword: error de red => lanza', async () => {
  const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  await assert.rejects(verifyPassword({ ...creds, fetchImpl: boom }));
});
```

- [ ] **Step 2: Correr el test y ver que falla**

Run: `npx tsx --test tests/email-auth.test.ts`
Expected: FAIL (`verifyPassword` no exportado).

- [ ] **Step 3: Implementar**

Agregar a `src/email-auth.ts`:
```ts
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
```

- [ ] **Step 4: Correr el test y ver que pasa**

Run: `npx tsx --test tests/email-auth.test.ts`
Expected: PASS (todos, incluidos los 5 nuevos).

- [ ] **Step 5: Commitear**

```bash
git add src/email-auth.ts tests/email-auth.test.ts
git commit -m "feat: verifyPassword contra GoTrue (200=ok, 400/401=falla, resto=error)"
```

---

## Task 4: email-auth — `tenantRoleFromRows` + `resolveTenantRole`

**Files:**
- Modify: `src/email-auth.ts`
- Modify: `tests/email-auth.test.ts`

**Interfaces:**
- Produces:
  - `type TenantLookupRow = { subdomain: string; user_status: string; client_status: string; deleted_at: string | null; role_exists: boolean }`
  - `TENANT_LOOKUP_SQL: string`
  - `tenantRoleFromRows(rows: TenantLookupRow[]): string` (lanza `EmailLoginError`)
  - `resolveTenantRole(email: string, runCatalog: (sql: string, params: unknown[]) => Promise<TenantLookupRow[]>): Promise<string>`

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/email-auth.test.ts`:
```ts
import { tenantRoleFromRows, resolveTenantRole, TENANT_LOOKUP_SQL } from '../src/email-auth.js';
import type { TenantLookupRow } from '../src/email-auth.js';

const okRow: TenantLookupRow = {
  subdomain: 'iaca', user_status: 'active', client_status: 'active',
  deleted_at: null, role_exists: true,
};

test('tenantRoleFromRows: fila válida => subdomain', () => {
  assert.equal(tenantRoleFromRows([okRow]), 'iaca');
});

test('tenantRoleFromRows: sin filas => no_user', () => {
  assert.throws(() => tenantRoleFromRows([]), (e) => e instanceof EmailLoginError && e.reason === 'no_user');
});

test('tenantRoleFromRows: usuario inactivo => inactive', () => {
  assert.throws(() => tenantRoleFromRows([{ ...okRow, user_status: 'disabled' }]),
    (e) => e instanceof EmailLoginError && e.reason === 'inactive');
});

test('tenantRoleFromRows: cliente borrado => inactive', () => {
  assert.throws(() => tenantRoleFromRows([{ ...okRow, deleted_at: '2020-01-01' }]),
    (e) => e instanceof EmailLoginError && e.reason === 'inactive');
});

test('tenantRoleFromRows: sin rol de Postgres => no_tenant_role', () => {
  assert.throws(() => tenantRoleFromRows([{ ...okRow, role_exists: false }]),
    (e) => e instanceof EmailLoginError && e.reason === 'no_tenant_role');
});

test('resolveTenantRole: pasa el email al runner y devuelve el rol', async () => {
  let seen: unknown[] = [];
  const runner = async (_sql: string, params: unknown[]) => { seen = params; return [okRow]; };
  const role = await resolveTenantRole('A@B.com', runner);
  assert.equal(role, 'iaca');
  assert.deepEqual(seen, ['A@B.com']);
});

test('TENANT_LOOKUP_SQL usa lower() y tablas public calificadas', () => {
  assert.match(TENANT_LOOKUP_SQL, /lower\(u\.email\)/i);
  assert.match(TENANT_LOOKUP_SQL, /public\.users/i);
  assert.match(TENANT_LOOKUP_SQL, /public\.clients/i);
  assert.match(TENANT_LOOKUP_SQL, /pg_roles/i);
});
```

- [ ] **Step 2: Correr el test y ver que falla**

Run: `npx tsx --test tests/email-auth.test.ts`
Expected: FAIL (símbolos no exportados).

- [ ] **Step 3: Implementar**

Agregar a `src/email-auth.ts`:
```ts
export type TenantLookupRow = {
  subdomain: string;
  user_status: string;
  client_status: string;
  deleted_at: string | null;
  role_exists: boolean;
};

/**
 * Una fila (o ninguna) con el subdomain del cliente del usuario, su estado, y
 * si existe un rol de Postgres homónimo. `lower(u.email)` hace el match
 * case-insensitive. Nombres calificados a `public` porque corre como bootstrap
 * sin search_path de tenant.
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
  LIMIT 1
`;

/** Traduce el resultado del lookup a un nombre de rol, o lanza EmailLoginError. */
export function tenantRoleFromRows(rows: TenantLookupRow[]): string {
  const row = rows[0];
  if (!row) throw new EmailLoginError("no_user");
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
```

- [ ] **Step 4: Correr el test y ver que pasa**

Run: `npx tsx --test tests/email-auth.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Commitear**

```bash
git add src/email-auth.ts tests/email-auth.test.ts
git commit -m "feat: resolveTenantRole (email -> subdomain -> rol) con casos de error tipados"
```

---

## Task 5: Wiring en `oauth.ts` (ramificación por email en POST /authorize)

**Files:**
- Modify: `src/oauth.ts` (imports; `loginPage` label ~línea 351; `POST /authorize` handler ~líneas 193-241)

**Interfaces:**
- Consumes: `looksLikeEmail`, `verifyPassword`, `resolveTenantRole`, `EmailLoginError`, `emailLoginErrorMessage` de `./email-auth.js`; `Db` de `./db.js`; `cfg.supabaseUrl`, `cfg.supabaseAnonKey`, `cfg.statementTimeoutMs`; `pools.getBootstrapPool()`.

- [ ] **Step 1: Agregar imports**

En `src/oauth.ts`, junto a los imports existentes:
```ts
import { Db } from "./db.js";
import {
  looksLikeEmail,
  verifyPassword,
  resolveTenantRole,
  EmailLoginError,
  emailLoginErrorMessage,
  type TenantLookupRow,
} from "./email-auth.js";
```

- [ ] **Step 2: Cambiar el label del formulario**

En `loginPage`, cambiar:
```ts
  <label>Usuario</label>
```
por:
```ts
  <label>Usuario o email</label>
```

- [ ] **Step 3: Reescribir el handler `POST /authorize` con rama de email + cola compartida**

Reemplazar el cuerpo del handler `app.post("/authorize", ...)` (desde la validación del client hasta el `res.redirect`) por:
```ts
  app.post("/authorize", async (req: Request, res: Response) => {
    const { client_id, redirect_uri, code_challenge, state, username, password } =
      req.body as Record<string, string>;

    const client = client_id ? clients.get(client_id) : undefined;
    if (!client || !redirect_uri || !client.redirectUris.includes(redirect_uri) || !code_challenge) {
      res.status(400).send("Petición de autorización inválida.");
      return;
    }

    const fail = (error: string) => {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(loginPage({ client_id, redirect_uri, code_challenge, state: state ?? "", error }));
    };

    const input = (username ?? "").trim();
    if (!input || !password) return fail("Usuario o contraseña incorrectos.");

    // Resolvemos el username final (rol de Postgres) por una de las dos vías.
    let resolvedUsername: string;

    if (looksLikeEmail(input)) {
      // ── Login por email de la app (Supabase Auth) ──
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return fail("Usuario o contraseña incorrectos.");
      let ok: boolean;
      try {
        ok = await verifyPassword({
          supabaseUrl: cfg.supabaseUrl,
          anonKey: cfg.supabaseAnonKey,
          email: input,
          password,
        });
      } catch (e) {
        console.error("[oauth] error contactando Supabase Auth:", e);
        return fail("No se pudo verificar las credenciales. Intentá de nuevo.");
      }
      if (!ok) return fail("Usuario o contraseña incorrectos.");

      const lookupDb = new Db({
        pool: pools.getBootstrapPool(),
        statementTimeoutMs: cfg.statementTimeoutMs,
        assumeRole: null,
      });
      try {
        resolvedUsername = await resolveTenantRole(input, (sql, params) =>
          lookupDb.catalogQuery<TenantLookupRow>(sql, params),
        );
      } catch (e) {
        if (e instanceof EmailLoginError) return fail(emailLoginErrorMessage(e.reason));
        console.error("[oauth] error resolviendo tenant por email:", e);
        return fail("No se pudo verificar las credenciales. Intentá de nuevo.");
      }
      console.log(`[oauth] login por email ok: ${input} -> rol ${resolvedUsername}`);
    } else {
      // ── Login por rol de Postgres (flujo original) ──
      const err = await pools.validateCredentials(input, password);
      if (err) return fail("Usuario o contraseña incorrectos.");
      resolvedUsername = input;
    }

    // ── Cola compartida: auditoría + emisión del code ──
    try {
      await identityContexts.get({ mode: "assume", username: resolvedUsername });
    } catch (auditError) {
      const message =
        auditError instanceof AuditFailure
          ? summarizeAuditFailure(auditError)
          : "No se pudo verificar los permisos de este usuario.";
      return fail(message);
    }

    const code = rand(24);
    codes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      username: resolvedUsername,
      expiresAt: Date.now() + 60_000,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });
```

Nota: el flujo por rol ahora también corre siempre en modo `assume` (antes lo hacía igual — `identityContexts.get({mode:"assume", username})`), así que el comportamiento del login por rol de Postgres no cambia.

- [ ] **Step 4: Typecheck y build**

Run: `npm run typecheck`
Expected: sin errores.

Run: `npm run build`
Expected: compila a `dist/`.

- [ ] **Step 5: Verificación de la rama "Supabase sin configurar"**

Con las env vars de Supabase ausentes, un input con `@` NO debe intentar conexión a Postgres. Verificación por lectura de código: confirmar que la rama `looksLikeEmail(input)` chequea `!cfg.supabaseUrl || !cfg.supabaseAnonKey` **antes** de cualquier `verifyPassword`/`getBootstrapPool`, devolviendo `fail(...)`. (Cubierto en el código del Step 3; dejar constancia acá de que se revisó.)

- [ ] **Step 6: Commitear**

```bash
git add src/oauth.ts
git commit -m "feat: login por email en POST /authorize (convive con login por rol)"
```

---

## Task 6: Verificación del lookup SQL contra la base real

El `TENANT_LOOKUP_SQL` referencia `public.users`/`public.clients` con constraints y un enum que hacen frágil un test de integración que inserte filas ahí. La lógica de `tenantRoleFromRows`/`resolveTenantRole` ya está 100% cubierta por unit tests (Task 4). Esta task verifica que **la query real** devuelve la forma esperada, usando el MCP de Supabase ya conectado (read-only) — sin mutar datos.

**Files:** ninguno (verificación manual).

- [ ] **Step 1: Correr el lookup para un usuario con tenant válido**

Ejecutar (vía MCP de Supabase `execute_sql`) exactamente el `TENANT_LOOKUP_SQL` con `$1 = 'lucasoresi1@gmail.com'` (reemplazando `$1` por el literal):
```sql
SELECT c.subdomain, u.status AS user_status, c.status::text AS client_status,
       c.deleted_at,
       EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = c.subdomain) AS role_exists
FROM public.users u
JOIN public.clients c ON c.id = u.client_id
WHERE lower(u.email) = lower('lucasoresi1@gmail.com')
LIMIT 1;
```
Expected: una fila con `subdomain='iaca'`, `user_status='active'`, `client_status='active'`, `deleted_at=null`, `role_exists=true`. (Es decir, `tenantRoleFromRows` devolvería `'iaca'`.)

- [ ] **Step 2: Verificar el caso "cliente sin rol"**

Correr la misma query pero para un email cuyo cliente sea `maipu`/`demo`/`development`/`staging` (subdomains sin rol). Si no hay un usuario así a mano, verificar solo la condición del rol:
```sql
SELECT subdomain, EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = clients.subdomain) AS role_exists
FROM public.clients WHERE subdomain IN ('iaca','maipu','demo','staging','nanni','labmedicina') ORDER BY subdomain;
```
Expected: `iaca/nanni/labmedicina` → `role_exists=true`; `maipu/demo/staging` → `role_exists=false`. Confirma que esos clientes caerían en `no_tenant_role`.

- [ ] **Step 3: Verificar case-insensitivity**

```sql
SELECT count(*) FROM public.users WHERE lower(email) = lower('LucaSORESI1@Gmail.com');
```
Expected: `1` (el `lower()` normaliza mayúsculas).

- [ ] **Step 4: Dejar constancia**

No hay commit (sin cambios de archivos). Anotar los resultados en el reporte de la task.

---

## Task 7: Docs + prerrequisito operativo (`GRANT`) + `.env.example`

**Files:**
- Modify: `.env.example`
- Modify: `README.md` (tabla "Variables de entorno" y sección de auth/seguridad)

**Interfaces:** ninguna (documentación).

- [ ] **Step 1: `.env.example`**

Agregar (con comentario en español):
```bash
# Login por email de la app (opcional). Si faltan, solo funciona el login por
# rol de Postgres. Requiere además: GRANT SELECT ON public.users, public.clients TO mcp_bootstrap;
SUPABASE_URL=https://tuproyecto.supabase.co
SUPABASE_ANON_KEY=
```

- [ ] **Step 2: README — tabla de variables**

Agregar filas a la tabla "Variables de entorno":
- `SUPABASE_URL` — URL base del proyecto Supabase para validar login por email contra GoTrue. Opcional; ausente ⇒ login por email deshabilitado.
- `SUPABASE_ANON_KEY` — anon/publishable key usada como header `apikey` contra GoTrue. Opcional.

- [ ] **Step 3: README — sección de login por email**

Agregar una subsección explicando:
- El formulario OAuth acepta **usuario de Postgres o email de la app** (detección por `@`).
- El email se valida contra Supabase Auth y se mapea `email → public.users.client_id → clients.subdomain` (= rol de tenant), reusando `SET ROLE`.
- **Prerrequisito** (bloque SQL a correr una vez en la base):
  ```sql
  GRANT SELECT ON public.users, public.clients TO mcp_bootstrap;
  ```
  Es el único acceso directo que necesita `mcp_bootstrap` fuera de `SET ROLE`; acotado a esas dos tablas de mapeo global. `mcp_bootstrap` sigue siendo `NOINHERIT`.
- Un cliente sin rol de Postgres homónimo (ej. subdomains de staging/demo) verá "Tu organización todavía no tiene acceso al MCP.".

- [ ] **Step 4: Commitear**

```bash
git add .env.example README.md
git commit -m "docs: login por email (env vars + GRANT a mcp_bootstrap)"
```

---

## Task 8: Smoke test end-to-end (manual, local)

**Files:** ninguno.

- [ ] **Step 1: Aplicar el GRANT en la base de dev**

En una base disponible (no producción salvo que sea el objetivo real), correr:
```sql
GRANT SELECT ON public.users, public.clients TO mcp_bootstrap;
```

- [ ] **Step 2: Arrancar el server con Supabase configurado**

Con `.env` conteniendo `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `BOOTSTRAP_DB_USER`, `BOOTSTRAP_DB_PASSWORD` y lo demás:
Run: `npm run dev`
Expected: arranca sin error, `pingBootstrap` OK.

- [ ] **Step 3: Probar el login por email**

Con `test-client.mjs` no aplica (es Basic Auth). Probar el flujo OAuth desde un cliente real (ChatGPT/Claude) o con `curl` contra `/authorize` (GET para ver el form, POST con `username=<tu email>&password=...`). Verificar:
  - Email + password correctos de un usuario con tenant (ej. `iaca`) → redirect con `code` → token → tools scopeadas a `iaca`.
  - Email correcto pero cliente sin rol → "Tu organización todavía no tiene acceso al MCP.".
  - Password incorrecta → "Usuario o contraseña incorrectos.".
  - Usuario de Postgres (sin `@`) → sigue funcionando igual que antes.

- [ ] **Step 4: Correr toda la suite unit**

Run: `npm run test:unit`
Expected: PASS (guard + config + email-auth).

- [ ] **Step 5: Dejar constancia de los resultados del smoke test.**
