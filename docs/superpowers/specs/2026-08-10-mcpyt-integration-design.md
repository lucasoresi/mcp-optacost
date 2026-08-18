# Integración de mcpYt en mcp/ (mismo comportamiento, transporte y auth multi-tenant de mcp/)

## Objetivo

Portar la lógica de dominio del servidor `safe-postgres-mcp` (`/mnt/c/Users/lucas/Desktop/mcpYt`, referido acá como **mcpYt**) — auditoría de privilegios, guard léxico, transacción read-only, formateo y las 6 tools — dentro de `mcp/`, conservando el comportamiento y rendimiento de mcpYt tal cual, pero sirviéndolo a través de la capa de transporte y autenticación multi-tenant que `mcp/` ya tiene en producción (Streamable HTTP + OAuth 2.1 embebido + Basic Auth), para poder consumirlo desde clientes remotos como ChatGPT.

mcpYt hoy solo corre local por stdio, anclado a un único `DATABASE_URL`/rol/schema durante toda la vida del proceso — no tiene transporte HTTP ni noción de múltiples usuarios.

## Por qué mcp/ es el destino (no mcpYt ni un proyecto nuevo)

`mcp/` ya tiene todo el andamiaje de transporte/red que se necesita conservar: Express + `StreamableHTTPServerTransport`, Authorization Server OAuth 2.1 embebido (metadata, DCR, `/authorize` con formulario de login, PKCE, refresh tokens), Basic Auth para editores, Dockerfile, y ya fue validado end-to-end con ngrok + ChatGPT. mcpYt no está publicado como paquete (`"private": true`, imports relativos, sin `exports`), así que la única integración realista es portar sus archivos fuente a `mcp/src/`, no importarlo como dependencia.

El trabajo se hace en la rama `feat/mcpyt-integration` de `mcp/`, dejando `main` intacto.

## Arquitectura

- **Se mantiene sin tocar:** `index.ts` (rutas `/mcp`, `resolveAuth()` Bearer/Basic), `oauth.ts` (Authorization Server completo), `config.ts` (con env vars nuevas agregadas para los límites de mcpYt).
- **Se reemplaza por completo:** `tools.ts` (las 4 tools actuales de mcp/) y la lógica interna de `db.ts`.
- **Se portan desde mcpYt casi sin cambios** (son funciones puras o casi-puras, no dependen de si hay 1 o N tenants):
  - `guard.ts` — guard léxico + protocolo extendido (`inspectSql`).
  - `audit.ts` — auditoría de privilegios (`runAudit`, `resolveSchema`, `remediationScript`).
  - `errors.ts` — sanitización de errores (`describeError`, `registerSecret`).
  - `format.ts` — formateo de resultados (`renderTable`).
  - `tools/*.ts` — las 6 tools (`query`, `list_tables`, `describe_table`, `list_relationships`, `explain_query`, `get_database_info`) y `registerTools()`.
- **Pieza nueva (el pegamento):** `IdentityContextCache` — `Map<username, Promise<ToolContext>>`. Se arma una vez por usuario (primera conexión), se cachea en memoria por el resto de la vida del proceso, y ese mismo `ToolContext` (`{ db, config, report, schema }`, tipo de mcpYt sin cambios) se pasa a `registerTools()`.

### Dos modos de identidad (igual que hoy en `db.ts`)

- **`direct` (Basic Auth):** pool propio conectado directamente como ese rol, con la opción de conexión `-c default_transaction_read_only=on` de mcpYt como blindaje extra. La auditoría corre directo sobre esa conexión.
- **`assume` (OAuth):** se reutiliza el pool bootstrap compartido de `mcp/`. La auditoría y las queries corren **después de `SET LOCAL ROLE "<username>"`** dentro de la misma transacción, para que `current_user` y los `has_*_privilege()` reflejen al usuario real y no al bootstrap. Esto requiere fusionar el `SET LOCAL ROLE` + `search_path` que ya tiene `db.ts` con `Db.withReadOnly()` de mcpYt.

## Decisiones ya tomadas

