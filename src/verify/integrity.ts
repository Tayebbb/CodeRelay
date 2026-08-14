import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Integrity of the files that decide WHAT the verification step executes.
 *
 * The agent is given write access to the project, and afterwards this app runs
 * the project's own `npm test` / `make test` / `mvn test`. The body of those
 * targets lives in `package.json`, `Makefile`, `pom.xml` … — inside the very
 * tree the agent just edited. A prompt-injected agent (or a malicious
 * dependency) could rewrite `scripts.test` and have the supervisor execute it
 * outside every Copilot permission control.
 *
 * So we fingerprint those files before the agent runs and re-check afterwards.
 * A change is legitimate often enough (adding a test script is normal) that we
 * ask rather than refuse — but it is never executed unnoticed.
 *
 * HONEST LIMITATION: this cannot cover the transitive closure of everything a
 * test command executes (arbitrary source files, node_modules, a script a
 * manifest points at three levels down). Running the project's own tests after
 * an agent edited the project inherently executes agent-influenced code — that
 * is the point of the feature. This gate catches the entry point being
 * REDIRECTED; the sandbox (COPILOT_SANDBOX) is what contains the rest.
 */

const MANIFESTS = [
  'package.json',
  'Makefile',
  'makefile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gradlew',
  'gradlew.bat',
  'gradle/wrapper/gradle-wrapper.properties',
  // The wrapper JARs are the code `gradlew`/`mvnw` actually execute. Hashing the
  // launcher script but not the JAR it runs leaves the real entry point open.
  'gradle/wrapper/gradle-wrapper.jar',
  'mvnw',
  'mvnw.cmd',
  '.mvn/wrapper/maven-wrapper.jar',
  '.mvn/wrapper/maven-wrapper.properties',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'tox.ini',
  'pytest.ini',
  'setup.cfg',
  'conftest.py',
  'pnpm-workspace.yaml',
  // npm/yarn/pnpm lifecycle scripts and config that affect what a build runs
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  // Test-runner configuration decides what the runner actually executes
  'jest.config.js',
  'jest.config.cjs',
  'jest.config.mjs',
  'jest.config.ts',
  'vitest.config.js',
  'vitest.config.ts',
  'vitest.config.mts',
  'karma.conf.js',
  'playwright.config.js',
  'playwright.config.ts',
  'cypress.config.js',
  'cypress.config.ts',
  '.mocharc.json',
  '.mocharc.js',
  '.mocharc.yml',
  'nx.json',
  'turbo.json',
  'lerna.json',
  'vite.config.js',
  'vite.config.ts',
  'vitest.workspace.ts',
  'jest.config.json',
  '.mocharc.cjs',
  'tests/conftest.py',
  'test/conftest.py',
  // Build systems whose config selects the program that runs
  '.cargo/config.toml',
  '.cargo/config',
  '.mvn/jvm.config',
  '.mvn/maven.config',
  '.mvn/extensions.xml',
  'gradle.properties',
  'settings.gradle',
  'settings.gradle.kts',
  'Directory.Build.props',
  'Directory.Build.targets',
  'nuget.config',
  'NuGet.config',
  'go.work',
  // Activates filter/diff drivers named in git config
  '.gitattributes',
];

export type ManifestFingerprint = Record<string, string>;

