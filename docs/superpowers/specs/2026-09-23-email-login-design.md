# Login por email de la aplicación (además del rol de Postgres)

## Objetivo

Permitir que un usuario final entre al MCP desde el formulario OAuth (el que usan ChatGPT / Claude web/desktop) usando **su email y contraseña de la aplicación** (ej. `lucasoresi1@gmail.com`), en vez del string críptico del rol de Postgres del tenant (ej. `nanni.nfjjlfovpznoipgkugdf`). Tras loguear, la sesión queda scopeada automáticamente al tenant de ese usuario, reutilizando el modo `assume` que ya existe.

El login por rol de Postgres **sigue funcionando** — la feature convive con él, no lo reemplaza.

## Contexto

- Las contraseñas de los usuarios de la app viven en `auth.users.encrypted_password` (Supabase Auth / GoTrue, bcrypt). `public.users` **no** tiene columna de contraseña.
- La pertenencia usuario→cliente está en `public.users.client_id → public.clients.subdomain`.
- El nombre del rol de Postgres del tenant **coincide con el `subdomain`** del cliente (`iaca`, `nanni`, `labmedicina`).
- En modo `assume`, `identity-context.ts` recorta el `username` en el primer punto (`split(".")[0]`) para el `SET ROLE`, así que basta el **nombre pelado del rol** (= subdomain); el sufijo `.project_ref` del pooler no hace falta.

### Verificado contra la base de producción (2026-09-23)

- Roles de Postgres que existen y coinciden con un `subdomain`: `iaca`, `labmedicina`, `nanni`. Los tres tienen a **`mcp_bootstrap` como miembro** (el `SET ROLE` funciona), y ninguno es `SUPERUSER`/`BYPASSRLS`.
- Subdomains **sin** rol de Postgres: `demo`, `development`, `maipu`, `staging`. El diseño debe manejar el caso "cliente sin rol de tenant".
- `lucasoresi1@gmail.com` existe en `auth.users` y `public.users`, mapea al cliente `iaca` (rol `iaca` existe) → la feature funciona para este usuario.

## Alcance (decisiones tomadas)

| Decisión | Elegido |
|---|---|
| Convivencia | El formulario acepta ambos. Detección por presencia de `@`: con `@` → login por email; sin `@` → flujo actual de rol de Postgres. |
| Validación de contraseña | API de GoTrue: `POST {SUPABASE_URL}/auth/v1/token?grant_type=password`. Reusa bcrypt, rate-limit, lockout y confirmación de email de Supabase. |
| Origen del mapeo email→tenant | `public.users` + `public.clients.subdomain` (= nombre del rol). Un tenant por usuario. Cubre a todos los usuarios. |
| Contenido del token OAuth | Solo el rol resuelto (ej. `iaca`), igual que hoy. El email va únicamente a log de servidor, no se persiste en el token store. |
| Prerrequisito operativo | `GRANT SELECT ON public.users, public.clients TO mcp_bootstrap` (acotado a esas dos tablas de mapeo global). **Si esas tablas tienen RLS activo (default en Supabase), además una policy `FOR SELECT TO mcp_bootstrap USING (true)` en cada una** — el GRANT no alcanza porque `mcp_bootstrap` no tiene `BYPASSRLS`. |
| Basic Auth (editores) | Sin cambios. El login por email es solo del flujo OAuth. |

## Arquitectura

Todo el cambio se concentra en el **paso de login** (`oauth.ts POST /authorize`). La cadena posterior no se toca: `identityContexts.get({mode:"assume", username:<rol>})` ya hace bootstrap pool + `SET ROLE` + auditoría + resolución de schema + registro de tools.

### Flujo del `POST /authorize`

```
input del form
 ├─ SIN "@"  → flujo actual: pools.validateCredentials(user, pass) → assume:<rol>
 └─ CON "@"  → NUEVO:
       1. emailAuth.verifyPassword(email, pass)   (GoTrue; si falla → "credenciales incorrectas")
       2. emailAuth.resolveTenantRole(email)      (lookup DB → nombre de rol, o error tipado)
       3. identityContexts.get({ mode:"assume", username: rol })   ← ya existe (corre auditoría)
       4. emitir code / token con username = rol                    ← igual que hoy
```

Si `SUPABASE_URL`/`SUPABASE_ANON_KEY` no están configuradas, la rama de email queda deshabilitada: un input con `@` cae en "credenciales incorrectas" (nunca intenta el flujo de rol con un email como usuario de Postgres).

### Componentes

- **`config.ts`** (modificado): dos env vars nuevas **opcionales**:
  - `SUPABASE_URL` — ej. `https://nfjjlfovpznoipgkugdf.supabase.co`
  - `SUPABASE_ANON_KEY` — anon/publishable key (header `apikey` contra GoTrue).
  - Se agregan a `AppConfig` como `supabaseUrl: string | null` y `supabaseAnonKey: string | null`. Ausentes ⇒ login por email deshabilitado.

