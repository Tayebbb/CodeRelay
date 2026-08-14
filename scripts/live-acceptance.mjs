/**
 * Live acceptance run: drives the REAL Copilot CLI against a throwaway git
 * repository containing a real bug, using the real TaskRunner.
 *
 * This is the only thing in the repo that spends AI credits, so it is a manual
 * script and never part of `npm test`. Run it after changes to the runner,
 * permissions or git handling:
 *
 *     node scripts/live-acceptance.mjs
 *
 * It asserts the whole chain: detect -> checkpoint -> repo scan -> Copilot ->
 * verification -> commit, and that the bot token never reaches the child.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(path.join(process.cwd(), 'dist', 'src', p)).href;

const { loadConfig } = await import(dist('core/config.js'));
const { openDatabase } = await import(dist('db/database.js'));
const { TaskRepository } = await import(dist('db/taskRepository.js'));
const { ProjectRegistry } = await import(dist('projects/registry.js'));
const { ApprovalService } = await import(dist('approval/service.js'));
const { nullNotifier } = await import(dist('notify/notifier.js'));
const { TaskRunner } = await import(dist('runner/taskRunner.js'));
const { detectCopilot } = await import(dist('copilot/detect.js'));
const { execCommand } = await import(dist('util/exec.js'));

const SECRET = '7777777777:LIVE-ACCEPTANCE-CANARY-TOKEN';
// Deliberately NOT os.tmpdir(): the Copilot CLI treats the system temp
// directory as a special path root, so a project living there is not
// representative of a real checkout.
const root = fs.mkdtempSync(path.join(process.cwd(), '.live-acceptance-'));
const projectDir = path.join(root, 'project');
fs.mkdirSync(projectDir, { recursive: true });

const git = (args) => execCommand('git', args, { cwd: projectDir, shell: false, timeoutMs: 60_000 });

// A genuinely broken implementation with a test that proves it is broken.
fs.writeFileSync(
  path.join(projectDir, 'slugify.mjs'),
  `export function slugify(title) {
  // BUG: collapses spaces but leaves punctuation and casing intact.
  return title.split(' ').join('-');
}
`,
);
fs.writeFileSync(
  path.join(projectDir, 'test.mjs'),
  `import assert from 'node:assert/strict';
import { slugify } from './slugify.mjs';

assert.equal(slugify('Hello World'), 'hello-world');
assert.equal(slugify('Hello, World!'), 'hello-world');
assert.equal(slugify('  Multiple   Spaces  '), 'multiple-spaces');
assert.equal(slugify('Café del Mar'), 'cafe-del-mar');
console.log('all slugify tests passed');
`,
);
fs.writeFileSync(
  path.join(projectDir, 'package.json'),
  JSON.stringify({ name: 'live-acceptance', private: true, scripts: { test: 'node test.mjs' } }, null, 2),
);

await git(['init', '-b', 'main']);
await git(['config', 'user.email', 'agent@example.com']);
await git(['config', 'user.name', 'Live Acceptance']);
await git(['add', '-A']);
await git(['commit', '-m', 'initial: slugify with a known bug']);
const headBefore = (await git(['rev-parse', 'HEAD'])).stdout.trim();

process.env.TELEGRAM_BOT_TOKEN = SECRET;
process.env.AUTHORIZED_TELEGRAM_USER_ID = '4242';
process.env.AGENT_WORKSPACE = path.join(root, 'workspace');
const config = loadConfig();

const copilot = await detectCopilot(config.copilot.bin);
assert.ok(copilot.installed, 'Copilot CLI must be installed for the live run');
assert.ok(copilot.launcher?.safe, 'launcher must be shell-free');
console.log(`Copilot ${copilot.version} · signed in as ${copilot.authenticatedUser}`);

const db = openDatabase(path.join(root, 'agent.db'));
const tasks = new TaskRepository(db);
const messages = [];
const notifier = {
  ...nullNotifier,
  async sendMessage(_chatId, text) {
    messages.push(text);
    console.log(`  telegram> ${text.split('\n')[0]}`);
  },
  async requestApproval(request) {
    messages.push(`APPROVAL: ${request.reason}`);
    console.log(`  telegram> APPROVAL REQUESTED: ${request.reason} -> auto-approving`);
    // Answer out of band, exactly as a Telegram button press would.
    setTimeout(() => approvals.resolve(request.taskId, 'APPROVED', 4242), 10);
  },
};
const projects = ProjectRegistry.fromRecords([
  { id: 'demo', name: 'Demo', path: projectDir, testCommand: 'npm test' },
]);
const approvals = new ApprovalService(tasks, notifier, 60_000);
const runner = new TaskRunner({ config, tasks, projects, notifier, approvals, copilot });

const task = tasks.create({
  userId: 4242,
  chatId: 4242,
  projectId: 'demo',
  prompt:
    'The slugify() function in slugify.mjs is broken: `npm test` fails. Fix slugify.mjs so every ' +
    'assertion in test.mjs passes. Do not change test.mjs.',
  approvalRequired: false,
  approvalReason: null,
});

console.log('\nRunning live task against the real Copilot CLI...\n');
const started = Date.now();
const outcome = await runner.run(task);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const stored = tasks.get(task.id);
const transcript = messages.join('\n');
const headAfter = (await git(['rev-parse', 'HEAD'])).stdout.trim();
const diff = (await git(['show', '--stat', '--oneline', 'HEAD'])).stdout.trim();

console.log(`\n===== RESULT (${elapsed}s) =====`);
console.log(`status        : ${outcome.status}`);
console.log(`ai credits    : ${stored.usage.aiCredits}`);
console.log(`output tokens : ${stored.usage.outputTokens}`);
console.log(`unreported    : ${stored.usage.unreportedRuns}`);
console.log(`commit        : ${stored.commitHash ?? '(none)'}`);
console.log(`\n${diff}`);
console.log('\n----- final slugify.mjs -----');
console.log(fs.readFileSync(path.join(projectDir, 'slugify.mjs'), 'utf8'));

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

console.log('----- acceptance checks -----');
check('task completed', outcome.status === 'COMPLETED', outcome.status);
check('a commit was created', headAfter !== headBefore && !!stored.commitHash);
check('tests actually pass now', (await execCommand('npm', ['test'], {
  cwd: projectDir, shell: process.platform === 'win32', timeoutMs: 120_000,
})).code === 0);
const changed = (await git(['diff', '--name-only', headBefore, 'HEAD'])).stdout;
check('slugify.mjs was fixed', changed.includes('slugify.mjs'), changed.trim().replace(/\s+/g, ' '));
check('test.mjs was not modified', !changed.includes('test.mjs'));
check('bot token never echoed to Telegram', !transcript.includes(SECRET));
check('credits were accounted', stored.usage.aiCredits > 0 && stored.usage.unreportedRuns === 0);
check('no git hook was installed', !fs.existsSync(path.join(projectDir, '.git', 'hooks', 'post-commit')));
check('checkpoint ref exists', (await git(['for-each-ref', 'refs/remote-agent'])).stdout.trim().length > 0);

console.log(`\n${failures.length === 0 ? 'LIVE ACCEPTANCE PASSED' : `LIVE ACCEPTANCE FAILED: ${failures.join(', ')}`}`);
console.log(`workspace kept for inspection: ${root}`);
db.close();
process.exit(failures.length === 0 ? 0 : 1);
