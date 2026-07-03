/**
 * Authorization Server OAuth 2.1 mínimo, embebido en el mismo Express.
 *
 * Objetivo: que ChatGPT y Claude (que sólo hablan OAuth) puedan "loguear"
 * con el usuario y contraseña de Postgres. La pantalla de /authorize pide
 * esas credenciales, las valida contra la base y, si son correctas, emite un
 * token. La contraseña NO se guarda: las consultas usan SET ROLE (ver db.ts).
 *
 * Implementa: metadata (.well-known), Dynamic Client Registration, authorize
 * con formulario de login, y token con PKCE S256 + refresh_token.
 *
 * NOTA: los stores son en memoria (suficiente para una instancia). Para varias
 * réplicas, reemplazar por Redis/DB.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { Database } from "./db.js";

interface Client {
  clientId: string;
  redirectUris: string[];
  name?: string;
}
interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  username: string;
  expiresAt: number;
}
interface Token {
  username: string;
  expiresAt: number;
}

function rand(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
function sha256b64url(v: string): string {
  return createHash("sha256").update(v).digest("base64url");
}
function html(strings: TemplateStringsArray, ...vals: string[]): string {
  return strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ""), "");
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export interface OAuthLayer {
  /** Devuelve el username asociado a un access token válido, o null. */
  resolveToken(token: string): string | null;
}

export function mountOAuth(app: Express, db: Database, cfg: AppConfig): OAuthLayer {
  const clients = new Map<string, Client>();
  const codes = new Map<string, AuthCode>();
  const tokens = new Map<string, Token>();
  const refreshTokens = new Map<string, string>(); // refresh -> username

  const issuer = cfg.publicUrl;
  const resourceUrl = `${issuer}/mcp`;

  // ── Metadata del Authorization Server ───────────────────────────
  const asMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read"],
  };

  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(asMetadata));
  // Algunos clientes buscan la metadata OIDC en esta ruta:
  app.get("/.well-known/openid-configuration", (_req, res) => res.json(asMetadata));

  // ── Metadata del Protected Resource (RFC 9728) ──────────────────
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource: resourceUrl, authorization_servers: [issuer] });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({ resource: resourceUrl, authorization_servers: [issuer] });
  });

  // ── Dynamic Client Registration (RFC 7591) ──────────────────────
  app.post("/register", (req: Request, res: Response) => {
    const body = req.body ?? {};
    const redirectUris: unknown = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris requerido" });
      return;
    }
    for (const u of redirectUris) {
      if (typeof u !== "string" || !/^https?:\/\//.test(u)) {
        res.status(400).json({ error: "invalid_redirect_uri" });
        return;
      }
    }
    const clientId = rand(16);
    clients.set(clientId, {
      clientId,
      redirectUris: redirectUris as string[],
      name: typeof body.client_name === "string" ? body.client_name : undefined,
    });
    res.status(201).json({
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ── GET /authorize -> formulario de login ───────────────────────
  app.get("/authorize", (req: Request, res: Response) => {
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state, response_type } =
      req.query as Record<string, string>;

    const client = client_id ? clients.get(client_id) : undefined;
    if (!client) return res.status(400).send("client_id desconocido. Registrá el cliente primero.");
    if (!redirect_uri || !client.redirectUris.includes(redirect_uri)) {
      return res.status(400).send("redirect_uri no registrado para este cliente.");
    }
    if (response_type !== "code") return res.status(400).send("response_type debe ser 'code'.");
    if (!code_challenge || code_challenge_method !== "S256") {
      return res.status(400).send("Se requiere PKCE con code_challenge_method=S256.");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(loginPage({ client_id, redirect_uri, code_challenge, state: state ?? "", error: null }));
  });

  // ── POST /authorize -> valida credenciales de Postgres ──────────
  app.post("/authorize", async (req: Request, res: Response) => {
    const { client_id, redirect_uri, code_challenge, state, username, password } =
      req.body as Record<string, string>;

    const client = client_id ? clients.get(client_id) : undefined;
    if (!client || !redirect_uri || !client.redirectUris.includes(redirect_uri) || !code_challenge) {
      res.status(400).send("Petición de autorización inválida.");
      return;
    }

    const err = username && password ? await db.validateCredentials(username, password) : "faltan credenciales";
    if (err) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        loginPage({ client_id, redirect_uri, code_challenge, state: state ?? "", error: "Usuario o contraseña incorrectos." }),
      );
      return;
    }

    const code = rand(24);
    codes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      username,
      expiresAt: Date.now() + 60_000, // 60s
    });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  // ── POST /token ─────────────────────────────────────────────────
  app.post("/token", (req: Request, res: Response) => {
    const body = req.body as Record<string, string>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const { code, code_verifier, redirect_uri, client_id } = body;
      const entry = code ? codes.get(code) : undefined;
      if (!entry) return tokenError(res, "invalid_grant", "code inválido o expirado");
      codes.delete(code);
      if (entry.expiresAt < Date.now()) return tokenError(res, "invalid_grant", "code expirado");
      if (entry.clientId !== client_id) return tokenError(res, "invalid_grant", "client_id no coincide");
      if (entry.redirectUri !== redirect_uri) return tokenError(res, "invalid_grant", "redirect_uri no coincide");
      if (!code_verifier || sha256b64url(code_verifier) !== entry.codeChallenge) {
        return tokenError(res, "invalid_grant", "PKCE inválido");
      }
      return issueTokens(res, entry.username);
    }

    if (grantType === "refresh_token") {
      const rt = body.refresh_token;
      const username = rt ? refreshTokens.get(rt) : undefined;
      if (!username) return tokenError(res, "invalid_grant", "refresh_token inválido");
      refreshTokens.delete(rt);
      return issueTokens(res, username);
    }

    return tokenError(res, "unsupported_grant_type", `grant_type no soportado: ${grantType}`);
  });

  function issueTokens(res: Response, username: string) {
    const accessToken = rand(32);
    const refreshToken = rand(32);
    tokens.set(accessToken, { username, expiresAt: Date.now() + cfg.tokenTtlSeconds * 1000 });
    refreshTokens.set(refreshToken, username);
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: cfg.tokenTtlSeconds,
      refresh_token: refreshToken,
      scope: "read",
    });
  }

  function tokenError(res: Response, error: string, desc: string) {
    res.status(400).json({ error, error_description: desc });
  }

  // Limpieza periódica de entradas expiradas.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
    for (const [k, v] of tokens) if (v.expiresAt < now) tokens.delete(k);
  }, 60_000).unref();

  return {
    resolveToken(token: string): string | null {
      const t = tokens.get(token);
      if (!t) return null;
      if (t.expiresAt < Date.now()) {
        tokens.delete(token);
        return null;
      }
      return t.username;
    },
  };
}

