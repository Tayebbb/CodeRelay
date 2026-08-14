/**
 * Resolving a program name to an absolute path, without consulting the current
 * directory.
 *
 * On Windows, CreateProcess searches the CURRENT DIRECTORY before PATH, and
 * `NoDefaultCurrentDirectoryInExePath` does not change that for a direct
 * `spawn()` — only for shell lookups. Verified on this machine: with a planted
 * `git.exe` in the working directory, `spawn('git', [], { cwd })` executed the
 * plant. Since the working directory is a hostile repository, every bare
 * program name we spawn must be resolved here first.
 */

import fs from 'node:fs';
import path from 'node:path';

function candidateExtensions(): string[] {
  if (process.platform !== 'win32') return [''];
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return pathext.split(';').filter(Boolean);
}

/**
 * Find `name` on PATH and return an absolute path, or null if not found.
 * An input that already contains a separator is returned as an absolute path
 * without a PATH search.
 */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (name.includes('/') || name.includes('\\')) {
    return path.isAbsolute(name) ? name : path.resolve(name);
  }

  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const extensions = candidateExtensions();

  for (const dir of dirs) {
    // A relative PATH entry would reintroduce the very problem this avoids.
    if (!path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}
