import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeEmail, EmailLoginError, emailLoginErrorMessage } from '../src/email-auth.js';

test('looksLikeEmail detecta @', () => {
  assert.equal(looksLikeEmail('a@b.com'), true);
  assert.equal(looksLikeEmail('nanni.nfjjlfovpznoipgkugdf'), false);
  assert.equal(looksLikeEmail(''), false);
});

test('emailLoginErrorMessage: mensaje específico solo para no_tenant_role', () => {
  assert.equal(emailLoginErrorMessage('no_tenant_role'), 'Tu organización todavía no tiene acceso al MCP.');
  assert.equal(emailLoginErrorMessage('no_user'), 'Usuario o contraseña incorrectos.');
  assert.equal(emailLoginErrorMessage('inactive'), 'Usuario o contraseña incorrectos.');
});

test('EmailLoginError guarda el reason', () => {
  const e = new EmailLoginError('no_tenant_role');
  assert.equal(e.reason, 'no_tenant_role');
  assert.equal(e.name, 'EmailLoginError');
});

import { verifyPassword } from '../src/email-auth.js';

function fakeFetch(status: number): typeof fetch {
  return (async () => ({ status } as Response)) as unknown as typeof fetch;
}

const creds = { supabaseUrl: 'https://p.supabase.co', anonKey: 'anon', email: 'a@b.com', password: 'x' };

test('verifyPassword: 200 => true', async () => {
  assert.equal(await verifyPassword({ ...creds, fetchImpl: fakeFetch(200) }), true);
});

test('verifyPassword: 400 => false', async () => {
  assert.equal(await verifyPassword({ ...creds, fetchImpl: fakeFetch(400) }), false);
});

test('verifyPassword: 401 => false', async () => {
  assert.equal(await verifyPassword({ ...creds, fetchImpl: fakeFetch(401) }), false);
});

test('verifyPassword: 500 => lanza', async () => {
  await assert.rejects(verifyPassword({ ...creds, fetchImpl: fakeFetch(500) }));
});

test('verifyPassword: error de red => lanza', async () => {
  const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  await assert.rejects(verifyPassword({ ...creds, fetchImpl: boom }));
});

import { tenantRoleFromRows, resolveTenantRole, TENANT_LOOKUP_SQL } from '../src/email-auth.js';
import type { TenantLookupRow } from '../src/email-auth.js';

const okRow: TenantLookupRow = {
  subdomain: 'iaca', user_status: 'active', client_status: 'active',
  deleted_at: null, role_exists: true,
};

test('tenantRoleFromRows: fila válida => subdomain', () => {
  assert.equal(tenantRoleFromRows([okRow]), 'iaca');
});

test('tenantRoleFromRows: sin filas => no_user', () => {
  assert.throws(() => tenantRoleFromRows([]), (e) => e instanceof EmailLoginError && e.reason === 'no_user');
});

test('tenantRoleFromRows: usuario inactivo => inactive', () => {
  assert.throws(() => tenantRoleFromRows([{ ...okRow, user_status: 'disabled' }]),
    (e) => e instanceof EmailLoginError && e.reason === 'inactive');
});

test('tenantRoleFromRows: cliente borrado => inactive', () => {
  assert.throws(() => tenantRoleFromRows([{ ...okRow, deleted_at: '2020-01-01' }]),
    (e) => e instanceof EmailLoginError && e.reason === 'inactive');
});

test('tenantRoleFromRows: sin rol de Postgres => no_tenant_role', () => {
  assert.throws(() => tenantRoleFromRows([{ ...okRow, role_exists: false }]),
    (e) => e instanceof EmailLoginError && e.reason === 'no_tenant_role');
});

test('tenantRoleFromRows: cliente suspendido => inactive', () => {
  assert.throws(() => tenantRoleFromRows([{ ...okRow, client_status: 'suspended' }]),
    (e) => e instanceof EmailLoginError && e.reason === 'inactive');
});

test('tenantRoleFromRows: más de una fila => ambiguous (falla cerrado)', () => {
  assert.throws(() => tenantRoleFromRows([okRow, okRow]),
    (e) => e instanceof EmailLoginError && e.reason === 'ambiguous');
});

test('tenantRoleFromRows: dos filas con distinto subdomain => ambiguous', () => {
  assert.throws(
    () => tenantRoleFromRows([okRow, { ...okRow, subdomain: 'otro' }]),
    (e) => e instanceof EmailLoginError && e.reason === 'ambiguous',
  );
});

test('emailLoginErrorMessage: ambiguous no filtra la ambigüedad', () => {
  assert.equal(emailLoginErrorMessage('ambiguous'), 'Usuario o contraseña incorrectos.');
});

test('resolveTenantRole: pasa el email al runner y devuelve el rol', async () => {
  let seen: unknown[] = [];
  const runner = async (_sql: string, params: unknown[]) => { seen = params; return [okRow]; };
  const role = await resolveTenantRole('A@B.com', runner);
  assert.equal(role, 'iaca');
  assert.deepEqual(seen, ['A@B.com']);
});

test('TENANT_LOOKUP_SQL usa lower() y tablas public calificadas', () => {
  assert.match(TENANT_LOOKUP_SQL, /lower\(u\.email\)/i);
  assert.match(TENANT_LOOKUP_SQL, /public\.users/i);
  assert.match(TENANT_LOOKUP_SQL, /public\.clients/i);
  assert.match(TENANT_LOOKUP_SQL, /pg_roles/i);
});
