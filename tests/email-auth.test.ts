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
