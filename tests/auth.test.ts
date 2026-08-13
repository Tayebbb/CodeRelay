import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, UnauthorizedThrottle } from '../src/telegram/auth.js';

describe('telegram authorization', () => {
  test('accepts the configured operator', () => {
    assert.deepEqual(authorize(4242, [4242]), { allowed: true, reason: 'ok' });
  });

  test('rejects any other user', () => {
    assert.equal(authorize(9999, [4242]).allowed, false);
    assert.equal(authorize(9999, [4242]).reason, 'not-authorized');
  });

  test('rejects updates with no user', () => {
    assert.equal(authorize(undefined, [4242]).allowed, false);
    assert.equal(authorize(undefined, [4242]).reason, 'no-user');
  });

  test('an empty allow-list means nobody, never everybody', () => {
    assert.equal(authorize(4242, []).allowed, false);
    assert.equal(authorize(0, []).allowed, false);
  });

  test('supports multiple operators when explicitly configured', () => {
    assert.equal(authorize(7, [1, 7, 9]).allowed, true);
    assert.equal(authorize(8, [1, 7, 9]).allowed, false);
  });
});

describe('unauthorized throttle', () => {
  test('responds once per stranger per window', () => {
    const throttle = new UnauthorizedThrottle(60_000);
    assert.equal(throttle.shouldRespond(1), true);
    assert.equal(throttle.shouldRespond(1), false);
    assert.equal(throttle.shouldRespond(2), true);
  });
});
