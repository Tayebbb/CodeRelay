/**
 * Windows auto-start management. These are unit tests of the command
 * construction, parsing and guards — they never register, query or delete a
 * real Scheduled Task, because the suite must not mutate the developer's
 * machine. Registering the real task is a manual acceptance step.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  installArgv,
  installScriptPath,
  parseTaskFacts,
  powershellExe,
  queryArgv,
  STARTUP_TASK_NAME,
  startupSupported,
  uninstallArgv,
  uninstallScriptPath,
  validateBuilt,
} from '../src/startup/windows.js';
import { PROJECT_ROOT } from '../src/core/config.js';

describe('startup platform guard', () => {
  test('only Windows is supported', () => {
    assert.equal(startupSupported('win32'), true);
    assert.equal(startupSupported('linux'), false);
    assert.equal(startupSupported('darwin'), false);
  });
});

describe('startup task name consistency', () => {
  // The TypeScript constant and both PowerShell scripts must agree, or
  // install/status/remove would silently manage different tasks.
  test('matches the install script', () => {
    const script = fs.readFileSync(installScriptPath(PROJECT_ROOT), 'utf8');
    assert.ok(script.includes(`$taskName = '${STARTUP_TASK_NAME}'`));
  });

  test('matches the uninstall script', () => {
    const script = fs.readFileSync(uninstallScriptPath(PROJECT_ROOT), 'utf8');
    assert.ok(script.includes(`$taskName = '${STARTUP_TASK_NAME}'`));
  });

  test('install script accepts the -NodeExe parameter the CLI passes', () => {
    const script = fs.readFileSync(installScriptPath(PROJECT_ROOT), 'utf8');
    assert.match(script, /param\(/);
    assert.match(script, /\$NodeExe/);
  });
});

describe('startup command construction', () => {
  test('powershell path is absolute and inside System32', () => {
    const exe = powershellExe('C:\\Windows');
    assert.ok(path.isAbsolute(exe));
    assert.ok(exe.includes(path.join('System32', 'WindowsPowerShell')));
  });

  test('install argv is argv-array based with absolute script path and explicit node', () => {
    const argv = installArgv('C:\\nodejs\\node.exe', PROJECT_ROOT);
    assert.deepEqual(argv.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.ok(path.isAbsolute(argv[4]!), 'script path must be absolute');
    assert.ok(argv[4]!.endsWith('install-startup.ps1'));
    assert.equal(argv[5], '-NodeExe');
    assert.equal(argv[6], 'C:\\nodejs\\node.exe');
  });

  test('uninstall argv points at the uninstall script', () => {
    const argv = uninstallArgv(PROJECT_ROOT);
    assert.ok(argv[argv.length - 1]!.endsWith('uninstall-startup.ps1'));
  });

  test('query command embeds only the constant task name', () => {
    const argv = queryArgv();
    const command = argv[argv.length - 1]!;
    assert.ok(command.includes(`'${STARTUP_TASK_NAME}'`));
    assert.ok(command.includes('ConvertTo-Json'));
    // No template holes a caller could ever fill with untrusted text.
    assert.doesNotMatch(command, /\$\{|\bprocess\.|argv/);
  });
});

describe('startup install validation', () => {
  test('accepts a built repository', () => {
    // The suite itself runs from dist/, so the real repo is built.
    assert.equal(validateBuilt(PROJECT_ROOT), null);
  });

  test('refuses an unbuilt directory with an actionable message', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'coderelay-startup-'));
    try {
      const problem = validateBuilt(empty);
      assert.ok(problem);
      assert.match(problem!, /npm run build/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('scheduled task query parsing', () => {
  test('parses the facts JSON', () => {
    const facts = parseTaskFacts(
      JSON.stringify({
        state: 'Ready',
        restartCount: 999,
        restartInterval: 'PT1M',
        execute: 'C:\\nodejs\\node.exe',
        arguments: '--no-warnings=ExperimentalWarning "E:\\repo\\dist\\src\\main.js"',
        workingDirectory: 'E:\\repo',
      }),
    );
    assert.ok(facts);
    assert.equal(facts!.state, 'Ready');
    assert.equal(facts!.restartCount, 999);
    assert.equal(facts!.restartInterval, 'PT1M');
    assert.equal(facts!.workingDirectory, 'E:\\repo');
  });

  test('returns null on garbage rather than throwing', () => {
    assert.equal(parseTaskFacts('ERROR: something in Norwegian'), null);
    assert.equal(parseTaskFacts(''), null);
  });
});

describe('startup module makes no AI calls', () => {
  test('never imports the provider or executor layers', () => {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'startup', 'windows.ts'), 'utf8');
    assert.doesNotMatch(source, /providers|executor|runCopilot/);
  });
});