function loginPage(o: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  error: string | null;
}): string {
  const err = o.error
    ? `<p style="color:#c00;margin:0 0 12px">${escapeHtml(o.error)}</p>`
    : "";
  return html`<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar a la base de datos</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f1220;color:#e7e9f0;display:flex;
       min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#191d2e;padding:32px;border-radius:14px;width:320px;
        box-shadow:0 10px 40px rgba(0,0,0,.5)}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{color:#9aa0b4;font-size:13px;margin:0 0 20px}
  label{display:block;font-size:13px;margin:14px 0 6px;color:#c3c7d6}
  input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2c3149;
        background:#0f1220;color:#e7e9f0;font-size:14px}
  button{width:100%;margin-top:22px;padding:11px;border:0;border-radius:8px;background:#5b7cfa;
         color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#4a6bf0}
</style></head>
<body><form class="card" method="post" action="/authorize">
  <h1>Conectar a la base de datos</h1>
  <p class="sub">Ingresá tu usuario y contraseña de PostgreSQL.</p>
  ${err}
  <input type="hidden" name="client_id" value="${escapeHtml(o.client_id)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(o.redirect_uri)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(o.code_challenge)}">
  <input type="hidden" name="state" value="${escapeHtml(o.state)}">
  <label>Usuario</label>
  <input name="username" autocomplete="username" autofocus required>
  <label>Contraseña</label>
  <input name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Conectar</button>
</form></body></html>`;
}
