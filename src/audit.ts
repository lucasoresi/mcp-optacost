/**
 * Capa 1 del modelo de seguridad: una auditoría de privilegios que corre
 * antes de registrar ninguna tool, para el rol conectado (o asumido vía
 * SET LOCAL ROLE — ver db.ts).
 *
 * Los chequeos se dividen por una línea de principio:
 *
 *   FATAL, nunca anulable -- privilegios que dejan a una query escapar de la
 *   transacción READ ONLY por completo (superuser, BYPASSRLS, roles de
 *   servidor/archivos, dblink/postgres_fdw, lenguajes procedurales no
 *   confiables).
 *
 *   FATAL salvo ALLOW_WRITABLE_ROLE -- privilegios que la transacción READ
 *   ONLY sí bloquea genuinamente (grants de escritura, CREATE en un schema
 *   o base, CREATEDB, CREATEROLE). Se rechazan por defecto igual, porque la
 *   capa 1 no debería depender de la capa 3, pero es seguro anularlos
 *   deliberadamente.
 *
 * Los privilegios se consultan con has_*_privilege() en vez de leer
 * information_schema, porque esas funciones ya resuelven privilegios
 * heredados por membresía de rol y por PUBLIC.
 *
 * Puerto de mcpYt (safe-postgres-mcp/src/audit.ts). Los nombres/detalles de
 * los checks están traducidos al español (a diferencia del resto de los
 * archivos portados): son texto operador-facing, no algo que el modelo deba
 * interpretar en un formato fijo.
 */

import type { Db } from "./db.js";

/**
 * Único subconjunto de AppConfig que necesita la auditoría — se define acá
 * en vez de importar AppConfig completo para no atar audit.ts a mcp/'s
 * config shape entero (útil también para tests: ver tests/integration.test.ts).
 */
export interface AuditConfig {
  allowWritableRole: boolean;
  /** Ya no es una variable de entorno global multi-tenant: siempre null en producción. */
  schemaOverride: string | null;
}

export type Severity = "fatal" | "warning" | "info";

export interface AuditCheck {
  name: string;
  passed: boolean;
  severity: Severity;
  detail: string;
}

export interface AuditReport {
  role: string;
  database: string;
  serverVersion: string;
  /** Schemas no-sistema a los que el rol puede acceder, en orden alfabético. */
  schemas: string[];
  /**
   * Subconjunto de `schemas` donde el rol puede leer al menos una relación.
   * Es lo que desambigua el schema del tenant: en Supabase todo rol tiene
   * USAGE en `public` y `pgsodium` porque se le otorga a PUBLIC, pero no
   * puede leer nada en ellos.
   */
  readableSchemas: string[];
  checks: AuditCheck[];
}

export class AuditFailure extends Error {
  constructor(
    message: string,
    readonly failures: AuditCheck[],
    readonly report: AuditReport | null,
  ) {
    super(message);
    this.name = "AuditFailure";
  }
}

const ESCAPE_EXTENSIONS = [
  "dblink",
  "postgres_fdw",
  "file_fdw",
  "plpythonu",
  "plpython3u",
  "plperlu",
  "pltclu",
  "plr",
];

const PRIVILEGED_PREDEFINED_ROLES = [
  "pg_execute_server_program",
  "pg_write_server_files",
  "pg_read_server_files",
];

interface IdentityRow {
  role: string;
  database: string;
  server_version: string;
}

interface RoleAttributeRow {
  rolname: string;
  attributes: string[];
}

interface SchemaRow {
  nspname: string;
  can_create: boolean;
  is_readable: boolean;
}

interface WritableTableRow {
  nspname: string;
  relname: string;
  privileges: string[];
}

