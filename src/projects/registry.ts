import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ProjectRecord {
  /** Stable slug used in Telegram commands, e.g. "medilink". */
  id: string;
  name: string;
  path: string;
  description?: string;
  /** Overrides auto-detection. */
  testCommand?: string;
  buildCommand?: string;
  /** Extra directories the agent may read (absolute). Use sparingly. */
  extraDirs?: string[];
  /** Disable a project without deleting it. */
  enabled?: boolean;
}

export class ProjectRegistryError extends Error {}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Characters that would change the meaning of an operator-configured test/build
 * command once it reaches a shell. Rejected at registration time.
 */
const COMMAND_METACHARACTERS = /[&|;<>^`$\r\n%"]/;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Directories that must never be registered as a project root. */
function forbiddenRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.azure'),
    path.join(home, '.kube'),
    path.join(home, '.config', 'gh'),
    path.join(home, '.copilot'),
    path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Credentials'),
    path.join(home, 'AppData', 'Local', 'Microsoft', 'Credentials'),
  ];
  if (process.platform === 'win32') {
    roots.push('C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData');
  } else {
    roots.push('/etc', '/usr', '/bin', '/sbin', '/var', '/boot', '/root');
  }
  return roots.map((p) => path.resolve(p));
}

/** True when `child` is inside `parent` (or equal). Case-insensitive on Windows. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Canonical, symlink-free form of a path. Directory junctions and symlinks would
 * otherwise let a path inside the project resolve to somewhere else entirely
 * (e.g. `<project>/vendor` -> `C:\Users\me\.ssh`), defeating every containment
 * check that works on strings alone.
 */
export function realPath(target: string): string {
  try {
    return fs.realpathSync.native(path.resolve(target));
  } catch {
    // Not yet created: canonicalise the nearest existing ancestor instead.
    const resolved = path.resolve(target);
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(realPath(parent), path.basename(resolved));
  }
}

/** True when `child` really is inside `parent`, following links on both sides. */
export function isReallyInside(parent: string, child: string): boolean {
  return isInside(realPath(parent), realPath(child));
}

/** Path spellings that bypass normalisation and must never be accepted. */
const SUSPICIOUS_PATH = [
  /^\\\\\?\\/, // \\?\C:\... extended-length form
  /^\\\\/, // UNC \\server\share
  /~\d(\\|\/|$)/, // 8.3 short names such as PROGRA~1
  /[\r\n\0]/,
];

function assertSafeProjectPath(projectPath: string): string {
  for (const pattern of SUSPICIOUS_PATH) {
    if (pattern.test(projectPath)) {
      throw new ProjectRegistryError(`Refusing a non-canonical or network path: ${projectPath}`);
    }
  }

  // Compare the REAL path: a junction could otherwise point a innocuous-looking
  // directory straight at ~/.ssh.
  const resolved = realPath(projectPath);

  if (!path.isAbsolute(resolved)) {
    throw new ProjectRegistryError(`Project path must be absolute: ${projectPath}`);
  }

  const parsed = path.parse(resolved);
  if (parsed.root === resolved) {
    throw new ProjectRegistryError(`Refusing to register a filesystem root: ${resolved}`);
  }
  if (resolved === realPath(os.homedir())) {
    throw new ProjectRegistryError('Refusing to register your entire home directory as a project.');
  }
  for (const forbidden of forbiddenRoots()) {
    if (isInside(forbidden, resolved) || isInside(resolved, forbidden)) {
      throw new ProjectRegistryError(`Refusing to register a sensitive location: ${resolved}`);
    }
  }
  return resolved;
}

export class ProjectRegistry {
  private projects = new Map<string, ProjectRecord>();
  private lastError: string | null = null;

  constructor(private readonly file: string) {}

  static fromRecords(records: ProjectRecord[]): ProjectRegistry {
    const registry = new ProjectRegistry(':memory:');
    for (const record of records) registry.projects.set(record.id, registry.normalize(record));
    return registry;
  }

  private normalize(record: ProjectRecord): ProjectRecord {
    const id = slugify(record.id || record.name);
    if (!SLUG_RE.test(id)) {
      throw new ProjectRegistryError(`Invalid project id "${record.id}". Use letters, digits, dot, dash, underscore.`);
    }
    for (const [field, value] of [
      ['testCommand', record.testCommand],
      ['buildCommand', record.buildCommand],
    ] as const) {
      if (value && COMMAND_METACHARACTERS.test(value)) {
        throw new ProjectRegistryError(
          `${field} for "${id}" contains shell metacharacters. Use a single command with plain arguments.`,
        );
      }
    }
    return {
      ...record,
      id,
      name: record.name || record.id,
      path: assertSafeProjectPath(record.path),
      extraDirs: (record.extraDirs ?? []).map((d) => assertSafeProjectPath(d)),
      enabled: record.enabled !== false,
    };
  }

  /**
   * Reload from disk. A corrupted file keeps the last good set in memory rather
   * than leaving the agent with no projects at all, and reports the problem.
   */
  load(): void {
    if (this.file === ':memory:') return;

    let records: ProjectRecord[];
    try {
      records = this.readRecords();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.projects.size > 0) return;
      throw err;
    }

    const next = new Map<string, ProjectRecord>();
    for (const record of records) {
      const normalized = this.normalize(record);
      if (next.has(normalized.id)) {
        throw new ProjectRegistryError(`Duplicate project id "${normalized.id}" in ${this.file}`);
      }
      next.set(normalized.id, normalized);
    }

    this.projects = next;
    this.lastError = null;
  }

  /** Why the last reload failed, if it did. */
  loadError(): string | null {
    return this.lastError;
  }

  private readRecords(): ProjectRecord[] {
    if (!fs.existsSync(this.file)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new ProjectRegistryError(`Could not parse ${this.file}: ${(err as Error).message}`);
    }

    return Array.isArray(parsed)
      ? (parsed as ProjectRecord[])
      : ((parsed as { projects?: ProjectRecord[] }).projects ?? []);
  }

  save(): void {
    if (this.file === ':memory:') return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = { projects: [...this.projects.values()] };
    fs.writeFileSync(this.file, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  all(): ProjectRecord[] {
    return [...this.projects.values()];
  }

  enabled(): ProjectRecord[] {
    return this.all().filter((p) => p.enabled !== false);
  }

  add(record: ProjectRecord): ProjectRecord {
    const normalized = this.normalize(record);
    if (!fs.existsSync(normalized.path) || !fs.statSync(normalized.path).isDirectory()) {
      throw new ProjectRegistryError(`Path does not exist or is not a directory: ${normalized.path}`);
    }
    this.projects.set(normalized.id, normalized);
    this.save();
    return normalized;
  }

  remove(id: string): boolean {
    const removed = this.projects.delete(slugify(id));
    if (removed) this.save();
    return removed;
  }

  getById(id: string): ProjectRecord | null {
    return this.projects.get(slugify(id)) ?? null;
  }

  /**
   * Resolve a user-supplied selector to a registered project.
   * Accepts: 1-based index, exact id, exact name, or unambiguous prefix/substring.
   * Never accepts a filesystem path — that is the whole point of the registry.
   */
  resolve(selector: string): { project: ProjectRecord } | { ambiguous: ProjectRecord[] } | null {
    const list = this.enabled();
    const raw = selector.trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
      const index = Number.parseInt(raw, 10) - 1;
      const project = list[index];
      return project ? { project } : null;
    }

    const needle = raw.toLowerCase();
    const exact = list.find((p) => p.id === slugify(needle) || p.name.toLowerCase() === needle);
    if (exact) return { project: exact };

    const partial = list.filter(
      (p) => p.id.includes(slugify(needle)) || p.name.toLowerCase().includes(needle),
    );
    if (partial.length === 1) return { project: partial[0]! };
    if (partial.length > 1) return { ambiguous: partial };
    return null;
  }

  /** Verify a path is inside a registered project. Used before any file operation. */
  assertWithinProject(projectId: string, candidate: string): string {
    const project = this.getById(projectId);
    if (!project) throw new ProjectRegistryError(`Unknown project "${projectId}"`);
    const resolved = realPath(candidate);
    const allowed = [project.path, ...(project.extraDirs ?? [])];
    if (!allowed.some((root) => isReallyInside(root, resolved))) {
      throw new ProjectRegistryError(`Path "${resolved}" is outside project "${project.name}"`);
    }
    return resolved;
  }
}
