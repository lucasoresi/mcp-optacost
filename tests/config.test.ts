import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally { process.env = prev; }
}

const base = { PUBLIC_URL: 'https://x.test', PGHOST: 'h', PGDATABASE: 'd' };

test('supabase vars ausentes => null', () => {
  withEnv({ ...base, SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.supabaseUrl, null);
    assert.equal(cfg.supabaseAnonKey, null);
  });
});

test('supabase vars presentes => se leen y se recorta la barra final', () => {
  withEnv({ ...base, SUPABASE_URL: 'https://proj.supabase.co/', SUPABASE_ANON_KEY: 'anon123' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.supabaseUrl, 'https://proj.supabase.co');
    assert.equal(cfg.supabaseAnonKey, 'anon123');
  });
});
