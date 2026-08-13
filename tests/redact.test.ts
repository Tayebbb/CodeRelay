import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveFile, redact, registerSecret, clearRegisteredSecrets } from '../src/core/redact.js';

describe('secret redaction', () => {
  test('removes registered literal secrets', () => {
    clearRegisteredSecrets();
    registerSecret('1234567890:AAHsuperSecretBotTokenValue');
    const out = redact('token is 1234567890:AAHsuperSecretBotTokenValue ok');
    assert.ok(!out.includes('AAHsuperSecretBotTokenValue'));
    clearRegisteredSecrets();
  });

  test('ignores short values so common words are not mangled', () => {
    clearRegisteredSecrets();
    registerSecret('abc');
    assert.equal(redact('abc def'), 'abc def');
    clearRegisteredSecrets();
  });

  test('redacts GitHub tokens', () => {
    const out = redact('use ghp_abcdefghijklmnopqrstuvwxyz0123456789 now');
    assert.ok(out.includes('[REDACTED_GITHUB_TOKEN]'));
    assert.ok(!out.includes('ghp_abcdefghij'));
  });

  test('redacts fine-grained PATs', () => {
    const out = redact('github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz012345');
    assert.ok(out.includes('[REDACTED_GITHUB_TOKEN]'));
  });

  test('redacts dotenv-style assignments', () => {
    const out = redact('DATABASE_PASSWORD=hunter2\nAPI_KEY: "abc123xyz"');
    assert.ok(!out.includes('hunter2'));
    assert.ok(!out.includes('abc123xyz'));
  });

  test('redacts credentials embedded in connection strings', () => {
    const out = redact('postgres://admin:s3cr3tpw@db.local:5432/app');
    assert.ok(!out.includes('s3cr3tpw'));
    assert.ok(out.includes('admin:[REDACTED]@'));
  });

  test('redacts private key blocks', () => {
    const out = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----');
    assert.equal(out, '[REDACTED_PRIVATE_KEY]');
  });

  test('redacts JWTs', () => {
    const out = redact('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N');
    assert.ok(out.includes('[REDACTED_JWT]'));
  });

  test('leaves ordinary text untouched', () => {
    const text = 'Fixed the login bug in auth.service.ts and added a regression test.';
    assert.equal(redact(text), text);
  });
});

describe('sensitive file detection', () => {
  test('flags env and credential files', () => {
    for (const file of ['.env', 'config/.env.production', 'id_rsa', 'certs/server.pem', '.npmrc', 'secrets.yaml']) {
      assert.equal(isSensitiveFile(file), true, file);
    }
  });

  test('does not flag normal source files', () => {
    for (const file of ['src/auth.service.ts', 'README.md', 'env.ts', 'package.json']) {
      assert.equal(isSensitiveFile(file), false, file);
    }
  });
});
