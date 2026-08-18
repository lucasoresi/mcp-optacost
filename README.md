# MCP Postgres (solo lectura, multiusuario)

Servidor **MCP remoto** sobre **Streamable HTTP** que expone una base **PostgreSQL en modo solo lectura**, con **login por usuario y contraseña de la propia base**. Cada persona entra con sus credenciales de Postgres y **solo ve su schema** (lo hace cumplir Postgres, no el servidor). Consumible desde **Claude Desktop, claude.ai, ChatGPT, Cursor, VS Code** y cualquier cliente MCP.

Mismo espíritu que el [MCP oficial de Supabase](https://supabase.com/docs/guides/ai-tools/mcp), pero acotado a consulta segura y con autenticación por usuario.

---

## Cómo se autentica cada cliente

El problema: ChatGPT y Claude (web/desktop) **solo hablan OAuth**; no mandan usuario/contraseña por header. Los editores (Cursor/VS Code/Claude Code) sí pueden mandar un header. Por eso el servidor soporta **dos vías**, ambas terminando en "ejecutar como tu usuario de Postgres":

| Cliente                          | Método         | Qué escribís                                    |
| -------------------------------- | -------------- | ----------------------------------------------- |
| ChatGPT, Claude web/desktop      | **OAuth**      | Usuario y contraseña en la pantalla de login    |
| Cursor, VS Code, Claude Code     | **Basic Auth** | Usuario y contraseña en la config del cliente   |

**Flujo OAuth:** el cliente abre `/authorize` → aparece una pantalla que pide tu usuario y contraseña de Postgres → el servidor los valida conectándose a la base → si andan, emite un token y **descarta la contraseña**. Las consultas se ejecutan como vos vía `SET ROLE`, así Postgres te limita a tu schema.

**Flujo Basic:** el cliente manda `Authorization: Basic usuario:contraseña` y el servidor se conecta a Postgres directamente como ese usuario.

> En ningún caso se guardan contraseñas de usuarios. En OAuth se valida una vez y se usa `SET ROLE`; en Basic la conexión vive mientras dure la sesión.

---

## Seguridad de solo lectura (defensa en profundidad)

1. **Permisos del usuario de Postgres** — cada rol ya tiene acceso solo a su schema. Barrera principal, la misma que usás hoy.
2. **Auditoría de privilegios** — la primera vez que cada persona se conecta, el server audita su rol y le niega el acceso si tiene privilegios que podrían escapar de las capas siguientes: `SUPERUSER`, `BYPASSRLS`, `REPLICATION`, membresía en `pg_execute_server_program`/`pg_*_server_files`, o acceso a `dblink`/`postgres_fdw`/lenguajes no confiables. Esos chequeos son fatales y no se pueden anular. Los grants de escritura, `CREATE`, `CREATEDB` y `CREATEROLE` también rechazan por defecto, pero se pueden bajar a warning con `ALLOW_WRITABLE_ROLE=true` (la capa 4 los bloquea igual).
3. **`SET ROLE`** (sesiones OAuth) — se ejecuta con la identidad y permisos de la persona, incluida la auditoría del punto anterior.
4. **Transacción `READ ONLY`** — cada consulta corre en `BEGIN TRANSACTION READ ONLY` y termina en `ROLLBACK`.
5. **Guard léxico previo al SQL** — un único statement y sólo `SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES`, sin llamadas a `set_config()` (la única forma en que una consulta puede cambiar de rol a mitad de camino y salirse de su tenant), más el protocolo extendido de Postgres, que rechaza múltiples comandos a nivel de protocolo.
6. **Límites** — `statement_timeout` y tope de filas (`MAX_ROWS`).

---

## Tools que expone

Portadas de `safe-postgres-mcp` (mcpYt), con el mismo comportamiento y las mismas descriptions — sólo cambia cómo se resuelve la identidad (auth de este server) en vez de un único `DATABASE_URL`.

| Tool                 | Qué hace                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| `query`              | Una consulta de sólo lectura (`SELECT/WITH/EXPLAIN/TABLE/VALUES/SHOW`).      |
| `list_tables`        | Tablas, vistas y vistas materializadas del schema, con tamaño y comentario.  |
| `describe_table`     | Columnas, PK, FKs entrantes/salientes, constraints e índices de una tabla.   |
| `list_relationships` | Todo el grafo de foreign keys del schema, para escribir JOINs correctos.     |
| `explain_query`      | Plan de ejecución de una query, sin correrla (nunca usa `ANALYZE`).          |
| `get_database_info`  | A qué está conectado el server y qué chequeos de seguridad pasaron.          |

El schema de cada persona se detecta solo, a partir de sus `GRANT`s: es el único schema no-sistema donde el rol puede **leer** algo. `USAGE` no alcanza para desempatar, porque en Supabase `public` y `pgsodium` se lo otorgan a `PUBLIC` y por lo tanto los ve cualquier rol. Si el rol puede leer en cero o en más de un schema, el login falla con un error que dice qué corregir.

---

## Paso 1 — Preparar Postgres

Tus usuarios ya existen y cada uno tiene su schema. Sólo necesitás el **rol bootstrap** que usa el flujo OAuth para ejecutar como cada persona:

```sql
-- Rol que hará SET ROLE a los usuarios (para sesiones OAuth)
CREATE ROLE mcp_bootstrap LOGIN PASSWORD 'clave-fuerte' NOINHERIT;

-- Permitirle asumir a cada usuario (uno por cada persona)
GRANT usuario1 TO mcp_bootstrap;
GRANT usuario2 TO mcp_bootstrap;
-- ...
```

`NOINHERIT` es importante: el bootstrap no usa privilegios propios, solo los del rol que asume con `SET ROLE`.

> El schema de cada persona no se configura: se deduce de sus `GRANT`s. Cada rol tiene que poder leer (`SELECT` en al menos una relación) en exactamente un schema no-sistema — el suyo. Que además vea `public` o `pgsodium` no molesta, porque no puede leer nada ahí. Lo que sí rompe la detección es darle `SELECT` en dos schemas de tenant distintos.
>
> Si **solo** vas a usar editores con Basic Auth, el rol bootstrap es opcional (podés omitirlo).

---

## Paso 2 — Configurar y correr

```bash
cp .env.example .env
# Editá: PUBLIC_URL, PGHOST/PGPORT/PGDATABASE, BOOTSTRAP_DB_USER/PASSWORD

npm install
npm run build
npm start
```

`PUBLIC_URL` debe ser exactamente la URL pública por la que se accede (se usa como issuer de OAuth). Verificá con `curl $PUBLIC_URL/healthz`.

### Con Docker

```bash
docker build -t mcp-postgres-ro .
docker run -p 3000:3000 --env-file .env mcp-postgres-ro
```

---

## Paso 3 — Exponerlo en internet (HTTPS)

OAuth y los clientes remotos requieren **HTTPS**:

- **Producción:** Fly.io, Railway, Render, Cloud Run, o VPS con Nginx + TLS.
- **Pruebas:** `cloudflared tunnel --url http://localhost:3000` o `ngrok http 3000`. Poné la URL del túnel en `PUBLIC_URL` y reiniciá.

La URL del conector es `https://tu-dominio/mcp`.

---

## Paso 4 — Conectar cada cliente

### ChatGPT (Developer mode)

Settings → Connectors → Developer mode → **Create** → URL `https://tu-dominio/mcp`, protocolo **Streamable HTTP**, autenticación **OAuth**. Al conectar te aparece la pantalla de login: ponés tu usuario y contraseña de Postgres.

### Claude Desktop / claude.ai

Settings → Connectors → **Add custom connector** → `https://tu-dominio/mcp`. Claude detecta OAuth y abre la pantalla de login.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "postgres-ro": {
      "url": "https://tu-dominio/mcp",
      "headers": {
        "Authorization": "Basic BASE64(usuario:contraseña)"
      }
    }
  }
}
```

Generá el valor con: `printf 'usuario:contraseña' | base64`.

### VS Code (Copilot) — `.vscode/mcp.json`

```json
{
  "servers": {
    "postgres-ro": {
      "type": "http",
      "url": "https://tu-dominio/mcp",
      "headers": { "Authorization": "Basic BASE64(usuario:contraseña)" }
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add postgres-ro --transport http https://tu-dominio/mcp \
  --header "Authorization: Basic BASE64(usuario:contraseña)"
```

> Cursor, VS Code y Claude Code también soportan OAuth: si preferís, dejá solo la `url` y te pedirá login como a ChatGPT/Claude.

---

## Variables de entorno

| Variable                | Default                          | Descripción                                                     |
| ----------------------- | -------------------------------- | -------------------------------------------------------------- |
| `PUBLIC_URL`            | —                                | URL pública (issuer OAuth y resource). **Obligatoria.**        |
| `PGHOST`                | —                                | Host de Postgres.                                              |
| `PGPORT`                | `5432`                           | Puerto.                                                        |
| `PGDATABASE`            | —                                | Nombre de la base.                                             |
| `PGSSLMODE`             | `require`                        | `require` \| `no-verify` \| `disable`.                        |
| `BOOTSTRAP_DB_USER`     | —                                | Rol que hace `SET ROLE` (para OAuth).                          |
| `BOOTSTRAP_DB_PASSWORD` | —                                | Contraseña del rol bootstrap.                                  |
| `STATEMENT_TIMEOUT_MS`  | `8000`                           | Timeout por consulta (ms).                                     |
| `MAX_ROWS`              | `1000`                           | Tope de filas por `query`.                                     |
| `ALLOW_WRITABLE_ROLE`   | `false`                          | Baja de fatal a warning el chequeo de permisos de escritura del rol conectado. Los chequeos de superuser, `BYPASSRLS` y extensiones de escape (`dblink`, etc.) nunca se pueden anular. |
| `TOKEN_TTL_SECONDS`     | `3600`                           | Vida del access token OAuth.                                  |
| `ENABLE_BASIC_AUTH`     | `true`                           | Permitir Basic Auth en `/mcp`.                                |
| `PORT`                  | `3000`                           | Puerto HTTP.                                                   |
| `ALLOWED_ORIGINS`       | `claude.ai, chatgpt.com`         | Orígenes CORS.                                                 |

---

## Arquitectura

```
src/
├── index.ts             # Express + Streamable HTTP + resolución de identidad (Bearer/Basic)
├── oauth.ts             # Authorization Server OAuth 2.1 (metadata, DCR, login, token, PKCE)
├── identity.ts          # El tipo Identity: "direct" (Basic) o "assume" (OAuth)
├── pool.ts              # Ciclo de vida de los pools: por usuario y el bootstrap compartido
├── db.ts                # Ejecución read-only sobre un pool inyectado (+ SET LOCAL ROLE)
├── audit.ts             # Auditoría de privilegios y detección del schema del tenant
├── identity-context.ts  # Arma y cachea, por usuario, el contexto que usan las tools
├── tools.ts             # McpServer para un contexto ya resuelto
├── tools/               # Las 6 tools portadas de mcpYt + registerTools()
├── guard.ts             # Guard léxico del SQL (un statement, sólo lectura)
├── format.ts            # Formateo de resultados en tablas de texto
├── errors.ts            # Sanitización de errores (nunca filtra contraseñas)
└── config.ts            # Variables de entorno
```

Rutas: `POST/GET/DELETE /mcp`, `GET /authorize` + `POST /authorize`, `POST /token`, `POST /register`, `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`, `GET /healthz`.

---

## Notas de producción

- Los stores de OAuth (códigos y tokens) están **en memoria**: sirven para una instancia. Para varias réplicas, reemplazá los `Map` de `oauth.ts` por Redis o una tabla.
- Serví siempre por **HTTPS**; el login manda la contraseña de Postgres.
- El rol bootstrap puede asumir a cualquier usuario que se le haya concedido: protegé su contraseña como cualquier secreto sensible.
- Considerá rate-limiting en `/authorize` para frenar fuerza bruta.
