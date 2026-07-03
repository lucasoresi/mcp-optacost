#!/usr/bin/env node
/**
 * Servidor MCP remoto (Streamable HTTP) multiusuario.
 *
 * Autenticación de /mcp:
 *   - Bearer <token>  -> emitido por el OAuth embebido (ChatGPT, Claude web/desktop).
 *                        El token mapea a un usuario; las consultas usan SET ROLE.
 *   - Basic user:pass -> para editores (Cursor, VS Code, Claude Code). Conecta a
 *                        Postgres directamente como ese usuario.
 *
 * En ambos casos el schema accesible lo limita Postgres según los permisos del rol.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { Database, type Identity } from "./db.js";
import { createMcpServer } from "./tools.js";
import { mountOAuth } from "./oauth.js";

const cfg = loadConfig();
const db = new Database(cfg);

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true })); // /authorize (form) y /token

// ── CORS ────────────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && cfg.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// OAuth (metadata, register, authorize, token). Devuelve resolveToken().
const oauth = mountOAuth(app, db, cfg);

// ── Resolución de identidad para /mcp ───────────────────────────────
type AuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: number; message: string; wwwAuth?: string };

function resolveAuth(req: Request): AuthResult {
  const header = req.headers.authorization ?? "";
  const resourceMeta = `${cfg.publicUrl}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${resourceMeta}"`;

  if (header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    const username = oauth.resolveToken(token);
    if (!username) {
      return { ok: false, status: 401, message: "Token inválido o expirado.", wwwAuth: challenge };
    }
    return { ok: true, identity: { mode: "assume", username } };
  }

  if (cfg.enableBasicAuth && header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    } catch {
      return { ok: false, status: 400, message: "Basic Auth mal formado." };
    }
    const idx = decoded.indexOf(":");
    if (idx < 0) return { ok: false, status: 400, message: "Basic Auth mal formado." };
    const username = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);
    return { ok: true, identity: { mode: "direct", username, password } };
  }

  // Sin credenciales: disparar el descubrimiento OAuth.
  return { ok: false, status: 401, message: "Autenticación requerida.", wwwAuth: challenge };
}

function send401(res: Response, r: Extract<AuthResult, { ok: false }>) {
  if (r.wwwAuth) res.setHeader("WWW-Authenticate", r.wwwAuth);
  res.status(r.status).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: r.message },
    id: null,
  });
}

// ── Sesiones MCP ────────────────────────────────────────────────────
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req: Request, res: Response) => {
  const auth = resolveAuth(req);
  if (!auth.ok) return send401(res, auth);

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Para Basic Auth validamos las credenciales al iniciar la sesión.
      if (auth.identity.mode === "direct") {
        const err = await db.validateCredentials(auth.identity.username, auth.identity.password);
        if (err) {
          return send401(res, { ok: false, status: 401, message: `No se pudo conectar a la base como "${auth.identity.username}": ${err}` });
        }
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const server = createMcpServer(db, cfg, auth.identity);
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Falta Mcp-Session-Id válido o no es initialize." },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error en POST /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Error interno del servidor." },
        id: null,
      });
    }
  }
});

async function handleSessionRequest(req: Request, res: Response) {
  const auth = resolveAuth(req);
  if (!auth.ok) return send401(res, auth);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send("Mcp-Session-Id inválido o ausente.");
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

// ── Arranque ────────────────────────────────────────────────────────
async function main() {
  if (cfg.bootstrapUser) {
    try {
      await db.pingBootstrap();
      console.log("[db] Rol bootstrap verificado (para sesiones OAuth).");
    } catch (e) {
      console.error("[db] No se pudo conectar con el rol bootstrap:", e);
      process.exit(1);
    }
  } else {
    console.warn("[db] Sin BOOTSTRAP_DB_USER: las sesiones OAuth (ChatGPT/Claude) no funcionarán. Basic Auth sí.");
  }

  const httpServer = app.listen(cfg.port, () => {
    console.log(`MCP Postgres (read-only, multiusuario) en ${cfg.publicUrl}/mcp`);
    console.log(`OAuth login: ${cfg.publicUrl}/authorize`);
    console.log(`Basic Auth para editores: ${cfg.enableBasicAuth ? "habilitado" : "deshabilitado"}`);
  });

  const shutdown = async () => {
    console.log("\nCerrando...");
    httpServer.close();
    for (const t of transports.values()) await t.close().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
