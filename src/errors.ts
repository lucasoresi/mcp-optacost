/**
 * Error handling with one hard rule: credentials never reach the caller.
 *
 * The pg driver attaches connection details to several kinds of error, and MCP
 * tool results are shown to the model and often logged, so every message that
 * leaves this process passes through redact().
 */

const secrets = new Set<string>();

/** Registers a value that must never appear in output. Short values are ignored. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 4) secrets.add(value);
}

const CREDENTIALS_IN_URL = /(postgres(?:ql)?:\/\/[^\s:/@]+:)[^@\s]+(@)/gi;

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join('***');
  }
  return out.replace(CREDENTIALS_IN_URL, '$1***$2');
}

/** Guidance keyed by SQLSTATE, translated into something the caller can act on. */
const SQLSTATE_GUIDANCE: Record<string, string> = {
  '25006':
    'Blocked by the read-only transaction: this server cannot modify data under any circumstances.',
  '42501': 'The connected role does not have permission on that object.',
  '42P01': 'That table or view does not exist here. Use list_tables to see what is available.',
  '42703': 'That column does not exist. Use describe_table to see the available columns.',
  '42601': 'The query has a syntax error.',
  '3F000': 'That schema does not exist or is not visible to this role.',
  '57014':
    'The query exceeded the statement timeout. Use explain_query to inspect the plan, add a WHERE clause, or reduce the number of rows scanned.',
  '53300': 'The database refused the connection because it has too many clients.',
  '08006': 'The connection to the database failed.',
  '28P01': 'Authentication failed for the configured role.',
};

interface PgLikeError {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
}

function isPgLikeError(error: unknown): error is PgLikeError {
  return typeof error === 'object' && error !== null && 'message' in error;
}

/**
 * Turns any thrown value into a single redacted, actionable message.
 */
export function describeError(error: unknown): string {
  if (!isPgLikeError(error)) return redact(String(error));

  const parts: string[] = [];
  const base = error.message ?? 'Unknown database error';
  // pg reuses `code` for syscall errnos (ECONNREFUSED, ETIMEDOUT) as well as for
  // SQLSTATEs, which are always five alphanumeric characters.
  const isSqlState = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code);
  parts.push(isSqlState ? `${base} (SQLSTATE ${error.code})` : base);

  if (error.detail) parts.push(error.detail);
  if (error.hint) parts.push(`Hint: ${error.hint}`);

  const guidance = error.code ? SQLSTATE_GUIDANCE[error.code] : undefined;
  if (guidance) parts.push(guidance);

  return redact(parts.join('\n'));
}
