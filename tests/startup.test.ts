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
import { formatHeartbeat, msUntilNextLocalHour } from '../src/notify/heartbeat.js';
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

  // "PC on" usually means "resumed from sleep", which fires no logon event.
  // Without the watchdog tick, an agent killed mid-session stayed dead for
  // days until the next real sign-in (observed 2026-08-18 → 19).
  test('install script registers both the logon trigger and the watchdog tick', () => {
    const script = fs.readFileSync(installScriptPath(PROJECT_ROOT), 'utf8');
    assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
    assert.match(script, /-RepetitionInterval/);
    // Indefinite repetition: [TimeSpan]::MaxValue is rejected by
    // Register-ScheduledTask, so the duration must be cleared instead.
    assert.match(script, /Repetition\.Duration = \$null/);
    assert.doesNotMatch(script, /\[TimeSpan\]::MaxValue.*RepetitionDuration|RepetitionDuration.*\[TimeSpan\]::MaxValue/);
    // Both triggers must actually be registered.
    assert.match(script, /-Trigger\s+@\(\$logonTrigger, \$tickTrigger\)/);
    // The tick is only safe alongside IgnoreNew (no duplicate instances) and
    // StartWhenAvailable (a tick missed during sleep runs on wake).
    assert.match(script, /-MultipleInstances IgnoreNew/);
    assert.match(script, /-StartWhenAvailable/);
  });

  // A visible console window is load-bearing by accident: closing it sends
  // CTRL_CLOSE to the whole console and kills supervisor + agent in one click
  // (observed 2026-08-18). The action must stay behind the hidden launcher.
  test('install script launches the agent with no visible console window', () => {
    const script = fs.readFileSync(installScriptPath(PROJECT_ROOT), 'utf8');
    assert.match(script, /start-agent-hidden\.ps1/);
    assert.match(script, /-WindowStyle Hidden/);
    const hidden = fs.readFileSync(
      path.join(PROJECT_ROOT, 'scripts', 'start-agent-hidden.ps1'),
      'utf8',
    );
    assert.match(hidden, /start-agent\.cmd/);
    assert.match(hidden, /-WindowStyle Hidden/);
    // The supervisor's exit code must survive the extra layer.
    assert.match(hidden, /exit \$proc\.ExitCode/);
  });

  // Exit 5 (lock held) must STAND BY, not exit: an exiting instance ends the
  // scheduled task, and with an orphaned agent still holding the lock every
  // watchdog tick then spawned a full probe stack forever (observed 2026-08-19).
  test('supervisor loop adopts instead of exiting when the lock is held', () => {
    const script = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'start-agent.cmd'), 'utf8');
    assert.match(script, /if "%EXIT_CODE%"=="5" \(/);
    assert.doesNotMatch(script, /if "%EXIT_CODE%"=="5" exit/);
    assert.match(script, /if "%EXIT_CODE%"=="0" exit \/b 0/);
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
        triggerCount: 2,
        triggerTypes: 'MSFT_TaskLogonTrigger,MSFT_TaskTimeTrigger',
        lastTaskResult: 0,
        lastRunTime: '08/19/2026 17:10:01',
      }),
    );
    assert.ok(facts);
    assert.equal(facts!.state, 'Ready');
    assert.equal(facts!.restartCount, 999);
    assert.equal(facts!.restartInterval, 'PT1M');
    assert.equal(facts!.workingDirectory, 'E:\\repo');
    assert.equal(facts!.triggerCount, 2);
    assert.match(facts!.triggerTypes, /TimeTrigger/);
    assert.equal(facts!.lastTaskResult, 0);
  });

  // Doctor diagnoses a missing watchdog from these fields; the query must
  // keep producing them.
  test('query command fetches trigger and last-result facts', () => {
    const command = queryArgv()[queryArgv().length - 1]!;
    assert.match(command, /Get-ScheduledTaskInfo/);
    assert.match(command, /triggerCount/);
    assert.match(command, /lastTaskResult/);
  });

  test('tolerates facts JSON from an older build without trigger fields', () => {
    const facts = parseTaskFacts(JSON.stringify({ state: 'Ready' }));
    assert.ok(facts);
    assert.equal(facts!.triggerCount, null);
    assert.equal(facts!.lastTaskResult, null);
  });

  test('returns null on garbage rather than throwing', () => {
    assert.equal(parseTaskFacts('ERROR: something in Norwegian'), null);
    assert.equal(parseTaskFacts(''), null);
  });
});

describe('console-close survivability', () => {
  // CTRL_CLOSE arrives as SIGHUP with a ~5s budget; without this handler the
  // agent dies silently and the log never says why (cost a night of forensics).
  test('main.ts registers a SIGHUP handler', () => {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main.ts'), 'utf8');
    assert.match(source, /process\.on\('SIGHUP'/);
  });
});

describe('daily heartbeat scheduling', () => {
  test('targets the next occurrence of the configured hour', () => {
    const now = new Date(2026, 7, 19, 10, 30, 0);
    // 9:00 already passed today → tomorrow 9:00.
    assert.equal(msUntilNextLocalHour(9, now), 22.5 * 60 * 60 * 1000);
    // 11:00 is still ahead today.
    assert.equal(msUntilNextLocalHour(11, now), 30 * 60 * 1000);
  });

  test('exactly at the hour schedules the NEXT day, never a double-send', () => {
    const now = new Date(2026, 7, 19, 9, 0, 0, 0);
    assert.equal(msUntilNextLocalHour(9, now), 24 * 60 * 60 * 1000);
  });

  test('message shape covers idle and busy days', () => {
    assert.match(formatHeartbeat(26 * 60 * 60 * 1000, { completed: 0, failed: 0 }), /online, uptime 26h, no tasks/);
    assert.match(formatHeartbeat(60 * 60 * 1000, { completed: 3, failed: 1 }), /3 completed, 1 failed/);
  });
});

describe('startup module makes no AI calls', () => {
  test('never imports the provider or executor layers', () => {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'startup', 'windows.ts'), 'utf8');
    assert.doesNotMatch(source, /providers|executor|runCopilot/);
  });
});