- **`email-auth.ts`** (nuevo): unidad aislada y testeable, dos responsabilidades separadas.
  - `verifyPassword(email, password): Promise<boolean>` — único lugar que habla HTTP con GoTrue. `fetch` a `{SUPABASE_URL}/auth/v1/token?grant_type=password` con header `apikey`. `200` ⇒ `true`; `400/401` ⇒ `false`; error de red ⇒ se propaga como fallo genérico (no como "credenciales incorrectas", para no confundir un problema de infra con una contraseña mala). No devuelve ni guarda el token de Supabase — solo valida.
  - `resolveTenantRole(email, catalogDb): Promise<string>` — lookup vía el bootstrap pool. Reglas: `lower(email)` match, `users.status = 'active'`, cliente no borrado (`clients.deleted_at IS NULL`) y `clients.status = 'active'`, y que **exista** un rol de Postgres con nombre = `subdomain` (chequeo contra `pg_roles`). Devuelve el nombre del rol, o lanza `EmailLoginError` tipado con la causa (`no_user` | `no_tenant_role` | `inactive`).

- **`oauth.ts`** (modificado):
  - Label del form: "Usuario" → "**Usuario o email**". Sin cambios de layout.
  - En `POST /authorize`, antes de `validateCredentials`, ramificar por `username.includes("@")`.
  - Traducir `EmailLoginError` a los mensajes de la matriz de abajo, re-renderizando `loginPage` con el error (mismo patrón que el error actual de credenciales).

- **`db.ts`** (posible ajuste menor): el lookup de `resolveTenantRole` corre sobre el bootstrap pool con `catalogQuery()`. Consulta el esquema `public` (no un schema de tenant), así que puede requerir una variante que no aplique `SET LOCAL search_path` al schema del tenant, o un `catalogQuery` con `search_path` explícito a `public`. Se resuelve en implementación reutilizando `withReadOnly` sin `assumeRole`.

### Matriz de errores (todo cae en la pantalla de login, sin filtrar qué parte falló)

| Caso | Mensaje |
|---|---|
| GoTrue rechaza (password mala / email inexistente en `auth`) | "Usuario o contraseña incorrectos." |
| Email válido en GoTrue pero sin fila en `public.users` (`no_user`) | "Usuario o contraseña incorrectos." |
| Usuario o cliente inactivo/borrado (`inactive`) | "Usuario o contraseña incorrectos." |
| Cliente sin rol de tenant — demo/maipu/… (`no_tenant_role`) | "Tu organización todavía no tiene acceso al MCP." |
| Rol resuelto pero falla la auditoría de privilegios | El detalle actual de `AuditFailure` (`summarizeAuditFailure`, ya existe) |
| GoTrue caído / error de red | "No se pudo verificar las credenciales. Intentá de nuevo." |

Los casos `no_user`/`inactive` devuelven el mismo mensaje que una contraseña mala a propósito: no se filtra si el email existe o en qué estado está.

## Seguridad

- **La frontera de seguridad sigue siendo Postgres.** El login por email solo elige *qué rol asumir*; el aislamiento entre tenants lo siguen garantizando los `GRANT`s del rol, la auditoría (`audit.ts`) y `SET ROLE`. Un bug en el mapeo podría mandar a alguien al tenant equivocado, pero nunca darle privilegios que el rol no tenga.
- **Cache de `IdentityContextCache`:** en modo `assume` la clave es `assume:<rol>`. Varios emails del mismo tenant comparten el mismo `ToolContext` (mismo tenant read-only) — correcto, y cada uno pasó GoTrue antes. La preocupación de "password load-bearing en la clave" del modo `direct` no aplica: acá la contraseña se valida en GoTrue *antes* de tocar el cache.
- **La contraseña del email nunca se guarda** (igual que hoy con la de Postgres). El token de Supabase que devuelve GoTrue se descarta.
- **`GRANT SELECT` a `mcp_bootstrap`** se limita a `public.users` y `public.clients`. `mcp_bootstrap` sigue siendo `NOINHERIT`; esto no cambia lo que un tenant puede leer (los tenants no asumen bootstrap). **Nota (descubierto en pruebas):** si esas tablas tienen RLS activo, el `GRANT` no basta — RLS filtra las filas y el lookup ve 0 filas (login falla con "Usuario o contraseña incorrectos"). Hace falta además una policy `FOR SELECT TO mcp_bootstrap USING (true)` en cada tabla, ya que `mcp_bootstrap` no tiene `BYPASSRLS` (a propósito).

## Testing

- **Unit** (`tests/`, sin DB, mockeando `fetch`):
  - Detección de rama por `@`.
  - `verifyPassword`: `200`→true, `400`→false, error de red→throw.
  - Traducción `EmailLoginError` → mensaje.
- **Integration** (`tests/integration.test.ts`, con `TEST_ADMIN_URL`):
  - `resolveTenantRole`: usuario/cliente/rol de prueba en el schema `mcp_test`, incluyendo el caso "cliente sin rol de tenant" (`no_tenant_role`) y "usuario inactivo".
  - Se reutiliza el andamiaje de creación/drop de `mcp_test` que ya existe.
- GoTrue no se testea contra la API real en integración (se mockea en unit).

## Convención de idioma

`email-auth.ts` es un archivo propio de este proyecto (capa transporte/auth), así que su texto operador-facing va en **español**, igual que `oauth.ts`, `config.ts`, etc. Imports con extensión `.js` (NodeNext).

## Fuera de alcance (YAGNI)

- MFA / OTP (GoTrue lo soporta pero no lo pide este flujo).
- Multi-tenant por usuario (un usuario en varios tenants) — hoy `public.users.client_id` es un único cliente. Si más adelante hace falta, se migra el mapeo a `user_tenants` con un selector de tenant en el login.
- Cachear el resultado de `resolveTenantRole` (el lookup es una query barata; el `ToolContext` ya se cachea aguas abajo).
- Persistir el email en el token store o en logs estructurados más allá de un `console.log` de servidor.
