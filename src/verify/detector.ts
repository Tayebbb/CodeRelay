import fs from 'node:fs';
import path from 'node:path';

export interface DetectedCommand {
  kind: 'test' | 'build';
  /** Executable, spawned with an argument array (no shell interpolation). */
  command: string;
  args: string[];
  /** Display form for logs and Telegram. */
  display: string;
  source: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exists(root: string, ...names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Node package manager implied by the lockfile. */
function detectPackageManager(root: string): { bin: string; runPrefix: string[] } {
  if (exists(root, 'pnpm-lock.yaml')) return { bin: 'pnpm', runPrefix: ['run'] };
  if (exists(root, 'yarn.lock')) return { bin: 'yarn', runPrefix: [] };
  if (exists(root, 'bun.lockb', 'bun.lock')) return { bin: 'bun', runPrefix: ['run'] };
  return { bin: 'npm', runPrefix: ['run'] };
}

function nodeCommands(root: string): DetectedCommand[] {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) return [];

  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const pm = detectPackageManager(root);
  const out: DetectedCommand[] = [];

  const testScript = ['test', 'test:unit', 'tests'].find((s) => typeof scripts[s] === 'string');
  if (testScript) {
    const args = testScript === 'test' && pm.bin === 'npm' ? ['test', '--silent'] : [...pm.runPrefix, testScript];
    out.push({
      kind: 'test',
      command: pm.bin,
      args,
      display: `${pm.bin} ${args.join(' ')}`,
      source: 'package.json scripts',
    });
  }

  const buildScript = ['build', 'compile'].find((s) => typeof scripts[s] === 'string');
  if (buildScript) {
    const args = [...pm.runPrefix, buildScript];
    out.push({
      kind: 'build',
      command: pm.bin,
      args,
      display: `${pm.bin} ${args.join(' ')}`,
      source: 'package.json scripts',
    });
  }

  return out;
}

function pythonCommands(root: string): DetectedCommand[] {
  const out: DetectedCommand[] = [];
  const hasPyproject = exists(root, 'pyproject.toml');
  const hasTests = exists(root, 'tests', 'test');
  const hasPytestCfg = exists(root, 'pytest.ini', 'tox.ini', 'setup.cfg');

  if (hasPyproject || hasTests || hasPytestCfg) {
    out.push({
      kind: 'test',
      command: process.platform === 'win32' ? 'python' : 'python3',
      args: ['-m', 'pytest', '-q'],
      display: 'python -m pytest -q',
      source: hasPyproject ? 'pyproject.toml' : 'tests directory',
    });
  }
  return out;
}

function jvmCommands(root: string): DetectedCommand[] {
  const out: DetectedCommand[] = [];
  if (exists(root, 'pom.xml')) {
    const mvn = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
    out.push({ kind: 'test', command: mvn, args: ['-B', 'test'], display: 'mvn -B test', source: 'pom.xml' });
    out.push({
      kind: 'build',
      command: mvn,
      args: ['-B', '-DskipTests', 'package'],
      display: 'mvn -B -DskipTests package',
      source: 'pom.xml',
    });
    return out;
  }
  if (exists(root, 'build.gradle', 'build.gradle.kts')) {
    const wrapper = exists(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const bin = wrapper ?? 'gradle';
    out.push({ kind: 'test', command: bin, args: ['test'], display: `${path.basename(bin)} test`, source: 'gradle' });
    out.push({
      kind: 'build',
      command: bin,
      args: ['build', '-x', 'test'],
      display: `${path.basename(bin)} build -x test`,
      source: 'gradle',
    });
  }
  return out;
}

function otherEcosystems(root: string): DetectedCommand[] {
  const out: DetectedCommand[] = [];
  if (exists(root, 'Cargo.toml')) {
    out.push({ kind: 'test', command: 'cargo', args: ['test'], display: 'cargo test', source: 'Cargo.toml' });
    out.push({ kind: 'build', command: 'cargo', args: ['build'], display: 'cargo build', source: 'Cargo.toml' });
  }
  if (exists(root, 'go.mod')) {
    out.push({ kind: 'test', command: 'go', args: ['test', './...'], display: 'go test ./...', source: 'go.mod' });
    out.push({ kind: 'build', command: 'go', args: ['build', './...'], display: 'go build ./...', source: 'go.mod' });
  }
  const csproj = fs.existsSync(root)
    ? fs.readdirSync(root).find((f) => f.endsWith('.sln') || f.endsWith('.csproj'))
    : undefined;
  if (csproj) {
    out.push({ kind: 'test', command: 'dotnet', args: ['test'], display: 'dotnet test', source: csproj });
    out.push({ kind: 'build', command: 'dotnet', args: ['build'], display: 'dotnet build', source: csproj });
  }
  return out;
}

function makeCommands(root: string): DetectedCommand[] {
  const makefile = exists(root, 'Makefile', 'makefile');
  if (!makefile) return [];
  const contents = fs.readFileSync(makefile, 'utf8');
  const out: DetectedCommand[] = [];
  if (/^test\s*:/m.test(contents)) {
    out.push({ kind: 'test', command: 'make', args: ['test'], display: 'make test', source: 'Makefile' });
  }
  if (/^build\s*:/m.test(contents)) {
    out.push({ kind: 'build', command: 'make', args: ['build'], display: 'make build', source: 'Makefile' });
  }
  return out;
}

/** Split a user-configured override into command + args (no shell). */
export function parseOverride(kind: 'test' | 'build', raw: string): DetectedCommand {
  const parts = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cleaned = parts.map((p) => p.replace(/^["']|["']$/g, ''));
  const [command = raw, ...args] = cleaned;
  return { kind, command, args, display: raw, source: 'project registry override' };
}

/**
 * Determine the project's own test/build commands by inspecting its manifests.
 * Never guesses a command that the project does not declare.
 */
export function detectCommands(
  root: string,
  overrides: { testCommand?: string; buildCommand?: string } = {},
): DetectedCommand[] {
  const detected = [
    ...nodeCommands(root),
    ...jvmCommands(root),
    ...otherEcosystems(root),
    ...pythonCommands(root),
    ...makeCommands(root),
  ];

  const byKind = new Map<'test' | 'build', DetectedCommand>();
  for (const command of detected) {
    if (!byKind.has(command.kind)) byKind.set(command.kind, command);
  }

  if (overrides.testCommand) byKind.set('test', parseOverride('test', overrides.testCommand));
  if (overrides.buildCommand) byKind.set('build', parseOverride('build', overrides.buildCommand));

  return [...byKind.values()];
}