export async function runAudit(db: Db, config: AuditConfig): Promise<AuditReport> {
  const [identity] = await db.catalogQuery<IdentityRow>(
    `SELECT current_user AS role,
            current_database() AS database,
            current_setting('server_version') AS server_version`,
  );

  if (!identity) {
    throw new AuditFailure("La base no devolvió una identidad de sesión.", [], null);
  }

  const roleAttributes = await db.catalogQuery<RoleAttributeRow>(
    `SELECT r.rolname,
            array_remove(ARRAY[
              CASE WHEN r.rolsuper       THEN 'SUPERUSER'   END,
              CASE WHEN r.rolbypassrls   THEN 'BYPASSRLS'   END,
              CASE WHEN r.rolreplication THEN 'REPLICATION' END,
              CASE WHEN r.rolcreatedb    THEN 'CREATEDB'    END,
              CASE WHEN r.rolcreaterole  THEN 'CREATEROLE'  END
            ], NULL) AS attributes
       FROM pg_roles r
      WHERE pg_has_role(current_user, r.oid, 'MEMBER')
        AND (r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreatedb OR r.rolcreaterole)
      ORDER BY r.rolname`,
  );

  const predefinedRoles = await db.catalogQuery<{ rolname: string }>(
    `SELECT rolname
       FROM pg_roles
      WHERE rolname = ANY($1::text[])
        AND pg_has_role(current_user, oid, 'MEMBER')
      ORDER BY rolname`,
    [PRIVILEGED_PREDEFINED_ROLES],
  );

  const schemaRows = await db.catalogQuery<SchemaRow>(
    `SELECT n.nspname,
            has_schema_privilege(n.oid, 'CREATE') AS can_create,
            EXISTS (
              SELECT 1
                FROM pg_class c
               WHERE c.relnamespace = n.oid
                 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                 AND has_table_privilege(c.oid, 'SELECT')
            ) AS is_readable
       FROM pg_namespace n
      WHERE has_schema_privilege(n.oid, 'USAGE')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY n.nspname`,
  );

  const writableTables = await db.catalogQuery<WritableTableRow>(
    `SELECT n.nspname,
            c.relname,
            array_remove(ARRAY[
              CASE WHEN has_table_privilege(c.oid, 'INSERT')   THEN 'INSERT'   END,
              CASE WHEN has_table_privilege(c.oid, 'UPDATE')   THEN 'UPDATE'   END,
              CASE WHEN has_table_privilege(c.oid, 'DELETE')   THEN 'DELETE'   END,
              CASE WHEN has_table_privilege(c.oid, 'TRUNCATE') THEN 'TRUNCATE' END
            ], NULL) AS privileges
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
        AND has_schema_privilege(n.oid, 'USAGE')
        AND (has_table_privilege(c.oid, 'INSERT')
          OR has_table_privilege(c.oid, 'UPDATE')
          OR has_table_privilege(c.oid, 'DELETE')
          OR has_table_privilege(c.oid, 'TRUNCATE'))
      ORDER BY n.nspname, c.relname
      LIMIT 20`,
  );

  const reachableExtensions = await db.catalogQuery<{ extname: string }>(
    `SELECT DISTINCT e.extname
       FROM pg_extension e
       JOIN pg_depend d
         ON d.refobjid = e.oid
        AND d.refclassid = 'pg_extension'::regclass
        AND d.classid = 'pg_proc'::regclass
       JOIN pg_proc p ON p.oid = d.objid
      WHERE e.extname = ANY($1::text[])
        AND has_function_privilege(p.oid, 'EXECUTE')
      ORDER BY e.extname`,
    [ESCAPE_EXTENSIONS],
  );

  const untrustedLanguages = await db.catalogQuery<{ lanname: string }>(
    `SELECT lanname
       FROM pg_language
      WHERE NOT lanpltrusted
        AND lanname NOT IN ('internal', 'c')
        AND has_language_privilege(oid, 'USAGE')
      ORDER BY lanname`,
  );

  const overridable: Severity = config.allowWritableRole ? "warning" : "fatal";
  const checks: AuditCheck[] = [];

  const blockingAttributes = roleAttributes.flatMap((row) =>
    row.attributes
      .filter((attribute) => ["SUPERUSER", "BYPASSRLS", "REPLICATION"].includes(attribute))
      .map((attribute) => `${attribute} (vía ${row.rolname})`),
  );

  checks.push({
    name: "el rol no es superusuario y no puede saltear RLS ni replicar",
    passed: blockingAttributes.length === 0,
    severity: "fatal",
    detail:
      blockingAttributes.length === 0
        ? "El rol no tiene SUPERUSER, BYPASSRLS ni REPLICATION."
        : `El rol tiene ${blockingAttributes.join(", ")}. Esto anula la transacción de solo lectura: un superusuario puede correr COPY ... TO PROGRAM, y BYPASSRLS ignora el row-level security que separa a los tenants.`,
  });

  checks.push({
    name: "el rol no es miembro de un rol predefinido privilegiado",
    passed: predefinedRoles.length === 0,
    severity: "fatal",
    detail:
      predefinedRoles.length === 0
        ? "El rol no es miembro de pg_execute_server_program, pg_write_server_files ni pg_read_server_files."
        : `El rol es miembro de ${predefinedRoles.map((r) => r.rolname).join(", ")}, lo que permite leer o escribir archivos en el host de la base, o ejecutar programas.`,
  });

  const escapeVectors = [
    ...reachableExtensions.map((row) => `extensión ${row.extname}`),
    ...untrustedLanguages.map((row) => `lenguaje ${row.lanname}`),
  ];

  checks.push({
    name: "no hay forma de escapar de la transacción de solo lectura",
    passed: escapeVectors.length === 0,
    severity: "fatal",
    detail:
      escapeVectors.length === 0
        ? "Este rol no puede ejecutar dblink, foreign-data wrappers ni lenguajes procedurales no confiables."
        : `El rol puede acceder a ${escapeVectors.join(", ")}. Esto abre una conexión separada o corre código fuera de la transacción, así que un simple SELECT podría igual escribir.`,
  });

  const createAttributes = roleAttributes.flatMap((row) =>
    row.attributes
      .filter((attribute) => ["CREATEDB", "CREATEROLE"].includes(attribute))
      .map((attribute) => `${attribute} (vía ${row.rolname})`),
  );

  checks.push({
    name: "el rol no puede crear bases de datos ni roles",
    passed: createAttributes.length === 0,
    severity: overridable,
    detail:
      createAttributes.length === 0
        ? "El rol no tiene CREATEDB ni CREATEROLE."
        : `El rol tiene ${createAttributes.join(", ")}.`,
  });

  const creatableSchemas = schemaRows.filter((row) => row.can_create).map((row) => row.nspname);

  checks.push({
    name: "el rol no puede crear objetos en ningún schema",
    passed: creatableSchemas.length === 0,
    severity: overridable,
    detail:
      creatableSchemas.length === 0
        ? "El rol no tiene privilegio CREATE en ningún schema alcanzable."
        : `El rol puede hacer CREATE en: ${creatableSchemas.join(", ")}. En PostgreSQL 14 y anteriores esto se le otorga a PUBLIC en el schema public por defecto.`,
  });

  const writable = writableTables.map(
    (row) => `${row.nspname}.${row.relname} (${row.privileges.join("/")})`,
  );

  checks.push({
    name: "el rol no tiene privilegios de escritura en ninguna tabla",
    passed: writable.length === 0,
    severity: overridable,
    detail:
      writable.length === 0
        ? "El rol solo tiene privilegios de lectura en todas las tablas alcanzables."
        : `El rol puede escribir en ${writable.length === 20 ? "al menos " : ""}${writable.length} objeto(s): ${writable.join(", ")}.`,
  });

  const report: AuditReport = {
    role: identity.role,
    database: identity.database,
    serverVersion: identity.server_version,
    schemas: schemaRows.map((row) => row.nspname),
    readableSchemas: schemaRows.filter((row) => row.is_readable).map((row) => row.nspname),
    checks,
  };

  const failures = checks.filter((check) => !check.passed && check.severity === "fatal");
  if (failures.length > 0) {
    throw new AuditFailure(
      "El rol conectado no es seguro para un servidor MCP de solo lectura.",
      failures,
      report,
    );
  }

  return report;
}

