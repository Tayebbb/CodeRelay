import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectRegistry, ProjectRegistryError, isInside } from '../src/projects/registry.js';

// GitHub's Windows runners return an 8.3 short path from os.tmpdir()
// (C:\Users\RUNNER~1\...), which the registry rightly refuses. Canonicalise once
// so tests use the long-form paths a real operator would register.
const TMP_ROOT = fs.realpathSync.native(os.tmpdir());

function tempProject(name: string): string {
  const dir = path.join(TMP_ROOT, `rpca-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('path containment', () => {
  test('detects paths inside a root', () => {
    assert.equal(isInside('/a/b', '/a/b/c'), true);
    assert.equal(isInside('/a/b', '/a/b'), true);
  });

  test('rejects traversal and siblings', () => {
    assert.equal(isInside('/a/b', '/a/c'), false);
    assert.equal(isInside('/a/b', '/a/b/../../etc/passwd'), false);
    assert.equal(isInside('/a/b', '/a'), false);
  });
});

describe('project registry', () => {
  test('refuses sensitive locations', () => {
    const registry = new ProjectRegistry(':memory:');
    const sensitive = [
      path.join(os.homedir(), '.ssh'),
      path.join(os.homedir(), '.copilot'),
      process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/ssl',
    ];
    for (const target of sensitive) {
      assert.throws(
        () => registry.add({ id: 'x', name: 'x', path: target }),
        ProjectRegistryError,
        `should reject ${target}`,
      );
    }
  });

  test('refuses the home directory and filesystem roots', () => {
    const registry = new ProjectRegistry(':memory:');
    assert.throws(() => registry.add({ id: 'h', name: 'h', path: os.homedir() }), ProjectRegistryError);
    assert.throws(
      () => registry.add({ id: 'r', name: 'r', path: process.platform === 'win32' ? 'C:\\' : '/' }),
      ProjectRegistryError,
    );
  });

  test('resolves by index, id, name and unambiguous prefix', () => {
    const a = tempProject('alpha');
    const b = tempProject('beta');
    const registry = ProjectRegistry.fromRecords([
      { id: 'medilink', name: 'MediLink', path: a },
      { id: 'austhir', name: 'AUSThir', path: b },
    ]);

    assert.equal((registry.resolve('1') as { project: { id: string } }).project.id, 'medilink');
    assert.equal((registry.resolve('austhir') as { project: { id: string } }).project.id, 'austhir');
    assert.equal((registry.resolve('MediLink') as { project: { id: string } }).project.id, 'medilink');
    assert.equal((registry.resolve('medi') as { project: { id: string } }).project.id, 'medilink');
    assert.equal(registry.resolve('nothing-here'), null);
    assert.equal(registry.resolve('99'), null);

    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  test('reports ambiguity instead of guessing', () => {
    const a = tempProject('api1');
    const b = tempProject('api2');
    const registry = ProjectRegistry.fromRecords([
      { id: 'shop-api', name: 'shop-api', path: a },
      { id: 'blog-api', name: 'blog-api', path: b },
    ]);
    const resolved = registry.resolve('api');
    assert.ok(resolved && 'ambiguous' in resolved);
    assert.equal((resolved as { ambiguous: unknown[] }).ambiguous.length, 2);

    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  test('never resolves a raw filesystem path from chat input', () => {
    const dir = tempProject('secret');
    const registry = ProjectRegistry.fromRecords([{ id: 'ok', name: 'ok', path: dir }]);

    for (const attempt of [dir, 'C:\\Windows\\System32', '/etc/passwd', '../../..', './']) {
      const resolved = registry.resolve(attempt);
      assert.ok(
        resolved === null || ('project' in resolved && resolved.project.id === 'ok'),
        `path-like selector must not escape the registry: ${attempt}`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('assertWithinProject blocks traversal outside the project root', () => {
    const dir = tempProject('bounded');
    const registry = ProjectRegistry.fromRecords([{ id: 'bounded', name: 'bounded', path: dir }]);

    assert.equal(registry.assertWithinProject('bounded', path.join(dir, 'src', 'a.ts')), path.join(dir, 'src', 'a.ts'));
    assert.throws(
      () => registry.assertWithinProject('bounded', path.join(dir, '..', 'elsewhere', 'x.ts')),
      ProjectRegistryError,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
