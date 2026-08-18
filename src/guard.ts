/**
 * Layer 2 of the safety model: a lexical guard over raw SQL.
 *
 * This is deliberately a pure function with no database access, so it can be
 * exhaustively unit-tested. It is *not* the authority on what is read-only --
 * that is the READ ONLY transaction in db.ts. This layer exists to reject the
 * obvious cases early, with a clear message, and to make multi-statement
 * smuggling impossible before the query ever reaches the server.
 */

export type GuardRule =
  | 'empty'
  | 'unterminated-literal'
  | 'multiple-statements'
  | 'forbidden-statement'
  | 'data-modifying-cte'
  | 'explain-analyze'
  | 'runtime-parameter-change';

export type GuardResult =
  | { ok: true; statement: string }
  | { ok: false; rule: GuardRule; reason: string };

/** Leading keywords that cannot, on their own, modify data. */
const ALLOWED_LEADING_KEYWORDS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'TABLE', 'VALUES', 'SHOW']);

const DATA_MODIFYING = /\b(insert|update|delete|merge)\b/i;
const ANALYZE = /\banalyze\b/i;
const FIRST_WORD = /[A-Za-z_][A-Za-z0-9_]*/;

/**
 * `set_config()` reaches the same code path as the SET command, but it is an
 * ordinary function, so the leading-keyword check above never sees it: it rides
 * inside any permitted SELECT/WITH.
 *
 * That matters most for `role`. Postgres checks role membership against
 * `session_user`, not against whoever `SET LOCAL ROLE` made current -- and for
 * OAuth sessions `session_user` is the shared bootstrap role, which by design is
 * a member of every tenant. So one `set_config('role', ...)` buried in an
 * otherwise innocent query would step out of the tenant this session is anchored
 * to and read another tenant's schema.
 *
 * The call is rejected outright rather than inspected: the first argument can be
 * any expression (even a subquery), so deciding *which* parameter it targets is
 * not something a lexer can do reliably. No read-only query needs this function.
 * The trailing `\(` keeps a column that merely happens to be named `set_config`
 * from being caught.
 */
const RUNTIME_PARAMETER_CHANGE = /\bset_config\s*\(/i;

interface MaskResult {
  /** Same length as the input, with comment and literal bytes replaced by spaces. */
  masked: string;
  /**
   * Same as `masked`, except quoted identifiers keep their contents (only the
   * quotes themselves are blanked). Needed to catch `"set_config"(...)`, which
   * Postgres resolves to the same function but which `masked` blanks away.
   * Statement splitting deliberately does NOT use this, so a semicolon inside a
   * quoted identifier still cannot fake a statement boundary.
   */
  maskedWithIdentifiers: string;
  /** Description of the unclosed construct, or null when the input is well-formed. */
  unterminated: string | null;
}

/**
 * Blanks out comments and literals so that delimiters hidden inside them cannot
 * be mistaken for syntax. Offsets are preserved, so positions in the masked
 * string map back to the original.
 *
 * Handles the Postgres-specific cases that trip up naive splitting: nested block
 * comments, doubled-quote escapes, E'' strings with backslash escapes, and
 * dollar quoting with or without a tag.
 */
function maskLiteralsAndComments(sql: string): MaskResult {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) out[k] = ' ';
  };

  /** Spans of quoted identifiers, including their surrounding quotes. */
  const identifierSpans: Array<{ start: number; end: number }> = [];
  const bail = (unterminated: string): MaskResult => {
    const masked = out.join('');
    return { masked, maskedWithIdentifiers: masked, unterminated };
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      blank(i, end);
      i = end;
      continue;
    }

    if (c === '/' && next === '*') {
      // Postgres block comments nest, unlike C.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) return bail('block comment');
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return bail('dollar-quoted string');
        blank(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }

    if (c === "'") {
      // E'...' strings honour backslash escapes; ordinary strings do not.
      const prev = sql[i - 1];
      const beforePrev = sql[i - 2];
      const isEscapeString =
        (prev === 'E' || prev === 'e') && (i < 2 || !/[A-Za-z0-9_$]/.test(beforePrev ?? ''));

      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (isEscapeString && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) return bail('string literal');
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) return bail('quoted identifier');
      identifierSpans.push({ start: i, end: j });
      blank(i, j);
      i = j;
      continue;
    }

    i++;
  }

  const withIdentifiers = out.slice();
  for (const span of identifierSpans) {
    for (let k = span.start + 1; k < span.end - 1; k++) withIdentifiers[k] = sql[k]!;
  }

  return {
    masked: out.join(''),
    maskedWithIdentifiers: withIdentifiers.join(''),
    unterminated: null,
  };
}

/** Splits on semicolons that sit outside any literal or comment. */
function splitStatements(masked: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let k = 0; k < masked.length; k++) {
    if (masked[k] === ';') {
      spans.push({ start, end: k });
      start = k + 1;
    }
  }
  spans.push({ start, end: masked.length });
  return spans.filter((span) => masked.slice(span.start, span.end).trim() !== '');
}

export function inspectSql(sql: string): GuardResult {
  const { masked, maskedWithIdentifiers, unterminated } = maskLiteralsAndComments(sql);

  if (unterminated) {
    return {
      ok: false,
      rule: 'unterminated-literal',
      reason: `The query contains an unterminated ${unterminated}. Close it and try again.`,
    };
  }

  const spans = splitStatements(masked);

  if (spans.length === 0) {
    return { ok: false, rule: 'empty', reason: 'The query is empty.' };
  }

  if (spans.length > 1) {
    return {
      ok: false,
      rule: 'multiple-statements',
      reason: `Only one statement is allowed per call, but ${spans.length} were found. Send them as separate queries.`,
    };
  }

  const span = spans[0]!;
  const maskedStatement = masked.slice(span.start, span.end);
  const statement = sql.slice(span.start, span.end).trim();

  const firstWord = FIRST_WORD.exec(maskedStatement)?.[0]?.toUpperCase();

  if (!firstWord || !ALLOWED_LEADING_KEYWORDS.has(firstWord)) {
    return {
      ok: false,
      rule: 'forbidden-statement',
      reason: `This server is read-only, so ${firstWord ?? 'this statement'} is not allowed. Queries must begin with ${[...ALLOWED_LEADING_KEYWORDS].join(', ')}.`,
    };
  }

  if (RUNTIME_PARAMETER_CHANGE.test(maskedWithIdentifiers.slice(span.start, span.end))) {
    return {
      ok: false,
      rule: 'runtime-parameter-change',
      reason:
        'set_config() changes a runtime parameter for the rest of the transaction, including the role this session is restricted to, so it is not allowed here.',
    };
  }

  if (firstWord === 'EXPLAIN' && ANALYZE.test(maskedStatement)) {
    return {
      ok: false,
      rule: 'explain-analyze',
      reason: 'EXPLAIN ANALYZE actually executes the statement. Use plain EXPLAIN to see the plan.',
    };
  }

  if (firstWord === 'WITH' && DATA_MODIFYING.test(maskedStatement)) {
    return {
      ok: false,
      rule: 'data-modifying-cte',
      reason: 'This CTE contains a data-modifying statement, which is not allowed on a read-only server.',
    };
  }

  return { ok: true, statement };
}