/**
 * Determina el schema del tenant a partir de los privilegios reales del rol.
 * `schemaOverride` sólo elige entre schemas a los que el rol ya puede
 * acceder (y en producción siempre es `null` — ver AuditConfig).
 *
 * Tener USAGE no alcanza para desambiguar: en Supabase `public` y `pgsodium`
 * le otorgan USAGE a PUBLIC, así que todo rol los ve. Lo que distingue al
 * schema del tenant es poder LEER algo ahí (`readableSchemas`).
 */
export function resolveSchema(report: AuditReport, config: AuditConfig): string {
  if (report.schemas.length === 0) {
    throw new AuditFailure(
      `El rol "${report.role}" no tiene USAGE en ningún schema no-sistema, así que no hay nada para consultar. Otorgale USAGE en el schema del tenant.`,
      [],
      report,
    );
  }

  if (config.schemaOverride) {
    if (!report.schemas.includes(config.schemaOverride)) {
      throw new AuditFailure(
        `Se pidió el schema "${config.schemaOverride}", pero el rol "${report.role}" no puede acceder a él. Schemas alcanzables: ${report.schemas.join(", ")}.`,
        [],
        report,
      );
    }
    return config.schemaOverride;
  }

  // Un único schema alcanzable no necesita desambiguarse, incluso si todavía
  // está vacío: es el caso de un tenant recién creado, sin tablas aún.
  if (report.schemas.length === 1) {
    return report.schemas[0]!;
  }

  if (report.readableSchemas.length === 1) {
    return report.readableSchemas[0]!;
  }

  if (report.readableSchemas.length === 0) {
    throw new AuditFailure(
      `El rol "${report.role}" tiene USAGE en ${report.schemas.length} schemas (${report.schemas.join(", ")}) pero no puede leer ninguna tabla en ninguno, así que no hay schema de tenant que usar. Otorgale SELECT en las tablas de su schema.`,
      [],
      report,
    );
  }

  throw new AuditFailure(
    `El rol "${report.role}" puede leer en ${report.readableSchemas.length} schemas (${report.readableSchemas.join(", ")}), así que el schema del tenant es ambiguo. El rol debe poder leer en exactamente un schema no-sistema.`,
    [],
    report,
  );
}

