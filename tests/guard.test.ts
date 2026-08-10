import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inspectSql } from '../src/guard.js';

function assertAccepted(sql: string) {
  const result = inspectSql(sql);
  assert.equal(result.ok, true, `expected accepted, got: ${JSON.stringify(result)}`);
}

function assertRejected(sql: string, rule: string) {
  const result = inspectSql(sql);
  assert.equal(result.ok, false, `expected rejected, but it was accepted: ${sql}`);
  assert.equal(result.ok === false && result.rule, rule);
}

// --- accepted shapes -------------------------------------------------------

test('accepts a plain SELECT', () => {
  assertAccepted('SELECT id, name FROM clientes');
});

test('accepts lowercase keywords', () => {
  assertAccepted('select 1');
});

test('accepts a read-only CTE', () => {
  assertAccepted('WITH recientes AS (SELECT * FROM pedidos) SELECT count(*) FROM recientes');
});

test('accepts EXPLAIN without ANALYZE', () => {
  assertAccepted('EXPLAIN SELECT * FROM pedidos');
});

test('accepts EXPLAIN with a parenthesised option list', () => {
  assertAccepted('EXPLAIN (FORMAT JSON, VERBOSE) SELECT * FROM pedidos');
});

test('accepts TABLE and VALUES statements', () => {
  assertAccepted('TABLE clientes');
  assertAccepted('VALUES (1), (2)');
});

test('accepts leading line comments', () => {
  assertAccepted('-- traer todo\nSELECT * FROM clientes');
});

test('accepts leading block comments', () => {
  assertAccepted('/* informe mensual */ SELECT * FROM clientes');
});

test('accepts a single trailing semicolon', () => {
  assertAccepted('SELECT 1;');
});

test('accepts a trailing semicolon followed by whitespace and a comment', () => {
  assertAccepted('SELECT 1;  -- listo\n');
});

// --- delimiters hidden inside literals must not be mistaken for statements --

test('accepts a semicolon inside a single-quoted string', () => {
  assertAccepted("SELECT * FROM logs WHERE msg = 'a;b'");
});

test('accepts a semicolon inside an escaped single quote', () => {
  assertAccepted("SELECT 'it''s; fine' AS texto");
});

test('accepts a semicolon inside an E-string with a backslash escape', () => {
  assertAccepted("SELECT E'a\\';b' AS texto");
});

test('accepts a semicolon inside a dollar-quoted string', () => {
  assertAccepted('SELECT $$a;b$$ AS texto');
});

test('accepts a semicolon inside a tagged dollar-quoted string', () => {
  assertAccepted('SELECT $tag$a;b$tag$ AS texto');
});

test('accepts a semicolon inside a quoted identifier', () => {
  assertAccepted('SELECT 1 AS "col;raro"');
});

test('accepts a semicolon inside a line comment', () => {
  assertAccepted('SELECT 1 -- no soy ; un separador\n');
});

test('accepts a semicolon inside a block comment', () => {
  assertAccepted('SELECT /* ; */ 1');
});

// --- multiple statements ---------------------------------------------------

test('rejects two statements separated by a semicolon', () => {
  assertRejected('SELECT 1; SELECT 2', 'multiple-statements');
});

test('rejects a destructive statement smuggled after a SELECT', () => {
  assertRejected('SELECT 1; DROP TABLE clientes', 'multiple-statements');
});

test('rejects a second statement hidden after a line comment', () => {
  assertRejected('SELECT 1; -- inocente\nDELETE FROM clientes', 'multiple-statements');
});

test('rejects a second statement when the first ends inside no literal', () => {
  assertRejected("SELECT 'a;b'; UPDATE clientes SET name = 'x'", 'multiple-statements');
});

// --- forbidden leading keywords --------------------------------------------

test('rejects INSERT', () => {
  assertRejected("INSERT INTO clientes (name) VALUES ('x')", 'forbidden-statement');
});

test('rejects UPDATE', () => {
  assertRejected("UPDATE clientes SET name = 'x'", 'forbidden-statement');
});

test('rejects DELETE', () => {
  assertRejected('DELETE FROM clientes', 'forbidden-statement');
});

test('rejects DROP', () => {
  assertRejected('DROP TABLE clientes', 'forbidden-statement');
});

test('rejects TRUNCATE', () => {
  assertRejected('TRUNCATE clientes', 'forbidden-statement');
});

test('rejects CREATE', () => {
  assertRejected('CREATE TABLE t (id int)', 'forbidden-statement');
});

test('rejects GRANT', () => {
  assertRejected('GRANT SELECT ON clientes TO someone', 'forbidden-statement');
});

test('rejects COPY', () => {
  assertRejected("COPY (SELECT 1) TO PROGRAM 'sh -c whoami'", 'forbidden-statement');
});

test('rejects DO blocks', () => {
  assertRejected('DO $$ BEGIN PERFORM 1; END $$', 'forbidden-statement');
});

test('rejects SET, which could change role or transaction mode', () => {
  assertRejected('SET ROLE postgres', 'forbidden-statement');
});

test('rejects mixed-case destructive keywords', () => {
  assertRejected('InSeRt INTO clientes DEFAULT VALUES', 'forbidden-statement');
});

test('rejects a destructive statement hidden behind a leading comment', () => {
  assertRejected('-- solo mirando\nDROP TABLE clientes', 'forbidden-statement');
});

// --- data-modifying CTEs ---------------------------------------------------

test('rejects a CTE containing INSERT ... RETURNING', () => {
  assertRejected(
    "WITH nuevo AS (INSERT INTO clientes (name) VALUES ('x') RETURNING id) SELECT * FROM nuevo",
    'data-modifying-cte',
  );
});

test('rejects a CTE containing DELETE ... RETURNING', () => {
  assertRejected(
    'WITH borrados AS (DELETE FROM clientes RETURNING id) SELECT * FROM borrados',
    'data-modifying-cte',
  );
});

test('rejects a CTE containing UPDATE ... RETURNING', () => {
  assertRejected(
    "WITH tocados AS (UPDATE clientes SET name = 'x' RETURNING id) SELECT * FROM tocados",
    'data-modifying-cte',
  );
});

test('does not mistake the word update inside a string for a modifying CTE', () => {
  assertAccepted("WITH t AS (SELECT 'insert into' AS accion) SELECT * FROM t");
});

test('does not mistake a column named update_at for a modifying CTE', () => {
  assertAccepted('WITH t AS (SELECT updated_at FROM pedidos) SELECT * FROM t');
});

// --- EXPLAIN ANALYZE -------------------------------------------------------

test('rejects EXPLAIN ANALYZE, which executes the statement', () => {
  assertRejected('EXPLAIN ANALYZE SELECT * FROM pedidos', 'explain-analyze');
});

test('rejects EXPLAIN ANALYZE inside a parenthesised option list', () => {
  assertRejected('EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM pedidos', 'explain-analyze');
});

// --- empty input -----------------------------------------------------------

test('rejects empty input', () => {
  assertRejected('', 'empty');
});

test('rejects whitespace-only input', () => {
  assertRejected('   \n\t ', 'empty');
});

test('rejects comment-only input', () => {
  assertRejected('-- nada aqui\n', 'empty');
});

// --- unterminated literals -------------------------------------------------

test('rejects an unterminated string literal', () => {
  assertRejected("SELECT 'abierto", 'unterminated-literal');
});

test('rejects an unterminated block comment', () => {
  assertRejected('SELECT 1 /* abierto', 'unterminated-literal');
});

test('rejects an unterminated dollar-quoted string', () => {
  assertRejected('SELECT $$abierto', 'unterminated-literal');
});
