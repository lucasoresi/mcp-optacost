/** Rendering of result sets into compact markdown that a model can read cheaply. */

const DEFAULT_MAX_CELL_CHARS = 300;

export function renderValue(value: unknown, maxChars = DEFAULT_MAX_CELL_CHARS): string {
  if (value === null || value === undefined) return 'NULL';

  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (Buffer.isBuffer(value)) {
    text = `\\x${value.toString('hex')}`;
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  // Newlines and pipes would break the table layout.
  text = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}… (${text.length} chars)`;
  }
  return text;
}

export function renderTable(
  columns: string[],
  rows: unknown[][],
  maxChars = DEFAULT_MAX_CELL_CHARS,
): string {
  if (columns.length === 0) return '(statement returned no columns)';
  if (rows.length === 0) return `(0 rows)\n\nColumns: ${columns.join(', ')}`;

  const header = `| ${columns.map((c) => renderValue(c, maxChars)).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => renderValue(cell, maxChars)).join(' | ')} |`);

  return [header, divider, ...body].join('\n');
}

/** Renders an array of row objects, preserving the given column order. */
export function renderRecords(
  columns: string[],
  records: Array<Record<string, unknown>>,
  maxChars = DEFAULT_MAX_CELL_CHARS,
): string {
  return renderTable(
    columns,
    records.map((record) => columns.map((column) => record[column])),
    maxChars,
  );
}