/** Un fix listo para copiar y pegar para la falla de auditoría más común. */
export function remediationScript(schema: string): string {
  return [
    `CREATE ROLE mcp_reader LOGIN PASSWORD 'elegí-una-contraseña-fuerte';`,
    `GRANT USAGE ON SCHEMA ${schema} TO mcp_reader;`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO mcp_reader;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO mcp_reader;`,
    ``,
    `-- PostgreSQL 14 y anteriores también necesitan esto, ya que CREATE en public se le otorga a PUBLIC por defecto:`,
    `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
  ].join("\n");
}

/** Detalle completo de una falla de auditoría, para el 401 de Basic Auth (uso de operador/editor). */
export function formatAuditFailure(error: AuditFailure): string {
  const lines = [error.message];
  if (error.failures.length > 0) {
    lines.push("", "Chequeos que fallaron:");
    for (const failure of error.failures) {
      lines.push(`  - ${failure.name}: ${failure.detail}`);
    }
  }

  const schema = error.report?.schemas[0] ?? "tu_schema";
  const onlyOverridable = error.failures.every(
    (failure) =>
      failure.name.includes("privilegios de escritura") ||
      failure.name.includes("crear objetos") ||
      failure.name.includes("crear bases de datos"),
  );

  if (error.failures.length > 0 && onlyOverridable) {
    lines.push("", "Creá un rol de sólo lectura dedicado:", "", remediationScript(schema));
  } else if (error.failures.length > 0) {
    lines.push(
      "",
      "Estos chequeos no se pueden anular: los privilegios de arriba permiten que una consulta escape de la transacción read-only. Usá un rol dedicado y sin privilegios:",
      "",
      remediationScript(schema),
    );
  }

  return lines.join("\n");
}

/** Resumen de una línea, para mostrar en el formulario de login OAuth. */
export function summarizeAuditFailure(error: AuditFailure): string {
  const first = error.failures[0];
  return first ? `${error.message} (${first.name}: ${first.detail})` : error.message;
}
