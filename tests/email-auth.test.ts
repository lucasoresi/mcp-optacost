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
