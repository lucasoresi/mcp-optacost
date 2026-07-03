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
2. **`SET ROLE`** (sesiones OAuth) — se ejecuta con la identidad y permisos de la persona.
3. **Transacción `READ ONLY`** — cada consulta corre en `BEGIN TRANSACTION READ ONLY` y termina en `ROLLBACK`.
4. **Validación previa del SQL** — un único statement y sólo `SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES`.
5. **Límites** — `statement_timeout` y tope de filas (`MAX_ROWS`).

---

## Tools que expone

| Tool             | Qué hace                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `list_schemas`   | Schemas visibles para tu usuario.                                  |
| `list_tables`    | Tablas y vistas sobre las que tenés `SELECT`.                      |
| `describe_table` | Columnas, tipos, PK y FKs de una tabla.                            |
| `execute_sql`    | Una consulta de lectura con parámetros (`$1, $2, ...`).            |

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

> Si tu convención es "cada usuario tiene un schema con su mismo nombre", no toques `USER_SCHEMA_TEMPLATE`. Si el schema se llama distinto, ajustá la plantilla (ej. `data_{user}`).
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
| `USER_SCHEMA_TEMPLATE`  | `{user}`                         | Plantilla del schema por usuario.                             |
| `STATEMENT_TIMEOUT_MS`  | `8000`                           | Timeout por consulta (ms).                                     |
| `MAX_ROWS`              | `1000`                           | Tope de filas por `execute_sql`.                              |
| `TOKEN_TTL_SECONDS`     | `3600`                           | Vida del access token OAuth.                                  |
| `ENABLE_BASIC_AUTH`     | `true`                           | Permitir Basic Auth en `/mcp`.                                |
| `PORT`                  | `3000`                           | Puerto HTTP.                                                   |
| `ALLOWED_ORIGINS`       | `claude.ai, chatgpt.com`         | Orígenes CORS.                                                 |

---

## Arquitectura

```
src/
├── index.ts   # Express + Streamable HTTP + resolución de identidad (Bearer/Basic)
├── oauth.ts   # Authorization Server OAuth 2.1 (metadata, DCR, login, token, PKCE)
├── tools.ts   # McpServer y tools, scopeadas al usuario autenticado
├── db.ts      # pg multiusuario: conexión directa (Basic) o SET ROLE (OAuth), read-only
└── config.ts  # Variables de entorno
```

Rutas: `POST/GET/DELETE /mcp`, `GET /authorize` + `POST /authorize`, `POST /token`, `POST /register`, `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`, `GET /healthz`.

---

## Notas de producción

- Los stores de OAuth (códigos y tokens) están **en memoria**: sirven para una instancia. Para varias réplicas, reemplazá los `Map` de `oauth.ts` por Redis o una tabla.
- Serví siempre por **HTTPS**; el login manda la contraseña de Postgres.
- El rol bootstrap puede asumir a cualquier usuario que se le haya concedido: protegé su contraseña como cualquier secreto sensible.
- Considerá rate-limiting en `/authorize` para frenar fuerza bruta.