function hashFile(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function fingerprintManifests(root: string, extraFiles: string[] = []): ManifestFingerprint {
  const fingerprint: ManifestFingerprint = {};
  // Windows and macOS are case-insensitive, so `Makefile` and `makefile` would
  // otherwise both match the same file and report a spurious duplicate.
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const seen = new Set<string>();

  for (const name of [...MANIFESTS, ...extraFiles]) {
    const key = caseInsensitive ? name.toLowerCase() : name;
    if (seen.has(key)) continue;
    const hash = hashFile(path.join(root, name));
    if (hash) {
      fingerprint[name] = hash;
      seen.add(key);
    }
  }
  return fingerprint;
}

/**
 * Repo-relative script paths mentioned by a verification command, e.g.
 * `node run-tests.mjs` or `python -m pytest tests/smoke.py`. These are the
 * command's own entry points, so a change to them changes what runs.
 */
export function referencedScripts(commandArgs: string[]): string[] {
  const out: string[] = [];
  for (const arg of commandArgs) {
    if (arg.startsWith('-')) continue;
    if (!/\.(m?js|cjs|ts|mts|py|rb|sh|ps1|bat|cmd)$/i.test(arg)) continue;
    if (path.isAbsolute(arg) || arg.includes('..')) continue;
    out.push(arg.replace(/\\/g, '/'));
  }
  return out;
}

/**
 * Scripts reachable through `package.json` lifecycle entries.
 *
 * `npm test` carries no script path in its argv, so `referencedScripts` alone
 * sees nothing — yet `"test": "node evil.js"` is exactly the interesting case.
 * Reading the script BODIES recovers the files that actually execute.
 */
export function packageScriptTargets(root: string): string[] {
  let scripts: Record<string, string>;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }

  const interesting = ['pretest', 'test', 'posttest', 'prebuild', 'build', 'postbuild', 'test:ci', 'test:unit'];
  const targets = new Set<string>();
  for (const name of interesting) {
    const body = scripts[name];
    if (typeof body !== 'string') continue;
    // Split on whitespace and shell separators, then keep script-looking tokens.
    for (const token of body.split(/[\s;&|]+/)) {
      for (const found of referencedScripts([token])) targets.add(found);
    }
  }
  return [...targets];
}

export interface ManifestDiff {
  changed: string[];
  added: string[];
  removed: string[];
  any: boolean;
}

export function diffManifests(before: ManifestFingerprint, after: ManifestFingerprint): ManifestDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [name, hash] of Object.entries(after)) {
    if (!(name in before)) added.push(name);
    else if (before[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) removed.push(name);
  }

  return { changed, added, removed, any: changed.length + added.length + removed.length > 0 };
}

/** Human-readable summary for an approval card. */
export function describeManifestDiff(diff: ManifestDiff): string[] {
  return [
    ...diff.changed.map((f) => `modified: ${f}`),
    ...diff.added.map((f) => `added: ${f}`),
    ...diff.removed.map((f) => `removed: ${f}`),
  ];
}

/**
 * The git control surface: config and hooks.
 *
 * `.git` may be a FILE (worktrees, submodules) pointing at the real git dir, so
 * the caller resolves it with `git rev-parse --absolute-git-dir`. Naively joining
 * `<root>/.git/config` would hash nothing there and then compare empty-to-empty
 * forever — a silent no-op exactly where integrity matters most.
 */
export function fingerprintGitControlSurface(root: string, gitDir?: string | null): ManifestFingerprint {
  const fingerprint: ManifestFingerprint = {};
  const base = gitDir ?? path.join(root, '.git');

  // Records that the git dir could not be resolved, so a later comparison sees a
  // change rather than treating "nothing found" as "nothing changed".
  if (!fs.existsSync(base)) {
    fingerprint['<git-dir-missing>'] = 'missing';
    return fingerprint;
  }

  for (const file of ['config', 'config.worktree', 'info/attributes', 'info/exclude']) {
    const hash = hashFile(path.join(base, file));
    if (hash) fingerprint[`.git/${file}`] = hash;
  }

  // Any hooks directory, including `.git/copilot-hooks` which the CLI itself
  // creates and points `core.hooksPath` at.
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().includes('hooks')) continue;
    const dir = path.join(base, entry);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        // Git ships inert `.sample` files; only executable hooks matter.
        if (name.endsWith('.sample')) continue;
        const hash = hashFile(path.join(dir, name));
        if (hash) fingerprint[`.git/${entry}/${name}`] = hash;
      }
    } catch {
      // unreadable: skip
    }
  }

  // Submodule git dirs carry their own config.
  const modules = path.join(base, 'modules');
  try {
    for (const name of fs.readdirSync(modules)) {
      const hash = hashFile(path.join(modules, name, 'config'));
      if (hash) fingerprint[`.git/modules/${name}/config`] = hash;
    }
  } catch {
    // no submodules
  }

  // `.gitattributes` activates filter/diff drivers named in config.
  for (const file of ['.gitattributes']) {
    const hash = hashFile(path.join(root, file));
    if (hash) fingerprint[file] = hash;
  }

  return fingerprint;
}