| Decisión | Elegido |
|---|---|
| Ejecución de la auditoría de privilegios (capa 1) | Una vez por usuario, cacheada en memoria mientras el proceso viva (mismo patrón que el cache de pools por usuario que ya existe en `mcp/`) |
| Tool-set final | Reemplazo completo por las 6 tools de mcpYt. `list_schemas` de `mcp/` desaparece — no aplica en un modelo de un-schema-por-tenant |
| Resolución de schema por tenant | Auto-detección de mcpYt vía `GRANT`s reales (`resolveSchema`), en vez de `USER_SCHEMA_TEMPLATE` de `mcp/` |
| Ubicación del trabajo | Rama nueva `feat/mcpyt-integration` dentro de `mcp/`, no en mcpYt ni en un proyecto nuevo |
| Cache de auditoría stale ante cambios de privilegios en caliente | Aceptado como limitación conocida — no se agrega TTL ni re-auditoría periódica (YAGNI) |

## Flujo de datos

**Primera conexión de un usuario nuevo (cache miss):**

1. `POST /mcp` llega a `index.ts`. `resolveAuth()` (sin cambios) devuelve la `Identity`.
2. Es un `initialize` sin `Mcp-Session-Id` → se llama a `getIdentityContext(identity)`:
   - `direct`: abre el pool dedicado, corre `runAudit()`, si pasa corre `resolveSchema()`.
   - `assume`: usa el pool bootstrap, ejecuta la auditoría después de `SET LOCAL ROLE`.
   - Si `runAudit()` lanza `AuditFailure`, no se cachea nada.
   - Si pasa, se cachea `{ db, schema, report }` por `username` para el resto de la vida del proceso.
3. Se crea el `McpServer`, se llama a `registerTools(server, context)` de mcpYt tal cual, y se conecta el transporte — mismo patrón que `createMcpServer()` usa hoy.
4. Llamadas de tools en esa sesión van directo a las funciones de mcpYt, con el mismo camino y costo que mcpYt corriendo local (sin overhead extra).

**Conexiones siguientes del mismo usuario:** cache hit en memoria, no se vuelve a auditar.

## Manejo de errores

- **Falla de auditoría en `direct` (Basic Auth/editores):** 401 con el detalle completo de qué chequeo falló, igual al output que mcpYt imprime hoy por consola (incluyendo el script de remediación SQL). Tiene sentido acá porque quien usa Basic Auth está configurando un rol nuevo.
- **Falla de auditoría en `assume` (OAuth/ChatGPT):** se mueve a `POST /authorize`, justo después de `db.validateCredentials()`. Si la auditoría falla, se vuelve a mostrar el formulario de login con el error (mismo patrón que ya usa `loginPage({..., error})` para credenciales inválidas), en vez de dejar completar el intercambio de código OAuth.
- **Guard léxico y errores de query en runtime:** sin cambios respecto a mcpYt — `errorResult()` con `describeError()` (que ya sanitiza contraseñas vía `registerSecret`).
- **Límite conocido y aceptado:** cambios de privilegios en Postgres después de cachear el contexto de un usuario no se detectan hasta reiniciar el proceso.

## Testing

- Portar tal cual `tests/guard.test.ts` de mcpYt (lógica pura, sin DB).
- Portar/adaptar `tests/integration.test.ts` de mcpYt (crea schema y roles descartables vía `TEST_ADMIN_URL`) para auditoría + `Db` + guard de punta a punta.
- Test de integración nuevo, específico para este proyecto: el combo `SET LOCAL ROLE` + auditoría en modo `assume` — verificar que `has_table_privilege()` etc. se evalúan como el rol asumido y no como el bootstrap. Es la única lógica genuinamente nueva (no existía tal cual en ninguno de los dos proyectos origen).
- Smoke test manual: extender `test-client.mjs` (o agregar un script hermano) para ejercitar las 6 tools nuevas en vez de las 4 actuales.

## Fuera de alcance

- No se toca `mcpYt/` ni se publica como paquete.
- No se agrega TTL ni re-auditoría periódica al cache de identidad.
- No se conserva `list_schemas` ni `USER_SCHEMA_TEMPLATE`.
- No se integra con el conector oficial hosteado de Supabase (`mcp.supabase.com`) ni con `npx skills add supabase/agent-skills` — quedó descartado por no aplicar a este proyecto.
